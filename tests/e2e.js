// End-to-end test: a real Encore server (in-process, temp DB) whose outbound
// requests go to a fake internet (Apple/Deezer/Kworb/Last.fm charts, Spotify
// OAuth + Web API), plus browser-side mocks for Apple's catalog, artwork,
// previews and MusicKit. Phone (390px) and desktop (1280px); saves screenshots.
// Usage: node tests/e2e.js [screenshotDir]
const { chromium } = require('playwright');
const { createApp } = require('../server.js');
const out = process.argv[2] || '.';

const rows = [
  ['Midnight Drive', 'Nova Lane', 'Night Shift', 'Pop', ['#3b1d12', '#c8552a', '#f2d9a6']],
  ['Golden Hour (Extended Sunset Version) [feat. The Very Long Name Orchestra]', 'Kite Club', 'Sunline', 'Pop', ['#f2c46b', '#c4572c', '#2b1a12']],
  ['Static', 'Nova Lane', 'Night Shift', 'Pop', ['#3b1d12', '#c8552a', '#f2d9a6']],
  ['Paper Planes', 'The Oaks', 'Timber', 'Rock', null],
  ['Low Tide', 'Mira', 'Harbor', 'R&B/Soul', ['#14302f', '#5e8f7e', '#efe2c6']],
  ['Neon Rain', 'Kite Club', 'Sunline', 'Pop', ['#f2c46b', '#c4572c', '#2b1a12']],
  ['Saltwater', 'The Oaks', 'Timber', 'Rock', null],
  ['Glass House', 'Mira', 'Harbor', 'R&B/Soul', ['#14302f', '#5e8f7e', '#efe2c6']],
  ['Cypher', 'MC Static', 'Tape One', 'Hip-Hop/Rap', ['#1f1a2e', '#d6a84a', '#e9e2d0']],
  ['Dirt Road', 'Dusty Roads', 'Back Porch', 'Country', ['#5a3a1c', '#b98b4e', '#f3e3c2']],
];
const albums = [...new Set(rows.map((r) => r[2]))];
const itunes = (n, a, al, g, i, id) => ({
  kind: 'song', wrapperType: 'track', trackId: id, trackName: n, artistName: a, collectionName: al,
  artistId: 50 + i, collectionId: 90 + albums.indexOf(al), primaryGenreName: g, releaseDate: '2025-01-01',
  artworkUrl100: `https://is1-ssl.mzstatic.com/image/thumb/Music/mock${albums.indexOf(al)}/100x100bb.jpg`,
  previewUrl: `https://audio-ssl.itunes.apple.com/mock/${i}.m4a`, trackViewUrl: 'https://music.apple.com/', trackExplicitness: 'none',
});
const songs = rows.map(([n, a, al, g], i) => itunes(n, a, al, g, i, 1000 + i));
const byId = (id) => songs.find((s) => s.trackId === id);
const taste = { 1000: 3, 1001: 9, 1002: 1, 1003: 7, 1004: 5, 1005: 8, 1006: 2, 1007: 6, 1008: 4, 1009: 4 };
const ARTIST_GENRE = { 'nova lane': ['pop'], 'kite club': ['pop', 'indie pop'], mira: ['rnb', 'soul'], 'the oaks': ['rock'], 'mc static': ['hip-hop', 'rap'], 'dusty roads': ['country'] };

function wav(seconds = 4, rate = 22050) {
  const n = seconds * rate;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) { const t = i / rate; buf.writeInt16LE(Math.round((0.3 * Math.sin(2 * Math.PI * 220 * t) + 0.15 * Math.sin(2 * Math.PI * 660 * t)) * 16000), 44 + i * 2); }
  return buf;
}
const AUDIO = wav();

async function makeCovers(browser) {
  const p = await browser.newPage({ viewport: { width: 300, height: 300 } });
  const covers = {};
  for (const [, , al, , pal] of rows) {
    const i = albums.indexOf(al);
    if (!pal || covers[i]) continue;
    await p.setContent(`<body style="margin:0"><div style="width:300px;height:300px;position:relative;overflow:hidden;background:${pal[0]}">
      <div style="position:absolute;left:-40px;top:${60 + i * 25}px;width:380px;height:90px;background:${pal[1]};transform:rotate(-12deg)"></div>
      <div style="position:absolute;right:24px;top:24px;width:${70 + i * 12}px;height:${70 + i * 12}px;border-radius:50%;background:${pal[2]}"></div>
      <div style="position:absolute;left:18px;bottom:16px;font:900 32px/1 Georgia,serif;color:${pal[2]}">${al}</div></div></body>`);
    covers[i] = await p.screenshot({ type: 'png' });
  }
  await p.close();
  return covers;
}

/** The server's view of the internet: charts sources, Last.fm, Spotify. Records calls. */
function serverWeb() {
  const calls = [];
  const res = (body, status = 200) => ({ ok: status < 400, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  const feed = (ids) => ({ feed: { entry: ids.map((id) => { const s = byId(id); return { 'im:name': { label: s.trackName }, 'im:artist': { label: s.artistName }, 'im:image': [{ label: s.artworkUrl100 }], id: { attributes: { 'im:id': String(id) } }, category: { attributes: { label: s.primaryGenreName } } }; }) } });
  const kworbRow = (id, streams) => `<tr><td class="text"><div><a href="#">${byId(id).artistName}</a> - <a href="#">${byId(id).trackName}</a></div></td><td>${streams.toLocaleString('en-US')}</td><td>1</td></tr>`;
  const spTrack = (id) => ({ id: 'sp' + id, name: byId(id).trackName, artists: [{ name: byId(id).artistName }], album: { name: byId(id).collectionName, images: [] } });
  async function fetch(url, opts = {}) {
    const u = new URL(url);
    calls.push({ method: opts.method || 'GET', host: u.host, path: u.pathname, query: Object.fromEntries(u.searchParams), body: opts.body });
    const G = u.pathname.match(/genre=(\d+)/);
    if (u.host === 'itunes.apple.com' && G) return res(feed({ 14: [1001, 1004, 1008], 18: [1008, 1005], 15: [1007, 1004], 6: [1009], 21: [1003, 1006] }[G[1]] || []));
    if (u.host === 'rss.marketingtools.apple.com') return res({ feed: { results: [1001, 1008, 1007, 1000, 1003, 1009].map((id) => ({ id: String(id), name: byId(id).trackName, artistName: byId(id).artistName, artworkUrl100: byId(id).artworkUrl100 })) } });
    if (u.host === 'itunes.apple.com' && u.pathname === '/search') {
      const term = (u.searchParams.get('term') || '').toLowerCase();
      if (u.searchParams.get('entity') === 'musicArtist') { const s = songs.find((x) => x.artistName.toLowerCase() === term); return res({ results: s ? [{ artistName: s.artistName, primaryGenreName: s.primaryGenreName }] : [] }); }
      return res({ results: songs.filter((s) => term.includes(s.trackName.toLowerCase().slice(0, 8)) || term.includes(s.artistName.toLowerCase())) });
    }
    if (u.host === 'api.deezer.com') return res({ data: [] });
    if (u.host === 'kworb.net' && u.pathname.endsWith('songs.html')) return res(`<table><thead><tr><th>Artist and Title</th><th>Streams</th><th>Daily</th></tr></thead><tbody>${kworbRow(1001, 3100000000)}${kworbRow(1008, 2200000000)}${kworbRow(1007, 1900000000)}${kworbRow(1003, 1500000000)}${kworbRow(1009, 900000000)}</tbody></table>`);
    if (u.host === 'kworb.net') return res(`<table><thead><tr><th>Pos</th><th>P+</th><th>Artist and Title</th><th>Days</th><th>Pk</th><th>Streams</th></tr></thead><tbody>${kworbRow(1000, 0).replace('<td class', '<td>1</td><td>=</td><td class').replace(/<td>0<\/td><td>1<\/td>/, '<td>12</td><td>1</td><td>4,000,000</td>')}</tbody></table>`);
    if (u.host === 'ws.audioscrobbler.com') {
      const m = u.searchParams.get('method');
      if (m === 'artist.gettoptags') return res({ toptags: { tag: (ARTIST_GENRE[(u.searchParams.get('artist') || '').toLowerCase()] || []).map((name) => ({ name })) } });
      if (m === 'user.getrecenttracks') return res(u.searchParams.get('user') === 'nobody' ? { error: 6, message: 'User not found' } : { recenttracks: { track: [{ name: 'Saltwater', artist: { '#text': 'The Oaks' } }, { name: 'Static', artist: { '#text': 'Nova Lane' } }] } });
      if (m === 'user.gettoptracks') return res({ toptracks: { track: [] } });
      return res({ tracks: { track: [] } });
    }
    if (u.host === 'accounts.spotify.com' && u.pathname === '/api/token') return res({ access_token: 'sp-access', refresh_token: 'sp-refresh', expires_in: 3600 });
    if (u.host === 'api.spotify.com') {
      const p = u.pathname;
      if (p === '/v1/me') return res({ id: 'maya_sp', display_name: 'Maya on Spotify' });
      if (p === '/v1/me/player/recently-played') return res({ items: [{ track: spTrack(1007) }, { track: spTrack(1009) }] });
      if (p === '/v1/search') { const q = (u.searchParams.get('q') || '').toLowerCase(); const s = songs.find((x) => q.includes(x.trackName.toLowerCase().slice(0, 10))); return res({ tracks: { items: s ? [spTrack(s.trackId)] : [] } }); }
      if (p === '/v1/me/tracks') return res('', 200);
      if (p === '/v1/me/playlists') return res({ items: [{ id: 'pl1', name: 'Gym Mix', owner: { id: 'maya_sp' }, tracks: { total: 12 } }] });
      if (p === '/v1/users/maya_sp/playlists') return res({ id: 'pl2', name: JSON.parse(opts.body).name }, 201);
      if (/^\/v1\/playlists\/pl\d\/tracks$/.test(p)) return res({ snapshot_id: 'x' }, 201);
    }
    return res({ error: 'unmocked ' + url }, 404);
  }
  return { fetch, calls };
}

async function mockBrowser(page, covers, appleCalls = []) {
  page.on('pageerror', (e) => { console.log('PAGEERROR', e.message); process.exitCode = 1; });
  const cors = { 'Access-Control-Allow-Origin': '*' };
  const search = (term) => {
    const t = term.toLowerCase();
    const hits = songs.filter((s) => t === 'all' || `${s.artistName} ${s.trackName}`.toLowerCase().includes(t) || t.includes(s.trackName.toLowerCase().slice(0, 10)));
    return hits;
  };
  await page.route('**/api/catalog/search*', (r) => r.fulfill({ json: { results: search(new URL(r.request().url()).searchParams.get('term')) } }));
  await page.route('**/api/catalog/lookup*', (r) => r.fulfill({ json: { results: new URL(r.request().url()).searchParams.get('id').split(',').map((id) => byId(+id)).filter(Boolean) } }));
  const top = { feed: { results: songs.slice(0, 8).map((s) => ({ id: String(s.trackId) })) } };
  await page.route('**/api/catalog/charts*', (r) => r.fulfill({ json: top }));
  // Before the app knows a server exists it talks to Apple directly.
  await page.route('https://rss.marketingtools.apple.com/**', (r) => r.fulfill({ json: top, headers: cors }));
  await page.route('https://itunes.apple.com/**', (r) => {
    const u = new URL(r.request().url());
    if (u.pathname === '/lookup') return r.fulfill({ json: { results: u.searchParams.get('id').split(',').map((id) => byId(+id)).filter(Boolean) }, headers: cors });
    if (u.pathname === '/search') return r.fulfill({ json: { results: search(u.searchParams.get('term') || '') }, headers: cors });
    return r.abort();
  });
  const serveArt = (r, url) => { const m = url.match(/mock(\d+)/); const png = m && covers[+m[1]]; return png ? r.fulfill({ body: png, contentType: 'image/png', headers: cors }) : r.abort(); };
  await page.route('https://is1-ssl.mzstatic.com/**', (r) => serveArt(r, r.request().url()));
  await page.route((u) => u.pathname === '/api/art', (r) => serveArt(r, new URL(r.request().url()).searchParams.get('u') || ''));
  await page.route('https://audio-ssl.itunes.apple.com/**', (r) => r.fulfill({ body: AUDIO, contentType: 'audio/wav', headers: cors }));
  await page.route('**/api/apple/developer-token', (r) => r.fulfill({ json: { token: 'test-developer-token' } }));
  // The test server has no Apple key; report Apple Music as set up (the token route above stands in for it).
  await page.route((u) => u.pathname === '/api/config', async (r) => { const resp = await r.fetch(); const j = await resp.json(); r.fulfill({ json: { ...j, appleMusic: true } }); });
  // Spotify's consent screen: let Encore start the sign-in, then "approve" and go straight to the callback.
  await page.route((u) => u.pathname === '/auth/spotify/start', async (r) => {
    const resp = await r.fetch({ maxRedirects: 0 });
    const auth = new URL(resp.headers().location);
    const headers = { Location: `${auth.searchParams.get('redirect_uri')}?code=approved&state=${auth.searchParams.get('state')}` };
    if (resp.headers()['set-cookie']) headers['Set-Cookie'] = resp.headers()['set-cookie'];
    r.fulfill({ status: 302, headers });
  });
  await page.route('https://api.music.apple.com/**', (r) => {
    const req = r.request();
    const u = new URL(req.url());
    appleCalls.push(`${req.method()} ${u.pathname}${u.search}`);
    if (u.pathname === '/v1/me/recent/played/tracks') {
      const data = [1001, 1005].map((id) => ({ id: String(id), type: 'songs', attributes: { name: byId(id).trackName, artistName: byId(id).artistName, albumName: byId(id).collectionName, genreNames: [byId(id).primaryGenreName], artwork: { url: byId(id).artworkUrl100.replace('100x100bb', '{w}x{h}bb') }, previews: [{ url: byId(id).previewUrl }] } }));
      return r.fulfill({ json: { data }, headers: cors });
    }
    if (u.pathname === '/v1/me/library/playlists' && req.method() === 'GET') return r.fulfill({ json: { data: [{ id: 'p.am1', attributes: { name: 'Late Night', canEdit: true } }] }, headers: cors });
    if (u.pathname === '/v1/me/library/playlists' && req.method() === 'POST') return r.fulfill({ status: 201, json: { data: [{ id: 'p.am2' }] }, headers: cors });
    return r.fulfill({ status: 202, body: '', headers: cors });
  });
  await page.addInitScript(() => {
    // Like real MusicKit, the sign-in survives a page reload.
    const was = localStorage.getItem('mk-test-auth') === '1';
    const music = { isAuthorized: was, musicUserToken: was ? 'user-token' : '', storefrontId: 'us', playbackState: 0, currentPlaybackProgress: 0,
      async authorize() { await new Promise((res) => setTimeout(res, 120)); this.isAuthorized = true; this.musicUserToken = 'user-token'; localStorage.setItem('mk-test-auth', '1'); return 'user-token'; },
      async unauthorize() { this.isAuthorized = false; localStorage.removeItem('mk-test-auth'); }, addEventListener() {}, async setQueue() { throw new Error('preview only in tests'); }, stop() {}, pause() {}, play() {} };
    window.MusicKit = { configure: async () => music, PlaybackStates: { playing: 2, paused: 3, completed: 10, ended: 5 } };
  });
}

const check = (label, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) process.exitCode = 1; };
const noOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const settle = (p, ms = 600) => p.waitForTimeout(ms);
async function closeSheet(p) {
  const done = p.locator('[data-done="close"]');
  if (await done.count()) await done.click(); else await p.keyboard.press('Escape');
  await p.waitForSelector('#sheet', { state: 'hidden' });
}
async function rateVia(page, rowSel) {
  await page.locator(rowSel).first().click();
  await page.waitForSelector('#sheet .step');
  while (await page.locator('#sheet .answers').count()) {
    const ids = await page.$$eval('#sheet .duelist [data-vinyl]', (els) => els.map((e) => e.dataset.vinyl));
    await page.click(taste[ids[0]] > taste[ids[1]] ? '[data-ans="better"]' : '[data-ans="worse"]');
    await settle(page, 200);
  }
  await page.waitForSelector('[data-done="close"]');
}
const toastText = (p) => p.locator('#toast').innerText();

async function main() {
  const web = serverWeb();
  const env = { TOKEN_ENCRYPTION_KEY: 'e'.repeat(64), SPOTIFY_CLIENT_ID: 'sp-id', SPOTIFY_CLIENT_SECRET: 'sp-secret', LASTFM_API_KEY: 'lf', KWORB_ENABLED: '1' };
  const server = createApp({ dbPath: ':memory:', env, fetch: web.fetch, log: () => {}, chartOptions: { rpm: {} } });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  env.APP_URL = base.slice(0, -1);
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const covers = await makeCovers(browser);
  const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, serviceWorkers: 'block' };
  try {
    const ctx = await browser.newContext(phone);
    const p = await ctx.newPage();
    const appleCalls = [];
    await mockBrowser(p, covers, appleCalls);
    await p.goto(base);
    await p.waitForSelector('#trending li.row');
    check('Search (⌘K) button and Export are gone', (await p.locator('#palette-btn').count()) === 0);

    // A few ratings first.
    await p.fill('#search', 'all');
    await p.waitForSelector('#results li.row[data-id="1001"]');
    for (const id of [1001, 1005, 1003]) { await rateVia(p, `#results li.row[data-id="${id}"] .rate-btn`); await closeSheet(p); }
    await p.fill('#search', '');

    // Sign up (with a unique username), then the default vinyl avatar.
    await p.click('#me-btn');
    await p.fill('#auth-form [name=email]', 'maya@example.com');
    await p.fill('#auth-form [name=username]', 'maya');
    await p.waitForFunction(() => /available/.test(document.querySelector('#u-hint').textContent));
    await p.fill('#auth-form [name=password]', 'correct horse');
    await p.click('#auth-form button[type=submit]');
    await p.waitForSelector('#me-btn.has-avatar');
    await p.click('.tab[data-view="profile"]');
    await settle(p, 500);
    check('No photo yet → default vinyl-record avatar', (await p.locator('.profile-card .avatar.xl.vinyl-av').count()) === 1);
    check('Export button removed from Profile', (await p.locator('[data-p="export"]').count()) === 0);

    // Connect settings: five services, every one with a Connect button (none "Coming soon").
    const svcRows = await p.$$eval('#connect-settings .services li', (ls) => ls.map((l) => l.innerText.replace(/\s+/g, ' ')));
    check('Connect settings list all five services', svcRows.length === 5 && /Apple Music/.test(svcRows[0]) && /Spotify/.test(svcRows[1]) && /YouTube Music/.test(svcRows[2]) && /SoundCloud/.test(svcRows[3]) && /Amazon Music/.test(svcRows[4]));
    check('No "Coming soon" anywhere', !(await p.locator('#profile').innerText()).match(/coming soon/i));
    check('Every service has a Connect button', (await p.locator('#connect-settings .services li').filter({ hasText: /Connect/ }).count()) === 5);
    check('Unconfigured services name the exact env vars they need', /SOUNDCLOUD_CLIENT_ID/.test(svcRows[3]) && /GOOGLE_CLIENT_ID/.test(svcRows[2]));
    await p.locator('#connect-settings').evaluate((e) => e.scrollIntoView({ block: 'start' }));
    await settle(p, 300);
    await p.screenshot({ path: `${out}/01-connect-settings.png` });

    // Apple Music (MusicKit) + Spotify (real OAuth round-trip through the server).
    await p.click('[data-svc="apple-on"]');
    await p.waitForFunction(() => /Apple Music connected/.test(document.querySelector('#toast').textContent));
    await Promise.all([p.waitForURL(/#profile$/), p.locator('#connect-settings a[href="/auth/spotify/start"]').click()]);
    await p.waitForFunction(() => /Spotify connected/.test(document.querySelector('#toast').textContent));
    await settle(p, 800);
    check('Spotify connects through OAuth and shows the account', /Connected as Maya on Spotify/.test(await p.locator('[data-svc-row="spotify"]').innerText()));
    check('Server exchanged the code with PKCE and the secret (server-side)', web.calls.some((c) => c.host === 'accounts.spotify.com' && /code_verifier=/.test(c.body || '')));
    await p.screenshot({ path: `${out}/02-connected.png` });

    // Home: recently played from both services.
    await p.click('.tab[data-view="home"]');
    await p.waitForFunction(() => /Apple Music/.test(document.querySelector('#recent-source').textContent) && /Spotify/.test(document.querySelector('#recent-source').textContent));
    await settle(p, 600);
    const recent = await p.$$eval('#recent li.row', (ls) => ls.map((l) => l.dataset.id));
    check('Home shows recent plays from Apple Music and Spotify', recent.includes('1001') && recent.includes('1007') && recent.includes('1009'));
    await p.screenshot({ path: `${out}/03-home-recent.png` });

    // ❤ favorite → Apple Music library + Spotify Liked Songs.
    await p.locator('#recent li.row[data-id="1007"] .meta').click();
    await p.click('[data-detail="fav"]');
    await p.waitForFunction(() => /Saved to/.test(document.querySelector('#toast').textContent));
    const favMsg = await toastText(p);
    check('Favorite saves to Apple Music and Spotify', /Saved to Apple Music and Spotify/.test(favMsg) && !/error|Failed/i.test(favMsg));
    check('…via Apple’s library API and Spotify’s Saved Tracks', appleCalls.some((c) => /POST \/v1\/me\/library\?ids\[songs\]=1007/.test(decodeURIComponent(c))) && web.calls.some((c) => c.host === 'api.spotify.com' && c.method === 'PUT' && c.path === '/v1/me/tracks' && c.query.ids === 'sp1007'));
    await p.screenshot({ path: `${out}/04-favorited.png` });

    // Add to playlist: pick a service, pick a playlist, or make a new one.
    await p.click('[data-detail="playlist"]');
    await p.waitForSelector('#pl-list [data-pl]');
    check('Playlist picker offers each connected service', (await p.$$eval('#pl-strip button', (b) => b.map((x) => x.textContent))).join() === 'Apple Music,Spotify');
    await p.click('#pl-strip [data-t="spotify"]');
    await p.waitForSelector('#pl-list [data-pl="pl1"]');
    await p.screenshot({ path: `${out}/05-add-to-playlist.png` });
    await p.click('#pl-list [data-pl="pl1"]');
    await p.waitForFunction(() => /Added to “Gym Mix” on Spotify/.test(document.querySelector('#toast').textContent));
    check('Added to an existing Spotify playlist', web.calls.some((c) => c.path === '/v1/playlists/pl1/tracks'));
    await p.fill('#pl-new [name=name]', 'Encore Picks');
    await p.click('#pl-new button');
    await p.waitForFunction(() => /Created “Encore Picks” on Spotify/.test(document.querySelector('#toast').textContent));
    check('Created a new Spotify playlist with the song', web.calls.some((c) => c.path === '/v1/users/maya_sp/playlists') && web.calls.some((c) => c.path === '/v1/playlists/pl2/tracks'));
    await p.keyboard.press('Escape');
    await p.waitForSelector('#sheet', { state: 'hidden' });

    // Find my account (connector fallback): Last.fm username.
    await p.click('.tab[data-view="profile"]');
    await p.selectOption('#lookup-form [name=service]', 'lastfm');
    await p.fill('#lookup-form [name=input]', 'nobody');
    await p.click('#lookup-form button');
    await p.waitForSelector('#lookup-error:not([hidden])');
    check('Find my account explains a missing profile', /not found/i.test(await p.locator('#lookup-error').innerText()));
    await p.fill('#lookup-form [name=input]', 'https://www.last.fm/user/vinylhead');
    await p.click('#lookup-form button');
    await p.waitForSelector('#found-list li.row');
    const found = await p.$$eval('#found-list li.row', (ls) => ls.map((l) => l.dataset.id));
    check('Find my account pulls public recent songs, ready to rate', found.join() === '1006,1002' && (await p.locator('#found-list .rate-btn').count()) === 2);
    await p.locator('.find-account').evaluate((e) => e.scrollIntoView({ block: 'start' }));
    await settle(p, 300);
    await p.screenshot({ path: `${out}/06-find-my-account.png` });

    // Charts: real per-genre data, one genre per song, weeks/peak and stream counts.
    await p.click('.tab[data-view="charts"]');
    await p.waitForSelector('#chart-current li.row');
    await settle(p, 700);
    check('Charts open on All genres', (await p.locator('#genre-strip button.active').innerText()) === 'All genres');
    const allTitles = await p.$$eval('#chart-current li.row', (ls) => ls.map((l) => l.dataset.id));
    check('All-genres chart is the overall chart (not de-duplicated)', allTitles.slice(0, 3).join() === '1001,1008,1007');
    await p.screenshot({ path: `${out}/07-charts-all.png` });
    const ids = {};
    for (const g of ['pop', 'hiphop', 'rnb', 'country', 'rock']) {
      await p.click(`#genre-strip [data-genre="${g}"]`);
      await p.waitForFunction(() => document.querySelectorAll('#chart-current li.row').length > 0 || document.querySelector('#chart-current-state').textContent);
      await settle(p, 300);
      ids[g] = await p.$$eval('#chart-current li.row', (ls) => ls.map((l) => l.dataset.id));
    }
    const flat = Object.values(ids).flat();
    check('Each genre chart is different and no song repeats across genres', new Set(flat).size === flat.length && ids.pop.join() !== ids.hiphop.join());
    check('Songs sit under their primary artist’s genre (Low Tide → R&B, Cypher → Hip-Hop, Neon Rain → Pop)', !ids.pop.includes('1004') && ids.rnb.includes('1004') && ids.hiphop.join() === '1008' && ids.pop.includes('1005'));
    await p.click('#genre-strip [data-genre="pop"]');
    await p.waitForSelector('#chart-current li.row');
    await settle(p, 500);
    check('Rows show weeks on chart and peak; header shows source and last updated', /wk.* on chart · peak #1|New this week · peak #1/.test(await p.locator('#chart-current li.row').first().innerText()) && /updated/i.test(await p.locator('#current-source').innerText()));
    check('Most Streamed shows real stream counts', /3\.1B Spotify streams/.test(await p.locator('#chart-streamed').innerText()));
    check('No horizontal overflow (Charts)', await noOverflow(p));
    await p.screenshot({ path: `${out}/08-charts-pop.png` });
    await p.click('#genre-strip [data-genre="hiphop"]');
    await p.waitForSelector('#chart-streamed li.row');
    await settle(p, 400);
    await p.screenshot({ path: `${out}/09-charts-hiphop.png` });

    // Profile: change username (unique), crop a profile photo.
    await p.click('.tab[data-view="profile"]');
    await p.click('[data-p="edit"]');
    await p.fill('#edit-form [name=username]', 'listener_x');
    await p.fill('#edit-form [name=username]', 'maya_v');
    await p.waitForFunction(() => /available/.test(document.querySelector('#edit-u-hint').textContent));
    await p.click('#edit-form button');
    await p.waitForFunction(() => /@maya_v/.test(document.querySelector('#profile').textContent));
    check('Username can be changed later', true);
    await p.setInputFiles('#avatar-file', { name: 'me.png', mimeType: 'image/png', buffer: covers[4] });
    await p.waitForSelector('#crop-canvas');
    const cv = await p.locator('#crop-canvas').boundingBox();
    await p.locator('#crop-zoom').fill('1.8');
    await p.mouse.move(cv.x + 140, cv.y + 140); await p.mouse.down(); await p.mouse.move(cv.x + 90, cv.y + 120, { steps: 6 }); await p.mouse.up();
    await settle(p, 300);
    await p.screenshot({ path: `${out}/10-avatar-crop.png` });
    await p.click('#crop-save');
    await p.waitForSelector('.profile-card .avatar.xl img');
    check('Cropped photo shows on the profile and next to lists/ratings', (await p.locator('.profile-card .avatar img').count()) === 1 && (await p.locator('#profile h2.owned .avatar img').count()) >= 1);
    check('No horizontal overflow (Profile)', await noOverflow(p));
    await p.screenshot({ path: `${out}/11-profile.png` });
    await p.screenshot({ path: `${out}/12-profile-full.png`, fullPage: true });
    await p.click('.tab[data-view="lists"]');
    await settle(p, 500);
    check('Ratings show the owner’s avatar', (await p.locator('#ratings-owner .avatar img').count()) === 1);
    await p.screenshot({ path: `${out}/13-ratings.png` });

    // Desktop
    const d = await (await browser.newContext({ viewport: { width: 1280, height: 820 }, serviceWorkers: 'block' })).newPage();
    await mockBrowser(d, covers);
    await d.goto(base + '#charts');
    await d.click('#genre-strip [data-genre="rnb"]');
    await d.waitForSelector('#chart-current li.row');
    await settle(d, 700);
    check('No horizontal overflow at 1280px', await noOverflow(d));
    check('Desktop rail has no search button', (await d.locator('.tabbar #palette-btn').count()) === 0);
    await d.screenshot({ path: `${out}/20-desktop-charts.png` });
    await d.click('.tab[data-view="profile"]');
    await settle(d, 600);
    await d.screenshot({ path: `${out}/21-desktop-profile.png` });
  } finally {
    await browser.close();
    server.close();
  }
}

if (require.main === module) main();
module.exports = { mockBrowser, makeCovers, rateVia, songs, rows, taste, settle, serverWeb };
