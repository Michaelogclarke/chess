// Online chess server: Express serves the client, Socket.IO syncs games.
// Every move is validated here with chess.js, so clients can't cheat by
// editing their browser. Games in progress live in memory; finished games,
// accounts and ratings are saved to Postgres when DATABASE_URL is set.

const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { Chess } = require('chess.js');
const db = require('./db');
const auth = require('./auth');
const store = require('./store');
const variants = require('./variants');

const PORT = process.env.PORT || 3000;
const GAME_TTL_MS = 24 * 60 * 60 * 1000; // forget games idle for a day

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // Only accept live connections from our own pages, so other sites can't
  // open a socket using a player's login cookie.
  allowRequest: (req, cb) => {
    const origin = req.headers.origin;
    try { cb(null, !origin || new URL(origin).host === req.headers.host); } catch { cb(null, false); }
  },
});

app.set('trust proxy', 1); // Render sits behind a proxy; needed for secure cookies and req.ip
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));
// Serve chess.js to the browser so the client can show legal-move hints.
app.get('/vendor/chess.js', (req, res) =>
  res.sendFile(require.resolve('chess.js/dist/esm/chess.js')));
// Stockfish (WASM build, single-threaded "lite") for after-game review. It runs
// in the player's browser, so analysis costs the server nothing.
const STOCKFISH_FILES = new Set(['stockfish-19-lite-single.js', 'stockfish-19-lite-single.wasm']);
const stockfishDir = path.join(path.dirname(require.resolve('stockfish/package.json')), 'bin');
app.get('/vendor/stockfish/:file', (req, res, next) => {
  if (!STOCKFISH_FILES.has(req.params.file)) return next();
  res.set('Cache-Control', 'public, max-age=604800');
  res.sendFile(path.join(stockfishDir, req.params.file));
});

auth.routes(app);

/** @type {Map<string, any>} */
const games = new Map();

const randomId = (bytes) => crypto.randomBytes(bytes).toString('base64url');
const other = (c) => (c === 'w' ? 'b' : 'w');

// Nicknames: no accounts, just a display name the browser remembers.
function cleanName(name) {
  const n = String(name || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
  return n || 'Anonymous';
}

function newGame({ color, minutes, increment, isPublic, name, user, rated, variant }) {
  const id = randomId(6);
  variant = variants.VARIANTS[variant] ? variant : 'standard';
  const timed = minutes > 0;
  const time = timed ? { initial: minutes * 60000, increment: increment * 1000 } : null;
  const game = {
    id,
    round: 0, // bumps on each rematch; each round is saved as its own game
    variant,
    chess: variants.newBoard(variant),
    hq: variant === 'hiddenqueen' ? variants.freshHiddenQueen() : null,
    seats: { w: null, b: null }, // { token, name, userId, rating, sockets:Set }
    isPublic, // listed in the open games lobby while waiting for an opponent
    rated: !!(rated && user && timed && variant === 'standard'), // variants are casual for now
    category: store.categoryFor(time),
    ratingDiff: null,
    notRated: null, // why a rated game didn't count, e.g. too short
    createdAt: Date.now(),
    time,
    clocks: timed ? { w: minutes * 60000, b: minutes * 60000 } : null,
    turnStartedAt: null, // when the side to move's clock started running
    timer: null,
    status: 'waiting', // waiting | playing | over
    result: null, // '1-0' | '0-1' | '1/2-1/2'
    reason: null,
    lastMove: null,
    drawOffer: null, // color that offered
    ...freshDrawLimits(),
    rematchOffer: null, // color that offered
    touchedAt: Date.now(),
  };
  const creatorColor = color === 'w' || color === 'b' ? color : Math.random() < 0.5 ? 'w' : 'b';
  const token = randomId(18);
  game.seats[creatorColor] = newSeat(token, user, name);
  if (variant !== 'standard') game.snaps = [variants.snapshot(game)];
  games.set(id, game);
  return { game, token, color: creatorColor };
}

// Draw offers: at most DRAW_MAX per player per game, and after one is
// declined that player waits DRAW_COOLDOWN_PLIES half-moves to offer again.
const DRAW_MAX = 3;
const DRAW_COOLDOWN_PLIES = 20; // 10 moves each
function freshDrawLimits() {
  return { drawOffersMade: { w: 0, b: 0 }, drawBlockedUntil: { w: 0, b: 0 } };
}
function drawStatus(game, c) {
  const plies = game.chess.history().length;
  const left = DRAW_MAX - game.drawOffersMade[c];
  const wait = Math.max(0, game.drawBlockedUntil[c] - plies);
  return { left, waitMoves: Math.ceil(wait / 2) };
}
function declineDraw(game) {
  const c = game.drawOffer;
  if (!c) return;
  game.drawBlockedUntil[c] = game.chess.history().length + DRAW_COOLDOWN_PLIES;
  game.drawOffer = null;
}

// GIFs are shown to other players, so only accept direct image links from
// well-known GIF hosts (no arbitrary sites, no tracking pages, no scripts).
const GIF_HOSTS = /^(media\d?\.giphy\.com|i\.giphy\.com|media\.tenor\.com|c\.tenor\.com)$/;
function isAllowedGif(url) {
  if (typeof url !== 'string' || url.length > 500) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && GIF_HOSTS.test(u.hostname) && /\.(gif|webp)$/i.test(u.pathname);
  } catch { return false; }
}

function newSeat(token, user, name) {
  return {
    token,
    name: user ? user.username : cleanName(name),
    userId: user ? user.id : null,
    rating: null, // filled in by loadSeatRating
    sockets: new Set(),
    teamId: randomId(9), // socket room shared with this player's coach (follows the player on rematch)
    coachToken: null,
    coachSockets: new Set(),
  };
}

async function loadSeatRating(game, seat) {
  if (!seat?.userId) return;
  try { seat.rating = await store.getRating(seat.userId, game.category); } catch (err) { console.error(err); }
}

const dbId = (game) => `${game.id}.${game.round}`;

// Clock running = timed game, in progress, and white has made a first move.
function clockRunning(game) {
  return game.time && game.status === 'playing' && game.chess.history().length > 0;
}

function currentClocks(game) {
  if (!game.clocks) return null;
  const clocks = { ...game.clocks };
  if (clockRunning(game)) {
    const turn = game.chess.turn();
    clocks[turn] = Math.max(0, clocks[turn] - (Date.now() - game.turnStartedAt));
  }
  return clocks;
}

function publicState(game) {
  const { chess } = game;
  return {
    id: game.id,
    fen: chess.fen(),
    moves: chess.history(),
    lastMove: game.lastMove,
    turn: chess.turn(),
    inCheck: chess.inCheck(),
    status: game.status,
    result: game.result,
    reason: game.reason,
    players: { w: seatInfo(game, 'w'), b: seatInfo(game, 'b') },
    rated: game.rated,
    category: game.category,
    variant: game.variant || 'standard',
    variantName: variants.VARIANTS[game.variant || 'standard'],
    reviewable: !game.variant || game.variant === 'standard' || game.variant === 'hiddenqueen',
    ratingDiff: game.ratingDiff,
    notRated: game.notRated,
    archived: !!game.archived,
    savedId: game.savedId || null,
    time: game.time,
    clocks: currentClocks(game),
    clockRunning: clockRunning(game) ? chess.turn() : null,
    isPublic: game.isPublic,
    drawOffer: game.drawOffer,
    drawLimits: game.drawOffersMade ? { w: drawStatus(game, 'w'), b: drawStatus(game, 'b') } : null,
    rematchOffer: game.rematchOffer,
  };
}

function viewerOf(game, sid) {
  return ['w', 'b'].find((c) => game.seats[c]?.sockets.has(sid) || game.seats[c]?.coachSockets?.has(sid)) || null;
}
function stateFor(game, sid) {
  const base = publicState(game);
  return game.snaps ? { ...base, ...variants.viewFor(game, viewerOf(game, sid)) } : base;
}

function seatInfo(game, c) {
  const s = game.seats[c];
  if (!s) return null;
  return {
    name: s.name,
    account: !!s.userId,
    rating: s.rating,
    coached: !!s.coachSockets?.size,
    connected: game.archived ? true : s.sockets.size > 0,
  };
}

function broadcast(game) {
  game.touchedAt = Date.now();
  if (!game.snaps) {
    io.to(game.id).emit('state', publicState(game));
  } else {
    // Variants hide different things from each player, so each gets their own view.
    const base = publicState(game);
    for (const sid of io.sockets.adapter.rooms.get(game.id) || []) {
      io.to(sid).emit('state', { ...base, ...variants.viewFor(game, viewerOf(game, sid)) });
    }
  }
  lobbyChanged();
}

// ---------- open games lobby ----------
// A public game is listed while it's waiting for an opponent and its creator
// still has the game page open, so abandoned games drop off by themselves.
function openGames() {
  const list = [];
  for (const g of games.values()) {
    if (!g.isPublic || g.status !== 'waiting') continue;
    const color = g.seats.w ? 'w' : 'b';
    const seat = g.seats[color];
    if (seat.sockets.size === 0) continue;
    list.push({
      id: g.id, name: seat.name, color, time: g.time, createdAt: g.createdAt,
      rated: g.rated, rating: seat.rating, account: !!seat.userId,
      variant: g.variant, variantName: variants.VARIANTS[g.variant],
    });
  }
  return list.sort((a, b) => b.createdAt - a.createdAt);
}

let lobbyQueued = false;
function lobbyChanged() {
  // Batch bursts of changes into one update.
  if (lobbyQueued) return;
  lobbyQueued = true;
  setImmediate(() => {
    lobbyQueued = false;
    io.to('lobby').emit('lobby', lobbyPayload());
  });
}

function lobbyPayload() {
  return { games: openGames(), playing: countPlaying(), online: onlineList() };
}

// ---------- presence and direct challenges ----------
// One entry per person (account, or browser for guests), however many tabs.
const presence = new Map(); // key -> { key, name, userId, sockets:Set }
const challenges = new Map(); // id -> { id, from, to, minutes, increment, color, rated, timer }

function isBusy(entry) {
  for (const sid of entry.sockets) {
    const gid = io.sockets.sockets.get(sid)?.data.gameId;
    const g = gid && games.get(gid);
    if (g && g.status === 'playing' && ['w', 'b'].some((c) => g.seats[c]?.sockets.has(sid))) return true;
  }
  return false;
}

function onlineList() {
  return [...presence.values()].map((p) => ({
    key: p.key, name: p.name, account: !!p.userId, rating: p.rating || null, busy: isBusy(p),
  })).sort((a, b) => a.name.localeCompare(b.name));
}

const challengeView = (ch) => ({
  id: ch.id, from: ch.fromName, to: ch.toName, minutes: ch.minutes, increment: ch.increment,
  color: ch.color, rated: ch.rated, variant: ch.variant, variantName: variants.VARIANTS[ch.variant],
});

const emitTo = (entry, event, data) => { for (const sid of entry.sockets) io.to(sid).emit(event, data); };

function endChallenge(id) {
  const ch = challenges.get(id);
  if (!ch) return null;
  clearTimeout(ch.timer);
  challenges.delete(id);
  return ch;
}

function countPlaying() {
  let n = 0;
  for (const g of games.values()) if (g.status === 'playing') n++;
  return n;
}

function endGame(game, result, reason) {
  clearTimeout(game.timer);
  game.timer = null;
  if (game.clocks) game.clocks = currentClocks(game);
  game.status = 'over';
  game.result = result;
  game.reason = reason;
  game.drawOffer = null;
  persistGame(game);
}

// Save a finished game and apply rating changes. Games where neither player
// has an account aren't saved: there's nowhere to list them.
async function persistGame(game) {
  if (!db.enabled || game.archived || (game.variant && game.variant !== 'standard')) return;
  const round = game.round;
  const moves = game.chess.history();
  const { w, b } = game.seats;
  if (moves.length < 2) {
    if (game.rated) game.notRated = 'Game ended before both players moved, so it was not rated.';
    return;
  }
  if (!w.userId && !b.userId) return;
  const rec = {
    id: dbId(game), rated: game.rated, category: game.category, time: game.time, moves,
    result: game.result, reason: game.reason,
    whiteId: w.userId, blackId: b.userId, whiteName: w.name, blackName: b.name,
  };
  try {
    const diff = await store.saveGame(rec);
    if (game.round !== round) return; // a rematch already started
    game.ratingDiff = diff;
    game.savedId = rec.id;
    await Promise.all([loadSeatRating(game, w), loadSeatRating(game, b)]);
    broadcast(game);
  } catch (err) {
    console.error('Failed to save game', rec.id, err);
  }
}

function onlyKing(chess, color) {
  return chess.board().flat().every((sq) => !sq || sq.color !== color || sq.type === 'k');
}

function scheduleFlag(game) {
  clearTimeout(game.timer);
  game.timer = null;
  if (!clockRunning(game)) return;
  const turn = game.chess.turn();
  const remaining = currentClocks(game)[turn];
  game.timer = setTimeout(() => {
    if (game.status !== 'playing' || game.chess.turn() !== turn) return;
    if (currentClocks(game)[turn] > 0) return scheduleFlag(game);
    // Flagging loses, unless the opponent can't possibly mate.
    if (onlyKing(game.chess, other(turn))) endGame(game, '1/2-1/2', 'timeout vs insufficient material');
    else endGame(game, turn === 'w' ? '0-1' : '1-0', 'timeout');
    game.clocks[turn] = 0;
    broadcast(game);
  }, remaining + 50);
}

function checkGameOver(game) {
  const { chess } = game;
  if (game.variant === 'fog') {
    if (chess.kingCaptured) endGame(game, chess.kingCaptured === 'w' ? '0-1' : '1-0', 'king capture');
    else if (!chess.pseudoMoves(chess.turn()).length) endGame(game, '1/2-1/2', 'no moves left');
    return;
  }
  if (chess.isCheckmate()) endGame(game, chess.turn() === 'w' ? '0-1' : '1-0', 'checkmate');
  else if (chess.isStalemate()) endGame(game, '1/2-1/2', 'stalemate');
  else if (chess.isInsufficientMaterial()) endGame(game, '1/2-1/2', 'insufficient material');
  else if (chess.isThreefoldRepetition()) endGame(game, '1/2-1/2', 'threefold repetition');
  else if (chess.isDrawByFiftyMoves()) endGame(game, '1/2-1/2', '50-move rule');
}

app.post('/api/games', async (req, res, next) => {
  try {
    const minutes = Math.min(180, Math.max(0, Number(req.body.minutes) || 0));
    const increment = Math.min(60, Math.max(0, Number(req.body.increment) || 0));
    if (req.body.rated && !req.user) return res.status(401).json({ error: 'Log in to play rated games.' });
    if (req.body.rated && minutes === 0) return res.status(400).json({ error: 'Rated games need a clock.' });
    const { game, token, color } = newGame({
      color: req.body.color, minutes, increment, isPublic: !!req.body.isPublic, name: req.body.name,
      user: req.user, rated: !!req.body.rated, variant: req.body.variant,
    });
    await loadSeatRating(game, game.seats[color]);
    res.json({ id: game.id, token, color });
  } catch (err) { next(err); }
});

app.get('/api/me', async (req, res, next) => {
  try {
    if (!req.user) return res.json({ accounts: db.enabled, user: null });
    res.json({ accounts: true, user: { username: req.user.username, ratings: await store.getRatings(req.user.id) } });
  } catch (err) { next(err); }
});

app.get('/api/leaderboard', async (req, res, next) => {
  try {
    if (!db.enabled) return res.status(503).json({ error: 'No database configured.' });
    const category = store.CATEGORIES.includes(req.query.category) ? req.query.category : 'blitz';
    res.json({ category, players: await store.leaderboard(category) });
  } catch (err) { next(err); }
});

app.get('/api/users/:username', async (req, res, next) => {
  try {
    if (!db.enabled) return res.status(503).json({ error: 'No database configured.' });
    const p = await store.profile(req.params.username);
    if (!p) return res.status(404).json({ error: 'No player with that name.' });
    res.json(p);
  } catch (err) { next(err); }
});

const page = (file) => (req, res) => res.sendFile(path.join(__dirname, 'public', file));
app.get('/g/:id', page('game.html'));
app.get('/login', page('login.html'));
app.get('/leaderboard', page('leaderboard.html'));
app.get('/u/:username', page('profile.html'));
app.get('/analysis', page('analysis.html'));

app.use('/api', (err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

// Finished games saved in the database open read-only, ready for review.
const archiveLoads = new Map();
function loadArchived(id) {
  if (!archiveLoads.has(id)) {
    archiveLoads.set(id, (async () => {
      const g = await store.loadGame(id);
      if (!g) return null;
      const chess = new Chess();
      for (const san of g.moves ? g.moves.split(' ') : []) chess.move(san);
      const last = chess.history({ verbose: true }).at(-1);
      const seat = (name, userId, rating, diff) => ({
        token: null, name, userId, sockets: new Set(),
        rating: rating !== null && rating !== undefined ? { rating: rating + (diff || 0), provisional: false } : null,
      });
      const game = {
        id, archived: true, round: 0, chess, isPublic: false,
        seats: {
          w: seat(g.white_name, g.white_id, g.white_rating, g.white_diff),
          b: seat(g.black_name, g.black_id, g.black_rating, g.black_diff),
        },
        rated: g.rated, category: g.category,
        ratingDiff: g.rated ? { w: g.white_diff, b: g.black_diff } : null, notRated: null,
        time: g.time_initial !== null ? { initial: g.time_initial, increment: g.time_increment } : null,
        clocks: null, timer: null, turnStartedAt: null,
        status: 'over', result: g.result, reason: g.reason,
        lastMove: last ? { from: last.from, to: last.to } : null,
        drawOffer: null, rematchOffer: null, createdAt: Date.now(), touchedAt: Date.now(), savedId: id,
      };
      games.set(id, game);
      return game;
    })().finally(() => setTimeout(() => archiveLoads.delete(id), 1000)));
  }
  return archiveLoads.get(id);
}

// Attach the logged-in user to each live connection.
io.use(async (socket, next) => {
  try { socket.data.user = await auth.userFromCookieHeader(socket.handshake.headers.cookie); } catch (err) { console.error(err); }
  next();
});

io.on('connection', (socket) => {
  let game = null;
  let color = null; // 'w' | 'b' | null (spectator); refreshed from seats on each event

  // Colours swap on rematch, so always look up this socket's seat.
  const isPlayer = () => {
    color = game ? ['w', 'b'].find((c) => game.seats[c]?.sockets.has(socket.id)) || null : null;
    return !!color;
  };

  // Presence: every page with a live connection says hello.
  socket.on('hello', async ({ clientId, name } = {}) => {
    if (socket.data.presenceKey) return;
    const user = socket.data.user;
    const key = user ? 'u:' + user.id : 'g:' + String(clientId || socket.id).slice(0, 40);
    let entry = presence.get(key);
    if (!entry) {
      entry = { key, name: user ? user.username : cleanName(name), userId: user?.id || null, sockets: new Set() };
      presence.set(key, entry);
      if (user) {
        try {
          const blitz = await store.getRating(user.id, 'blitz');
          if (blitz?.games) entry.rating = blitz;
        } catch (err) { console.error(err); }
      }
    } else if (!user && name) {
      entry.name = cleanName(name);
    }
    entry.sockets.add(socket.id);
    socket.data.presenceKey = key;
    socket.emit('hello-ok', { key });
    // Re-deliver challenges still waiting for this person.
    for (const ch of challenges.values()) if (ch.to === key) socket.emit('challenge:incoming', challengeView(ch));
    lobbyChanged();
  });

  const me = () => presence.get(socket.data.presenceKey);

  socket.on('challenge:send', ({ to, minutes, increment, color, rated, variant } = {}) => {
    const from = me();
    const target = presence.get(to);
    if (!from || !target || from === target) return socket.emit('challenge:error', 'That player is no longer online.');
    if ([...challenges.values()].some((c) => c.from === from.key)) {
      return socket.emit('challenge:error', 'You already have a challenge waiting. Cancel it first.');
    }
    minutes = Math.min(180, Math.max(0, Number(minutes) || 0));
    increment = Math.min(60, Math.max(0, Number(increment) || 0));
    rated = !!rated;
    if (rated && (!from.userId || !target.userId)) return socket.emit('challenge:error', 'Rated games need both players to have an account.');
    if (rated && minutes === 0) return socket.emit('challenge:error', 'Rated games need a clock.');
    const id = randomId(6);
    const ch = {
      id, from: from.key, to: target.key, fromName: from.name, toName: target.name,
      minutes, increment, color: ['w', 'b'].includes(color) ? color : 'random', rated,
      variant: variants.VARIANTS[variant] ? variant : 'standard',
    };
    if (ch.variant !== 'standard') ch.rated = false;
    ch.timer = setTimeout(() => {
      endChallenge(id);
      emitTo(from, 'challenge:closed', { id, reason: `${target.name} didn't answer.` });
      emitTo(target, 'challenge:closed', { id, reason: null });
    }, 60000);
    challenges.set(id, ch);
    emitTo(from, 'challenge:sent', challengeView(ch));
    emitTo(target, 'challenge:incoming', challengeView(ch));
  });

  socket.on('challenge:cancel', ({ id } = {}) => {
    const ch = challenges.get(id);
    if (!ch || ch.from !== socket.data.presenceKey) return;
    endChallenge(id);
    const target = presence.get(ch.to);
    if (target) emitTo(target, 'challenge:closed', { id, reason: `${ch.fromName} cancelled the challenge.` });
    const from = me();
    if (from) emitTo(from, 'challenge:closed', { id, reason: null });
  });

  socket.on('challenge:decline', ({ id } = {}) => {
    const ch = challenges.get(id);
    if (!ch || ch.to !== socket.data.presenceKey) return;
    endChallenge(id);
    const from = presence.get(ch.from);
    if (from) emitTo(from, 'challenge:closed', { id, reason: `${ch.toName} declined your challenge.` });
    const target = me();
    if (target) emitTo(target, 'challenge:closed', { id, reason: null });
  });

  socket.on('challenge:accept', async ({ id } = {}) => {
    const ch = challenges.get(id);
    if (!ch || ch.to !== socket.data.presenceKey) return;
    const from = presence.get(ch.from), target = me();
    endChallenge(id);
    if (!from || !target) return socket.emit('challenge:error', 'The other player went offline.');
    const fromUser = from.userId ? { id: from.userId, username: from.name } : null;
    const toUser = target.userId ? { id: target.userId, username: target.name } : null;
    const { game, token, color } = newGame({
      color: ch.color, minutes: ch.minutes, increment: ch.increment, isPublic: false,
      name: from.name, user: fromUser, rated: ch.rated && fromUser && toUser, variant: ch.variant,
    });
    const otherToken = randomId(18);
    game.seats[other(color)] = newSeat(otherToken, toUser, target.name);
    await Promise.all([loadSeatRating(game, game.seats.w), loadSeatRating(game, game.seats.b)]);
    emitTo(from, 'challenge:start', { id, gameId: game.id, token });
    emitTo(target, 'challenge:start', { id, gameId: game.id, token: otherToken });
  });

  socket.on('lobby', () => {
    socket.join('lobby');
    socket.emit('lobby', lobbyPayload());
  });

  socket.on('join', async ({ gameId, token, name, coachToken } = {}) => {
    const user = socket.data.user;
    gameId = String(gameId || '').slice(0, 40);
    game = games.get(gameId) || null;
    if (!game && db.enabled) {
      try { game = await loadArchived(gameId); } catch (err) { console.error(err); }
    }
    if (!game) return socket.emit('error-msg', 'Game not found. It may have expired.');
    socket.join(game.id);
    socket.data.gameId = game.id;

    color = null;
    let newToken = null;
    let notice = null;
    // Coach link: watch from one player's side and share drawings with them.
    const coachSeatColor = coachToken && !game.archived
      ? ['w', 'b'].find((c) => game.seats[c]?.coachToken && game.seats[c].coachToken === coachToken) : null;
    if (coachToken && !coachSeatColor) notice = 'That coach link is no longer valid.';
    if (coachSeatColor && game.rated) notice = 'Coaching is not allowed in rated games.';
    if (coachSeatColor && !game.rated) {
      const seat = game.seats[coachSeatColor];
      seat.coachSockets.add(socket.id);
      socket.data.coachSeat = seat;
      socket.join(seat.teamId);
      socket.emit('joined', { color: null, coachOf: coachSeatColor, coachName: seat.name });
      broadcast(game);
      return;
    }
    if (!game.archived) {
      // Your seat: the token this browser was given, or your account on any device.
      color = ['w', 'b'].find((c) => game.seats[c] && (
        (token && game.seats[c].token === token) || (user && game.seats[c].userId === user.id))) || null;
      if (!color) {
        // Take the empty seat if there is one; otherwise spectate.
        const empty = ['w', 'b'].find((c) => !game.seats[c]);
        if (empty && game.rated && !user) {
          notice = 'This is a rated game. Log in to play it.';
        } else if (empty && game.rated && game.seats[other(empty)]?.userId === user.id) {
          notice = "You can't play a rated game against yourself.";
        } else if (empty) {
          color = empty;
          newToken = randomId(18);
          game.seats[color] = newSeat(newToken, user, name);
          await loadSeatRating(game, game.seats[color]); // seat is already claimed before this await
        }
      }
    }
    if (color) {
      const seat = game.seats[color];
      seat.sockets.add(socket.id);
      socket.join(seat.teamId);
      if (!seat.userId && name) seat.name = cleanName(name); // guests can change nickname
    }
    if (game.status === 'waiting' && game.seats.w && game.seats.b) {
      game.status = game.variant === 'hiddenqueen' ? 'setup' : 'playing';
    }

    socket.emit('joined', { color, token: newToken || (color && game.seats[color].token), notice });
    broadcast(game);
  });

  socket.on('move', ({ from, to, promotion } = {}) => {
    if (!isPlayer() || game.status !== 'playing') return;
    if (game.chess.turn() !== color) return socket.emit('state', stateFor(game, socket.id));
    let move;
    try {
      move = game.chess.move({ from, to, promotion: promotion || 'q' });
    } catch {
      return socket.emit('state', stateFor(game, socket.id)); // illegal: resync the client
    }
    if (game.variant === 'hiddenqueen') {
      const shown = variants.hiddenQueenAfterMove(game, move);
      game.snaps.push(variants.snapshot(game, move, shown));
    } else if (game.snaps) {
      game.snaps.push(variants.snapshot(game, move));
    }
    const now = Date.now();
    if (game.time) {
      // White's first move doesn't use clock time; after that, deduct and add increment.
      if (game.turnStartedAt && game.chess.history().length > 1) {
        game.clocks[color] = Math.max(0, game.clocks[color] - (now - game.turnStartedAt));
        game.clocks[color] += game.time.increment;
      }
      game.turnStartedAt = now;
    }
    game.lastMove = { from: move.from, to: move.to };
    if (game.drawOffer && game.drawOffer !== color) declineDraw(game); // moving declines
    checkGameOver(game);
    scheduleFlag(game);
    broadcast(game);
  });

  // Hidden Queen: each player secretly picks the pawn that is really their queen.
  socket.on('hq:pick', (square) => {
    if (!isPlayer() || game.variant !== 'hiddenqueen' || game.status !== 'setup') return;
    const p = typeof square === 'string' && /^[a-h][1-8]$/.test(square) ? game.chess.get(square) : null;
    if (!p || p.type !== 'p' || p.color !== color || game.hq[color].square) return;
    game.hq[color].square = square;
    if (game.hq.w.square && game.hq.b.square) {
      variants.applyHiddenQueens(game);
      game.snaps = [variants.snapshot(game)];
      game.status = 'playing';
    }
    broadcast(game);
  });

  // Coaching (casual games only).
  socket.on('coach:invite', () => {
    if (!isPlayer() || game.rated || game.archived) return;
    const seat = game.seats[color];
    seat.coachToken ||= randomId(12);
    socket.emit('coach:link', { token: seat.coachToken });
  });

  // Drawings shared between a player and their coach.
  socket.on('shapes', (shapes) => {
    if (!game || game.rated) return;
    const seat = isPlayer() ? game.seats[color] : socket.data.coachSeat;
    if (!seat || !(seat.coachSockets.size || socket.data.coachSeat)) return;
    if (!Array.isArray(shapes) || shapes.length > 40) return;
    const SQ = /^[a-h][1-8]$/, BRUSH = ['green', 'red', 'blue', 'yellow'];
    const clean = shapes.filter((x) => x && SQ.test(x.from) && (x.to === undefined || SQ.test(x.to)) && BRUSH.includes(x.brush))
      .map((x) => ({ from: x.from, to: x.to, brush: x.brush }));
    socket.to(seat.teamId).emit('shapes', { shapes: clean, from: socket.data.coachSeat ? 'coach' : 'player' });
  });

  // GIF reactions: players only, from GIPHY/Tenor only, at most one every 3 seconds.
  socket.on('gif', ({ url } = {}) => {
    if (!isPlayer() || !game || game.archived) return;
    const now = Date.now();
    if (now - (socket.data.lastGif || 0) < 3000) return;
    if (!isAllowedGif(url)) return socket.emit('gif-error', 'Only GIPHY or Tenor GIF links can be sent.');
    socket.data.lastGif = now;
    io.to(game.id).emit('gif', { color, url });
  });

  socket.on('resign', () => {
    if (!isPlayer() || (game.status !== 'playing' && game.status !== 'setup')) return;
    endGame(game, color === 'w' ? '0-1' : '1-0', 'resignation');
    broadcast(game);
  });

  socket.on('draw', (action) => {
    if (!isPlayer() || game.status !== 'playing') return;
    if (action === 'offer' && !game.drawOffer) {
      const d = drawStatus(game, color);
      if (d.left <= 0 || d.waitMoves > 0) return;
      game.drawOffer = color;
      game.drawOffersMade[color]++;
    } else if (action === 'accept' && game.drawOffer === other(color)) endGame(game, '1/2-1/2', 'agreement');
    else if (action === 'decline' && game.drawOffer === other(color)) declineDraw(game);
    else if (action === 'cancel' && game.drawOffer === color) game.drawOffer = null;
    broadcast(game);
  });

  socket.on('rematch', () => {
    if (!isPlayer() || game.status !== 'over') return;
    if (!game.rematchOffer) {
      game.rematchOffer = color;
    } else if (game.rematchOffer === other(color)) {
      // Fresh board in the same room, colours swapped.
      game.seats = { w: game.seats.b, b: game.seats.w };
      game.chess = variants.newBoard(game.variant);
      game.clocks = game.time ? { w: game.time.initial, b: game.time.initial } : null;
      game.turnStartedAt = null;
      game.status = game.variant === 'hiddenqueen' ? 'setup' : 'playing';
      if (game.variant === 'hiddenqueen') game.hq = variants.freshHiddenQueen();
      if (game.snaps) game.snaps = [variants.snapshot(game)];
      game.round++;
      game.result = game.reason = game.lastMove = game.drawOffer = game.rematchOffer = null;
      game.ratingDiff = game.notRated = game.savedId = null;
      Object.assign(game, freshDrawLimits());
      // Tell every socket its new colour.
      for (const c of ['w', 'b']) {
        for (const sid of game.seats[c].sockets) io.to(sid).emit('recolor', c);
        for (const sid of game.seats[c].coachSockets) io.to(sid).emit('coach-recolor', c);
      }
    }
    broadcast(game);
  });

  socket.on('disconnect', () => {
    const entry = presence.get(socket.data.presenceKey);
    if (entry) {
      entry.sockets.delete(socket.id);
      if (entry.sockets.size === 0) {
        presence.delete(entry.key);
        // Their outgoing challenges lapse.
        for (const ch of [...challenges.values()]) {
          if (ch.from === entry.key) {
            endChallenge(ch.id);
            const t = presence.get(ch.to);
            if (t) emitTo(t, 'challenge:closed', { id: ch.id, reason: `${ch.fromName} went offline.` });
          }
        }
      }
      lobbyChanged();
    }
    if (!game) return;
    for (const c of ['w', 'b']) {
      game.seats[c]?.sockets.delete(socket.id);
      game.seats[c]?.coachSockets?.delete(socket.id);
    }
    broadcast(game);
  });
});

setInterval(() => {
  const cutoff = Date.now() - GAME_TTL_MS;
  for (const [id, game] of games) {
    if (game.touchedAt < cutoff) {
      clearTimeout(game.timer);
      games.delete(id);
    }
  }
}, 60 * 60 * 1000).unref();

db.migrate()
  .then(() => {
    server.listen(PORT, () => console.log(
      `Chess server running on http://localhost:${PORT}` +
      (db.enabled ? ' (accounts and ratings on)' : ' (no DATABASE_URL: guest play only)')));
  })
  .catch((err) => {
    console.error('Could not set up the database:', err.message);
    process.exit(1);
  });
