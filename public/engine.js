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
  analyse(fen, { depth = 16, movetime = 1500 } = {}) {
    const run = async () => {
      await this.ready;
      let info = null;
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

  terminate() {
    this.worker.terminate();
  }
}
