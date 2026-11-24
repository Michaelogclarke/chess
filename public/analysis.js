// Analysis board: move freely with live Stockfish lines, or play against
// Stockfish at a chosen level. Everything runs in the browser.
import { Chess } from '/vendor/chess.js';
import { winPct } from '/review.js';
import { Engine } from '/engine.js';

const $ = (id) => document.getElementById(id);
const boardEl = $('board');
const promoEl = $('promo');
const pieceUrl = (c, t) => window.settings.pieceUrl(c, t);
const START = new Chess().fen();

// line[0] is the starting position; line[i] is after move i.
let line = [{ fen: START }];
let ply = 0;
let orientation = 'w';
let selected = null;
let engine = null;
let lines = []; // live engine lines for the shown position, by multipv
let liveFen = null;
let vs = null; // { color, level } while playing the computer
let thinking = false;

// Difficulty levels: Stockfish "Skill Level" plus a depth and time cap.
const LEVELS = [
  { skill: 0, depth: 1, movetime: 100 },
  { skill: 3, depth: 2, movetime: 150 },
  { skill: 6, depth: 4, movetime: 200 },
  { skill: 9, depth: 6, movetime: 300 },
  { skill: 12, depth: 9, movetime: 500 },
  { skill: 15, depth: 12, movetime: 700 },
  { skill: 18, depth: 16, movetime: 1000 },
  { skill: 20, depth: 22, movetime: 1500 },
];
let level = 3;

const current = () => new Chess(line[ply].fen);
const getEngine = () => (engine ||= new Engine());

// ---------- loading from a finished game or pasted PGN/FEN ----------
function loadMoves(sans, startFen = START) {
  const c = new Chess(startFen);
  line = [{ fen: c.fen() }];
  for (const san of sans) {
    const m = c.move(san);
    line.push({ fen: c.fen(), san: m.san, from: m.from, to: m.to });
  }
  ply = line.length - 1;
}
function loadText(text) {
  text = text.trim();
  if (!text) throw new Error('Paste some moves or a FEN.');
  if (/^[rnbqkpRNBQKP1-8]+(\/[rnbqkpRNBQKP1-8]+){7}\s/.test(text)) {
    new Chess(text); // throws if invalid
    loadMoves([], text);
    return;
  }
  const c = new Chess();
  c.loadPgn(text, { strict: false });
  loadMoves(c.history());
}
try {
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get('moves')) loadMoves(hash.get('moves').split(' ').filter(Boolean), hash.get('fen') || START);
  else if (hash.get('fen')) loadMoves([], hash.get('fen'));
  if (hash.get('flip') === '1') orientation = 'b';
} catch {}

// ---------- drawing ----------
function squares() {
  const F = 'abcdefgh', out = [];
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
    out.push(orientation === 'w' ? F[f] + (8 - r) : F[7 - f] + (r + 1));
  }
  return out;
}
function sqCenter(sq) {
  const f = 'abcdefgh'.indexOf(sq[0]), r = Number(sq[1]) - 1;
  return orientation === 'w' ? [f + 0.5, 7 - r + 0.5] : [7 - f + 0.5, r + 0.5];
}

function render() {
  const c = current();
  const last = line[ply];
  const targets = new Set(selected ? c.moves({ square: selected, verbose: true }).map((m) => m.to) : []);
  const check = c.inCheck() ? c.board().flat().find((p) => p && p.type === 'k' && p.color === c.turn())?.square : null;
  boardEl.innerHTML = '';
  boardEl.classList.toggle('blindfold', !!window.settings.get('blindfold'));
  squares().forEach((sq, i) => {
    const el = document.createElement('div');
    const dark = ('abcdefgh'.indexOf(sq[0]) + Number(sq[1])) % 2 === 0;
    el.className = 'sq ' + (dark ? 'dark' : 'light');
    el.dataset.sq = sq;
    if (last.from && (sq === last.from || sq === last.to)) el.classList.add('last');
    if (sq === selected) el.classList.add('sel');
    if (sq === check) el.classList.add('check');
    const p = c.get(sq);
    if (p) {
      const pc = document.createElement('span');
      pc.className = 'pc';
      pc.style.backgroundImage = `url(${pieceUrl(p.color, p.type)})`;
      el.appendChild(pc);
    }
    if (targets.has(sq)) el.classList.add(p ? 'capture' : 'target');
    if (i % 8 === 0) el.insertAdjacentHTML('beforeend', `<span class="coord rank">${sq[1]}</span>`);
    if (i >= 56) el.insertAdjacentHTML('beforeend', `<span class="coord file">${sq[0]}</span>`);
    boardEl.appendChild(el);
  });

  const bottom = orientation, top = bottom === 'w' ? 'b' : 'w';
  const label = (col) => (vs ? (col === vs.color ? 'You' : `Stockfish level ${vs.level + 1}`) : col === 'w' ? 'White' : 'Black');
  $('top-player').querySelector('.name').textContent = label(top);
  $('bottom-player').querySelector('.name').textContent = label(bottom);

  renderMoves();
  renderStatus(c);
  renderEngine();
  requestAnalysis();
}

function renderMoves() {
  const ol = $('moves');
  ol.innerHTML = '';
  for (let i = 1; i < line.length; i += 2) {
    const li = document.createElement('li');
    for (const p of [i, i + 1]) {
      if (!line[p]) { li.appendChild(document.createElement('span')); continue; }
      const b = document.createElement('button');
      b.className = 'mv' + (p === ply ? ' current' : '');
      b.textContent = line[p].san;
      b.onclick = () => goTo(p);
      li.appendChild(b);
    }
    ol.appendChild(li);
  }
  ol.querySelector('.current')?.scrollIntoView({ block: 'nearest' });
  $('nav-pos').textContent = line.length > 1 ? `${ply} / ${line.length - 1}` : '';
  $('nav-first').disabled = $('nav-prev').disabled = ply === 0;
  $('nav-next').disabled = $('nav-last').disabled = ply === line.length - 1;
}

function renderStatus(c) {
  let text = '';
  if (c.isCheckmate()) text = `Checkmate. ${c.turn() === 'w' ? 'Black' : 'White'} wins.`;
  else if (c.isStalemate()) text = 'Stalemate. Draw.';
  else if (c.isInsufficientMaterial()) text = 'Draw by insufficient material.';
  else if (c.isThreefoldRepetition()) text = 'Draw by threefold repetition.';
  else if (c.isDraw()) text = 'Draw.';
  else if (vs) text = thinking ? 'Stockfish is thinking…' : c.turn() === vs.color ? 'Your move' : '';
  $('status').hidden = !text;
  $('status').textContent = text;
  $('status').classList.toggle('over', c.isGameOver());
}

// ---------- live engine ----------
const engineVisible = () => $('engine-on').checked && !vs;

function requestAnalysis() {
  const fen = line[ply].fen;
  if (!engineVisible()) {
    if (engine) engine.stopLive();
    return;
  }
  if (fen === liveFen) return;
  liveFen = fen;
  lines = [];
  const c = new Chess(fen);
  if (c.isGameOver()) { engine?.stopLive(); renderEngine(); return; }
  $('engine-info').textContent = 'Thinking…';
  getEngine().analyseLive(fen, { multipv: 3 }, (info) => {
    if (fen !== liveFen) return; // stale line from an old position
    lines[info.multipv - 1] = info;
    renderEngine();
  }).catch((err) => { $('engine-info').textContent = 'Could not start Stockfish: ' + err.message; });
}

// Score from White's point of view.
function whiteScore(info, fen) {
  const sign = fen.split(' ')[1] === 'w' ? 1 : -1;
  if (info.mate !== null) return { mate: info.mate * sign, score: Math.sign(info.mate * sign) * 10000 };
  return { mate: null, score: info.cp * sign };
}
const fmtScore = (s) => (s.mate !== null ? '#' + s.mate : (s.score > 0 ? '+' : '') + (s.score / 100).toFixed(2));

function pvToSan(fen, pv, max = 10) {
  const c = new Chess(fen);
  let moveNo = Number(fen.split(' ')[5]) || 1;
  const out = [];
  for (const uci of pv.slice(0, max)) {
    let m;
    try { m = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }); } catch { break; }
    if (m.color === 'w') out.push(`${moveNo}. ${m.san}`);
    else { out.push(out.length === 0 ? `${moveNo}… ${m.san}` : m.san); moveNo++; }
  }
  return out.join(' ');
}

function renderEngine() {
  const fen = line[ply].fen;
  const visible = engineVisible();
  const bar = $('evalbar');
  bar.hidden = !visible;
  const svg = $('arrows');
  svg.innerHTML = '';
  const ol = $('lines');
  ol.innerHTML = '';
  if (!visible) return;
  const c = new Chess(fen);
  const best = lines[0];
  let ws = null;
  if (c.isCheckmate()) ws = { mate: 0, score: c.turn() === 'w' ? -10000 : 10000 };
  else if (c.isGameOver()) ws = { mate: null, score: 0 };
  else if (best) ws = whiteScore(best, fen);

  // Eval bar.
  const white = ws ? winPct(ws.score) : 50;
  bar.querySelector('.evalfill').style.height = white + '%';
  bar.classList.toggle('flipped', orientation === 'b');
  const t = bar.querySelector('.evaltext');
  t.textContent = ws ? (ws.mate === 0 ? (ws.score > 0 ? '1-0' : '0-1') : fmtScore(ws).replace(/^\+/, '').replace(/\.(\d)\d$/, '.$1')) : '';
  t.classList.toggle('on-white', white >= 50);

  if (best) {
    $('engine-info').textContent = `Depth ${best.depth} · Stockfish 19 lite`;
    // Arrows: best move strong, other lines faint.
    svg.innerHTML = lines.filter(Boolean).map((l, i) => {
      const [x1, y1] = sqCenter(l.pv[0].slice(0, 2)), [x2, y2] = sqCenter(l.pv[0].slice(2, 4));
      const len = Math.hypot(x2 - x1, y2 - y1), ux = (x2 - x1) / len, uy = (y2 - y1) / len;
      const ex = x2 - ux * 0.42, ey = y2 - uy * 0.42, px = -uy, py = ux;
      return `<g class="${i === 0 ? 'eng-best' : 'eng-alt'}"><line class="arrow-shaft" x1="${x1}" y1="${y1}" x2="${ex}" y2="${ey}"/>
        <polygon class="arrow-head" points="${x2},${y2} ${ex + px * 0.26},${ey + py * 0.26} ${ex - px * 0.26},${ey - py * 0.26}"/></g>`;
    }).reverse().join('');
    for (const l of lines.filter(Boolean)) {
      const li = document.createElement('li');
      const s = whiteScore(l, fen);
      li.innerHTML = '<strong></strong> <span></span>';
      li.querySelector('strong').textContent = fmtScore(s);
      li.querySelector('span').textContent = pvToSan(fen, l.pv);
      li.title = 'Click to play the first move of this line';
      li.onclick = () => playMove(l.pv[0].slice(0, 2), l.pv[0].slice(2, 4), l.pv[0][4]);
      ol.appendChild(li);
    }
  } else if (c.isGameOver()) {
    $('engine-info').textContent = 'Game over';
  }
}

// ---------- moving ----------
function playMove(from, to, promotion) {
  const c = current();
  let m;
  try { m = c.move({ from, to, promotion }); } catch { return false; }
  // A new move from an earlier position replaces what came after.
  line = line.slice(0, ply + 1);
  line.push({ fen: c.fen(), san: m.san, from: m.from, to: m.to });
  ply = line.length - 1;
  selected = null;
  window.playSound?.(/[+#]/.test(m.san) ? 'check' : m.captured ? 'capture' : 'move');
  render();
  maybeComputerMove();
  return true;
}

function goTo(p) {
  ply = Math.max(0, Math.min(line.length - 1, p));
  selected = null;
  render();
  maybeComputerMove();
}

function squareAt(x, y) {
  const r = boardEl.getBoundingClientRect();
  const col = Math.floor(((x - r.left) / r.width) * 8), row = Math.floor(((y - r.top) / r.height) * 8);
  if (col < 0 || col > 7 || row < 0 || row > 7) return null;
  return squares()[row * 8 + col];
}

const canMoveNow = () => {
  if (!promoEl.hidden || thinking) return false;
  if (!vs) return true;
  return ply === line.length - 1 && current().turn() === vs.color;
};
const movable = (sq) => { const p = current().get(sq); return p && p.color === current().turn(); };

function attempt(from, to) {
  const legal = current().moves({ square: from, verbose: true }).filter((m) => m.to === to);
  if (!legal.length) { selected = movable(to) ? to : null; return render(); }
  if (legal.some((m) => m.promotion)) return askPromotion(from, to);
  playMove(from, to);
}

let drag = null;
boardEl.addEventListener('contextmenu', (e) => e.preventDefault());
boardEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !canMoveNow()) return;
  const sq = squareAt(e.clientX, e.clientY);
  if (!sq) return;
  if (selected && sq !== selected && !movable(sq)) return attempt(selected, sq);
  if (!movable(sq)) { selected = null; return render(); }
  e.preventDefault();
  const was = selected === sq;
  selected = sq;
  render();
  const pieceEl = boardEl.querySelector(`[data-sq="${sq}"] .pc`);
  const ghost = pieceEl.cloneNode(true);
  ghost.classList.add('ghost');
  const size = pieceEl.getBoundingClientRect().width;
  ghost.style.width = ghost.style.height = size + 'px';
  document.body.appendChild(ghost);
  pieceEl.classList.add('lifted');
  drag = { from: sq, ghost, moved: false, was, x: e.clientX, y: e.clientY };
  ghost.style.left = e.clientX + 'px'; ghost.style.top = e.clientY + 'px';
  boardEl.setPointerCapture(e.pointerId);
});
boardEl.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4) drag.moved = true;
  drag.ghost.style.left = e.clientX + 'px'; drag.ghost.style.top = e.clientY + 'px';
});
boardEl.addEventListener('pointerup', (e) => {
  if (!drag) return;
  const { from, ghost, moved, was } = drag;
  drag = null;
  ghost.remove();
  const to = squareAt(e.clientX, e.clientY);
  if (moved && to && to !== from) return attempt(from, to);
  if (!moved && was) selected = null;
  render();
});

function askPromotion(from, to) {
  const color = current().turn();
  promoEl.innerHTML = '';
  for (const t of ['q', 'r', 'b', 'n']) {
    const b = document.createElement('button');
    b.className = 'promo-pc';
    b.style.backgroundImage = `url(${pieceUrl(color, t)}), radial-gradient(circle, #fff 0%, #b0b0b0 100%)`;
    b.onclick = () => { promoEl.hidden = true; playMove(from, to, t); };
    promoEl.appendChild(b);
  }
  const cancel = document.createElement('button');
  cancel.className = 'cancel';
  cancel.textContent = '✕';
  cancel.onclick = () => { promoEl.hidden = true; selected = null; render(); };
  promoEl.appendChild(cancel);
  promoEl.hidden = false;
}

// ---------- playing the computer ----------
async function maybeComputerMove() {
  if (!vs || thinking || ply !== line.length - 1) return;
  const c = current();
  if (c.isGameOver() || c.turn() === vs.color) return;
  thinking = true;
  render();
  const started = performance.now();
  try {
    const L = LEVELS[vs.level];
    const r = await getEngine().analyse(c.fen(), L);
    // Don't reply instantly at low levels; it feels unnatural.
    const wait = 350 - (performance.now() - started);
    if (wait > 0) await new Promise((res) => setTimeout(res, wait));
    thinking = false;
    if (vs && r.best && ply === line.length - 1 && line[ply].fen === c.fen()) {
      playMove(r.best.slice(0, 2), r.best.slice(2, 4), r.best[4]);
      return;
    }
  } catch (err) {
    $('vs-status').textContent = 'Stockfish failed: ' + err.message;
  }
  thinking = false;
  render();
}

LEVELS.forEach((_, i) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = i + 1;
  b.dataset.l = i;
  if (i === level) b.className = 'on';
  $('levels').appendChild(b);
});
const chipGroup = (id, fn) => $(id).addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  $(id).querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  fn(b);
});
chipGroup('levels', (b) => { level = Number(b.dataset.l); });
let vsColor = 'w';
chipGroup('vs-color', (b) => { vsColor = b.dataset.c; });

$('vs-start').onclick = () => {
  const color = vsColor === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : vsColor;
  vs = { color, level };
  orientation = color;
  line = [{ fen: START }];
  ply = 0;
  liveFen = null;
  engine?.stopLive();
  $('vs-status').textContent = `Playing Stockfish level ${level + 1} as ${color === 'w' ? 'White' : 'Black'}. Switch to Analyse to stop and study the game.`;
  history.replaceState(null, '', location.pathname);
  render();
  maybeComputerMove();
};

function showTab(name) {
  $('tab-analyse').classList.toggle('on', name === 'analyse');
  $('tab-play').classList.toggle('on', name === 'play');
  $('pane-analyse').hidden = name !== 'analyse';
  $('pane-play').hidden = name !== 'play';
  if (name === 'analyse' && vs) { vs = null; thinking = false; liveFen = null; $('vs-status').textContent = ''; }
  render();
}
$('tab-analyse').onclick = () => showTab('analyse');
$('tab-play').onclick = () => showTab('play');

// ---------- buttons, keys, settings ----------
$('engine-on').onchange = () => { liveFen = null; render(); };
$('flip').onclick = () => { orientation = orientation === 'w' ? 'b' : 'w'; render(); };
$('undo').onclick = () => {
  if (ply === 0) return;
  // Against the computer, take back your move and its reply.
  const back = vs && ply >= 2 && current().turn() === vs.color ? 2 : 1;
  line = line.slice(0, ply - back + 1);
  ply = line.length - 1;
  render();
};
$('reset').onclick = () => { line = [{ fen: START }]; ply = 0; vs = null; history.replaceState(null, '', location.pathname); showTab('analyse'); };
$('nav-first').onclick = () => goTo(0);
$('nav-prev').onclick = () => goTo(ply - 1);
$('nav-next').onclick = () => goTo(ply + 1);
$('nav-last').onclick = () => goTo(line.length - 1);
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = { ArrowLeft: ply - 1, ArrowRight: ply + 1, Home: 0, ArrowUp: 0, End: line.length - 1, ArrowDown: line.length - 1 }[e.key];
  if (k !== undefined) { e.preventDefault(); goTo(k); }
});
$('load').onclick = () => { $('load-err').hidden = true; $('load-dialog').showModal(); };
$('load-dialog').addEventListener('close', () => {
  if ($('load-dialog').returnValue !== 'load') return;
  try {
    loadText($('load-text').value);
    vs = null;
    showTab('analyse');
  } catch (err) {
    $('load-err').textContent = 'Could not read that: ' + (err.message || 'invalid PGN or FEN');
    $('load-err').hidden = false;
    $('load-dialog').showModal();
  }
});
document.addEventListener('settings-change', () => render());

render();
