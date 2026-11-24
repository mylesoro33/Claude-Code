/*
 * Encore server — accounts, cloud sync, public profiles, charts, recommendations.
 * Zero dependencies: Node >= 22.13 (node:sqlite, node:crypto, global fetch).
 *
 *   node server.js            # http://localhost:3000
 *
 * Env:
 *   PORT                      default 3000
 *   DATABASE_PATH             default ./data/encore.db
 *   COOKIE_SECURE=1           set when served over HTTPS
 *   APPLE_TEAM_ID, APPLE_KEY_ID, and APPLE_PRIVATE_KEY (PEM text) or
 *   APPLE_PRIVATE_KEY_PATH    → "Connect Apple Music" (MusicKit)
 *   SPOTIFY_CLIENT_ID         → "Connect Spotify" (OAuth with PKCE; no secret needed)
 *   LASTFM_API_KEY            → live "Most Streamed" charts (Last.fm tag charts)
 */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const Ranking = require('./ranking.js');
const { recommend } = require('./recommend.js');
const { byKey: GENRE } = require('./genres.js');

const ROOT = __dirname;
const SESSION_DAYS = 60;
const MAX_BODY = 4 * 1024 * 1024;
const STATIC = {
  '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/ranking.js': 'ranking.js',
  '/genres.js': 'genres.js', '/recommend.js': 'recommend.js', '/config.js': 'config.js',
  '/styles.css': 'styles.css', '/icon.svg': 'icon.svg', '/manifest.webmanifest': 'manifest.webmanifest', '/sw.js': 'sw.js',
};
// Asset folders served as-is (names restricted so nothing else in the repo is reachable).
const ASSET_RE = /^\/(js\/[a-z0-9-]+\.js|fonts\/[a-z0-9-]+\.woff2|icons\/[a-z0-9-]+\.(png|svg))$/;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.woff2': 'font/woff2',
};
const ART_HOST_RE = /^is\d+(-ssl)?\.mzstatic\.com$/;
const MAX_ART = 3 * 1024 * 1024;
const USERNAME_RE = /^[a-z0-9_.]{3,24}$/i;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const AVATAR_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const MAX_AVATAR = 200 * 1024;
const SERVICES = ['apple', 'spotify', 'soundcloud', 'youtube', 'amazon'];

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
  // Migrations: columns added after the first release.
  const cols = new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
  if (!cols.has('email')) db.exec('ALTER TABLE users ADD COLUMN email TEXT');
  if (!cols.has('bio')) db.exec("ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT ''");
  if (!cols.has('avatar')) db.exec("ALTER TABLE users ADD COLUMN avatar TEXT NOT NULL DEFAULT ''");
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users(email) WHERE email IS NOT NULL');
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

const str = (v, n = 500) => (typeof v === 'string' ? v.slice(0, n) : '');
const ids = (a, max = 5000) => (Array.isArray(a) ? [...new Set(a.filter((x) => typeof x === 'string' && x.length < 40))].slice(0, max) : []);
function cleanSong(id, x) {
  return {
    id, title: str(x.title), artist: str(x.artist), album: str(x.album), art: str(x.art, 1000),
    preview: str(x.preview, 1000), url: str(x.url, 1000), genre: str(x.genre, 100), year: str(x.year, 4),
    explicit: !!x.explicit, artistId: str(x.artistId, 40), albumId: str(x.albumId, 40),
  };
}

/**
 * Validate a client state blob. Accepts the current shape
 * ({ order, lists, connections, ... }) and migrates the old bucketed
 * { rankings: { liked, fine, disliked }, later } shape.
 */
function cleanState(s) {
  if (!s || typeof s !== 'object') throw Object.assign(new Error('Invalid state'), { status: 400 });
  const order = Array.isArray(s.order) ? ids(s.order) : Ranking.fromLegacy(s.rankings);
  const lists = (Array.isArray(s.lists) ? s.lists : []).slice(0, 200).flatMap((l) => {
    if (!l || typeof l !== 'object' || typeof l.id !== 'string') return [];
    const name = str(l.name, 60).trim();
    if (!name) return [];
    return [{ id: str(l.id, 40), name, songIds: ids(l.songIds, 500), isPublic: l.isPublic !== false, createdAt: Number(l.createdAt) || Date.now(), updatedAt: Number(l.updatedAt) || Date.now() }];
  });
  const connections = {};
  for (const k of SERVICES) {
    const c = s.connections && s.connections[k];
    if (c && typeof c === 'object' && c.connectedAt) connections[k] = { connectedAt: Number(c.connectedAt) || Date.now(), name: str(c.name, 80) };
  }
  // Keep metadata only for songs that are rated or on a list.
  const keep = new Set([...order, ...lists.flatMap((l) => l.songIds)]);
  const songs = {};
  for (const [id, x] of Object.entries(s.songs || {})) {
    if (keep.has(id) && x && typeof x === 'object' && id.length < 40) songs[id] = cleanSong(id, x);
  }
  const ratedAt = {};
  for (const [id, t] of Object.entries(s.ratedAt || s.rankedAt || {})) if (keep.has(id) && typeof t === 'number') ratedAt[id] = t;
  return { songs, order, lists, connections, ratedAt, country: str(s.country, 2) || 'us' };
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

/** ES256 JWT that MusicKit needs. Apple allows up to 180 days; the server mints 12h tokens. */
function makeDeveloperToken(cfg, ttlSec = 12 * 3600) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: cfg.keyId, typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iss: cfg.teamId, iat: now, exp: now + ttlSec }));
  const data = `${header}.${payload}`;
  const sig = crypto.sign('sha256', Buffer.from(data), { key: cfg.key, dsaEncoding: 'ieee-p1363' });
  return `${data}.${b64url(sig)}`;
}

// ---------------- Upstream fetches (Apple catalog, charts, Last.fm) ----------------
const proxyCache = new Map();
async function cachedFetchJson(url, ttlMs = 10 * 60 * 1000) {
  const hit = proxyCache.get(url);
  if (hit && Date.now() - hit.t < ttlMs) return hit.data;
  let res;
  try { res = await fetch(url, { headers: { 'User-Agent': 'Encore/3.0' } }); }
  catch { throw Object.assign(new Error('Music service unavailable'), { status: 502 }); }
  if (!res.ok) throw Object.assign(new Error('Upstream ' + res.status), { status: 502 });
  const data = await res.json();
  if (proxyCache.size > 800) proxyCache.clear();
  proxyCache.set(url, { t: Date.now(), data });
  return data;
}
function toSong(r) {
  return {
    id: String(r.trackId), title: r.trackName, artist: r.artistName, album: r.collectionName || '',
    art: r.artworkUrl100 || '', preview: r.previewUrl || '', url: r.trackViewUrl || '', genre: r.primaryGenreName || '',
    year: r.releaseDate ? String(r.releaseDate).slice(0, 4) : '', explicit: r.trackExplicitness === 'explicit',
    artistId: r.artistId ? String(r.artistId) : '', albumId: r.collectionId ? String(r.collectionId) : '',
  };
}
async function lookupSongs(idList, country) {
  const out = [];
  for (let i = 0; i < idList.length; i += 100) {
    const qs = new URLSearchParams({ id: idList.slice(i, i + 100).join(','), country, entity: 'song' });
    const d = await cachedFetchJson(`https://itunes.apple.com/lookup?${qs}`, 60 * 60 * 1000);
    const by = {};
    (d.results || []).filter((r) => r.trackId).forEach((r) => { by[r.trackId] = toSong(r); });
    idList.slice(i, i + 100).forEach((id) => by[id] && out.push(by[id]));
  }
  return out;
}
/** Find the Apple Music track for "title by artist". */
async function resolveTrack(title, artist, country) {
  const qs = new URLSearchParams({ term: `${artist} ${title}`, media: 'music', entity: 'song', limit: '5', country });
  const d = await cachedFetchJson(`https://itunes.apple.com/search?${qs}`, 24 * 3600 * 1000);
  const rs = (d.results || []).filter((r) => r.trackId);
  const a = artist.toLowerCase();
  const hit = rs.find((r) => String(r.artistName).toLowerCase().includes(a)) || rs[0];
  return hit ? toSong(hit) : null;
}
async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch { out[k] = null; } }
  }));
  return out;
}

// ---------------- App ----------------
function createApp({ dbPath = process.env.DATABASE_PATH || path.join(ROOT, 'data', 'encore.db'), env = process.env } = {}) {
  const db = openDb(dbPath);
  const secure = env.COOKIE_SECURE === '1';
  const authLimit = limiter(20, 15 * 60 * 1000);
  const recLimit = limiter(120, 60 * 1000);
  let devToken = null;
  let communityCache = null; // public users' ratings; rebuilt after any write

  const q = {
    userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    insertUser: db.prepare('INSERT INTO users (username, email, display_name, pass_hash, salt, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
    session: db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
    getState: db.prepare('SELECT data, version, updated_at FROM states WHERE user_id = ?'),
    putState: db.prepare(`INSERT INTO states (user_id, data, version, ranked_count, updated_at) VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, version = states.version + 1, ranked_count = excluded.ranked_count, updated_at = excluded.updated_at`),
    updateProfile: db.prepare('UPDATE users SET display_name = ?, bio = ?, avatar = ?, is_public = ?, email = ? WHERE id = ?'),
    searchUsers: db.prepare(`SELECT u.username, u.display_name, u.avatar, COALESCE(s.ranked_count, 0) AS ranked
      FROM users u LEFT JOIN states s ON s.user_id = u.id
      WHERE u.is_public = 1 AND (u.username LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\')
      ORDER BY ranked DESC LIMIT 20`),
    community: db.prepare('SELECT s.user_id, s.data FROM states s JOIN users u ON u.id = s.user_id WHERE u.is_public = 1 AND s.ranked_count >= 2'),
  };

  const publicUser = (u) => ({ username: u.username, displayName: u.display_name, bio: u.bio || '', avatar: u.avatar || '', isPublic: !!u.is_public, createdAt: u.created_at });
  const selfUser = (u) => ({ ...publicUser(u), email: u.email || '' });

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
    if (!row) return { state: null, version: 0, updatedAt: 0 };
    const raw = JSON.parse(row.data);
    const state = Array.isArray(raw.order) ? raw : cleanState(raw); // migrate old bucketed rows on read
    return { state, version: row.version, updatedAt: row.updated_at };
  }
  function community() {
    if (!communityCache) {
      communityCache = q.community.all().map((r) => {
        const raw = JSON.parse(r.data);
        const st = Array.isArray(raw.order) ? raw : cleanState(raw);
        return { userId: r.user_id, order: st.order, songs: st.songs };
      });
    }
    return communityCache;
  }
  const country = (url) => (url.searchParams.get('country') || 'us').toLowerCase().replace(/[^a-z]/g, '').slice(0, 2) || 'us';

  async function api(req, res, url) {
    const p = url.pathname;
    const m = req.method;
    // Only accept JSON writes from our own pages (basic CSRF protection on top of SameSite).
    if (m !== 'GET' && !(req.headers['content-type'] || '').includes('application/json')) return send(res, 415, { error: 'JSON required' });

    if (p === '/api/config' && m === 'GET') {
      return send(res, 200, { appleMusic: !!appleConfig(env), spotifyClientId: env.SPOTIFY_CLIENT_ID || '', lastfm: !!env.LASTFM_API_KEY });
    }

    // ----- Accounts -----
    if (p === '/api/signup' && m === 'POST') {
      if (!authLimit('auth:' + req.socket.remoteAddress)) return send(res, 429, { error: 'Too many attempts. Try again later.' });
      const b = await readJson(req);
      const email = str(b.email, 254).trim().toLowerCase();
      const username = str(b.username, 40).trim();
      const password = typeof b.password === 'string' ? b.password : '';
      if (!EMAIL_RE.test(email)) return send(res, 400, { error: 'Enter a valid email address.', field: 'email' });
      if (!USERNAME_RE.test(username)) return send(res, 400, { error: 'Usernames are 3–24 letters, numbers, _ or .', field: 'username' });
      if (password.length < 8) return send(res, 400, { error: 'Use at least 8 characters for your password.', field: 'password' });
      if (q.userByEmail.get(email)) return send(res, 409, { error: 'An account already uses that email. Try signing in.', field: 'email' });
      if (q.userByName.get(username)) return send(res, 409, { error: 'That username is taken. Try another.', field: 'username' });
      const { hash, salt } = hashPassword(password);
      const r = q.insertUser.run(username, email, str(b.displayName, 40).trim() || username, hash, salt, Date.now());
      startSession(res, Number(r.lastInsertRowid));
      return send(res, 201, { user: selfUser(q.userByName.get(username)), ...stateFor(Number(r.lastInsertRowid)) });
    }

    if (p === '/api/username-available' && m === 'GET') {
      const name = str(url.searchParams.get('u'), 40).trim();
      return send(res, 200, { valid: USERNAME_RE.test(name), available: USERNAME_RE.test(name) && !q.userByName.get(name) });
    }

    if (p === '/api/login' && m === 'POST') {
      if (!authLimit('auth:' + req.socket.remoteAddress)) return send(res, 429, { error: 'Too many attempts. Try again later.' });
      const b = await readJson(req);
      const login = str(b.login || b.email || b.username, 254).trim();
      const u = login.includes('@') ? q.userByEmail.get(login.toLowerCase()) : q.userByName.get(login);
      if (!u || typeof b.password !== 'string' || !verifyPassword(b.password, u.salt, u.pass_hash)) return send(res, 401, { error: 'That email or password isn’t right.' });
      startSession(res, u.id);
      return send(res, 200, { user: selfUser(u), ...stateFor(u.id) });
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
      return send(res, 200, { user: selfUser(u), ...stateFor(u.id) });
    }

    if (p === '/api/me' && m === 'PATCH') {
      const u = currentUser(req);
      if (!u) return send(res, 401, { error: 'Not signed in' });
      const b = await readJson(req);
      const name = typeof b.displayName === 'string' && b.displayName.trim() ? b.displayName.trim().slice(0, 40) : u.display_name;
      const bio = typeof b.bio === 'string' ? b.bio.trim().slice(0, 280) : u.bio;
      let avatar = u.avatar;
      if (typeof b.avatar === 'string') {
        if (b.avatar && (!AVATAR_RE.test(b.avatar) || b.avatar.length > MAX_AVATAR)) return send(res, 400, { error: 'That image can’t be used. Try a smaller JPEG or PNG.' });
        avatar = b.avatar;
      }
      let email = u.email;
      if (typeof b.email === 'string' && b.email.trim().toLowerCase() !== (u.email || '')) {
        email = b.email.trim().toLowerCase();
        if (!EMAIL_RE.test(email)) return send(res, 400, { error: 'Enter a valid email address.' });
        const other = q.userByEmail.get(email);
        if (other && other.id !== u.id) return send(res, 409, { error: 'An account already uses that email.' });
      }
      const isPublic = typeof b.isPublic === 'boolean' ? (b.isPublic ? 1 : 0) : u.is_public;
      q.updateProfile.run(name, bio, avatar, isPublic, email, u.id);
      communityCache = null;
      return send(res, 200, { user: selfUser(q.userByName.get(u.username)) });
    }

    if (p === '/api/state' && m === 'PUT') {
      const u = currentUser(req);
      if (!u) return send(res, 401, { error: 'Not signed in' });
      const b = await readJson(req);
      const cur = stateFor(u.id);
      // Optimistic concurrency: reject writes based on a stale version (another device synced first).
      if (typeof b.baseVersion === 'number' && b.baseVersion !== cur.version) return send(res, 409, { error: 'conflict', ...cur });
      const st = cleanState(b.state);
      q.putState.run(u.id, JSON.stringify(st), st.order.length, Date.now());
      communityCache = null;
      const after = stateFor(u.id);
      return send(res, 200, { version: after.version, updatedAt: after.updatedAt });
    }

    // ----- People -----
    if (p === '/api/users' && m === 'GET') {
      const term = (url.searchParams.get('q') || '').trim().slice(0, 40).replace(/[\\%_]/g, (c) => '\\' + c);
      if (!term) return send(res, 200, { users: [] });
      const rows = q.searchUsers.all(`%${term}%`, `%${term}%`);
      return send(res, 200, { users: rows.map((r) => ({ username: r.username, displayName: r.display_name, avatar: r.avatar || '', ranked: r.ranked })) });
    }

    const prof = p.match(/^\/api\/users\/([^/]+)$/);
    if (prof && m === 'GET') {
      const u = q.userByName.get(decodeURIComponent(prof[1]));
      const me = currentUser(req);
      const own = me && u && me.id === u.id;
      if (!u || (!u.is_public && !own)) return send(res, 404, { error: 'No such user' });
      const st = stateFor(u.id).state || { order: [], lists: [], songs: {}, connections: {} };
      const lists = (st.lists || []).filter((l) => own || l.isPublic);
      const want = new Set([...st.order, ...lists.flatMap((l) => l.songIds)]);
      const songs = {};
      for (const id of want) if (st.songs[id]) songs[id] = st.songs[id];
      return send(res, 200, { user: publicUser(u), order: st.order, lists, songs, connections: Object.keys(st.connections || {}) });
    }

    // ----- Recommendations (collaborative filtering across public profiles) -----
    if (p === '/api/recommendations' && m === 'POST') {
      if (!recLimit('rec:' + req.socket.remoteAddress)) return send(res, 429, { error: 'Slow down a little.' });
      const b = await readJson(req);
      const u = currentUser(req);
      let me;
      if (u) {
        const st = stateFor(u.id).state || { order: [], songs: {} };
        me = { order: st.order, songs: st.songs };
      } else {
        const st = cleanState({ order: b.order, songs: b.songs });
        me = { order: st.order, songs: st.songs };
      }
      // A device can be ahead of the last sync; prefer what it sends.
      if (u && Array.isArray(b.order)) { const st = cleanState({ order: b.order, songs: { ...me.songs, ...(b.songs || {}) } }); me = { order: st.order, songs: st.songs }; }
      me.heard = (Array.isArray(b.heard) ? b.heard : []).slice(0, 60).filter((x) => x && typeof x.id === 'string').map((x) => cleanSong(x.id, x));
      const others = community().filter((o) => !u || o.userId !== u.id);
      const out = recommend({ me, others, limit: Math.min(50, Number(b.limit) || 30) });
      return send(res, 200, { ...out, community: others.length });
    }

    // ----- Apple Music -----
    if (p === '/api/apple/developer-token' && m === 'GET') {
      const cfg = appleConfig(env);
      if (!cfg) return send(res, 404, { error: 'Apple Music isn’t set up on this server yet.' });
      if (!devToken || devToken.exp < Date.now() + 3600e3) devToken = { token: makeDeveloperToken(cfg), exp: Date.now() + 12 * 3600e3 };
      return send(res, 200, { token: devToken.token });
    }

    // Album-art proxy: same-origin copies of Apple artwork, so the app can read
    // pixel colors and draw covers onto the share-card canvas. Apple hosts only.
    if (p === '/api/art' && m === 'GET') {
      let target;
      try { target = new URL(url.searchParams.get('u') || ''); } catch { return send(res, 400, { error: 'Bad URL' }); }
      if (target.protocol !== 'https:' || !ART_HOST_RE.test(target.hostname)) return send(res, 400, { error: 'Only Apple artwork is allowed' });
      let up;
      try { up = await fetch(target, { headers: { 'User-Agent': 'Encore/3.0' } }); } catch { return send(res, 502, { error: 'Artwork unavailable' }); }
      const type = up.headers.get('content-type') || '';
      if (!up.ok || !/^image\/(jpeg|png|webp)/.test(type)) return send(res, 502, { error: 'Artwork unavailable' });
      const buf = Buffer.from(await up.arrayBuffer());
      if (buf.length > MAX_ART) return send(res, 502, { error: 'Artwork too large' });
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=604800', 'X-Content-Type-Options': 'nosniff' });
      return res.end(buf);
    }

    // ----- Genre charts -----
    // /api/charts/current?genre=pop → Apple's top songs in that genre right now.
    // /api/charts/streamed?genre=pop → Last.fm's all-time top tracks for the tag (needs LASTFM_API_KEY).
    const ch = p.match(/^\/api\/charts\/(current|streamed)$/);
    if (ch && m === 'GET') {
      const g = GENRE[url.searchParams.get('genre') || ''];
      if (!g) return send(res, 400, { error: 'Unknown genre' });
      const cc = country(url);
      if (ch[1] === 'current') {
        if (!g.appleId) return send(res, 404, { error: 'Apple has no chart feed for this genre' });
        const feed = await cachedFetchJson(`https://itunes.apple.com/${cc}/rss/topsongs/limit=50/genre=${g.appleId}/json`, 60 * 60 * 1000);
        const idList = ((feed.feed && feed.feed.entry) || []).map((e) => e.id && e.id.attributes && e.id.attributes['im:id']).filter(Boolean);
        if (!idList.length) return send(res, 502, { error: 'Empty chart' });
        return send(res, 200, { source: 'Apple Music', songs: await lookupSongs(idList, cc) });
      }
      if (!env.LASTFM_API_KEY) return send(res, 404, { error: 'Most Streamed needs a Last.fm API key' });
      const qs = new URLSearchParams({ method: 'tag.gettoptracks', tag: g.lastfmTag, api_key: env.LASTFM_API_KEY, format: 'json', limit: '30' });
      const d = await cachedFetchJson(`https://ws.audioscrobbler.com/2.0/?${qs}`, 6 * 3600 * 1000);
      const tracks = ((d.tracks && d.tracks.track) || []).map((t) => ({ title: t.name, artist: t.artist && t.artist.name })).filter((t) => t.title && t.artist).slice(0, 25);
      const songs = (await mapLimit(tracks, 5, (t) => resolveTrack(t.title, t.artist, cc))).filter(Boolean);
      return send(res, 200, { source: 'Last.fm', songs });
    }

    // ----- Apple public catalog proxy (search / lookup / overall chart) -----
    if (p.startsWith('/api/catalog/') && m === 'GET') {
      const cc = country(url);
      const kind = p.slice('/api/catalog/'.length);
      if (kind === 'search') {
        const term = (url.searchParams.get('term') || '').slice(0, 200);
        const qs = new URLSearchParams({ term, media: 'music', entity: 'song', limit: '40', country: cc });
        return send(res, 200, await cachedFetchJson(`https://itunes.apple.com/search?${qs}`));
      }
      if (kind === 'lookup') {
        const idList = (url.searchParams.get('id') || '').split(',').filter((x) => /^\d{1,20}$/.test(x)).slice(0, 150);
        if (!idList.length) return send(res, 200, { results: [] });
        const qs = new URLSearchParams({ id: idList.join(','), country: cc, entity: 'song' });
        return send(res, 200, await cachedFetchJson(`https://itunes.apple.com/lookup?${qs}`));
      }
      if (kind === 'charts') {
        return send(res, 200, await cachedFetchJson(`https://rss.marketingtools.apple.com/api/v2/${cc}/music/most-played/50/songs.json`, 30 * 60 * 1000));
      }
    }

    return send(res, 404, { error: 'Not found' });
  }

  function serveStatic(req, res, url) {
    const asset = url.pathname.match(ASSET_RE);
    const file = STATIC[url.pathname] || (asset && asset[1]);
    if (!file) return send(res, 404, 'Not found');
    fs.readFile(path.join(ROOT, file), (err, buf) => {
      if (err) return send(res, 404, 'Not found');
      // Fonts and icons never change name-for-content; everything else revalidates.
      const cache = /^(fonts|icons)\//.test(file) ? 'public, max-age=2592000, immutable' : 'no-cache';
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' });
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
    console.log(appleConfig() ? 'Apple Music: enabled' : 'Apple Music: off (set APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY)');
    console.log(process.env.SPOTIFY_CLIENT_ID ? 'Spotify: enabled' : 'Spotify: off (set SPOTIFY_CLIENT_ID)');
    console.log(process.env.LASTFM_API_KEY ? 'Most Streamed charts: Last.fm' : 'Most Streamed charts: placeholder data (set LASTFM_API_KEY)');
  });
}
