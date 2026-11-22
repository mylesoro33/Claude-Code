/*
 * Encore server — accounts, cloud sync, public profiles, Apple Music helpers.
 * Zero dependencies: Node >= 22.5 (node:sqlite, node:crypto, global fetch).
 *
 *   node server.js            # http://localhost:3000
 *
 * Env:
 *   PORT                      default 3000
 *   DATABASE_PATH             default ./data/encore.db
 *   COOKIE_SECURE=1           set when served over HTTPS
 *   APPLE_TEAM_ID, APPLE_KEY_ID, and APPLE_PRIVATE_KEY (PEM text) or
 *   APPLE_PRIVATE_KEY_PATH    → enables "Connect Apple Music" (MusicKit)
 */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const SESSION_DAYS = 60;
const MAX_BODY = 4 * 1024 * 1024;
const STATIC = {
  '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/ranking.js': 'ranking.js',
  '/styles.css': 'styles.css', '/icon.svg': 'icon.svg', '/manifest.webmanifest': 'manifest.webmanifest', '/sw.js': 'sw.js',
};
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

// ---------------- Database ----------------
function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL,
      pass_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      is_public INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS states (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      data TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 0,
      ranked_count INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );`);
  return db;
}

// ---------------- Helpers ----------------
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const b64url = (buf) => Buffer.from(buf).toString('base64url');

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return { hash, salt };
}
function verifyPassword(password, salt, expected) {
  const { hash } = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(expected, 'hex'));
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Request too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

const USERNAME_RE = /^[a-z0-9_.]{3,24}$/i;

/** Very small fixed-window rate limiter keyed by string. */
function limiter(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const h = hits.get(key);
    if (!h || now - h.start > windowMs) { hits.set(key, { start: now, n: 1 }); return true; }
    h.n++;
    if (hits.size > 10000) hits.clear();
    return h.n <= max;
  };
}

/** Light validation of a client state blob before storing it. */
function cleanState(s) {
  if (!s || typeof s !== 'object') throw Object.assign(new Error('Invalid state'), { status: 400 });
  const ids = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string' && x.length < 40) : []);
  const rankings = { liked: ids(s.rankings?.liked), fine: ids(s.rankings?.fine), disliked: ids(s.rankings?.disliked) };
  const songs = {};
  const str = (v, n = 500) => (typeof v === 'string' ? v.slice(0, n) : '');
  for (const [id, x] of Object.entries(s.songs || {})) {
    if (typeof id !== 'string' || id.length > 40 || !x || typeof x !== 'object') continue;
    songs[id] = {
      id, title: str(x.title), artist: str(x.artist), album: str(x.album), art: str(x.art, 1000),
      preview: str(x.preview, 1000), url: str(x.url, 1000), genre: str(x.genre, 100), year: str(x.year, 4),
      explicit: !!x.explicit, artistId: str(x.artistId, 40), albumId: str(x.albumId, 40),
    };
  }
  const rankedAt = {};
  for (const [id, t] of Object.entries(s.rankedAt || {})) if (typeof t === 'number') rankedAt[id] = t;
  return { songs, rankings, later: ids(s.later), rankedAt, country: str(s.country, 2) || 'us' };
}

// ---------------- Apple Music developer token (MusicKit) ----------------
function appleConfig(env = process.env) {
  let key = env.APPLE_PRIVATE_KEY;
  if (!key && env.APPLE_PRIVATE_KEY_PATH) {
    try { key = fs.readFileSync(env.APPLE_PRIVATE_KEY_PATH, 'utf8'); } catch { key = null; }
  }
  if (!env.APPLE_TEAM_ID || !env.APPLE_KEY_ID || !key) return null;
  return { teamId: env.APPLE_TEAM_ID, keyId: env.APPLE_KEY_ID, key: key.replace(/\\n/g, '\n') };
}

/** ES256 JWT that MusicKit needs. Valid for up to 180 days; we mint 12h tokens. */
function makeDeveloperToken(cfg, ttlSec = 12 * 3600) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: cfg.keyId, typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iss: cfg.teamId, iat: now, exp: now + ttlSec }));
  const data = `${header}.${payload}`;
  const sig = crypto.sign('sha256', Buffer.from(data), { key: cfg.key, dsaEncoding: 'ieee-p1363' });
  return `${data}.${b64url(sig)}`;
}

// ---------------- Apple catalog proxy (avoids browser CORS issues) ----------------
const proxyCache = new Map();
async function cachedFetchJson(url, ttlMs = 10 * 60 * 1000) {
  const hit = proxyCache.get(url);
  if (hit && Date.now() - hit.t < ttlMs) return hit.data;
  const res = await fetch(url, { headers: { 'User-Agent': 'Encore/1.0' } });
  if (!res.ok) throw Object.assign(new Error('Upstream ' + res.status), { status: 502 });
  const data = await res.json();
  if (proxyCache.size > 500) proxyCache.clear();
  proxyCache.set(url, { t: Date.now(), data });
  return data;
}

// ---------------- App ----------------
function createApp({ dbPath = process.env.DATABASE_PATH || path.join(ROOT, 'data', 'encore.db'), env = process.env } = {}) {
  const db = openDb(dbPath);
  const secure = env.COOKIE_SECURE === '1';
  const authLimit = limiter(20, 15 * 60 * 1000);
  let devToken = null;

  const q = {
    userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
    insertUser: db.prepare('INSERT INTO users (username, display_name, pass_hash, salt, created_at) VALUES (?, ?, ?, ?, ?)'),
    insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
    session: db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
    getState: db.prepare('SELECT data, version, updated_at FROM states WHERE user_id = ?'),
    putState: db.prepare(`INSERT INTO states (user_id, data, version, ranked_count, updated_at) VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, version = states.version + 1, ranked_count = excluded.ranked_count, updated_at = excluded.updated_at`),
    updateProfile: db.prepare('UPDATE users SET display_name = ?, is_public = ? WHERE id = ?'),
    searchUsers: db.prepare(`SELECT u.username, u.display_name, COALESCE(s.ranked_count, 0) AS ranked
      FROM users u LEFT JOIN states s ON s.user_id = u.id
      WHERE u.is_public = 1 AND (u.username LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\')
      ORDER BY ranked DESC LIMIT 20`),
  };

  const publicUser = (u) => ({ username: u.username, displayName: u.display_name, isPublic: !!u.is_public, createdAt: u.created_at });

  function currentUser(req) {
    const tok = parseCookies(req).encore_session;
    if (!tok) return null;
    return q.session.get(sha256(tok), Date.now()) || null;
  }
  function startSession(res, userId) {
    const tok = crypto.randomBytes(32).toString('base64url');
    const expires = Date.now() + SESSION_DAYS * 864e5;
    q.insertSession.run(sha256(tok), userId, expires);
    q.purgeSessions.run(Date.now());
    res.setHeader('Set-Cookie', `encore_session=${tok}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`);
  }
  function stateFor(userId) {
    const row = q.getState.get(userId);
    return row ? { state: JSON.parse(row.data), version: row.version, updatedAt: row.updated_at } : { state: null, version: 0, updatedAt: 0 };
  }

  async function api(req, res, url) {
    const p = url.pathname;
    const m = req.method;
    // Only accept JSON writes from our own pages (basic CSRF protection on top of SameSite).
    if (m !== 'GET' && !(req.headers['content-type'] || '').includes('application/json')) return send(res, 415, { error: 'JSON required' });

    if (p === '/api/signup' && m === 'POST') {
      if (!authLimit('auth:' + req.socket.remoteAddress)) return send(res, 429, { error: 'Too many attempts. Try again later.' });
      const { username = '', password = '', displayName = '' } = await readJson(req);
      if (!USERNAME_RE.test(username)) return send(res, 400, { error: 'Username must be 3–24 letters, numbers, _ or .' });
      if (typeof password !== 'string' || password.length < 8) return send(res, 400, { error: 'Password must be at least 8 characters.' });
      if (q.userByName.get(username)) return send(res, 409, { error: 'That username is taken.' });
      const { hash, salt } = hashPassword(password);
      const name = String(displayName || username).trim().slice(0, 40) || username;
      const r = q.insertUser.run(username, name, hash, salt, Date.now());
      startSession(res, Number(r.lastInsertRowid));
      return send(res, 201, { user: publicUser(q.userByName.get(username)), ...stateFor(Number(r.lastInsertRowid)) });
    }

    if (p === '/api/login' && m === 'POST') {
      if (!authLimit('auth:' + req.socket.remoteAddress)) return send(res, 429, { error: 'Too many attempts. Try again later.' });
      const { username = '', password = '' } = await readJson(req);
      const u = typeof username === 'string' && q.userByName.get(username);
      if (!u || typeof password !== 'string' || !verifyPassword(password, u.salt, u.pass_hash)) return send(res, 401, { error: 'Wrong username or password.' });
      startSession(res, u.id);
      return send(res, 200, { user: publicUser(u), ...stateFor(u.id) });
    }

    if (p === '/api/logout' && m === 'POST') {
      const tok = parseCookies(req).encore_session;
      if (tok) q.deleteSession.run(sha256(tok));
      res.setHeader('Set-Cookie', `encore_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`);
      return send(res, 200, { ok: true });
    }

    if (p === '/api/me' && m === 'GET') {
      const u = currentUser(req);
      if (!u) return send(res, 200, { user: null });
      return send(res, 200, { user: publicUser(u), ...stateFor(u.id) });
    }

    if (p === '/api/me' && m === 'PATCH') {
      const u = currentUser(req);
      if (!u) return send(res, 401, { error: 'Not signed in' });
      const body = await readJson(req);
      const name = typeof body.displayName === 'string' && body.displayName.trim() ? body.displayName.trim().slice(0, 40) : u.display_name;
      const isPublic = typeof body.isPublic === 'boolean' ? (body.isPublic ? 1 : 0) : u.is_public;
      q.updateProfile.run(name, isPublic, u.id);
      return send(res, 200, { user: publicUser(q.userByName.get(u.username)) });
    }

    if (p === '/api/state' && m === 'PUT') {
      const u = currentUser(req);
      if (!u) return send(res, 401, { error: 'Not signed in' });
      const body = await readJson(req);
      const cur = stateFor(u.id);
      // Optimistic concurrency: reject writes based on a stale version (another device synced first).
      if (typeof body.baseVersion === 'number' && body.baseVersion !== cur.version) {
        return send(res, 409, { error: 'conflict', ...cur });
      }
      const st = cleanState(body.state);
      const ranked = st.rankings.liked.length + st.rankings.fine.length + st.rankings.disliked.length;
      q.putState.run(u.id, JSON.stringify(st), ranked, Date.now());
      const after = stateFor(u.id);
      return send(res, 200, { version: after.version, updatedAt: after.updatedAt });
    }

    if (p === '/api/users' && m === 'GET') {
      const term = (url.searchParams.get('q') || '').trim().slice(0, 40).replace(/[\\%_]/g, (c) => '\\' + c);
      if (!term) return send(res, 200, { users: [] });
      const rows = q.searchUsers.all(`%${term}%`, `%${term}%`);
      return send(res, 200, { users: rows.map((r) => ({ username: r.username, displayName: r.display_name, ranked: r.ranked })) });
    }

    const prof = p.match(/^\/api\/users\/([^/]+)$/);
    if (prof && m === 'GET') {
      const u = q.userByName.get(decodeURIComponent(prof[1]));
      const me = currentUser(req);
      if (!u || (!u.is_public && (!me || me.id !== u.id))) return send(res, 404, { error: 'No such user' });
      const { state } = stateFor(u.id);
      const rankings = state?.rankings || { liked: [], fine: [], disliked: [] };
      const all = new Set([...rankings.liked, ...rankings.fine, ...rankings.disliked]);
      const songs = {};
      for (const id of all) if (state.songs[id]) songs[id] = state.songs[id];
      return send(res, 200, { user: { username: u.username, displayName: u.display_name }, rankings, songs });
    }

    if (p === '/api/apple/developer-token' && m === 'GET') {
      const cfg = appleConfig(env);
      if (!cfg) return send(res, 404, { error: 'Apple Music is not configured on this server.' });
      if (!devToken || devToken.exp < Date.now() + 3600e3) {
        devToken = { token: makeDeveloperToken(cfg), exp: Date.now() + 12 * 3600e3 };
      }
      return send(res, 200, { token: devToken.token });
    }

    // Apple public catalog proxy: /api/catalog/search, /api/catalog/lookup, /api/catalog/charts
    if (p.startsWith('/api/catalog/') && m === 'GET') {
      const country = (url.searchParams.get('country') || 'us').toLowerCase().replace(/[^a-z]/g, '').slice(0, 2) || 'us';
      const kind = p.slice('/api/catalog/'.length);
      if (kind === 'search') {
        const term = (url.searchParams.get('term') || '').slice(0, 200);
        const qs = new URLSearchParams({ term, media: 'music', entity: 'song', limit: '40', country });
        return send(res, 200, await cachedFetchJson(`https://itunes.apple.com/search?${qs}`));
      }
      if (kind === 'lookup') {
        const ids = (url.searchParams.get('id') || '').split(',').filter((x) => /^\d{1,20}$/.test(x)).slice(0, 150);
        if (!ids.length) return send(res, 200, { results: [] });
        const qs = new URLSearchParams({ id: ids.join(','), country, entity: 'song' });
        return send(res, 200, await cachedFetchJson(`https://itunes.apple.com/lookup?${qs}`));
      }
      if (kind === 'charts') {
        return send(res, 200, await cachedFetchJson(`https://rss.marketingtools.apple.com/api/v2/${country}/music/most-played/50/songs.json`, 30 * 60 * 1000));
      }
    }

    return send(res, 404, { error: 'Not found' });
  }

  function serveStatic(req, res, url) {
    const file = STATIC[url.pathname];
    if (!file) return send(res, 404, 'Not found');
    fs.readFile(path.join(ROOT, file), (err, buf) => {
      if (err) return send(res, 404, 'Not found');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      res.end(buf);
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) await api(req, res, url);
      else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res, url);
      else send(res, 405, 'Method not allowed');
    } catch (err) {
      if (!res.headersSent) send(res, err.status || 500, { error: err.status ? err.message : 'Server error' });
      if (!err.status) console.error(err);
    }
  });
  server.on('close', () => db.close());
  return server;
}

module.exports = { createApp, makeDeveloperToken, appleConfig, cleanState };

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => {
    console.log(`Encore running at http://localhost:${port}`);
    console.log(appleConfig() ? 'Apple Music linking: enabled' : 'Apple Music linking: disabled (set APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY)');
  });
}
