// Chess variants. Standard and Hidden Queen use chess.js for the rules;
// Fog of War has its own move generator because it has no check: you can
// move into danger, and the game ends when a king is captured.

const { Chess } = require('chess.js');

const VARIANTS = {
  standard: 'Standard',
  hiddenqueen: 'Hidden Queen',
  fog: 'Fog of War',
};

const FILES = 'abcdefgh';
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const idx = (sq) => (Number(sq[1]) - 1) * 8 + FILES.indexOf(sq[0]);
const sqName = (i) => FILES[i % 8] + (Math.floor(i / 8) + 1);

// ---------- FEN placement helpers ----------
function expand(fen) {
  const rows = fen.split(' ')[0].split('/'); // rank 8 first
  const cells = new Array(64).fill(null);
  rows.forEach((row, r) => {
    let f = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) f += Number(ch);
      else { cells[(7 - r) * 8 + f] = ch; f++; }
    }
  });
  return cells;
}
function compress(cells) {
  const rows = [];
  for (let r = 7; r >= 0; r--) {
    let row = '', empty = 0;
    for (let f = 0; f < 8; f++) {
      const c = cells[r * 8 + f];
      if (!c) empty++;
      else { if (empty) row += empty; empty = 0; row += c; }
    }
    if (empty) row += empty;
    rows.push(row);
  }
  return rows.join('/');
}
const withPlacement = (fen, cells) => [compress(cells), ...fen.split(' ').slice(1)].join(' ');

// ---------- Fog of War board ----------
class FogBoard {
  constructor() {
    this.cells = expand(START); // 'P','n', ... or null
    this._turn = 'w';
    this.castling = 'KQkq';
    this.ep = null;
    this.half = 0;
    this.full = 1;
    this._history = [];
    this.kingCaptured = null; // colour of the side whose king was taken
  }
  turn() { return this._turn; }
  history() { return this._history.slice(); }
  inCheck() { return false; }
  fen() {
    return `${compress(this.cells)} ${this._turn} ${this.castling || '-'} ${this.ep || '-'} ${this.half} ${this.full}`;
  }
  pieceAt(i) {
    const c = this.cells[i];
    return c ? { type: c.toLowerCase(), color: c === c.toUpperCase() ? 'w' : 'b' } : null;
  }
  board() {
    const rows = [];
    for (let r = 7; r >= 0; r--) {
      const row = [];
      for (let f = 0; f < 8; f++) {
        const p = this.pieceAt(r * 8 + f);
        row.push(p ? { ...p, square: sqName(r * 8 + f) } : null);
      }
      rows.push(row);
    }
    return rows;
  }

  // Every move that obeys how pieces move; check doesn't exist here.
  pseudoMoves(color) {
    const out = [];
    const enemy = (i) => { const p = this.pieceAt(i); return p && p.color !== color; };
    const empty = (i) => !this.cells[i];
    const onBoard = (f, r) => f >= 0 && f < 8 && r >= 0 && r < 8;
    for (let i = 0; i < 64; i++) {
      const p = this.pieceAt(i);
      if (!p || p.color !== color) continue;
      const f = i % 8, r = Math.floor(i / 8);
      const add = (t, extra = {}) => out.push({ from: sqName(i), to: sqName(t), piece: p.type, color, captured: this.pieceAt(t)?.type, ...extra });
      if (p.type === 'p') {
        const d = color === 'w' ? 1 : -1, last = color === 'w' ? 7 : 0;
        const promo = (t) => (Math.floor(t / 8) === last ? { promotion: true } : {});
        if (onBoard(f, r + d) && empty(i + 8 * d)) {
          add(i + 8 * d, promo(i + 8 * d));
          if (r === (color === 'w' ? 1 : 6) && empty(i + 16 * d)) add(i + 16 * d, { double: true });
        }
        for (const df of [-1, 1]) {
          if (!onBoard(f + df, r + d)) continue;
          const t = i + 8 * d + df;
          if (enemy(t)) add(t, promo(t));
          else if (this.ep && sqName(t) === this.ep) out.push({ from: sqName(i), to: sqName(t), piece: 'p', color, captured: 'p', ep: true });
        }
      } else {
        const steps = {
          n: [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]],
          k: [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]],
        }[p.type];
        const rays = {
          b: [[1, 1], [1, -1], [-1, 1], [-1, -1]],
          r: [[1, 0], [-1, 0], [0, 1], [0, -1]],
          q: [[1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]],
        }[p.type];
        if (steps) {
          for (const [df, dr] of steps) {
            if (!onBoard(f + df, r + dr)) continue;
            const t = (r + dr) * 8 + f + df;
            if (empty(t) || enemy(t)) add(t);
          }
        }
        if (rays) {
          for (const [df, dr] of rays) {
            for (let k = 1; k < 8; k++) {
              if (!onBoard(f + df * k, r + dr * k)) break;
              const t = (r + dr * k) * 8 + f + df * k;
              if (empty(t)) add(t);
              else { if (enemy(t)) add(t); break; }
            }
          }
        }
        if (p.type === 'k') {
          const home = color === 'w' ? 0 : 56;
          const [K, Q] = color === 'w' ? ['K', 'Q'] : ['k', 'q'];
          const rook = color === 'w' ? 'R' : 'r';
          if (i === home + 4) {
            if (this.castling.includes(K) && this.cells[home + 7] === rook && empty(home + 5) && empty(home + 6)) add(home + 6, { castle: 'K' });
            if (this.castling.includes(Q) && this.cells[home] === rook && empty(home + 1) && empty(home + 2) && empty(home + 3)) add(home + 2, { castle: 'Q' });
          }
        }
      }
    }
    return out;
  }

  move({ from, to, promotion }) {
    const color = this._turn;
    const m = this.pseudoMoves(color).find((x) => x.from === from && x.to === to);
    if (!m) throw new Error('Illegal move');
    const fi = idx(from), ti = idx(to);
    const piece = this.cells[fi];
    let san;
    if (m.castle) san = m.castle === 'K' ? 'O-O' : 'O-O-O';
    else {
      const letter = m.piece === 'p' ? (m.captured ? from[0] : '') : m.piece.toUpperCase();
      san = letter + (m.captured ? 'x' : '') + to;
    }
    // Move the piece.
    this.cells[ti] = piece;
    this.cells[fi] = null;
    if (m.ep) this.cells[ti + (color === 'w' ? -8 : 8)] = null;
    if (m.castle) {
      const home = color === 'w' ? 0 : 56;
      const [rf, rt] = m.castle === 'K' ? [home + 7, home + 5] : [home, home + 3];
      this.cells[rt] = this.cells[rf];
      this.cells[rf] = null;
    }
    if (m.promotion) {
      const p = ['q', 'r', 'b', 'n'].includes(promotion) ? promotion : 'q';
      this.cells[ti] = color === 'w' ? p.toUpperCase() : p;
      san += '=' + p.toUpperCase();
      m.promotion = p;
    } else {
      delete m.promotion;
    }
    // Castling rights.
    const strip = (chars) => { for (const ch of chars) this.castling = this.castling.replace(ch, ''); };
    if (m.piece === 'k') strip(color === 'w' ? 'KQ' : 'kq');
    for (const [sq, ch] of [[0, 'Q'], [7, 'K'], [56, 'q'], [63, 'k']]) if (fi === sq || ti === sq) strip(ch);
    this.ep = m.double ? sqName((fi + ti) / 2) : null;
    this.half = m.piece === 'p' || m.captured ? 0 : this.half + 1;
    if (color === 'b') this.full++;
    this._turn = color === 'w' ? 'b' : 'w';
    if (m.captured === 'k') { this.kingCaptured = color === 'w' ? 'b' : 'w'; san += '#'; }
    this._history.push(san);
    return { ...m, san };
  }

  // Squares this side can see: its own pieces, everywhere they can move,
  // and the square straight in front of each pawn.
  visible(color) {
    const vis = new Set();
    for (let i = 0; i < 64; i++) {
      const p = this.pieceAt(i);
      if (p && p.color === color) {
        vis.add(sqName(i));
        if (p.type === 'p') {
          const t = i + (color === 'w' ? 8 : -8);
          if (t >= 0 && t < 64) vis.add(sqName(t));
        }
      }
    }
    for (const m of this.pseudoMoves(color)) vis.add(m.to);
    return vis;
  }
}

function newBoard(variant) {
  return variant === 'fog' ? new FogBoard() : new Chess();
}

// ---------- Hidden Queen ----------
// Each player secretly chooses a pawn to be their queen (the real queen is
// removed). It looks like a pawn to the opponent until it makes a move a
// pawn couldn't, or reaches the last rank.
function freshHiddenQueen() {
  return { w: { square: null, revealed: false, captured: false }, b: { square: null, revealed: false, captured: false } };
}

function applyHiddenQueens(game) {
  for (const c of ['w', 'b']) {
    const q = game.chess.board().flat().find((p) => p && p.type === 'q' && p.color === c);
    if (q) game.chess.remove(q.square);
    game.chess.remove(game.hq[c].square);
    game.chess.put({ type: 'q', color: c }, game.hq[c].square);
  }
}

function pawnLike(m) {
  const d = m.color === 'w' ? 1 : -1;
  const df = FILES.indexOf(m.to[0]) - FILES.indexOf(m.from[0]);
  const dr = Number(m.to[1]) - Number(m.from[1]);
  const startRank = m.color === 'w' ? 2 : 7;
  if (df === 0 && dr === d && !m.captured) return true;
  if (df === 0 && dr === 2 * d && !m.captured && Number(m.from[1]) === startRank) return true;
  return Math.abs(df) === 1 && dr === d && !!m.captured;
}

// Update hidden queen tracking after a real move; returns the SAN the
// opponent should see.
function hiddenQueenAfterMove(game, m) {
  let shownSan = m.san;
  for (const c of ['w', 'b']) {
    const hq = game.hq[c];
    if (hq.captured) continue;
    if (m.color === c && m.from === hq.square) {
      hq.square = m.to;
      const lastRank = m.to[1] === (c === 'w' ? '8' : '1');
      if (!hq.revealed && pawnLike(m) && !lastRank) {
        const suffix = (m.san.match(/[+#]$/) || [''])[0];
        shownSan = (m.captured ? m.from[0] + 'x' : '') + m.to + suffix;
      } else {
        hq.revealed = true;
      }
    } else if (m.color !== c && m.to === hq.square) {
      hq.captured = true;
    }
  }
  return shownSan;
}

// Draw each unrevealed hidden queen as a pawn. Its owner sees a pawn too
// (marked with a crown by the client); the server still knows it's a queen.
function maskHiddenQueens(fen, hqState) {
  const cells = expand(fen);
  let changed = false;
  for (const c of ['w', 'b']) {
    const hq = hqState[c];
    if (!hq.square || hq.revealed || hq.captured) continue;
    const i = idx(hq.square);
    if (cells[i] && cells[i].toLowerCase() === 'q') { cells[i] = c === 'w' ? 'P' : 'p'; changed = true; }
  }
  return changed ? withPlacement(fen, cells) : fen;
}

// ---------- what each viewer is shown ----------
// Snapshot of the game after each move (index 0 = start), so the move list
// can be replayed with the right information hidden.
function snapshot(game, m, shownSan) {
  const snap = {
    fen: game.chess.fen(),
    from: m?.from || null,
    to: m?.to || null,
    color: m?.color || null,
    san: m?.san || null,
    shownSan: shownSan || m?.san || null,
    uci: m ? m.from + m.to + (m.promotion || '') : null,
  };
  if (game.variant === 'hiddenqueen') snap.hq = JSON.parse(JSON.stringify(game.hq));
  if (game.variant === 'fog') snap.vis = { w: [...game.chess.visible('w')], b: [...game.chess.visible('b')] };
  return snap;
}

function hideFog(fen, visible) {
  const vis = new Set(visible);
  const cells = expand(fen);
  for (let i = 0; i < 64; i++) if (!vis.has(sqName(i))) cells[i] = null;
  return withPlacement(fen, cells);
}

// viewer: 'w' | 'b' | null (spectator). Returns the parts of the state that
// differ per viewer.
function viewFor(game, viewer) {
  const over = game.status === 'over';
  const fogSide = viewer || 'w'; // spectators watch a Fog game from White's side
  const positions = game.snaps.map((s, i) => {
    let fen = s.fen, san = s.san, from = s.from, to = s.to;
    if (!over && game.variant === 'hiddenqueen') {
      fen = maskHiddenQueens(s.fen, s.hq);
      // Everyone sees hidden-queen moves written as pawn moves; the owner gets a crown marker.
      if (s.shownSan !== s.san) san = s.shownSan + (s.color === viewer ? ' ♛' : '');
    }
    let fog = null;
    if (!over && game.variant === 'fog') {
      fog = FILES.split('').flatMap((f) => [1, 2, 3, 4, 5, 6, 7, 8].map((r) => f + r)).filter((q) => !s.vis[fogSide].includes(q));
      fen = hideFog(s.fen, s.vis[fogSide]);
      if (i > 0 && s.color !== fogSide) { san = '•••'; from = to = null; }
    }
    return { fen, san, from, to, color: s.color, uci: over ? s.uci : null, fog };
  });
  const live = positions.at(-1);

  let dests = null;
  const turn = game.chess.turn();
  if (viewer && viewer === turn && game.status === 'playing') {
    dests = {};
    const moves = game.variant === 'fog'
      ? game.chess.pseudoMoves(viewer)
      : game.chess.moves({ verbose: true });
    for (const m of moves) (dests[m.from] ||= []).push(m.to);
  }

  let hq = null;
  if (game.variant === 'hiddenqueen') {
    hq = {
      picked: { w: !!game.hq.w.square, b: !!game.hq.b.square },
      mine: viewer && !over && !game.hq[viewer].captured ? game.hq[viewer].square : null,
      revealed: { w: game.hq.w.revealed, b: game.hq.b.revealed },
    };
  }

  return {
    fen: live.fen,
    moves: positions.slice(1).map((p) => p.san),
    positions,
    lastMove: live.from ? { from: live.from, to: live.to } : null,
    inCheck: game.variant === 'fog' ? false : game.chess.inCheck(),
    dests,
    fog: live.fog,
    hq,
  };
}

module.exports = {
  VARIANTS, newBoard, freshHiddenQueen, applyHiddenQueens, hiddenQueenAfterMove, snapshot, viewFor,
};
