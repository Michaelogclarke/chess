// Game review maths: replay the moves, evaluate each position with Stockfish,
// and grade every move by how much winning chance it gave away.
// Thresholds and the accuracy formula follow Lichess's published approach.
import { Chess } from '/vendor/chess.js';

// positions[0] is the start; positions[i] is after move i (with that move attached).
export function buildPositions(sanMoves) {
  const chess = new Chess();
  const positions = [{ fen: chess.fen(), move: null }];
  for (const san of sanMoves) {
    const m = chess.move(san);
    positions.push({
      fen: chess.fen(),
      move: { from: m.from, to: m.to, san: m.san, color: m.color, uci: m.from + m.to + (m.promotion || '') },
    });
  }
  return positions;
}

const MATE_SCORE = 10000;

// Evaluation from White's point of view.
//   score: centipawns (mates mapped to +/-10000 minus distance)
//   mate:  moves to mate (+ White mates, - Black mates), 0 if the game ended in mate
//   best:  engine's best move in UCI for the side to move (null if game over)
function terminalEval(fen) {
  const c = new Chess(fen);
  if (c.isCheckmate()) {
    const whiteWon = c.turn() === 'b';
    return { score: whiteWon ? MATE_SCORE : -MATE_SCORE, mate: 0, winner: whiteWon ? 'w' : 'b', best: null };
  }
  if (c.isDraw() || c.isStalemate()) return { score: 0, mate: null, draw: true, best: null };
  return null;
}

export async function analysePositions(positions, engine, { depth, onProgress } = {}) {
  const evals = [];
  for (let i = 0; i < positions.length; i++) {
    const { fen } = positions[i];
    let ev = terminalEval(fen);
    if (!ev) {
      const r = await engine.analyse(fen, { depth });
      const sign = fen.split(' ')[1] === 'w' ? 1 : -1;
      if (r.mate !== null) {
        const m = r.mate * sign;
        ev = { score: Math.sign(m) * (MATE_SCORE - Math.abs(m)), mate: m, best: r.best };
      } else {
        ev = { score: (r.cp ?? 0) * sign, mate: null, best: r.best };
      }
    }
    evals.push(ev);
    onProgress?.(i + 1, positions.length, evals);
  }
  return evals;
}

// Chance of winning (0-100) for White, from centipawns. Lichess's curve.
export function winPct(score) {
  const cp = Math.max(-1000, Math.min(1000, score));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

export const LABELS = {
  brilliant: { name: 'Brilliant move', symbol: '!!' },
  best: { name: 'Best move', symbol: '' },
  good: { name: 'Good move', symbol: '' },
  inaccuracy: { name: 'Inaccuracy', symbol: '?!' },
  mistake: { name: 'Mistake', symbol: '?' },
  blunder: { name: 'Blunder', symbol: '??' },
};

function uciToSan(fen, uci) {
  if (!uci) return null;
  try {
    return new Chess(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san;
  } catch { return null; }
}

const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

// Does this move give away material? True when, after it, the opponent can
// capture one of the mover's pieces (knight or bigger) that is either
// undefended or worth more than the piece taking it, and what's given away
// is clearly more than anything the move itself captured.
function isSacrifice(fenBefore, uci) {
  const c = new Chess(fenBefore);
  let mv;
  try { mv = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }); } catch { return false; }
  const me = mv.color;
  const gained = mv.captured ? VALUE[mv.captured] : 0;
  let worstLoss = 0;
  for (const reply of c.moves({ verbose: true })) {
    if (!reply.captured || VALUE[reply.captured] < 3) continue;
    const lost = VALUE[reply.captured];
    const after = new Chess(c.fen());
    after.move(reply);
    const defended = after.isAttacked(reply.to, me);
    const net = defended ? lost - VALUE[reply.piece] : lost;
    worstLoss = Math.max(worstLoss, net);
  }
  return worstLoss - gained >= 2;
}

// Grade each move. Result is indexed by ply (index 0 is null: no move led to the start).
export function classifyMoves(positions, evals) {
  const out = [null];
  for (let i = 1; i < positions.length && i < evals.length; i++) {
    const { move } = positions[i];
    const before = evals[i - 1], after = evals[i];
    const pov = move.color === 'w' ? 1 : -1;
    const winBefore = winPct(before.score * pov);
    const winAfter = winPct(after.score * pov);
    const drop = Math.max(0, winBefore - winAfter);
    const onlyMove = new Chess(positions[i - 1].fen).moves().length === 1;

    let label;
    const nearBest = move.uci === before.best || drop < 2;
    // Brilliant: a (near-)best sacrifice, when not already completely winning
    // and not losing afterwards.
    if (!onlyMove && nearBest && winBefore < 95 && winAfter >= 45 && after.mate !== 0
        && isSacrifice(positions[i - 1].fen, move.uci)) label = 'brilliant';
    else if (onlyMove || move.uci === before.best) label = 'best';
    else if (drop >= 30) label = 'blunder';
    else if (drop >= 20) label = 'mistake';
    else if (drop >= 10) label = 'inaccuracy';
    else label = 'good';

    const accuracy = Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * drop) - 3.1669));
    out.push({
      label,
      drop,
      accuracy: label === 'best' || label === 'brilliant' ? 100 : accuracy,
      bestSan: label === 'best' || label === 'brilliant' ? null : uciToSan(positions[i - 1].fen, before.best),
    });
  }
  return out;
}

export function summary(positions, grades) {
  const s = {};
  for (const c of ['w', 'b']) s[c] = { accuracy: null, brilliant: 0, inaccuracy: 0, mistake: 0, blunder: 0, moves: 0, total: 0 };
  for (let i = 1; i < grades.length; i++) {
    const g = grades[i], c = positions[i].move.color;
    s[c].moves++;
    s[c].total += g.accuracy;
    if (g.label in s[c]) s[c][g.label]++;
  }
  for (const c of ['w', 'b']) if (s[c].moves) s[c].accuracy = Math.round(s[c].total / s[c].moves);
  return s;
}

// "+1.3", "-0.4", "#3", "#-2", "1-0"
export function formatEval(ev) {
  if (!ev) return '';
  if (ev.mate === 0) return ev.winner === 'w' ? '1-0' : '0-1';
  if (ev.draw) return '½-½';
  if (ev.mate !== null) return '#' + ev.mate;
  const v = ev.score / 100;
  return (v > 0 ? '+' : '') + v.toFixed(1);
}
