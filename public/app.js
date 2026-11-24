// Game page client. The server is the source of truth; this file draws the
// board, handles clicks/drags, and sends move requests.
import { Chess } from '/vendor/chess.js';
import {
  buildPositions, analysePositions, classifyMoves, summary, winPct, formatEval, LABELS,
} from '/review.js';

const gameId = location.pathname.split('/').pop();
const tokenKey = 'chess-token-' + gameId;

// The creator arrives with their seat token in the URL hash. Save it and strip
// it so they can't accidentally share their seat by copying the address bar.
let token = null;
const hashToken = new URLSearchParams(location.hash.slice(1)).get('t');
if (hashToken) {
  token = hashToken;
  try { localStorage.setItem(tokenKey, token); } catch {}
  history.replaceState(null, '', location.pathname);
} else {
  try { token = localStorage.getItem(tokenKey); } catch {}
}

// SVG piece set: "cburnett" by Colin M.L. Burnett (see README for licence).
const pieceUrl = (color, type) => `/pieces/${color}${type.toUpperCase()}.svg`;
// Preload so pieces never flash in late.
for (const c of 'wb') for (const t of 'kqrbnp') new Image().src = pieceUrl(c, t);
const NAME = { w: 'White', b: 'Black' };
const $ = (id) => document.getElementById(id);

const boardEl = $('board');
const promoEl = $('promo');

let myColor = null; // 'w' | 'b' | null (spectator)
let state = null;
let chess = new Chess();
let flipped = false;
let selected = null; // square like 'e2'
let receivedAt = 0;
let rematchDismissed = false;

// Move review: positions[i] is the board after i moves. viewPly null = live.
let positions = buildPositions([]);
let positionsKey = '';
let viewPly = null;
// Stockfish review: { evals, grades, done } once started.
let review = null;
let engine = null;
const REVIEW_DEPTH = 16;

// ---------- networking ----------
const socket = io();
// Nickname from the lobby; people arriving straight from a link get a random one.
function myName() {
  let n = null;
  try { n = localStorage.getItem('chess-name'); } catch {}
  if (!n) {
    const pick = (a) => a[Math.floor(Math.random() * a.length)];
    n = pick(['Swift', 'Clever', 'Bold', 'Quiet', 'Lucky', 'Brave', 'Sly', 'Calm'])
      + pick(['Knight', 'Bishop', 'Rook', 'Pawn', 'Queen', 'King']) + Math.floor(Math.random() * 90 + 10);
    try { localStorage.setItem('chess-name', n); } catch {}
  }
  return n;
}
socket.on('connect', () => socket.emit('join', { gameId, token, name: myName() }));
let joinNotice = null;
socket.on('joined', ({ color, token: t, notice }) => {
  myColor = color;
  joinNotice = notice || null;
  if (t) { token = t; try { localStorage.setItem(tokenKey, t); } catch {} }
  render();
});
socket.on('recolor', (c) => { myColor = c; flipped = false; });
socket.on('state', (s) => {
  const prevMoves = state ? state.moves.length : 0;
  state = s;
  receivedAt = performance.now();
  chess = new Chess(s.fen);
  if (s.status !== 'over') rematchDismissed = false;
  if (s.moves.length !== prevMoves) selected = null;
  syncPositions();
  if (s.status === 'over' && !review) loadCachedReview();
  render();
});

function syncPositions() {
  const key = state.moves.join(' ');
  if (key === positionsKey) return;
  // A new game (rematch) or a correction from the server: drop history view and review.
  if (!key.startsWith(positionsKey)) { viewPly = null; stopReview(); review = null; }
  positionsKey = key;
  positions = buildPositions(state.moves);
  if (viewPly !== null && viewPly >= positions.length - 1) viewPly = null;
}
socket.on('error-msg', (msg) => {
  $('status').textContent = msg;
  boardEl.innerHTML = '';
});
socket.on('disconnect', () => {
  if (state) $('status').textContent = 'Connection lost. Reconnecting…';
});

// ---------- board drawing ----------
const orientation = () => {
  const base = myColor || 'w';
  return flipped ? (base === 'w' ? 'b' : 'w') : base;
};

function squaresInOrder() {
  const files = 'abcdefgh', out = [];
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
    out.push(orientation() === 'w' ? files[f] + (8 - r) : files[7 - f] + (r + 1));
  }
  return out;
}

function canMove() {
  return state && state.status === 'playing' && myColor && state.turn === myColor;
}

const shownPly = () => (viewPly === null ? positions.length - 1 : viewPly);

function render() {
  if (!state) return;
  const live = viewPly === null;
  const shown = live ? chess : new Chess(positions[viewPly].fen);
  const lastMove = live ? state.lastMove : positions[viewPly].move;
  const targets = new Set(
    live && selected ? chess.moves({ square: selected, verbose: true }).map((m) => m.to) : []);
  const kingInCheck = shown.inCheck()
    ? shown.board().flat().find((p) => p && p.type === 'k' && p.color === shown.turn())?.square
    : null;
  boardEl.classList.toggle('history', !live);

  const squares = squaresInOrder();
  boardEl.innerHTML = '';
  squares.forEach((sq, i) => {
    const el = document.createElement('div');
    const dark = ('abcdefgh'.indexOf(sq[0]) + Number(sq[1])) % 2 === 0;
    el.className = 'sq ' + (dark ? 'dark' : 'light');
    el.dataset.sq = sq;
    if (lastMove && (sq === lastMove.from || sq === lastMove.to)) el.classList.add('last');
    if (live && sq === selected) el.classList.add('sel');
    if (sq === kingInCheck) el.classList.add('check');

    const piece = shown.get(sq);
    if (piece) {
      const p = document.createElement('span');
      p.className = 'pc';
      p.style.backgroundImage = `url(${pieceUrl(piece.color, piece.type)})`;
      el.appendChild(p);
    }
    if (targets.has(sq)) el.classList.add(piece ? 'capture' : 'target');

    // Coordinates on the edge squares.
    if (i % 8 === 0) el.insertAdjacentHTML('beforeend', `<span class="coord rank">${sq[1]}</span>`);
    if (i >= 56) el.insertAdjacentHTML('beforeend', `<span class="coord file">${sq[0]}</span>`);
    boardEl.appendChild(el);
  });

  renderPanel();
  renderClocks();
  renderReview();
}

function renderPanel() {
  const bottom = orientation(), top = bottom === 'w' ? 'b' : 'w';
  for (const [id, c] of [['top-player', top], ['bottom-player', bottom]]) {
    const el = $(id), p = state.players[c];
    const you = c === myColor ? ' (you)' : '';
    el.querySelector('.name').textContent = (p ? p.name : 'Waiting for opponent…') + you;
    el.querySelector('.rating').textContent = p?.rating ? fmtRating(p.rating) : '';
    const d = state.ratingDiff?.[c];
    const diffEl = el.querySelector('.diff');
    diffEl.textContent = d === undefined || d === null ? '' : (d > 0 ? '+' : '') + d;
    diffEl.className = 'diff ' + (d > 0 ? 'up' : d < 0 ? 'down' : '');
    el.querySelector('.color').textContent = NAME[c];
    el.querySelector('.dot').className = 'dot ' + (p ? (p.connected ? 'on' : 'off') : 'none');
    el.querySelector('.dot').title = p ? (p.connected ? 'Online' : 'Disconnected') : 'Not joined yet';
    el.classList.toggle('to-move', state.status === 'playing' && state.turn === c);
    el.querySelector('.clock').hidden = !state.clocks;
  }

  // Invite box while waiting.
  const waiting = state.status === 'waiting';
  $('invite').hidden = !(waiting && myColor);
  $('link').value = location.origin + location.pathname;

  // Status line.
  let text;
  if (state.status === 'waiting') {
    text = !myColor ? 'Waiting for players…'
      : state.isPublic ? 'Waiting for an opponent. Your game is listed in the lobby.'
      : 'Waiting for your opponent to join…';
  } else if (state.status === 'over') {
    const winner = state.result === '1-0' ? 'w' : state.result === '0-1' ? 'b' : null;
    const who = !winner ? 'Draw' : myColor ? (winner === myColor ? 'You won' : 'You lost') : state.players[winner].name + ' wins';
    text = `${who} by ${state.reason} (${state.result})`;
  } else {
    text = myColor ? (state.turn === myColor ? 'Your move' : "Opponent's move") : state.players[state.turn].name + ' to move';
    if (state.inCheck) text += ' — check!';
    const opp = myColor && state.players[myColor === 'w' ? 'b' : 'w'];
    if (opp && !opp.connected) text += ' · Opponent disconnected';
    if (!myColor) text = 'Spectating · ' + text;
  }
  $('status').textContent = text;
  $('status').classList.toggle('over', state.status === 'over');
  const CAT = { bullet: 'Bullet', blitz: 'Blitz', rapid: 'Rapid', classical: 'Classical', casual: 'Casual' };
  const tc = state.time ? `${state.time.initial / 60000}+${state.time.increment / 1000}` : 'No clock';
  const sub = document.createElement('span');
  sub.className = 'status-sub';
  sub.textContent = `${state.rated ? 'Rated' : 'Casual'} ${state.category === 'casual' ? '' : CAT[state.category] + ' '}· ${tc}`
    + (state.archived ? ' · Saved game' : '');
  $('status').append(sub);

  // Notices: why you're spectating, or why a rated game didn't count.
  const notice = state.notRated || (!myColor && state.status === 'waiting' ? joinNotice : null);
  $('notice').hidden = !notice;
  $('notice').textContent = notice || '';
  if (notice && joinNotice === notice && notice.startsWith('This is a rated game')) {
    const a = document.createElement('a');
    a.href = '/login?next=' + encodeURIComponent(location.pathname);
    a.className = 'btn primary small-btn';
    a.textContent = 'Log in';
    $('notice').append(' ', a);
  }

  // Draw / rematch offer from the opponent.
  const opp = myColor === 'w' ? 'b' : 'w';
  const offerEl = $('offer');
  if (myColor && state.status === 'playing' && state.drawOffer === opp) {
    offerEl.hidden = false; offerEl.dataset.kind = 'draw';
    $('offer-text').textContent = 'Your opponent offers a draw.';
  } else if (myColor && state.status === 'over' && state.rematchOffer === opp && !rematchDismissed) {
    offerEl.hidden = false; offerEl.dataset.kind = 'rematch';
    $('offer-text').textContent = 'Your opponent wants a rematch.';
  } else {
    offerEl.hidden = true;
  }

  // Buttons.
  const playing = state.status === 'playing' && !!myColor;
  $('draw').hidden = $('resign').hidden = !playing;
  $('draw').textContent = state.drawOffer === myColor ? 'Cancel draw offer' : 'Offer draw';
  $('draw').disabled = state.drawOffer === opp;
  $('rematch').hidden = !(state.status === 'over' && myColor);
  $('rematch').disabled = state.rematchOffer === myColor;
  $('rematch').textContent = state.rematchOffer === myColor ? 'Rematch requested…' : 'Rematch';

  renderMoveList();
}

function renderMoveList() {
  const moves = $('moves');
  const current = shownPly();
  const grades = review?.grades || [];
  moves.innerHTML = '';
  for (let i = 0; i < state.moves.length; i += 2) {
    const li = document.createElement('li');
    for (const ply of [i + 1, i + 2]) {
      const san = state.moves[ply - 1];
      if (!san) { li.appendChild(document.createElement('span')); continue; }
      const b = document.createElement('button');
      b.className = 'mv';
      b.dataset.ply = ply;
      const g = grades[ply];
      b.textContent = san + (g ? LABELS[g.label].symbol : '');
      if (g && g.label !== 'good') b.classList.add(g.label);
      if (ply === current && (viewPly !== null || review)) b.classList.add('current');
      li.appendChild(b);
    }
    moves.appendChild(li);
  }
  moves.parentElement.hidden = state.moves.length === 0;

  const cur = moves.querySelector('.current');
  if (cur) cur.scrollIntoView({ block: 'nearest' });
  else if (viewPly === null) moves.scrollTop = moves.scrollHeight;

  const total = positions.length - 1;
  $('nav-pos').textContent = viewPly === null ? (total ? `Move ${total}` : '') : `${viewPly} / ${total}`;
  $('nav-first').disabled = $('nav-prev').disabled = current === 0;
  $('nav-next').disabled = $('nav-last').disabled = viewPly === null;
  $('nav-live').hidden = !(viewPly !== null && state.status === 'playing');
  $('nav-live').classList.toggle('urgent', state.status === 'playing' && myColor === state.turn);
  $('nav-live').textContent = myColor === state.turn && state.status === 'playing'
    ? "It's your move — back to the game ▸" : 'Back to the game ▸';
}

function fmt(ms) {
  ms = Math.max(0, ms);
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), sec = s % 60;
  if (ms < 10000) return `${m}:${String(sec).padStart(2, '0')}.${Math.floor((ms % 1000) / 100)}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function renderClocks() {
  if (!state || !state.clocks) return;
  const bottom = orientation(), top = bottom === 'w' ? 'b' : 'w';
  const elapsed = performance.now() - receivedAt;
  for (const [id, c] of [['top-player', top], ['bottom-player', bottom]]) {
    const running = state.clockRunning === c;
    const ms = state.clocks[c] - (running ? elapsed : 0);
    const el = $(id).querySelector('.clock');
    el.textContent = fmt(ms);
    el.classList.toggle('running', running);
    el.classList.toggle('low', ms < 20000);
  }
}
setInterval(renderClocks, 100);

// ---------- input: click-to-move and drag-and-drop ----------
function squareAt(x, y) {
  const r = boardEl.getBoundingClientRect();
  const col = Math.floor(((x - r.left) / r.width) * 8);
  const row = Math.floor(((y - r.top) / r.height) * 8);
  if (col < 0 || col > 7 || row < 0 || row > 7) return null;
  return squaresInOrder()[row * 8 + col];
}

const ownPiece = (sq) => { const p = chess.get(sq); return p && p.color === myColor; };

let drag = null; // { from, ghost, moved, wasSelected }

boardEl.addEventListener('pointerdown', (e) => {
  // Looking at an old position: touching the board jumps back to the game.
  if (viewPly !== null && state?.status === 'playing') { goTo(null); return; }
  if (viewPly !== null || !canMove() || !promoEl.hidden) return;
  const sq = squareAt(e.clientX, e.clientY);
  if (!sq) return;

  if (selected && sq !== selected && !ownPiece(sq)) {
    tryMove(selected, sq);
    return;
  }
  if (!ownPiece(sq)) { selected = null; render(); return; }

  e.preventDefault();
  const wasSelected = selected === sq;
  selected = sq;
  render();

  const pieceEl = boardEl.querySelector(`[data-sq="${sq}"] .pc`);
  const ghost = pieceEl.cloneNode(true);
  ghost.classList.add('ghost');
  const size = pieceEl.getBoundingClientRect().width;
  ghost.style.width = ghost.style.height = size + 'px';
  document.body.appendChild(ghost);
  pieceEl.classList.add('lifted');
  drag = { from: sq, ghost, moved: false, wasSelected, x: e.clientX, y: e.clientY };
  moveGhost(e);
  boardEl.setPointerCapture(e.pointerId);
});

function moveGhost(e) {
  drag.ghost.style.left = e.clientX + 'px';
  drag.ghost.style.top = e.clientY + 'px';
}

boardEl.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4) drag.moved = true;
  moveGhost(e);
});

function endDrag(e) {
  if (!drag) return;
  const { from, ghost, moved, wasSelected } = drag;
  drag = null;
  ghost.remove();
  const to = e && squareAt(e.clientX, e.clientY);
  if (moved && to && to !== from) return tryMove(from, to);
  if (!moved && wasSelected) selected = null; // clicking a selected piece deselects it
  render();
}
boardEl.addEventListener('pointerup', endDrag);
boardEl.addEventListener('pointercancel', () => endDrag(null));

function tryMove(from, to) {
  const legal = chess.moves({ square: from, verbose: true }).filter((m) => m.to === to);
  if (!legal.length) {
    selected = ownPiece(to) ? to : null;
    return render();
  }
  if (legal.some((m) => m.promotion)) return askPromotion(from, to);
  sendMove(from, to);
}

function sendMove(from, to, promotion) {
  // Show the move straight away; the server's reply confirms or corrects it.
  try {
    const m = chess.move({ from, to, promotion });
    state = { ...state, moves: [...state.moves, m.san], lastMove: { from, to }, turn: chess.turn(), inCheck: chess.inCheck() };
    syncPositions();
  } catch {}
  selected = null;
  render();
  socket.emit('move', { from, to, promotion });
}

function askPromotion(from, to) {
  promoEl.innerHTML = '';
  for (const t of ['q', 'r', 'b', 'n']) {
    const b = document.createElement('button');
    b.className = 'promo-pc';
    b.style.backgroundImage = `url(${pieceUrl(myColor, t)}), radial-gradient(circle, #fff 0%, #b0b0b0 100%)`;
    b.setAttribute('aria-label', { q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight' }[t]);
    b.onclick = () => { promoEl.hidden = true; sendMove(from, to, t); };
    promoEl.appendChild(b);
  }
  const cancel = document.createElement('button');
  cancel.className = 'cancel';
  cancel.textContent = '✕';
  cancel.onclick = () => { promoEl.hidden = true; selected = null; render(); };
  promoEl.appendChild(cancel);
  promoEl.hidden = false;
}

// ---------- buttons ----------
$('flip').onclick = () => { flipped = !flipped; render(); };
$('resign').onclick = () => { if (confirm('Resign this game?')) socket.emit('resign'); };
$('draw').onclick = () => socket.emit('draw', state.drawOffer === myColor ? 'cancel' : 'offer');
$('rematch').onclick = () => socket.emit('rematch');
$('offer-yes').onclick = () =>
  $('offer').dataset.kind === 'draw' ? socket.emit('draw', 'accept') : socket.emit('rematch');
$('offer-no').onclick = () => {
  if ($('offer').dataset.kind === 'draw') socket.emit('draw', 'decline');
  else { rematchDismissed = true; render(); }
};
$('copy').onclick = async () => {
  try { await navigator.clipboard.writeText($('link').value); }
  catch { $('link').select(); document.execCommand('copy'); }
  $('copy').textContent = 'Copied!';
  setTimeout(() => ($('copy').textContent = 'Copy'), 1500);
};

// ---------- move navigation ----------
function goTo(ply) {
  const last = positions.length - 1;
  if (ply !== null) ply = Math.max(0, Math.min(last, ply));
  // Reaching the latest position means "live" again.
  viewPly = ply === null || ply >= last ? null : ply;
  selected = null;
  render();
}
$('nav-first').onclick = () => goTo(0);
$('nav-prev').onclick = () => goTo(shownPly() - 1);
$('nav-next').onclick = () => goTo(shownPly() + 1);
$('nav-last').onclick = () => goTo(null);
$('nav-live').onclick = () => goTo(null);
$('moves').addEventListener('click', (e) => {
  const b = e.target.closest('.mv');
  if (b) goTo(Number(b.dataset.ply));
});
document.addEventListener('keydown', (e) => {
  if (!state || e.target.closest('input, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  const keys = {
    ArrowLeft: () => goTo(shownPly() - 1),
    ArrowRight: () => goTo(shownPly() + 1),
    ArrowUp: () => goTo(0),
    Home: () => goTo(0),
    ArrowDown: () => goTo(null),
    End: () => goTo(null),
  };
  if (keys[e.key]) { e.preventDefault(); keys[e.key](); }
});

// ---------- Stockfish game review ----------
// Only offered once the game is over, so nobody can use the engine mid-game.
const reviewKey = () => `chess-review-${gameId}-${positionsKey}`;

function loadCachedReview() {
  try {
    const evals = JSON.parse(sessionStorage.getItem(reviewKey()) || 'null');
    if (evals && evals.length === positions.length) {
      review = { evals, grades: classifyMoves(positions, evals), done: true };
    }
  } catch {}
}

function stopReview() {
  if (engine) { engine.terminate(); engine = null; }
}

async function startReview() {
  if (review || state.status !== 'over') return;
  const key = positionsKey;
  review = { evals: [], grades: [null], done: false, progress: 0 };
  render();
  try {
    const { Engine } = await import('/engine.js');
    engine = new Engine();
    await engine.ready;
    const evals = await analysePositions(positions, engine, {
      depth: REVIEW_DEPTH,
      onProgress: (n, total, evs) => {
        if (positionsKey !== key) throw new Error('stale');
        review.evals = evs.slice();
        review.grades = classifyMoves(positions, review.evals);
        review.progress = n / total;
        render();
      },
    });
    review.done = true;
    try { sessionStorage.setItem(reviewKey(), JSON.stringify(evals)); } catch {}
  } catch (err) {
    if (positionsKey === key) review = { error: 'Could not run Stockfish in this browser: ' + err.message };
  } finally {
    stopReview();
    render();
  }
}
$('review-start').onclick = startReview;

function renderReview() {
  const over = state.status === 'over' && state.moves.length > 0;
  $('review').hidden = !over;
  const ply = shownPly();
  const ev = review?.evals?.[ply];
  renderEvalBar(over ? ev : null);
  renderArrow(over && review ? ev : null);
  if (!over) return;

  $('review-start').hidden = !!review;
  const running = review && !review.done && !review.error;
  $('review-progress').hidden = !running;
  if (running) {
    $('review-progress').querySelector('.bar').style.width = Math.round(review.progress * 100) + '%';
    $('review-progress').querySelector('span').textContent =
      `Stockfish is analysing… ${Math.round(review.progress * 100)}%`;
  }

  // Summary table.
  const table = $('review-summary');
  table.hidden = !review?.done;
  if (review?.done) {
    const sum = summary(positions, review.grades);
    const tbody = table.querySelector('tbody');
    tbody.innerHTML = '';
    for (const c of ['w', 'b']) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<th><span class="swatch ${c}"></span><span class="nm"></span></th>
        <td class="acc">${sum[c].accuracy ?? '–'}${sum[c].accuracy !== null ? '%' : ''}</td>
        <td>${sum[c].inaccuracy}</td><td>${sum[c].mistake}</td><td>${sum[c].blunder}</td>`;
      tr.querySelector('.nm').textContent = state.players[c]?.name || NAME[c];
      tbody.appendChild(tr);
    }
  }

  // Graph.
  $('graph').hidden = !review?.evals?.length;
  if (review?.evals?.length) renderGraph();

  // Comment on the move that led to the shown position.
  const comment = $('comment');
  const g = review?.grades?.[ply];
  if (review?.error) {
    comment.hidden = false; comment.className = 'comment error'; comment.textContent = review.error;
  } else if (g && ply > 0) {
    const mv = positions[ply].move;
    const num = Math.ceil(ply / 2) + (mv.color === 'w' ? '.' : '…');
    comment.hidden = false;
    comment.className = 'comment ' + g.label;
    comment.textContent = '';
    const strong = document.createElement('strong');
    strong.textContent = `${num} ${mv.san}${LABELS[g.label].symbol}`;
    comment.append(strong, ` ${LABELS[g.label].name}. `);
    if (g.bestSan) comment.append(`Best was ${g.bestSan}. `);
    comment.append(`Eval ${formatEval(ev)}`);
  } else if (review?.done && ply === 0) {
    comment.hidden = false; comment.className = 'comment';
    comment.textContent = 'Use ◀ ▶ or the arrow keys to step through the moves. Click the graph to jump.';
  } else {
    comment.hidden = true;
  }
}

function renderEvalBar(ev) {
  const bar = $('evalbar');
  bar.hidden = !review;
  if (!review) return;
  const white = ev ? winPct(ev.score) : 50;
  const fill = bar.querySelector('.evalfill');
  // Fill shows White's share; it grows from White's side of the board.
  fill.style.height = white + '%';
  bar.classList.toggle('flipped', orientation() === 'b');
  const text = bar.querySelector('.evaltext');
  text.textContent = ev ? formatEval(ev).replace(/^\+/, '') : '';
  text.classList.toggle('on-white', white >= 50);
}

function renderArrow(ev) {
  const svg = $('arrows');
  svg.innerHTML = '';
  if (!ev?.best) return;
  const files = 'abcdefgh';
  const xy = (sq) => {
    const f = files.indexOf(sq[0]), r = Number(sq[1]) - 1;
    return orientation() === 'w' ? [f + 0.5, 7 - r + 0.5] : [7 - f + 0.5, r + 0.5];
  };
  const [x1, y1] = xy(ev.best.slice(0, 2)), [x2, y2] = xy(ev.best.slice(2, 4));
  const len = Math.hypot(x2 - x1, y2 - y1), ux = (x2 - x1) / len, uy = (y2 - y1) / len;
  const head = 0.42, ex = x2 - ux * head, ey = y2 - uy * head; // shaft stops where the head starts
  const px = -uy, py = ux; // perpendicular
  svg.innerHTML = `
    <line x1="${x1}" y1="${y1}" x2="${ex}" y2="${ey}" class="arrow-shaft"/>
    <polygon class="arrow-head" points="${x2},${y2} ${ex + px * 0.26},${ey + py * 0.26} ${ex - px * 0.26},${ey - py * 0.26}"/>
    <title>Stockfish's best move</title>`;
}

// Evaluation graph: White's winning chances over the game. Area below the line
// is White's share, above is Black's. Hover for details, click to jump.
function renderGraph() {
  const el = $('graph');
  const W = el.clientWidth || 280, H = 90;
  const n = positions.length - 1 || 1;
  const x = (i) => (i / n) * W;
  const y = (ev) => H - (winPct(ev.score) / 100) * H;
  const pts = review.evals.map((ev, i) => [x(i), y(ev)]);
  const line = pts.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join(' ');
  const area = `0,${H} ${line} ${pts.at(-1)[0].toFixed(1)},${H}`;
  const marks = review.grades.map((g, i) => {
    if (!g || !['mistake', 'blunder', 'inaccuracy'].includes(g.label)) return '';
    return `<circle class="gm ${g.label}" cx="${x(i)}" cy="${y(review.evals[i])}" r="4"/>`;
  }).join('');
  const cur = shownPly();
  el.innerHTML = `
    <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Evaluation graph">
      <rect class="g-black" width="${W}" height="${H}"/>
      <polygon class="g-white" points="${area}"/>
      <line class="g-mid" x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}"/>
      <polyline class="g-line" points="${line}"/>
      ${marks}
      <line class="g-cur" x1="${x(cur)}" x2="${x(cur)}" y1="0" y2="${H}"/>
      <line class="g-hover" x1="0" x2="0" y1="0" y2="${H}" visibility="hidden"/>
    </svg>
    <div class="g-tip" hidden></div>`;

  const svg = el.querySelector('svg'), tip = el.querySelector('.g-tip'), hl = el.querySelector('.g-hover');
  const plyAt = (e) => {
    const r = svg.getBoundingClientRect();
    return Math.max(0, Math.min(review.evals.length - 1, Math.round(((e.clientX - r.left) / r.width) * n)));
  };
  svg.onpointermove = (e) => {
    const i = plyAt(e);
    hl.setAttribute('x1', x(i)); hl.setAttribute('x2', x(i)); hl.setAttribute('visibility', 'visible');
    const mv = positions[i].move;
    const g = review.grades[i];
    tip.hidden = false;
    tip.textContent = (mv ? `${Math.ceil(i / 2)}${mv.color === 'w' ? '.' : '…'} ${mv.san}${g ? LABELS[g.label].symbol : ''}  ` : 'Start  ')
      + formatEval(review.evals[i]);
    tip.style.left = Math.min(Math.max(x(i), 40), W - 40) + 'px';
  };
  svg.onpointerleave = () => { tip.hidden = true; hl.setAttribute('visibility', 'hidden'); };
  svg.onclick = (e) => goTo(plyAt(e));
}
window.addEventListener('resize', () => { if (review?.evals?.length && !$('graph').hidden) renderGraph(); });
