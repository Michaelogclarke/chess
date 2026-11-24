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

// Piece images come from the chosen set (see Settings; licences in README).
const pieceUrl = (color, type) => window.settings.pieceUrl(color, type);
// Preload so pieces never flash in late.
const preloadPieces = () => { for (const c of 'wb') for (const t of 'kqrbnp') new Image().src = pieceUrl(c, t); };
preloadPieces();
document.addEventListener('settings-change', (e) => {
  if (e.detail.key === 'pieces') preloadPieces();
  if (['pieces', 'blindfold'].includes(e.detail.key)) render();
});
const NAME = { w: 'White', b: 'Black' };
const $ = (id) => document.getElementById(id);

const boardEl = $('board');
const promoEl = $('promo');

let myColor = null; // 'w' | 'b' | null (spectator)
let coachOf = null; // set when watching as someone's coach
const coachToken = new URLSearchParams(location.search).get('coach');
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
window.initChallenges(socket);
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
socket.on('connect', () => socket.emit('join', { gameId, token, name: myName(), coachToken }));
let joinNotice = null;
socket.on('joined', ({ color, token: t, notice, coachOf: co }) => {
  myColor = color;
  coachOf = co || null;
  if (coachOf) setTimeout(shareShapes, 0);
  joinNotice = notice || null;
  if (t) { token = t; try { localStorage.setItem(tokenKey, t); } catch {} }
  render();
});
socket.on('recolor', (c) => { myColor = c; flipped = false; });
socket.on('coach-recolor', (c) => { coachOf = c; flipped = false; });
socket.on('shapes', ({ shapes: incoming }) => {
  coachShapes = incoming.map((x) => ({ ...x, mine: false }));
  renderShapes();
});
socket.on('coach:link', ({ token: ct }) => {
  $('coach-card').hidden = false;
  $('coach-link').value = location.origin + location.pathname + '?coach=' + encodeURIComponent(ct);
});
// Share drawings only when there's a coach on this side.
function shareShapes() {
  const coached = myColor && state?.players?.[myColor]?.coached;
  if (coachOf || coached) socket.emit('shapes', shapes);
}
socket.on('state', (s) => {
  const prevMoves = state ? state.moves.length : 0;
  state = s;
  receivedAt = performance.now();
  chess = new Chess(s.fen);
  if (s.status !== 'over') rematchDismissed = false;
  if (s.moves.length !== prevMoves) selected = null;
  const wasCoached = prevCoached;
  prevCoached = !!(myColor && s.players?.[myColor]?.coached);
  if (prevCoached && !wasCoached) setTimeout(shareShapes, 0);
  if (!prevCoached && !coachOf) coachShapes = [];
  const wasOver = prevStatus === 'over';
  prevStatus = s.status;
  syncPositions();
  if (s.status !== 'playing') premove = null;
  if (s.status === 'over' && !wasOver && prevMoves > 0) window.playSound('end');
  if (s.status === 'over' && !review) loadCachedReview();
  render();
  tryPremove();
  if (s.status === 'over' && !wasOver && prevMoves >= 0) maybeVictoryGif();
});
let prevStatus = null;
let prevCoached = false;

function syncPositions() {
  const key = state.moves.join(' ');
  if (key === positionsKey) return;
  // A new game (rematch) or a correction from the server: drop history view and review.
  if (!key.startsWith(positionsKey)) { viewPly = null; stopReview(); review = null; }
  const grew = state.moves.length > positions.length - 1 && positions.length > 0 && key.startsWith(positionsKey);
  positionsKey = key;
  positions = buildPositions(state.moves);
  if (grew && viewPly === null) {
    const san = state.moves.at(-1);
    window.playSound(/[+#]/.test(san) ? 'check' : san.includes('x') ? 'capture' : 'move');
  }
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
  const base = myColor || coachOf || 'w';
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
  const targets = new Set(!live || !selected ? []
    : myTurn() ? chess.moves({ square: selected, verbose: true }).map((m) => m.to)
    : premoveDests(selected));
  const kingInCheck = shown.inCheck()
    ? shown.board().flat().find((p) => p && p.type === 'k' && p.color === shown.turn())?.square
    : null;
  boardEl.classList.toggle('history', !live);
  boardEl.classList.toggle('blindfold', !!window.settings.get('blindfold'));

  const squares = squaresInOrder();
  boardEl.innerHTML = '';
  squares.forEach((sq, i) => {
    const el = document.createElement('div');
    const dark = ('abcdefgh'.indexOf(sq[0]) + Number(sq[1])) % 2 === 0;
    el.className = 'sq ' + (dark ? 'dark' : 'light');
    el.dataset.sq = sq;
    if (lastMove && (sq === lastMove.from || sq === lastMove.to)) el.classList.add('last');
    if (live && sq === selected) el.classList.add('sel');
    if (live && premove && (sq === premove.from || sq === premove.to)) el.classList.add('premove');
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
  renderShapes();
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
    if (coachOf) text = `Coaching ${state.players[coachOf]?.name} · ` + (state.turn === coachOf ? 'their move' : "opponent's move");
    else if (!myColor) text = 'Spectating · ' + text;
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
  const oppColor = myColor === 'w' ? 'b' : 'w';
  const coachNotice = myColor && state.players[oppColor]?.coached ? `${state.players[oppColor].name} has a coach watching.` : null;
  const notice = state.notRated || (joinNotice && joinNotice.startsWith('That coach') ? joinNotice : null)
    || (!myColor && !coachOf && state.status === 'waiting' ? joinNotice : null) || coachNotice;
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
  const dl = myColor && state.drawLimits?.[myColor];
  if (state.drawOffer === myColor) {
    $('draw').textContent = 'Cancel draw offer';
    $('draw').disabled = false;
    $('draw').title = '';
  } else {
    $('draw').textContent = dl && dl.waitMoves > 0 ? `Offer draw (in ${dl.waitMoves})` : 'Offer draw';
    $('draw').disabled = state.drawOffer === opp || !dl || dl.left <= 0 || dl.waitMoves > 0;
    $('draw').title = !dl ? '' : dl.left <= 0 ? 'No draw offers left this game'
      : dl.waitMoves > 0 ? `Your last offer was declined. You can offer again in ${dl.waitMoves} move${dl.waitMoves === 1 ? '' : 's'}.`
      : `${dl.left} draw offer${dl.left === 1 ? '' : 's'} left this game`;
  }
  $('rematch').hidden = !(state.status === 'over' && myColor);
  $('gif-btn').hidden = !(myColor && !state.archived && state.status !== 'waiting');
  $('coach-btn').hidden = !(myColor && !state.rated && !state.archived && state.status !== 'over') || !$('coach-card').hidden;
  if (state.players[myColor]?.coached) $('coach-btn').textContent = 'Coach connected ✓';
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

// ---------- input: click-to-move, drag-and-drop, premoves, drawings ----------
function squareAt(x, y) {
  const r = boardEl.getBoundingClientRect();
  const col = Math.floor(((x - r.left) / r.width) * 8);
  const row = Math.floor(((y - r.top) / r.height) * 8);
  if (col < 0 || col > 7 || row < 0 || row > 7) return null;
  return squaresInOrder()[row * 8 + col];
}

const ownPiece = (sq) => { const p = chess.get(sq); return p && p.color === myColor; };
const myTurn = () => state && state.turn === myColor;
const canInteract = () => state && state.status === 'playing' && myColor && viewPly === null && promoEl.hidden;
const premovesOn = () => !!window.settings.get('premoves');

// Where a piece could go on an open board. Premoves use this, because the
// position will have changed by the time the premove is played.
function premoveDests(sq) {
  const p = chess.get(sq);
  if (!p) return [];
  const F = 'abcdefgh', f = F.indexOf(sq[0]), r = Number(sq[1]) - 1, out = [];
  const add = (df, dr) => {
    const nf = f + df, nr = r + dr;
    if (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) out.push(F[nf] + (nr + 1));
  };
  const slide = (dirs) => dirs.forEach(([df, dr]) => { for (let k = 1; k < 8; k++) add(df * k, dr * k); });
  const ORTH = [[1, 0], [-1, 0], [0, 1], [0, -1]], DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  if (p.type === 'n') [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]].forEach(([a, b]) => add(a, b));
  if (p.type === 'b' || p.type === 'q') slide(DIAG);
  if (p.type === 'r' || p.type === 'q') slide(ORTH);
  if (p.type === 'k') {
    [...ORTH, ...DIAG].forEach(([a, b]) => add(a, b));
    if (f === 4 && r === (p.color === 'w' ? 0 : 7)) { add(2, 0); add(-2, 0); }
  }
  if (p.type === 'p') {
    const d = p.color === 'w' ? 1 : -1;
    add(0, d); add(-1, d); add(1, d);
    if (r === (p.color === 'w' ? 1 : 6)) add(0, 2 * d);
  }
  return out.filter((t) => !ownPiece(t));
}

let premove = null; // { from, to }
function setPremove(from, to) {
  if (!premoveDests(from).includes(to)) {
    selected = ownPiece(to) ? to : null;
    return render();
  }
  premove = { from, to };
  selected = null;
  render();
}
// Called whenever a new position arrives: play the queued premove if it's legal now.
function tryPremove() {
  if (!premove || !canInteract() || !myTurn()) return;
  const pm = premove;
  premove = null;
  const legal = chess.moves({ square: pm.from, verbose: true }).find((m) => m.to === pm.to);
  if (legal) sendMove(pm.from, pm.to, legal.promotion ? 'q' : undefined);
  else render();
}

// ---------- drawings: right-click a square for a circle, right-drag for an arrow ----------
// Shift = red, Alt/Ctrl = blue, Shift+Alt = yellow, otherwise green. Left-click clears.
let shapes = []; // { from, to?, brush }
let coachShapes = []; // drawings shared by a coach / coached player
let drawStart = null;
const brushFor = (e) => (e.shiftKey && (e.altKey || e.ctrlKey) ? 'yellow' : e.shiftKey ? 'red' : e.altKey || e.ctrlKey ? 'blue' : 'green');
function toggleShape(from, to, brush) {
  const same = (s) => s.from === from && (s.to || null) === (to || null);
  const existing = shapes.find(same);
  shapes = shapes.filter((s) => !same(s));
  if (!existing || existing.brush !== brush) shapes.push({ from, to: to || undefined, brush });
  shapesChanged();
}
function shapesChanged() {
  renderShapes();
  onShapesChanged?.(shapes);
}
let onShapesChanged = () => shareShapes();

function sqCenter(sq) {
  const f = 'abcdefgh'.indexOf(sq[0]), r = Number(sq[1]) - 1;
  return orientation() === 'w' ? [f + 0.5, 7 - r + 0.5] : [7 - f + 0.5, r + 0.5];
}
function arrowSvg(from, to, cls, width = 0.17) {
  const [x1, y1] = sqCenter(from), [x2, y2] = sqCenter(to);
  const len = Math.hypot(x2 - x1, y2 - y1), ux = (x2 - x1) / len, uy = (y2 - y1) / len;
  const head = 0.42, ex = x2 - ux * head, ey = y2 - uy * head, px = -uy, py = ux;
  return `<g class="${cls}"><line x1="${x1}" y1="${y1}" x2="${ex}" y2="${ey}" stroke-width="${width}" stroke-linecap="round"/>
    <polygon points="${x2},${y2} ${ex + px * 0.26},${ey + py * 0.26} ${ex - px * 0.26},${ey - py * 0.26}"/></g>`;
}
function circleSvg(sq, cls) {
  const [x, y] = sqCenter(sq);
  return `<circle class="${cls}" cx="${x}" cy="${y}" r="0.45" fill="none" stroke-width="0.07"/>`;
}
function renderShapes() {
  const svg = $('shapes');
  if (!svg) return;
  svg.innerHTML = [...shapes.map((s) => ({ ...s, mine: true })), ...coachShapes].map((s) => {
    const cls = `shape ${s.brush}${s.mine ? '' : ' shared'}`;
    return s.to ? arrowSvg(s.from, s.to, cls) : circleSvg(s.from, cls);
  }).join('');
}

boardEl.addEventListener('contextmenu', (e) => e.preventDefault());

let drag = null; // { from, ghost, moved, wasSelected }

boardEl.addEventListener('pointerdown', (e) => {
  if (e.button === 2) {
    drawStart = { sq: squareAt(e.clientX, e.clientY), brush: brushFor(e) };
    if (premove || selected) { premove = null; selected = null; render(); } // right-click cancels a premove
    return;
  }
  if (e.button !== 0) return;
  if (shapes.length) { shapes = []; shapesChanged(); }
  // Looking at an old position: touching the board jumps back to the game.
  if (viewPly !== null && state?.status === 'playing') { goTo(null); return; }
  if (!canInteract()) return;
  const sq = squareAt(e.clientX, e.clientY);
  if (!sq) return;
  const mine = myTurn();
  if (!mine && !premovesOn()) return;

  if (selected && sq !== selected && !ownPiece(sq)) {
    if (mine) tryMove(selected, sq); else setPremove(selected, sq);
    return;
  }
  if (!ownPiece(sq)) { selected = null; premove = null; render(); return; }

  e.preventDefault();
  const wasSelected = selected === sq;
  selected = sq;
  if (!mine) premove = null;
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
  if (moved && to && to !== from) return myTurn() ? tryMove(from, to) : setPremove(from, to);
  if (!moved && wasSelected) selected = null; // clicking a selected piece deselects it
  render();
}
boardEl.addEventListener('pointerup', (e) => {
  if (e.button === 2) {
    const to = squareAt(e.clientX, e.clientY);
    if (drawStart?.sq && to) toggleShape(drawStart.sq, to === drawStart.sq ? null : to, drawStart.brush);
    drawStart = null;
    return;
  }
  endDrag(e);
});
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
  $('open-analysis').href = '/analysis#moves=' + encodeURIComponent(state.moves.join(' '))
    + (orientation() === 'b' ? '&flip=1' : '');
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
        <td class="${sum[c].brilliant ? 'bril' : ''}">${sum[c].brilliant}</td><td>${sum[c].inaccuracy}</td><td>${sum[c].mistake}</td><td>${sum[c].blunder}</td>`;
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
    if (!g || !['brilliant', 'mistake', 'blunder', 'inaccuracy'].includes(g.label)) return '';
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

// ---------- GIF reactions ----------
const GIF_KEY = 'chess-gifs';
function loadGifs() {
  try { return { list: [], victory: null, ...JSON.parse(localStorage.getItem(GIF_KEY) || '{}') }; } catch { return { list: [], victory: null }; }
}
function saveGifs(g) { try { localStorage.setItem(GIF_KEY, JSON.stringify(g)); } catch {} }

// Turn a GIPHY page link into its image link; pass direct image links through.
function normalizeGif(raw) {
  let u;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  if (/(^|\.)giphy\.com$/.test(u.hostname) && !/^(media\d?|i)\./.test(u.hostname)) {
    const id = u.pathname.split('/').filter(Boolean).pop()?.split('-').pop();
    return id && /^[A-Za-z0-9]+$/.test(id) ? `https://media.giphy.com/media/${id}/giphy.gif` : null;
  }
  if (/^(media\d?\.giphy\.com|i\.giphy\.com|media\.tenor\.com|c\.tenor\.com)$/.test(u.hostname) && /\.(gif|webp)$/i.test(u.pathname)) {
    return u.origin + u.pathname;
  }
  return null;
}

function renderGifPanel() {
  const g = loadGifs();
  const grid = $('gif-grid');
  grid.innerHTML = '';
  for (const url of g.list) {
    const cell = document.createElement('div');
    cell.className = 'gif-cell';
    const img = document.createElement('img');
    img.src = url; img.alt = 'GIF'; img.loading = 'lazy';
    img.onclick = () => { socket.emit('gif', { url }); $('gif-panel').hidden = true; };
    const star = document.createElement('button');
    star.className = 'gif-star' + (g.victory === url ? ' on' : '');
    star.textContent = '★';
    star.title = g.victory === url ? 'Your victory GIF' : 'Make this your victory GIF';
    star.onclick = () => { const x = loadGifs(); x.victory = x.victory === url ? null : url; saveGifs(x); renderGifPanel(); };
    const del = document.createElement('button');
    del.className = 'gif-del';
    del.textContent = '✕';
    del.title = 'Remove';
    del.onclick = () => { const x = loadGifs(); x.list = x.list.filter((v) => v !== url); if (x.victory === url) x.victory = null; saveGifs(x); renderGifPanel(); };
    cell.append(img, star, del);
    grid.appendChild(cell);
  }
  $('gif-empty').hidden = g.list.length > 0;
}

$('gif-btn').onclick = () => { $('gif-panel').hidden = !$('gif-panel').hidden; if (!$('gif-panel').hidden) renderGifPanel(); };
$('gif-close').onclick = () => { $('gif-panel').hidden = true; };
$('gif-add').addEventListener('submit', (e) => {
  e.preventDefault();
  const url = normalizeGif($('gif-url').value);
  $('gif-err').hidden = !!url;
  if (!url) { $('gif-err').textContent = "That doesn't look like a GIPHY or Tenor GIF link."; return; }
  const g = loadGifs();
  if (!g.list.includes(url)) g.list.unshift(url);
  g.list = g.list.slice(0, 40);
  saveGifs(g);
  $('gif-url').value = '';
  renderGifPanel();
});

const gifTimers = {};
socket.on('gif', ({ color, url }) => {
  if (color !== myColor && !window.settings.get('gifs')) return;
  const where = color === orientation() ? 'bottom' : 'top';
  const el = $('gif-pop-' + where);
  el.innerHTML = '';
  const img = document.createElement('img');
  img.src = url; img.alt = 'GIF reaction';
  el.appendChild(img);
  el.hidden = false;
  clearTimeout(gifTimers[where]);
  gifTimers[where] = setTimeout(() => { el.hidden = true; el.innerHTML = ''; }, 5000);
});
socket.on('gif-error', (msg) => { $('gif-err').textContent = msg; $('gif-err').hidden = false; });

// Victory GIF: sent once when you win.
let victorySentFor = null;
function maybeVictoryGif() {
  if (!state || state.status !== 'over' || !myColor) return;
  const won = (state.result === '1-0' && myColor === 'w') || (state.result === '0-1' && myColor === 'b');
  const key = positionsKey + state.result;
  if (!won || victorySentFor === key || !state.moves.length) return;
  victorySentFor = key;
  const v = loadGifs().victory;
  if (v) socket.emit('gif', { url: v });
}

$('coach-btn').onclick = () => socket.emit('coach:invite');
$('coach-copy').onclick = async () => {
  try { await navigator.clipboard.writeText($('coach-link').value); } catch { $('coach-link').select(); document.execCommand('copy'); }
  $('coach-copy').textContent = 'Copied!';
  setTimeout(() => ($('coach-copy').textContent = 'Copy'), 1500);
};
