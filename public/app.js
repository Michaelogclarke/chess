// Game page client. The server is the source of truth; this file draws the
// board, handles clicks/drags, and sends move requests.
import { Chess } from '/vendor/chess.js';

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
socket.on('joined', ({ color, token: t }) => {
  myColor = color;
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
  render();
});
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

function render() {
  if (!state) return;
  const targets = new Set(
    selected ? chess.moves({ square: selected, verbose: true }).map((m) => m.to) : []);
  const kingInCheck = state.inCheck
    ? chess.board().flat().find((p) => p && p.type === 'k' && p.color === state.turn)?.square
    : null;

  const squares = squaresInOrder();
  boardEl.innerHTML = '';
  squares.forEach((sq, i) => {
    const el = document.createElement('div');
    const dark = ('abcdefgh'.indexOf(sq[0]) + Number(sq[1])) % 2 === 0;
    el.className = 'sq ' + (dark ? 'dark' : 'light');
    el.dataset.sq = sq;
    if (state.lastMove && (sq === state.lastMove.from || sq === state.lastMove.to)) el.classList.add('last');
    if (sq === selected) el.classList.add('sel');
    if (sq === kingInCheck) el.classList.add('check');

    const piece = chess.get(sq);
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
}

function renderPanel() {
  const bottom = orientation(), top = bottom === 'w' ? 'b' : 'w';
  for (const [id, c] of [['top-player', top], ['bottom-player', bottom]]) {
    const el = $(id), p = state.players[c];
    const you = c === myColor ? ' (you)' : '';
    el.querySelector('.name').textContent = (p ? p.name : 'Waiting for opponent…') + you;
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

  // Move list.
  const moves = $('moves');
  moves.innerHTML = '';
  for (let i = 0; i < state.moves.length; i += 2) {
    const li = document.createElement('li');
    li.innerHTML = `<span>${state.moves[i]}</span><span>${state.moves[i + 1] || ''}</span>`;
    moves.appendChild(li);
  }
  moves.parentElement.hidden = state.moves.length === 0;
  moves.scrollTop = moves.scrollHeight;
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
  if (!canMove() || !promoEl.hidden) return;
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
    chess.move({ from, to, promotion });
    state = { ...state, lastMove: { from, to }, turn: chess.turn(), inCheck: chess.inCheck() };
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
