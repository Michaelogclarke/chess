// Thin wrapper around Stockfish (WASM, runs in a Web Worker in the browser).
// Talks UCI: send text commands, read text lines back.

const ENGINE_URL = '/vendor/stockfish/stockfish-19-lite-single.js';

export class Engine {
  constructor() {
    this.worker = new Worker(ENGINE_URL);
    this.listeners = new Set();
    this.worker.onmessage = (e) => {
      const line = String(e.data);
      for (const fn of [...this.listeners]) fn(line);
    };
    this.failed = new Promise((_, reject) => {
      this.worker.onerror = (e) => reject(new Error(e.message || 'Engine failed to load'));
    });
    this.ready = this.command('uci', (l) => l === 'uciok')
      .then(() => this.command('isready', (l) => l === 'readyok'));
    this.busy = Promise.resolve();
  }

  // Send a command and resolve when a line matching `until` arrives.
  command(cmd, until, onLine) {
    const done = new Promise((resolve) => {
      const fn = (line) => {
        onLine?.(line);
        if (until(line)) { this.listeners.delete(fn); resolve(line); }
      };
      this.listeners.add(fn);
    });
    this.worker.postMessage(cmd);
    return Promise.race([done, this.failed]);
  }

  // Evaluate one position. Score is from the side to move's point of view.
  // Resolves to { cp, mate, best, pv } where exactly one of cp / mate is set.
  analyse(fen, { depth = 16, movetime = 1500, skill = 20 } = {}) {
    const run = async () => {
      await this.ready;
      await this.stopLive();
      let info = null;
      this.worker.postMessage('setoption name MultiPV value 1');
      this.worker.postMessage(`setoption name Skill Level value ${skill}`);
      this.worker.postMessage('position fen ' + fen);
      const bestLine = await this.command(`go depth ${depth} movetime ${movetime}`,
        (l) => l.startsWith('bestmove'),
        (l) => { if (l.startsWith('info') && l.includes(' score ') && l.includes(' pv ')) info = l; });
      const best = bestLine.split(' ')[1];
      const score = info && info.match(/ score (cp|mate) (-?\d+)/);
      const pv = info ? info.split(' pv ')[1].trim().split(' ') : [];
      return {
        cp: score && score[1] === 'cp' ? Number(score[2]) : null,
        mate: score && score[1] === 'mate' ? Number(score[2]) : null,
        best: best && best !== '(none)' ? best : null,
        pv,
      };
    };
    // One search at a time.
    const p = this.busy.then(run);
    this.busy = p.catch(() => {});
    return p;
  }

  // Live analysis: search until stopped, calling onInfo with the latest
  // lines ({ depth, multipv, cp, mate, pv }) as they improve.
  async analyseLive(fen, { multipv = 3 } = {}, onInfo) {
    const seq = (this.liveSeq = (this.liveSeq || 0) + 1);
    await this.ready;
    await this.stopLive();
    await this.busy;
    if (seq !== this.liveSeq) return; // a newer position was requested meanwhile
    await this.stopLive();
    this.worker.postMessage('setoption name Skill Level value 20');
    this.worker.postMessage(`setoption name MultiPV value ${multipv}`);
    this.worker.postMessage('position fen ' + fen);
    this.live = new Promise((resolve) => {
      const fn = (line) => {
        if (line.startsWith('info') && line.includes(' pv ') && line.includes(' score ')) onInfo(parseInfo(line));
        if (line.startsWith('bestmove')) { this.listeners.delete(fn); resolve(); }
      };
      this.listeners.add(fn);
    });
    this.worker.postMessage('go infinite');
  }

  // Stop the live search and wait for its final "bestmove", so that reply
  // can't be mistaken for the end of the next search.
  async stopLive() {
    if (this.live) {
      this.stopping = this.live;
      this.live = null;
      this.worker.postMessage('stop');
    }
    if (this.stopping) {
      const s = this.stopping;
      await s;
      if (this.stopping === s) this.stopping = null;
    }
  }

  terminate() {
    this.worker.terminate();
  }
}

function parseInfo(line) {
  const num = (key) => { const m = line.match(new RegExp(' ' + key + ' (-?\\d+)')); return m ? Number(m[1]) : null; };
  const score = line.match(/ score (cp|mate) (-?\d+)/);
  return {
    depth: num('depth'),
    multipv: num('multipv') || 1,
    cp: score[1] === 'cp' ? Number(score[2]) : null,
    mate: score[1] === 'mate' ? Number(score[2]) : null,
    pv: line.split(' pv ')[1].trim().split(' '),
  };
}
