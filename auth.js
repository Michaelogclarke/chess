// Accounts: username + password, sessions in a cookie.
// Passwords are hashed with scrypt; only a hash of each session token is stored.

const crypto = require('crypto');
const { promisify } = require('util');
const db = require('./db');

const scrypt = promisify(crypto.scrypt);
const COOKIE = 'sid';
const SESSION_DAYS = 30;
const USERNAME_RE = /^[A-Za-z0-9_-]{3,20}$/;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function userFromCookieHeader(header) {
  if (!db.enabled) return null;
  const token = parseCookies(header)[COOKIE];
  if (!token) return null;
  const { rows } = await db.query(
    `SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`, [sha256(token)]);
  return rows[0] || null;
}

async function startSession(res, req, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at)
     VALUES ($1, $2, now() + interval '${SESSION_DAYS} days')`, [sha256(token), userId]);
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: SESSION_DAYS * 24 * 3600 * 1000,
    path: '/',
  });
}

// Simple per-IP limit on login/signup attempts to slow down password guessing.
const attempts = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || a.reset < now) { attempts.set(ip, { count: 1, reset: now + 15 * 60000 }); return false; }
  a.count++;
  return a.count > 20;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, a] of attempts) if (a.reset < now) attempts.delete(ip);
}, 10 * 60000).unref();

function routes(app) {
  // Attach the logged-in user (if any) to every request.
  app.use(async (req, res, next) => {
    try { req.user = await userFromCookieHeader(req.headers.cookie); } catch (err) { return next(err); }
    next();
  });

  const requireJson = (req, res, next) =>
    req.is('application/json') ? next() : res.status(415).json({ error: 'Expected JSON' });

  app.post('/api/signup', requireJson, async (req, res, next) => {
    try {
      if (!db.enabled) return res.status(503).json({ error: 'Accounts are not enabled on this server.' });
      if (rateLimited(req.ip)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
      const username = String(req.body.username || '').trim();
      const password = String(req.body.password || '');
      if (!USERNAME_RE.test(username)) {
        return res.status(400).json({ error: 'Username must be 3–20 letters, numbers, - or _.' });
      }
      if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
      if (password.length > 200) return res.status(400).json({ error: 'Password is too long.' });
      const hash = await hashPassword(password);
      let user;
      try {
        ({ rows: [user] } = await db.query(
          'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username', [username, hash]));
      } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'That username is taken.' });
        throw err;
      }
      await startSession(res, req, user.id);
      res.json({ user });
    } catch (err) { next(err); }
  });

  app.post('/api/login', requireJson, async (req, res, next) => {
    try {
      if (!db.enabled) return res.status(503).json({ error: 'Accounts are not enabled on this server.' });
      if (rateLimited(req.ip)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
      const username = String(req.body.username || '').trim();
      const password = String(req.body.password || '');
      const { rows: [row] } = await db.query(
        'SELECT id, username, password_hash FROM users WHERE lower(username) = lower($1)', [username]);
      if (!row || !(await verifyPassword(password, row.password_hash))) {
        return res.status(401).json({ error: 'Wrong username or password.' });
      }
      await startSession(res, req, row.id);
      res.json({ user: { id: row.id, username: row.username } });
    } catch (err) { next(err); }
  });

  app.post('/api/logout', async (req, res, next) => {
    try {
      const token = parseCookies(req.headers.cookie)[COOKIE];
      if (token && db.enabled) await db.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
      res.clearCookie(COOKIE, { path: '/' });
      res.json({ ok: true });
    } catch (err) { next(err); }
  });
}

module.exports = { routes, userFromCookieHeader };
