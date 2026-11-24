const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { createApp, makeDeveloperToken } = require('../server.js');

async function withServer(env, fn) {
  const server = createApp({ dbPath: ':memory:', env });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { await new Promise((r) => server.close(r)); }
}
function client(base) {
  let cookie = '';
  return async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  };
}
const sampleState = {
  songs: { 1: { id: '1', title: 'A', artist: 'X', album: 'LP' }, 2: { id: '2', title: 'B', artist: 'X', album: 'LP' } },
  rankings: { liked: ['1'], fine: ['2'], disliked: [] }, later: [], rankedAt: {}, country: 'us',
};

test('signup, session cookie, sync, conflict detection, logout', () => withServer({}, async (base) => {
  const a = client(base);
  assert.equal((await a('/api/me')).data.user, null);
  assert.equal((await a('/api/signup', { method: 'POST', body: { username: 'x', password: 'longenough' } })).status, 400);
  assert.equal((await a('/api/signup', { method: 'POST', body: { username: 'maya', password: 'short' } })).status, 400);
  const su = await a('/api/signup', { method: 'POST', body: { username: 'maya', password: 'correct horse', displayName: 'Maya' } });
  assert.equal(su.status, 201);
  assert.equal(su.data.user.displayName, 'Maya');
  assert.equal(su.data.state, null);
  assert.equal((await a('/api/signup', { method: 'POST', body: { username: 'MAYA', password: 'whatever123' } })).status, 409);

  const put = await a('/api/state', { method: 'PUT', body: { state: sampleState, baseVersion: 0 } });
  assert.equal(put.status, 200);
  assert.equal(put.data.version, 1);
  // A second device still on version 0 must not overwrite.
  const stale = await a('/api/state', { method: 'PUT', body: { state: sampleState, baseVersion: 0 } });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.version, 1);

  const me = await a('/api/me');
  assert.deepEqual(me.data.state.rankings, sampleState.rankings);

  // Second browser logs in and gets the same list.
  const b = client(base);
  assert.equal((await b('/api/login', { method: 'POST', body: { username: 'maya', password: 'nope' } })).status, 401);
  const li = await b('/api/login', { method: 'POST', body: { username: 'Maya', password: 'correct horse' } });
  assert.equal(li.status, 200);
  assert.equal(li.data.version, 1);
  assert.deepEqual(li.data.state.rankings.liked, ['1']);

  await a('/api/logout', { method: 'POST', body: {} });
  assert.equal((await a('/api/me')).data.user, null);
  assert.equal((await a('/api/state', { method: 'PUT', body: { state: sampleState } })).status, 401);
}));

test('public profiles, privacy toggle and user search', () => withServer({}, async (base) => {
  const a = client(base);
  await a('/api/signup', { method: 'POST', body: { username: 'sam_k', password: 'password1', displayName: 'Sam K' } });
  await a('/api/state', { method: 'PUT', body: { state: sampleState } });
  const anon = client(base);
  const prof = await anon('/api/users/sam_k');
  assert.equal(prof.status, 200);
  assert.equal(prof.data.user.displayName, 'Sam K');
  assert.deepEqual(Object.keys(prof.data.songs).sort(), ['1', '2']);
  assert.equal((await anon('/api/users?q=sam')).data.users[0].ranked, 2);
  assert.equal((await anon('/api/users?q=%25')).data.users.length, 0); // LIKE wildcards escaped

  await a('/api/me', { method: 'PATCH', body: { isPublic: false } });
  assert.equal((await anon('/api/users/sam_k')).status, 404);
  assert.equal((await anon('/api/users?q=sam')).data.users.length, 0);
  assert.equal((await a('/api/users/sam_k')).status, 200); // owner can still see it
}));

test('rejects non-JSON writes and does not serve server files', () => withServer({}, async (base) => {
  const r = await fetch(base + '/api/login', { method: 'POST', body: 'username=a&password=b', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  assert.equal(r.status, 415);
  assert.equal((await fetch(base + '/server.js')).status, 404);
  assert.equal((await fetch(base + '/data/encore.db')).status, 404);
  assert.equal((await fetch(base + '/')).status, 200);
}));

test('Apple Music developer token is a valid ES256 JWT', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const jwt = makeDeveloperToken({ teamId: 'TEAM123456', keyId: 'KEY1234567', key: pem });
  const [h, p, s] = jwt.split('.');
  const header = JSON.parse(Buffer.from(h, 'base64url'));
  const payload = JSON.parse(Buffer.from(p, 'base64url'));
  assert.deepEqual(header, { alg: 'ES256', kid: 'KEY1234567', typ: 'JWT' });
  assert.equal(payload.iss, 'TEAM123456');
  assert.ok(payload.exp > payload.iat);
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
});

test('developer-token endpoint: 404 when unconfigured, token when configured', async () => {
  await withServer({}, async (base) => assert.equal((await fetch(base + '/api/apple/developer-token')).status, 404));
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const env = { APPLE_TEAM_ID: 'T', APPLE_KEY_ID: 'K', APPLE_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  await withServer(env, async (base) => {
    const r = await (await fetch(base + '/api/apple/developer-token')).json();
    assert.equal(r.token.split('.').length, 3);
  });
});

test('serves app assets but nothing else, and the art proxy only accepts Apple artwork', () => withServer({}, async (base) => {
  const font = await fetch(base + '/fonts/manrope-latin-wght-normal.woff2');
  assert.equal(font.status, 200);
  assert.equal(font.headers.get('content-type'), 'font/woff2');
  assert.match(font.headers.get('cache-control'), /immutable/);
  assert.equal((await fetch(base + '/fonts/../server.js')).status, 404);
  assert.equal((await fetch(base + '/js/../package.json')).status, 404);
  assert.equal((await fetch(base + '/tests/e2e.js')).status, 404);
  for (const u of ['https://evil.example.com/a.jpg', 'http://is1-ssl.mzstatic.com/a.jpg', 'https://mzstatic.com.evil.io/a.jpg', 'not a url']) {
    assert.equal((await fetch(base + '/api/art?u=' + encodeURIComponent(u))).status, 400, u);
  }
}));
