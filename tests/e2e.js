// End-to-end test: a real Encore server (in-process, temp DB) whose outbound
// requests go to a fake internet (Apple/Deezer/Kworb/Last.fm chart sources),
// plus browser-side mocks for the iTunes catalog, artwork and previews.
// Phone (390px) and desktop (1280px); saves screenshots.
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
// A deeper catalog (ids 1100+) so recommendations have more than one batch.
const EXTRA = 24;
for (let i = 0; i < EXTRA; i++) { const [, a, al, g] = rows[i % rows.length]; songs.push(itunes(`Deep Cut ${i + 1}`, a, al, g, i % rows.length, 1100 + i)); }
const byId = (id) => songs.find((s) => s.trackId === id);
const taste = { 1000: 3, 1001: 9, 1002: 1, 1003: 7, 1004: 5, 1005: 8, 1006: 2, 1007: 6, 1008: 4, 1009: 4 };
for (let i = 0; i < EXTRA; i++) taste[1100 + i] = 0.5 + ((i * 7) % 10);
const appSong = (id) => { const s = byId(id); return { id: String(id), title: s.trackName, artist: s.artistName, album: s.collectionName, art: s.artworkUrl100, preview: s.previewUrl, genre: s.primaryGenreName, year: '2025' }; };
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

/** The server's view of the internet: chart sources and Last.fm. Records calls. */
function serverWeb() {
  const calls = [];
  const res = (body, status = 200) => ({ ok: status < 400, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  const feed = (ids) => ({ feed: { entry: ids.map((id) => { const s = byId(id); return { 'im:name': { label: s.trackName }, 'im:artist': { label: s.artistName }, 'im:image': [{ label: s.artworkUrl100 }], id: { attributes: { 'im:id': String(id) } }, category: { attributes: { label: s.primaryGenreName } } }; }) } });
  const kworbRow = (id, streams) => `<tr><td class="text"><div><a href="#">${byId(id).artistName}</a> - <a href="#">${byId(id).trackName}</a></div></td><td>${streams.toLocaleString('en-US')}</td><td>1</td></tr>`;
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
      return res({ tracks: { track: [] } });
    }
    return res({ error: 'unmocked ' + url }, 404);
  }
  return { fetch, calls };
}

async function mockBrowser(page, covers) {
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
/** Another listener, made through the API: similar taste to the test user, plus their own favourites. */
async function seedListener(base, name, order) {
  const r = await fetch(base + 'api/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: name + '@example.com', username: name, password: 'listening1' }) });
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const state = { order: order.map(String), songs: Object.fromEntries(order.map((id) => [String(id), appSong(id)])), lists: [] };
  await fetch(base + 'api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ state }) });
}
const recIds = (p) => p.$$eval('#recs .rec', (els) => els.map((e) => e.dataset.id));
const NO_SERVICES = /Apple Music|Spotify|YouTube|SoundCloud|Amazon|Connect|Recently played|Find my account|Last\.fm/i;

async function main() {
  const web = serverWeb();
  const env = { LASTFM_API_KEY: 'lf', KWORB_ENABLED: '1' };
  const server = createApp({ dbPath: ':memory:', env, fetch: web.fetch, log: () => {}, chartOptions: { rpm: {} } });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  // Four listeners who agree with the test user on 1001 > 1005 > 1003 and love different deep cuts.
  for (let n = 0; n < 4; n++) {
    const x = (k) => 1100 + n * 5 + k;
    await seedListener(base, `listener${n}`, [1001, x(0), x(1), x(2), 1005, x(3), x(4), 1000 + n, 1003, 1002, 1006, 1100 + 20 + n]);
  }
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const covers = await makeCovers(browser);
  const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, serviceWorkers: 'block' };
  try {
    const ctx = await browser.newContext(phone);
    const p = await ctx.newPage();
    await mockBrowser(p, covers);
    await p.goto(base);
    await p.waitForSelector('#trending li.row');

    // Navigation: six tabs, Charts and Most Streamed separate.
    const tabs = await p.$$eval('.tab', (ts) => ts.map((t) => t.innerText.replace(/\s+/g, ' ').replace(/­/g, '').trim()));
    check('Six tabs: Home, Charts, Most Streamed, Lists, Recommendations, Profile', tabs.join('|').toLowerCase() === 'home|charts|most streamed|lists|recommendations|profile');
    check('No horizontal overflow with six tabs (390px)', await noOverflow(p));

    // Search: neutral placeholder, no service branding.
    check('Search placeholder is "Search songs, artists, or albums"', (await p.getAttribute('#search', 'placeholder')) === 'Search songs, artists, or albums');
    check('Home has no Recently played and no service names', !NO_SERVICES.test(await p.locator('#view-home').innerText()));
    await p.fill('#search', 'all');
    await p.waitForSelector('#results li.row[data-id="1001"]');
    check('Search results carry no service branding', !NO_SERVICES.test(await p.locator('#search-results').innerText()));
    await p.screenshot({ path: `${out}/01-home-search.png` });
    for (const id of [1001, 1005, 1003]) { await rateVia(p, `#results li.row[data-id="${id}"] .rate-btn`); await closeSheet(p); }
    await p.locator('#results li.row[data-id="1007"] .meta').click();
    await p.waitForSelector('#sheet [data-detail="rate"]');
    const detail = await p.locator('#sheet').innerText();
    check('Song detail: Rate and Add to list, no favorite/playlist/service buttons', /Add to list/.test(detail) && !/Favorite|playlist|Apple Music/i.test(detail));
    await p.keyboard.press('Escape');
    await p.waitForSelector('#sheet', { state: 'hidden' });
    await p.fill('#search', '');

    // Sign up with a unique username; default vinyl avatar.
    await p.click('#me-btn');
    await p.fill('#auth-form [name=email]', 'maya@example.com');
    await p.fill('#auth-form [name=username]', 'listener0');
    await p.waitForFunction(() => /taken/.test(document.querySelector('#u-hint').textContent));
    check('Sign-up says when a username is taken', true);
    await p.fill('#auth-form [name=username]', 'maya');
    await p.waitForFunction(() => /available/.test(document.querySelector('#u-hint').textContent));
    await p.fill('#auth-form [name=password]', 'correct horse');
    await p.click('#auth-form button[type=submit]');
    await p.waitForSelector('#me-btn.has-avatar');
    await p.click('.tab[data-view="profile"]');
    await settle(p, 500);
    check('No photo yet → default vinyl-record avatar', (await p.locator('.profile-card .avatar.xl.vinyl-av').count()) === 1);
    check('Profile has no connections, Find my account or service names', !NO_SERVICES.test(await p.locator('#profile').innerText()) && (await p.locator('#connect-settings, #lookup-form, [data-svc]').count()) === 0);

    // Charts tab: current rankings only, unique per genre, Rate + Add to list on every row.
    await p.click('.tab[data-view="charts"]');
    await p.waitForSelector('#chart-current li.row');
    await settle(p, 700);
    check('Charts tab opens on All genres', (await p.locator('#genre-strip button.active').innerText()) === 'All genres');
    check('Charts tab holds only the current chart (Most Streamed is its own tab)', (await p.locator('#view-charts #chart-streamed').count()) === 0 && (await p.locator('#view-streamed #chart-streamed').count()) === 1);
    check('All-genres chart is the overall chart', (await p.$$eval('#chart-current li.row', (ls) => ls.map((l) => l.dataset.id))).slice(0, 3).join() === '1001,1008,1007');
    await p.screenshot({ path: `${out}/02-charts-all.png` });
    const everyRowActs = (sel) => p.$$eval(sel, (ls) => ls.length > 0 && ls.every((l) => l.querySelector('.rate-btn, [data-act="open"] .sticker, .icon-btn .sticker') && l.querySelector('.add-list')));
    const cur = {};
    for (const g of ['pop', 'hiphop', 'rnb', 'country', 'rock']) {
      await p.click(`#genre-strip [data-genre="${g}"]`);
      await p.waitForFunction(() => document.querySelectorAll('#chart-current li.row').length > 0 || document.querySelector('#chart-current-state').textContent);
      await settle(p, 300);
      cur[g] = await p.$$eval('#chart-current li.row', (ls) => ls.map((l) => l.dataset.id));
      if (g === 'pop') check('Every Charts row has Rate and Add to list', await everyRowActs('#chart-current li.row'));
    }
    const flat = Object.values(cur).flat();
    check('Charts: no song repeats across genres', new Set(flat).size === flat.length && cur.pop.join() !== cur.hiphop.join());
    check('Songs sit under their primary artist’s genre (Low Tide → R&B, Cypher → Hip-Hop)', !cur.pop.includes('1004') && cur.rnb.includes('1004') && cur.hiphop.join() === '1008');
    await p.click('#genre-strip [data-genre="pop"]');
    await p.waitForSelector('#chart-current li.row');
    await settle(p, 500);
    check('Rows show weeks on chart and peak; header shows source and last updated', /wk.* on chart · peak #1|New this week · peak #1/.test(await p.locator('#chart-current li.row').first().innerText()) && /updated/i.test(await p.locator('#current-source').innerText()));
    await p.screenshot({ path: `${out}/03-charts-pop.png` });

    // Most Streamed tab: same genre selector (keeps the genre), stream counts, unique per genre.
    await p.click('.tab[data-view="streamed"]');
    await p.waitForSelector('#chart-streamed li.row');
    await settle(p, 500);
    check('Most Streamed opens on the genre picked on Charts', (await p.locator('#streamed-strip button.active').innerText()) === 'Pop');
    check('Most Streamed rows show stream counts', /3\.1B Spotify streams/.test(await p.locator('#chart-streamed').innerText()));
    check('Every Most Streamed row has Rate and Add to list', await everyRowActs('#chart-streamed li.row'));
    await p.screenshot({ path: `${out}/04-most-streamed.png` });
    const str = {};
    for (const g of ['pop', 'hiphop', 'rnb', 'country', 'rock']) {
      await p.click(`#streamed-strip [data-genre="${g}"]`);
      await p.waitForFunction(() => document.querySelectorAll('#chart-streamed li.row').length > 0 || document.querySelector('#chart-streamed-state').textContent || document.querySelector('#streamed-note').textContent);
      await settle(p, 300);
      str[g] = await p.$$eval('#chart-streamed li.row', (ls) => ls.map((l) => l.dataset.id));
    }
    const sflat = Object.values(str).flat();
    check('Most Streamed: no song repeats across genres', sflat.length > 2 && new Set(sflat).size === sflat.length);
    check('No horizontal overflow (Most Streamed)', await noOverflow(p));

    // Recommendations: Refresh, live updates as you rate, never rated songs.
    await p.click('.tab[data-view="recs"]');
    await p.waitForSelector('#recs .rec');
    await settle(p, 800);
    const rated = () => p.evaluate(() => [...document.querySelectorAll('#ratings li.row')].map((l) => l.dataset.id));
    const first = await recIds(p);
    check('Recommendations show a batch with a visible Refresh button', first.length >= 8 && await p.locator('#recs-refresh').isVisible());
    check('Recommendations never include rated songs', first.every((id) => !['1001', '1005', '1003'].includes(id)));
    await p.screenshot({ path: `${out}/05-recs.png` });
    const target = first[0];
    await rateVia(p, `#recs .rec[data-id="${target}"] [data-act="rate"]`);
    await closeSheet(p);
    await p.waitForFunction(() => /Updated for your rating of/.test(document.querySelector('#recs-updated').textContent));
    const afterRate = await recIds(p);
    check('Rating a song updates the picks immediately, no reload or Refresh', !afterRate.includes(target) && afterRate.length >= 8);
    check('…with a visible update cue (pulse + new card highlight)', (await p.locator('#recs-updated.pulse').count()) === 1 && (await p.locator('#recs .rec.rec-new').count()) >= 1);
    await p.screenshot({ path: `${out}/06-recs-updated.png` });
    await p.click('#recs-refresh');
    await p.waitForFunction(() => /New batch|seen every pick/.test(document.querySelector('#recs-updated').textContent));
    const batch2 = await recIds(p);
    check('Refresh pulls a new batch', batch2.length > 0 && batch2.filter((id) => afterRate.includes(id)).length < batch2.length / 2);
    await p.click('.tab[data-view="lists"]');
    await settle(p, 300);
    const mine = await rated();
    check('…and the new batch has no rated songs', batch2.every((id) => !mine.includes(id)) && mine.includes(target));
    await p.click('.tab[data-view="recs"]');

    // Profile: change username (still unique), crop with a live preview, avatar everywhere.
    await p.click('.tab[data-view="profile"]');
    await p.click('[data-p="edit"]');
    await p.fill('#edit-form [name=username]', 'listener1');
    await p.waitForFunction(() => /taken/.test(document.querySelector('#edit-u-hint').textContent));
    await p.fill('#edit-form [name=username]', 'maya_v');
    await p.waitForFunction(() => /available/.test(document.querySelector('#edit-u-hint').textContent));
    await p.click('#edit-form button');
    await p.waitForFunction(() => /@maya_v/.test(document.querySelector('#profile').textContent));
    check('Username can be changed later and must stay unique', true);
    await p.setInputFiles('#avatar-file', { name: 'me.png', mimeType: 'image/png', buffer: covers[4] });
    await p.waitForSelector('#crop-canvas');
    const cv = await p.locator('#crop-canvas').boundingBox();
    await p.locator('#crop-zoom').fill('1.8');
    await p.mouse.move(cv.x + 140, cv.y + 140); await p.mouse.down(); await p.mouse.move(cv.x + 90, cv.y + 120, { steps: 6 }); await p.mouse.up();
    await settle(p, 300);
    const previewDrawn = await p.evaluate(() => { const c = document.querySelector('#crop-prev'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let sum = 0; for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2]; return sum > 0; });
    check('Crop step shows a live preview before saving', previewDrawn && /@maya_v/.test(await p.locator('.crop-preview').innerText()));
    await p.locator('.crop-preview').scrollIntoViewIfNeeded();
    await p.screenshot({ path: `${out}/07-avatar-crop.png` });
    await p.click('#crop-save');
    await p.waitForSelector('.profile-card .avatar.xl img');
    check('Photo shows on the profile and next to Top 10 / Lists', (await p.locator('.profile-card .avatar img').count()) === 1 && (await p.locator('#profile h2.owned .avatar img').count()) >= 1);
    check('No horizontal overflow (Profile)', await noOverflow(p));
    await p.screenshot({ path: `${out}/08-profile.png` });
    await p.click('.tab[data-view="lists"]');
    await settle(p, 500);
    check('Ratings show the owner’s photo and @username', (await p.locator('#ratings-owner .avatar img').count()) === 1 && /@maya_v/.test(await p.locator('#ratings-owner').innerText()));
    await p.click('#lists-strip [data-pane="mine"]');
    await p.click('#new-list');
    await p.fill('#new-list-form [name=name]', 'Gym Songs');
    await p.click('#new-list-form button[type=submit]');
    await p.waitForSelector('#list-detail .list-head');
    check('Lists show the owner’s photo and @username', (await p.locator('#list-detail .avatar img').count()) === 1 && /by @maya_v/i.test(await p.locator('#list-detail').innerText()));
    await p.screenshot({ path: `${out}/09-list.png` });

    // Desktop
    const d = await (await browser.newContext({ viewport: { width: 1280, height: 820 }, serviceWorkers: 'block' })).newPage();
    await mockBrowser(d, covers);
    await d.goto(base + '#streamed');
    await d.waitForSelector('#chart-streamed li.row');
    await settle(d, 700);
    check('No horizontal overflow at 1280px', await noOverflow(d));
    await d.screenshot({ path: `${out}/20-desktop-streamed.png` });
    await d.click('.tab[data-view="charts"]');
    await d.waitForSelector('#chart-current li.row');
    await settle(d, 500);
    await d.screenshot({ path: `${out}/21-desktop-charts.png` });
  } finally {
    await browser.close();
    server.close();
  }
}

if (require.main === module) main();
module.exports = { mockBrowser, makeCovers, rateVia, songs, rows, taste, settle, serverWeb, closeSheet, check, noOverflow };
