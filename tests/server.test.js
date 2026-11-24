const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { createApp, makeDeveloperToken, cleanState } = require('../server.js');

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
const song = (id, extra = {}) => ({ id, title: 'Song ' + id, artist: 'Artist ' + id, album: 'LP', genre: 'Pop', ...extra });
const stateWith = (order, extra = {}) => ({ order, songs: Object.fromEntries(order.map((id) => [id, song(id)])), lists: [], connections: {}, ...extra });
const signup = (c, username, email = `${username}@example.com`) => c('/api/signup', { method: 'POST', body: { email, username, password: 'correct horse' } });

test('sign up needs a valid email and a unique username; log in with either', () => withServer({}, async (base) => {
  const a = client(base);
  assert.equal((await a('/api/me')).data.user, null);
  assert.equal((await a('/api/signup', { method: 'POST', body: { email: 'nope', username: 'maya', password: 'correct horse' } })).data.field, 'email');
  assert.equal((await a('/api/signup', { method: 'POST', body: { email: 'm@example.com', username: 'x', password: 'correct horse' } })).data.field, 'username');
  assert.equal((await a('/api/signup', { method: 'POST', body: { email: 'm@example.com', username: 'maya', password: 'short' } })).data.field, 'password');
  const su = await signup(a, 'maya', 'Maya@Example.com');
  assert.equal(su.status, 201);
  assert.equal(su.data.user.email, 'maya@example.com');
  assert.equal(su.data.user.username, 'maya');
  const b = client(base);
  assert.equal((await signup(b, 'MAYA', 'other@example.com')).status, 409);
  assert.equal((await signup(b, 'sam', 'maya@example.com')).data.field, 'email');
  assert.deepEqual((await b('/api/username-available?u=maya')).data, { valid: true, available: false });
  assert.deepEqual((await b('/api/username-available?u=new_name')).data, { valid: true, available: true });
  assert.equal((await b('/api/login', { method: 'POST', body: { login: 'maya@example.com', password: 'nope' } })).status, 401);
  assert.equal((await b('/api/login', { method: 'POST', body: { login: 'MAYA@example.com', password: 'correct horse' } })).status, 200);
  const c = client(base);
  assert.equal((await c('/api/login', { method: 'POST', body: { login: 'maya', password: 'correct horse' } })).status, 200);
}));

test('sync uses the ordered list, keeps lists and services, rejects stale writes', () => withServer({}, async (base) => {
  const a = client(base);
  await signup(a, 'maya');
  const st = stateWith(['1', '2', '3'], {
    lists: [{ id: 'l1', name: 'Gym Songs', songIds: ['3', '9'], isPublic: true }, { id: 'l2', name: '  ', songIds: [] }],
    songs: { 1: song('1'), 2: song('2'), 3: song('3'), 9: song('9'), 77: song('77') },
    connections: { spotify: { connectedAt: 1, name: 'maya', accessToken: 'SECRET' }, bogus: { connectedAt: 1 } },
  });
  assert.equal((await a('/api/state', { method: 'PUT', body: { state: st, baseVersion: 0 } })).data.version, 1);
  assert.equal((await a('/api/state', { method: 'PUT', body: { state: st, baseVersion: 0 } })).status, 409);
  const me = (await a('/api/me')).data;
  assert.deepEqual(me.state.order, ['1', '2', '3']);
  assert.equal(me.state.lists.length, 1, 'nameless list dropped');
  assert.deepEqual(Object.keys(me.state.songs).sort(), ['1', '2', '3', '9'], 'unreferenced song metadata dropped');
  assert.deepEqual(me.state.connections, { spotify: { connectedAt: 1, name: 'maya' } }, 'tokens are never stored');
}));

test('old bucketed data migrates to one ordered list', () => {
  const st = cleanState({ rankings: { liked: ['a', 'b'], fine: ['c'], disliked: ['d'] }, later: ['z'], songs: { a: song('a'), z: song('z') } });
  assert.deepEqual(st.order, ['a', 'b', 'c', 'd']);
  assert.equal(st.later, undefined);
  assert.deepEqual(Object.keys(st.songs), ['a']);
});

test('profiles: bio, avatar, public lists only, privacy toggle', () => withServer({}, async (base) => {
  const a = client(base);
  await signup(a, 'sam_k');
  await a('/api/state', { method: 'PUT', body: { state: stateWith(['1', '2'], { lists: [
    { id: 'p', name: 'Best Rap Song', songIds: ['1'], isPublic: true }, { id: 's', name: 'Secret', songIds: ['2'], isPublic: false }] }) } });
  assert.equal((await a('/api/me', { method: 'PATCH', body: { avatar: 'javascript:alert(1)' } })).status, 400);
  const tiny = 'data:image/png;base64,' + Buffer.from('png').toString('base64');
  const patched = await a('/api/me', { method: 'PATCH', body: { bio: 'Rap and gym music.', avatar: tiny, displayName: 'Sam K' } });
  assert.equal(patched.data.user.bio, 'Rap and gym music.');
  const anon = client(base);
  const prof = (await anon('/api/users/sam_k')).data;
  assert.equal(prof.user.avatar, tiny);
  assert.equal(prof.user.email, undefined, 'email is private');
  assert.deepEqual(prof.lists.map((l) => l.name), ['Best Rap Song']);
  assert.deepEqual(prof.order, ['1', '2']);
  assert.equal((await a('/api/users/sam_k')).data.lists.length, 2, 'owner sees private lists');
  await a('/api/me', { method: 'PATCH', body: { isPublic: false } });
  assert.equal((await anon('/api/users/sam_k')).status, 404);
  assert.equal((await anon('/api/users?q=sam')).data.users.length, 0);
}));

test('recommendations: similar users’ favourites, with reasons, excluding rated songs', () => withServer({}, async (base) => {
  // Three people who agree with "me" on songs a, b, c and all love x; one who disagrees and loves y.
  const order = (ids) => ids;
  for (const [name, o] of [['nb_one', ['a', 'x', 'b', 'c']], ['nb_two', ['x', 'a', 'b', 'c']], ['nb_three', ['a', 'b', 'x', 'c']], ['contrarian', ['y', 'c', 'b', 'a']]]) {
    const c = client(base);
    await signup(c, name);
    await c('/api/state', { method: 'PUT', body: { state: stateWith(order(o)) } });
  }
  const me = client(base);
  await signup(me, 'me_user');
  await me('/api/state', { method: 'PUT', body: { state: stateWith(['a', 'b', 'c']) } });
  const r = (await me('/api/recommendations', { method: 'POST', body: { heard: [song('h1', { title: 'Heard Song' })] } })).data;
  assert.equal(r.neighbours, 3, 'the contrarian is not a neighbour');
  assert.ok(!r.items.some((i) => i.song.id === 'y'), 'the contrarian’s favourite is not suggested');
  assert.equal(r.items[0].song.id, 'h1', 'listening history comes first (rediscovery)');
  const x = r.items.find((i) => i.song.id === 'x');
  assert.ok(x, 'song loved by similar users is recommended');
  assert.match(x.reason, /people with similar taste rated this 9\+|Because you rated/);
  assert.ok(!r.items.some((i) => ['a', 'b', 'c'].includes(i.song.id)), 'never recommends already-rated songs');
  // Guests can send their ratings in the body.
  const guest = client(base);
  const g = (await guest('/api/recommendations', { method: 'POST', body: { order: ['a', 'b', 'c'], songs: stateWith(['a', 'b', 'c']).songs } })).data;
  assert.ok(g.items.some((i) => i.song.id === 'x'));
}));

test('charts validate the genre; Most Streamed needs a Last.fm key; config reports what is on', () => withServer({}, async (base) => {
  const c = client(base);
  assert.equal((await c('/api/charts/current?genre=polka')).status, 400);
  assert.equal((await c('/api/charts/streamed?genre=edm')).status, 404);
  assert.equal((await c('/api/charts/current?genre=indie')).status, 404, 'no Apple feed for indie');
  assert.deepEqual((await c('/api/config')).data, { appleMusic: false, spotifyClientId: '', lastfm: false });
}));

test('serves app assets but nothing else; art proxy only accepts Apple artwork', () => withServer({}, async (base) => {
  for (const f of ['/', '/genres.js', '/recommend.js', '/config.js', '/ranking.js']) assert.equal((await fetch(base + f)).status, 200, f);
  for (const f of ['/server.js', '/package.json', '/tests/e2e.js', '/scripts/musickit-token.js', '/data/encore.db']) assert.equal((await fetch(base + f)).status, 404, f);
  for (const u of ['https://evil.example.com/a.jpg', 'http://is1-ssl.mzstatic.com/a.jpg', 'https://mzstatic.com.evil.io/a.jpg']) {
    assert.equal((await fetch(base + '/api/art?u=' + encodeURIComponent(u))).status, 400, u);
  }
  const r = await fetch(base + '/api/login', { method: 'POST', body: 'x', headers: { 'Content-Type': 'text/plain' } });
  assert.equal(r.status, 415);
}));

test('Apple Music developer token is a valid ES256 JWT', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwt = makeDeveloperToken({ teamId: 'TEAM123456', keyId: 'KEY1234567', key: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
  const [h, p, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'ES256', kid: 'KEY1234567', typ: 'JWT' });
  assert.equal(JSON.parse(Buffer.from(p, 'base64url')).iss, 'TEAM123456');
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
});
