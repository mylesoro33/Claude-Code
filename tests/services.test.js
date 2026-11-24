const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../server.js');
const { parse } = require('../lib/env');
const { createBox } = require('../lib/crypto-box');

/** A fake "internet": Spotify + Google + Last.fm endpoints, recording every call. */
function fakeWeb() {
  const calls = [];
  let tokenN = 0;
  let refreshWorks = true;
  const json = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
  async function fetch(url, opts = {}) {
    const u = new URL(url);
    calls.push({ method: opts.method || 'GET', url: u.origin + u.pathname, query: Object.fromEntries(u.searchParams), body: opts.body, headers: opts.headers || {} });
    const form = typeof opts.body === 'string' ? Object.fromEntries(new URLSearchParams(opts.body)) : {};
    if (u.host === 'accounts.spotify.com' && u.pathname === '/api/token') {
      if (form.grant_type === 'refresh_token' && !refreshWorks) return json(400, { error: 'invalid_grant' });
      if (form.grant_type === 'client_credentials') return json(200, { access_token: 'cc', expires_in: 3600 });
      tokenN++;
      return json(200, { access_token: 'sp-access-' + tokenN, refresh_token: 'sp-refresh', expires_in: 3600 });
    }
    if (u.host === 'api.spotify.com') {
      const auth = (opts.headers || {}).Authorization || '';
      if (!auth.startsWith('Bearer ')) return json(401, { error: { message: 'no token' } });
      if (u.pathname === '/v1/me') return json(200, { id: 'maya_sp', display_name: 'Maya on Spotify' });
      if (u.pathname === '/v1/me/player/recently-played') return json(200, { items: [{ track: { id: 't1', name: 'Golden Hour', artists: [{ name: 'JVKE' }], album: { name: 'this is what ____ feels like', images: [{ url: 'https://i.scdn.co/a.jpg' }] } } }] });
      if (u.pathname === '/v1/search') return json(200, { tracks: { items: [{ id: 'wrong', name: 'Golden Hour (Cover)', artists: [{ name: 'Someone' }] }, { id: 't1', name: 'Golden Hour', artists: [{ name: 'JVKE' }] }] } });
      if (u.pathname === '/v1/me/tracks' && opts.method === 'PUT') return { ok: true, status: 200, text: async () => '' };
      if (u.pathname === '/v1/me/playlists') return json(200, { items: [{ id: 'p1', name: 'Gym', owner: { id: 'maya_sp' }, tracks: { total: 3 } }, { id: 'p2', name: 'Someone else’s', owner: { id: 'x' } }] });
      if (u.pathname === '/v1/users/maya_sp/playlists' && opts.method === 'POST') return json(201, { id: 'p9', name: JSON.parse(opts.body).name });
      if (u.pathname === '/v1/playlists/p1/tracks' && opts.method === 'POST') return json(201, { snapshot_id: 's' });
      if (u.pathname === '/v1/users/djmaya') return json(200, { id: 'djmaya', display_name: 'DJ Maya' });
      if (u.pathname === '/v1/users/djmaya/playlists') return json(200, { items: [{ id: 'pp', name: 'Summer' }] });
      if (u.pathname === '/v1/playlists/pp/tracks') return json(200, { items: [{ track: { id: 'z', name: 'Levitating', artists: [{ name: 'Dua Lipa' }], album: { name: 'FN', images: [] } } }] });
    }
    if (u.host === 'oauth2.googleapis.com') return json(200, { access_token: 'g-access', refresh_token: 'g-refresh', expires_in: 3600 });
    if (u.host === 'www.googleapis.com' && u.pathname === '/youtube/v3/channels') return json(200, { items: [{ id: 'UC1', snippet: { title: 'Maya Tube' } }] });
    if (u.host === 'www.googleapis.com' && u.pathname === '/youtube/v3/videos') return json(200, { items: [{ id: 'v1', snippet: { title: 'JVKE - golden hour (Official Video)', channelTitle: 'JVKE', categoryId: '10' } }, { id: 'v2', snippet: { title: 'cat video', channelTitle: 'cats', categoryId: '15' } }] });
    if (u.host === 'ws.audioscrobbler.com') {
      if (u.searchParams.get('method') === 'user.getrecenttracks') return json(200, { recenttracks: { track: [{ name: 'Flowers', artist: { '#text': 'Miley Cyrus' }, album: { '#text': 'Endless Summer Vacation' } }] } });
      return json(200, { toptracks: { track: [{ name: 'Flowers', artist: { name: 'Miley Cyrus' }, playcount: '41' }, { name: 'Espresso', artist: { name: 'Sabrina Carpenter' }, playcount: '30' }] } });
    }
    return json(404, { error: 'unmocked ' + url });
  }
  return { fetch, calls, setRefresh: (v) => { refreshWorks = v; } };
}

async function withServer(env, web, fn) {
  const server = createApp({ dbPath: ':memory:', env, fetch: web.fetch, log: () => {} });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { await new Promise((r) => server.close(r)); }
}
function browser(base) {
  const jar = {};
  return async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(base + path, { method, redirect: 'manual', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') }, body: body ? JSON.stringify(body) : undefined });
    for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) { const [kv] = c.split(';'); const [k, v] = kv.split('='); jar[k] = v; }
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, location: res.headers.get('location') };
  };
}
const ENV = { APP_URL: 'https://encore.test', TOKEN_ENCRYPTION_KEY: 'a'.repeat(64), SPOTIFY_CLIENT_ID: 'sp-id', SPOTIFY_CLIENT_SECRET: 'sp-secret', GOOGLE_CLIENT_ID: 'g-id', GOOGLE_CLIENT_SECRET: 'g-secret', LASTFM_API_KEY: 'lf' };

test('.env parser and token encryption', () => {
  assert.deepEqual(parse('# c\nA=1\nexport B="x\\ny"\nC=\'q\' \nD=plain # comment\nbad line'), { A: '1', B: 'x\ny', C: 'q', D: 'plain' });
  const box = createBox('b'.repeat(64), () => {});
  const sealed = box.seal({ access: 'secret-token' });
  assert.ok(!sealed.includes('secret-token'));
  assert.deepEqual(box.open(sealed), { access: 'secret-token' });
  assert.equal(createBox('c'.repeat(64), () => {}).open(sealed), null, 'another key cannot read it');
});

test('unconfigured services say exactly which env vars are missing', () => withServer({ APP_URL: 'https://encore.test' }, fakeWeb(), async (base) => {
  const b = browser(base);
  const list = (await b('/api/connections')).data.connections;
  assert.deepEqual(list.find((c) => c.service === 'youtube').missing, ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
  assert.deepEqual(list.find((c) => c.service === 'spotify').missing, ['SPOTIFY_CLIENT_ID']);
  const r = await b('/auth/soundcloud/start');
  assert.equal(r.status, 302);
  assert.match(r.location, /svc_error=SoundCloud/);
}));

test('Spotify: full OAuth round-trip with PKCE, recent, favorite, playlists, quiet refresh, revoked access', () => {
  const web = fakeWeb();
  return withServer(ENV, web, async (base) => {
    const b = browser(base);
    const start = await b('/auth/spotify/start');
    assert.equal(start.status, 302);
    const auth = new URL(start.location);
    assert.equal(auth.host, 'accounts.spotify.com');
    assert.equal(auth.searchParams.get('redirect_uri'), 'https://encore.test/auth/spotify/callback');
    assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
    assert.match(auth.searchParams.get('scope'), /user-library-modify.*playlist-modify-private/);
    // Forged state is refused.
    assert.match((await b('/auth/spotify/callback?code=x&state=forged')).location, /svc_error/);
    const cb = await b(`/auth/spotify/callback?code=good-code&state=${auth.searchParams.get('state')}`);
    assert.equal(cb.location, '/?connected=spotify#profile');
    const exch = web.calls.find((c) => c.url.endsWith('/api/token') && /authorization_code/.test(c.body));
    assert.match(exch.body, /code_verifier=/);
    assert.match(exch.headers.Authorization, /^Basic /, 'secret sent server-side only');
    const conn = (await b('/api/connections')).data.connections.find((c) => c.service === 'spotify');
    assert.deepEqual([conn.connected, conn.account], [true, 'Maya on Spotify']);

    assert.equal((await b('/api/svc/spotify/recent')).data.tracks[0].title, 'Golden Hour');
    const fav = await b('/api/svc/spotify/favorite', { method: 'POST', body: { title: 'Golden Hour', artist: 'JVKE' } });
    assert.equal(fav.data.matched.id, 't1', 'picked the real song, not the cover');
    assert.ok(web.calls.some((c) => c.method === 'PUT' && c.url.endsWith('/v1/me/tracks') && c.query.ids === 't1'));
    assert.deepEqual((await b('/api/svc/spotify/playlists')).data.playlists.map((p) => p.name), ['Gym'], 'only playlists you can edit');
    assert.equal((await b('/api/svc/spotify/playlists', { method: 'POST', body: { name: 'Encore Favorites' } })).data.playlist.id, 'p9');
    assert.equal((await b('/api/svc/spotify/playlists/p1/tracks', { method: 'POST', body: { title: 'Golden Hour', artist: 'JVKE' } })).data.matched.id, 't1');
  });
});

test('expired token refreshes quietly; revoked refresh asks to reconnect', () => {
  const web = fakeWeb();
  const env = { ...ENV };
  return withServer(env, web, async (base) => {
    const b = browser(base);
    const auth = new URL((await b('/auth/spotify/start')).location);
    await b(`/auth/spotify/callback?code=c&state=${auth.searchParams.get('state')}`);
    // Make the stored token look expired: the next call must refresh first.
    const realNow = Date.now;
    Date.now = () => realNow() + 2 * 3600e3;
    try {
      assert.equal((await b('/api/svc/spotify/recent')).status, 200);
      assert.ok(web.calls.some((c) => /grant_type=refresh_token/.test(c.body || '')), 'refreshed quietly');
      web.setRefresh(false);
      Date.now = () => realNow() + 4 * 3600e3;
      const r = await b('/api/svc/spotify/recent');
      assert.equal(r.status, 401);
      assert.equal(r.data.reauth, true);
      assert.equal((await b('/api/connections')).data.connections.find((c) => c.service === 'spotify').connected, false);
    } finally { Date.now = realNow; }
  });
});

test('guest connections move to the account at sign-up; YouTube likes become songs', () => withServer(ENV, fakeWeb(), async (base) => {
  const b = browser(base);
  const auth = new URL((await b('/auth/youtube/start')).location);
  assert.equal(auth.searchParams.get('access_type'), 'offline');
  await b(`/auth/youtube/callback?code=c&state=${auth.searchParams.get('state')}`);
  const recent = (await b('/api/svc/youtube/recent')).data.tracks;
  assert.deepEqual(recent.map((t) => [t.artist, t.title]), [['JVKE', 'golden hour']], 'non-music likes skipped; title split');
  await b('/api/signup', { method: 'POST', body: { email: 'm@example.com', username: 'maya', password: 'correct horse' } });
  const conn = (await b('/api/connections')).data.connections.find((c) => c.service === 'youtube');
  assert.equal(conn.connected, true);
  const other = browser(base);
  assert.equal((await other('/api/connections')).data.connections.find((c) => c.service === 'youtube').connected, false, 'not visible to anyone else');
}));

test('Find my account: Last.fm and Spotify public profiles', () => withServer(ENV, fakeWeb(), async (base) => {
  const b = browser(base);
  const lf = (await b('/api/lookup', { method: 'POST', body: { service: 'lastfm', input: 'https://www.last.fm/user/rj' } })).data;
  assert.deepEqual(lf.tracks.map((t) => t.title), ['Flowers', 'Espresso']);
  const sp = (await b('/api/lookup', { method: 'POST', body: { service: 'spotify', input: 'https://open.spotify.com/user/djmaya?si=x' } })).data;
  assert.equal(sp.account, 'DJ Maya');
  assert.equal(sp.tracks[0].title, 'Levitating');
  const yt = await b('/api/lookup', { method: 'POST', body: { service: 'youtube', input: '@someone' } });
  assert.equal(yt.status, 501, 'YouTube lookup says it needs YOUTUBE_API_KEY');
}));
