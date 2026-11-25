// Saving games and ratings, and the queries behind profiles and the leaderboard.

const db = require('./db');
const glicko2 = require('./glicko2');

const CATEGORIES = ['bullet', 'blitz', 'rapid', 'classical'];

// Same speed buckets as Lichess: estimated duration = initial + 40 × increment.
function categoryFor(time) {
  if (!time) return 'casual';
  const est = time.initial / 1000 + 40 * (time.increment / 1000);
  return est < 180 ? 'bullet' : est < 480 ? 'blitz' : est < 1500 ? 'rapid' : 'classical';
}

const DEFAULT = { rating: 1500, rd: 350, vol: 0.06, games: 0 };

const publicRating = (r) => ({
  rating: Math.round(r.rating),
  provisional: glicko2.isProvisional(r.rd),
  games: r.games,
});

async function getRating(userId, category) {
  if (!db.enabled || !userId || !CATEGORIES.includes(category)) return null;
  const { rows: [r] } = await db.query(
    'SELECT rating, rd, games FROM ratings WHERE user_id = $1 AND category = $2', [userId, category]);
  return publicRating(r || DEFAULT);
}

async function getRatings(userId) {
  const { rows } = await db.query(
    'SELECT category, rating, rd, vol, games, wins, losses, draws FROM ratings WHERE user_id = $1', [userId]);
  const byCat = Object.fromEntries(rows.map((r) => [r.category, r]));
  return CATEGORIES.map((c) => {
    const r = byCat[c] || { ...DEFAULT, wins: 0, losses: 0, draws: 0 };
    return { category: c, ...publicRating(r), wins: r.wins, losses: r.losses, draws: r.draws };
  });
}

// Save a finished game; for rated games, update both players' ratings in the
// same transaction. Returns { w, b } rating changes (or null if unrated).
async function saveGame(rec) {
  return db.tx(async (client) => {
    let diff = null;
    let before = { w: null, b: null };
    if (rec.rated && rec.whiteId && rec.blackId) {
      const lock = async (id) => {
        await client.query(
          'INSERT INTO ratings (user_id, category) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, rec.category]);
        const { rows: [r] } = await client.query(
          'SELECT rating, rd, vol FROM ratings WHERE user_id = $1 AND category = $2 FOR UPDATE', [id, rec.category]);
        return r;
      };
      // Lock in a fixed order so two games finishing at once can't deadlock.
      const [first, second] = rec.whiteId < rec.blackId ? ['w', 'b'] : ['b', 'w'];
      const ids = { w: rec.whiteId, b: rec.blackId };
      const cur = {};
      cur[first] = await lock(ids[first]);
      cur[second] = await lock(ids[second]);

      const score = rec.result === '1-0' ? 1 : rec.result === '0-1' ? 0 : 0.5;
      const next = { w: glicko2.update(cur.w, cur.b, score), b: glicko2.update(cur.b, cur.w, 1 - score) };
      diff = {};
      for (const c of ['w', 'b']) {
        const s = c === 'w' ? score : 1 - score;
        await client.query(
          `UPDATE ratings SET rating = $3, rd = $4, vol = $5, games = games + 1,
             wins = wins + $6, losses = losses + $7, draws = draws + $8, updated_at = now()
           WHERE user_id = $1 AND category = $2`,
          [ids[c], rec.category, next[c].rating, next[c].rd, next[c].vol, s === 1 ? 1 : 0, s === 0 ? 1 : 0, s === 0.5 ? 1 : 0]);
        before[c] = Math.round(cur[c].rating);
        diff[c] = Math.round(next[c].rating) - before[c];
      }
    }
    await client.query(
      `INSERT INTO games (id, white_id, black_id, white_name, black_name, rated, category,
         time_initial, time_increment, moves, result, reason, white_rating, black_rating, white_diff, black_diff)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (id) DO NOTHING`,
      [rec.id, rec.whiteId, rec.blackId, rec.whiteName, rec.blackName, !!diff, rec.category,
        rec.time?.initial ?? null, rec.time?.increment ?? null, rec.moves.join(' '), rec.result, rec.reason,
        before.w, before.b, diff?.w ?? null, diff?.b ?? null]);
    return diff;
  });
}

async function loadGame(id) {
  if (!db.enabled) return null;
  const { rows: [g] } = await db.query('SELECT * FROM games WHERE id = $1', [id]);
  return g || null;
}

async function leaderboard(category) {
  const { rows } = await db.query(
    `SELECT u.username, r.rating, r.rd, r.games, r.wins, r.losses, r.draws
     FROM ratings r JOIN users u ON u.id = r.user_id
     WHERE r.category = $1 AND r.games > 0
     ORDER BY (r.rd > 110), r.rating DESC
     LIMIT 100`, [category]);
  return rows.map((r) => ({ username: r.username, ...publicRating(r), wins: r.wins, losses: r.losses, draws: r.draws }));
}

async function profile(username) {
  const { rows: [user] } = await db.query(
    'SELECT id, username, created_at FROM users WHERE lower(username) = lower($1)', [username]);
  if (!user) return null;
  const ratings = await getRatings(user.id);
  const { rows: games } = await db.query(
    `SELECT id, white_id, black_id, white_name, black_name, rated, category, time_initial, time_increment,
            result, reason, white_rating, black_rating, white_diff, black_diff, ended_at,
            array_length(string_to_array(moves, ' '), 1) AS plies
     FROM games WHERE white_id = $1 OR black_id = $1
     ORDER BY ended_at DESC LIMIT 50`, [user.id]);
  return {
    username: user.username,
    joined: user.created_at,
    ratings,
    games: games.map((g) => {
      const color = g.white_id === user.id ? 'w' : 'b';
      const won = (g.result === '1-0' && color === 'w') || (g.result === '0-1' && color === 'b');
      return {
        id: g.id,
        color,
        opponent: color === 'w' ? g.black_name : g.white_name,
        opponentRating: color === 'w' ? g.black_rating : g.white_rating,
        outcome: g.result === '1/2-1/2' ? 'draw' : won ? 'win' : 'loss',
        result: g.result,
        reason: g.reason,
        rated: g.rated,
        category: g.category,
        time: g.time_initial !== null ? { initial: g.time_initial, increment: g.time_increment } : null,
        diff: color === 'w' ? g.white_diff : g.black_diff,
        moves: Math.ceil((g.plies || 0) / 2),
        endedAt: g.ended_at,
      };
    }),
  };
}

module.exports = { CATEGORIES, categoryFor, getRating, getRatings, saveGame, loadGame, leaderboard, profile };
