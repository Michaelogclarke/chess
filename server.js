// Online chess server: Express serves the client, Socket.IO syncs games.
// Every move is validated here with chess.js, so clients can't cheat by
// editing their browser. Games live in memory (they vanish on restart).

const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { Chess } = require('chess.js');

const PORT = process.env.PORT || 3000;
const GAME_TTL_MS = 24 * 60 * 60 * 1000; // forget games idle for a day

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
// Serve chess.js to the browser so the client can show legal-move hints.
app.get('/vendor/chess.js', (req, res) =>
  res.sendFile(require.resolve('chess.js/dist/esm/chess.js')));

/** @type {Map<string, any>} */
const games = new Map();

const randomId = (bytes) => crypto.randomBytes(bytes).toString('base64url');
const other = (c) => (c === 'w' ? 'b' : 'w');

function newGame({ color, minutes, increment }) {
  const id = randomId(6);
  const timed = minutes > 0;
  const game = {
    id,
    chess: new Chess(),
    seats: { w: null, b: null }, // { token, sockets:Set }
    time: timed ? { initial: minutes * 60000, increment: increment * 1000 } : null,
    clocks: timed ? { w: minutes * 60000, b: minutes * 60000 } : null,
    turnStartedAt: null, // when the side to move's clock started running
    timer: null,
    status: 'waiting', // waiting | playing | over
    result: null, // '1-0' | '0-1' | '1/2-1/2'
    reason: null,
    lastMove: null,
    drawOffer: null, // color that offered
    rematchOffer: null, // color that offered
    touchedAt: Date.now(),
  };
  const creatorColor = color === 'w' || color === 'b' ? color : Math.random() < 0.5 ? 'w' : 'b';
  const token = randomId(18);
  game.seats[creatorColor] = { token, sockets: new Set() };
  games.set(id, game);
  return { game, token, color: creatorColor };
}

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
    players: {
      w: game.seats.w ? { connected: game.seats.w.sockets.size > 0 } : null,
      b: game.seats.b ? { connected: game.seats.b.sockets.size > 0 } : null,
    },
    time: game.time,
    clocks: currentClocks(game),
    clockRunning: clockRunning(game) ? chess.turn() : null,
    drawOffer: game.drawOffer,
    rematchOffer: game.rematchOffer,
  };
}

function broadcast(game) {
  game.touchedAt = Date.now();
  io.to(game.id).emit('state', publicState(game));
}

function endGame(game, result, reason) {
  clearTimeout(game.timer);
  game.timer = null;
  if (game.clocks) game.clocks = currentClocks(game);
  game.status = 'over';
  game.result = result;
  game.reason = reason;
  game.drawOffer = null;
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
  if (chess.isCheckmate()) endGame(game, chess.turn() === 'w' ? '0-1' : '1-0', 'checkmate');
  else if (chess.isStalemate()) endGame(game, '1/2-1/2', 'stalemate');
  else if (chess.isInsufficientMaterial()) endGame(game, '1/2-1/2', 'insufficient material');
  else if (chess.isThreefoldRepetition()) endGame(game, '1/2-1/2', 'threefold repetition');
  else if (chess.isDrawByFiftyMoves()) endGame(game, '1/2-1/2', '50-move rule');
}

app.post('/api/games', (req, res) => {
  const minutes = Math.min(180, Math.max(0, Number(req.body.minutes) || 0));
  const increment = Math.min(60, Math.max(0, Number(req.body.increment) || 0));
  const { game, token, color } = newGame({ color: req.body.color, minutes, increment });
  res.json({ id: game.id, token, color });
});

app.get('/g/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'game.html')));

io.on('connection', (socket) => {
  let game = null;
  let color = null; // 'w' | 'b' | null (spectator); refreshed from seats on each event

  // Colours swap on rematch, so always look up this socket's seat.
  const isPlayer = () => {
    color = game ? ['w', 'b'].find((c) => game.seats[c]?.sockets.has(socket.id)) || null : null;
    return !!color;
  };

  socket.on('join', ({ gameId, token } = {}) => {
    game = games.get(gameId);
    if (!game) return socket.emit('error-msg', 'Game not found. It may have expired.');
    socket.join(game.id);

    color = ['w', 'b'].find((c) => game.seats[c] && token && game.seats[c].token === token) || null;
    let newToken = null;
    if (!color) {
      // Take the empty seat if there is one; otherwise spectate.
      const empty = ['w', 'b'].find((c) => !game.seats[c]);
      if (empty) {
        color = empty;
        newToken = randomId(18);
        game.seats[color] = { token: newToken, sockets: new Set() };
      }
    }
    if (color) game.seats[color].sockets.add(socket.id);
    if (game.status === 'waiting' && game.seats.w && game.seats.b) game.status = 'playing';

    socket.emit('joined', { color, token: newToken || (color && game.seats[color].token) });
    broadcast(game);
  });

  socket.on('move', ({ from, to, promotion } = {}) => {
    if (!isPlayer() || game.status !== 'playing') return;
    if (game.chess.turn() !== color) return socket.emit('state', publicState(game));
    let move;
    try {
      move = game.chess.move({ from, to, promotion: promotion || 'q' });
    } catch {
      return socket.emit('state', publicState(game)); // illegal: resync the client
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
    if (game.drawOffer && game.drawOffer !== color) game.drawOffer = null; // moving declines
    checkGameOver(game);
    scheduleFlag(game);
    broadcast(game);
  });

  socket.on('resign', () => {
    if (!isPlayer() || game.status !== 'playing') return;
    endGame(game, color === 'w' ? '0-1' : '1-0', 'resignation');
    broadcast(game);
  });

  socket.on('draw', (action) => {
    if (!isPlayer() || game.status !== 'playing') return;
    if (action === 'offer' && !game.drawOffer) game.drawOffer = color;
    else if (action === 'accept' && game.drawOffer === other(color)) endGame(game, '1/2-1/2', 'agreement');
    else if (action === 'decline' && game.drawOffer === other(color)) game.drawOffer = null;
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
      game.chess = new Chess();
      game.clocks = game.time ? { w: game.time.initial, b: game.time.initial } : null;
      game.turnStartedAt = null;
      game.status = 'playing';
      game.result = game.reason = game.lastMove = game.drawOffer = game.rematchOffer = null;
      // Tell every socket its new colour.
      for (const c of ['w', 'b']) {
        for (const sid of game.seats[c].sockets) io.to(sid).emit('recolor', c);
      }
    }
    broadcast(game);
  });

  socket.on('disconnect', () => {
    if (!game) return;
    for (const c of ['w', 'b']) game.seats[c]?.sockets.delete(socket.id);
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

server.listen(PORT, () => console.log(`Chess server running on http://localhost:${PORT}`));
