// Postgres access (Neon in production). If DATABASE_URL isn't set, the app
// still runs: everyone plays as a guest and nothing is saved.

const { Pool } = require('pg');

const url = process.env.DATABASE_URL;
const pool = url
  ? new Pool({
      connectionString: url,
      // Neon requires TLS; a local database usually doesn't have it.
      ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: true },
      max: 5,
    })
  : null;

const enabled = !!pool;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower ON users (lower(username));

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);

-- One Glicko-2 rating per player per speed (bullet, blitz, rapid, classical).
CREATE TABLE IF NOT EXISTS ratings (
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category   TEXT NOT NULL,
  rating     DOUBLE PRECISION NOT NULL DEFAULT 1500,
  rd         DOUBLE PRECISION NOT NULL DEFAULT 350,
  vol        DOUBLE PRECISION NOT NULL DEFAULT 0.06,
  games      INT NOT NULL DEFAULT 0,
  wins       INT NOT NULL DEFAULT 0,
  losses     INT NOT NULL DEFAULT 0,
  draws      INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, category)
);

CREATE TABLE IF NOT EXISTS games (
  id             TEXT PRIMARY KEY,
  white_id       INT REFERENCES users(id) ON DELETE SET NULL,
  black_id       INT REFERENCES users(id) ON DELETE SET NULL,
  white_name     TEXT NOT NULL,
  black_name     TEXT NOT NULL,
  rated          BOOLEAN NOT NULL,
  category       TEXT NOT NULL,
  time_initial   INT,
  time_increment INT,
  moves          TEXT NOT NULL,
  result         TEXT NOT NULL,
  reason         TEXT NOT NULL,
  white_rating   INT,
  black_rating   INT,
  white_diff     INT,
  black_diff     INT,
  ended_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS games_white ON games (white_id, ended_at DESC);
CREATE INDEX IF NOT EXISTS games_black ON games (black_id, ended_at DESC);
`;

async function migrate() {
  if (!pool) return;
  await pool.query(SCHEMA);
  await pool.query('DELETE FROM sessions WHERE expires_at < now()');
}

const query = (text, params) => pool.query(text, params);

// Run fn(client) inside a transaction.
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { enabled, migrate, query, tx };
