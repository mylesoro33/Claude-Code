// End-to-end UI test: a real Encore server (in-process, temp DB) with Apple's
// catalog, artwork, preview audio and MusicKit mocked. Exercises every feature
// at phone (390px) and desktop (1280px) widths and saves screenshots.
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
];
const albums = [...new Set(rows.map((r) => r[2]))];
const itunes = (n, a, al, g, i, id) => ({
  kind: 'song', wrapperType: 'track', trackId: id, trackName: n, artistName: a, collectionName: al,
  artistId: 50 + i, collectionId: 90 + albums.indexOf(al), primaryGenreName: g, releaseDate: '2025-01-01',
  // "Timber" covers are broken on purpose → generated placeholder art.
  artworkUrl100: `https://is1-ssl.mzstatic.com/image/thumb/Music/mock${albums.indexOf(al)}/100x100bb.jpg`,
  previewUrl: `https://audio-ssl.itunes.apple.com/mock/${i}.m4a`, trackViewUrl: 'https://music.apple.com/', trackExplicitness: i === 2 ? 'explicit' : 'none',
});
const songs = rows.map(([n, a, al, g], i) => itunes(n, a, al, g, i, 1000 + i));
// Deeper cuts by the same artists: in search, never in the charts, never rated by the test user.
songs.push(itunes('Paper Moon', 'Kite Club', 'Sunline', 'Pop', 1, 1008), itunes('Undertow', 'Mira', 'Harbor', 'R&B/Soul', 4, 1009), itunes('Afterglow', 'Nova Lane', 'Night Shift', 'Pop', 0, 1010));
const chartSongs = songs.slice(0, 8);
const asSong = (r) => ({ id: String(r.trackId), title: r.trackName, artist: r.artistName, album: r.collectionName, art: r.artworkUrl100, preview: r.previewUrl, url: r.trackViewUrl, genre: r.primaryGenreName, year: '2025', explicit: false, artistId: String(r.artistId), albumId: String(r.collectionId) });
const taste = { 1000: 3, 1001: 9, 1002: 1, 1003: 7, 1004: 5, 1005: 8, 1006: 2, 1007: 6 }; // hidden "true" preferences
/** Any search term with no mock match becomes its own song (lets sample chart lists resolve). */
function synth(term) {
  let h = 7; for (const c of term) h = (h * 31 + c.charCodeAt(0)) % 900000;
  return { ...itunes(term.replace(/^\S+\s/, ''), term.split(' ')[0], 'Sample Album', 'Pop', h % 3, 200000 + h), artworkUrl100: '' };
}

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
      <div style="position:absolute;left:-40px;top:${60 + i * 30}px;width:380px;height:90px;background:${pal[1]};transform:rotate(-12deg)"></div>
      <div style="position:absolute;right:24px;top:24px;width:${70 + i * 20}px;height:${70 + i * 20}px;border-radius:50%;background:${pal[2]}"></div>
      <div style="position:absolute;left:18px;bottom:16px;font:900 32px/1 Georgia,serif;color:${pal[2]}">${al}</div></div></body>`);
    covers[i] = await p.screenshot({ type: 'png' });
  }
  await p.close();
  return covers;
}

async function mockApple(page, covers, counters = {}, { musickit = true, recentFails = false } = {}) {
  page.on('pageerror', (e) => { console.log('PAGEERROR', e.message); process.exitCode = 1; });
  const count = (k) => { counters[k] = (counters[k] || 0) + 1; };
  const charts = { feed: { results: chartSongs.map((s) => ({ id: String(s.trackId) })) } };
  const search = (term) => {
    const t = term.toLowerCase();
    const hits = songs.filter((s) => `${s.trackName} ${s.artistName}`.toLowerCase().includes(t) || t === 'all' || t.split(' ').some((w) => w.length > 2 && s.artistName.toLowerCase() === t));
    return hits.length ? hits : [synth(term)];
  };
  const lookup = (ids) => ids.map((id) => songs.find((s) => String(s.trackId) === id) || null).filter(Boolean);
  const cors = { 'Access-Control-Allow-Origin': '*' };
  await page.route('**/api/catalog/charts*', (r) => { count('charts'); r.fulfill({ json: charts }); });
  await page.route('**/api/catalog/lookup*', (r) => r.fulfill({ json: { results: lookup(new URL(r.request().url()).searchParams.get('id').split(',')) } }));
  await page.route('**/api/catalog/search*', (r) => { count('search'); r.fulfill({ json: { results: search(new URL(r.request().url()).searchParams.get('term')) } }); });
  // Genre charts: Apple has a feed for every genre but Indie; Most Streamed has no Last.fm key → placeholders.
  await page.route('**/api/charts/current*', (r) => {
    const g = new URL(r.request().url()).searchParams.get('genre');
    if (g === 'indie') return r.fulfill({ status: 404, json: { error: 'no feed' } });
    const order = g === 'edm' ? [5, 1, 0, 4, 2, 3, 6, 7] : [1, 5, 3, 7, 4, 0, 6, 2];
    r.fulfill({ json: { source: 'Apple Music', songs: order.map((i) => asSong(songs[i])) } });
  });
  await page.route('**/api/charts/streamed*', (r) => r.fulfill({ status: 404, json: { error: 'Most Streamed needs a Last.fm API key' } }));
  await page.route('https://rss.marketingtools.apple.com/**', (r) => { count('charts'); r.fulfill({ json: charts, headers: cors }); });
  await page.route('https://itunes.apple.com/**', (r) => {
    const u = new URL(r.request().url());
    if (u.pathname === '/lookup') return r.fulfill({ json: { results: lookup(u.searchParams.get('id').split(',')) }, headers: cors });
    if (u.pathname === '/search') { count('search'); return r.fulfill({ json: { results: search(u.searchParams.get('term') || '') }, headers: cors }); }
    r.abort();
  });
  const serveArt = (r, url) => {
    const m = url.match(/mock(\d+)/);
    const png = m && covers[+m[1]];
    if (!png) return r.abort();
    r.fulfill({ body: png, contentType: 'image/png', headers: cors });
  };
  await page.route('https://is1-ssl.mzstatic.com/**', (r) => serveArt(r, r.request().url()));
  await page.route((u) => u.pathname === '/api/art', (r) => serveArt(r, new URL(r.request().url()).searchParams.get('u') || ''));
  await page.route('https://audio-ssl.itunes.apple.com/**', (r) => r.fulfill({ body: AUDIO, contentType: 'audio/wav', headers: cors }));
  if (!musickit) return;
  // Apple Music: a MusicKit stand-in plus the recently-played endpoint.
  await page.route('**/api/config', (r) => r.fulfill({ json: { appleMusic: true, spotifyClientId: '', lastfm: false } }));
  await page.route('**/api/apple/developer-token', (r) => r.fulfill({ json: { token: 'test-developer-token' } }));
  await page.route('https://api.music.apple.com/**', (r) => {
    if (recentFails) return r.fulfill({ status: 500, body: 'nope', headers: cors });
    const data = [1, 5, 3, 4, 0].map((i) => ({ id: String(1000 + i), type: 'songs', attributes: {
      name: songs[i].trackName, artistName: songs[i].artistName, albumName: songs[i].collectionName, genreNames: [songs[i].primaryGenreName, 'Music'],
      artwork: { url: songs[i].artworkUrl100.replace('100x100bb', '{w}x{h}bb') }, previews: [{ url: songs[i].previewUrl }], url: 'https://music.apple.com/', releaseDate: '2025-01-01' } }));
    r.fulfill({ json: { data }, headers: cors });
  });
  await page.addInitScript(() => {
    const music = { isAuthorized: false, musicUserToken: '', storefrontId: 'us', playbackState: 0, currentPlaybackProgress: 0,
      async authorize() { await new Promise((res) => setTimeout(res, 150)); this.isAuthorized = true; this.musicUserToken = 'user-token'; return 'user-token'; },
      async unauthorize() { this.isAuthorized = false; }, addEventListener() {}, async setQueue() { throw new Error('preview only in tests'); }, stop() {}, pause() {}, play() {} };
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
/** Rate a song through the sheet, answering better/worse from `taste`. Returns how many questions were asked. */
async function rateVia(page, rowSel, { shot } = {}) {
  await page.locator(rowSel).first().click();
  await page.waitForSelector('#sheet .step');
  let q = 0;
  while (await page.locator('#sheet .answers').count()) {
    q++;
    if (shot && q === 1) { await settle(page, 450); await page.screenshot({ path: `${out}/${shot}` }); }
    const ids = await page.$$eval('#sheet .duelist [data-vinyl]', (els) => els.map((e) => e.dataset.vinyl));
    await page.click(taste[ids[0]] > taste[ids[1]] ? '[data-ans="better"]' : '[data-ans="worse"]');
    await settle(page, 220);
  }
  await page.waitForSelector('[data-done="close"]');
  return q;
}
async function seedCommunity(base) {
  // Three listeners who agree with the test user's taste and love Glass House (1007), which the test user never rates.
  const orders = [[1001, 1007, 1008, 1005, 1003, 1004, 1000, 1006, 1002], [1007, 1001, 1005, 1008, 1003, 1000, 1004, 1006, 1002], [1007, 1001, 1003, 1005, 1004, 1000, 1002, 1006, 1010]];
  for (const [i, ord] of orders.entries()) {
    let cookie = '';
    const call = async (path, method, body) => {
      const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
      const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
      return r;
    };
    await call('/api/signup', 'POST', { email: `listener${i}@example.com`, username: `listener_${i + 1}`, password: 'correct horse' });
    const ids = ord.map(String);
    await call('/api/state', 'PUT', { state: { order: ids, songs: Object.fromEntries(ids.map((id) => [id, asSong(songs.find((x) => String(x.trackId) === id))])), lists: [] } });
  }
}

async function main() {
  const server = createApp({ dbPath: ':memory:', env: {} });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  await seedCommunity(base.slice(0, -1));
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const covers = await makeCovers(browser);
  const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, serviceWorkers: 'block' };
  try {
    // ================= Phone =================
    const ctx = await browser.newContext(phone);
    const p = await ctx.newPage();
    await mockApple(p, covers);
    await p.goto(base);
    await p.waitForSelector('#trending li.row');
    await settle(p, 900);
    check('Navigation is Home, Charts, Lists, Recommendations, Profile', JSON.stringify(await p.$$eval('.tab', (t) => t.map((x) => x.innerText.trim()))) === JSON.stringify(['HOME', 'CHARTS', 'LISTS', 'RECOMMENDATIONS', 'PROFILE']));
    check('Later tab, shortcuts and Reset are gone', (await p.locator('[data-view="later"], #shortcuts-btn, #reset, #later').count()) === 0);
    check('Home shows the not-connected Apple Music state', /Connect Apple Music/.test(await p.locator('#recent-state').innerText()));
    check('No horizontal overflow at 390px (Home)', await noOverflow(p));
    await p.screenshot({ path: `${out}/01-home.png` });

    // Apple Music → recently played
    await p.locator('#recent-state .btn', { hasText: 'Connect Apple Music' }).click();
    await p.waitForSelector('#recent li.row');
    await settle(p, 900);
    check('Recently played appears after connecting, each with "Rate this"', (await p.locator('#recent li.row').count()) === 5 && (await p.locator('#recent .rate-btn', { hasText: 'Rate this' }).count()) === 5);
    await p.screenshot({ path: `${out}/02-home-recently-played.png` });

    // First song → automatic 10
    await p.locator('#recent li.row[data-id="1001"] .rate-btn').click();
    await p.waitForSelector('#big-score');
    check('First song skips the questions', (await p.locator('#sheet .answers').count()) === 0);
    await settle(p, 1500);
    check('First song is scored 10', (await p.locator('#big-score').innerText()) === '10');
    await p.screenshot({ path: `${out}/03-first-song-10.png` });
    await closeSheet(p);

    // Everything after: better/worse until placed
    let shot = '04-better-or-worse.png';
    for (const id of [1005, 1003, 1004, 1000]) {
      await rateVia(p, `#recent li.row[data-id="${id}"] .rate-btn`, { shot });
      shot = null;
      await closeSheet(p);
    }
    await p.fill('#search', 'all');
    await p.waitForSelector('#results li.row[data-id="1006"]');
    await rateVia(p, '#results li.row[data-id="1006"] .rate-btn');
    await closeSheet(p);
    const q = await rateVia(p, '#results li.row[data-id="1002"] .rate-btn');
    check('Placement takes at most log2(n)+1 questions', q <= 3);
    await settle(p, 1400);
    await p.screenshot({ path: `${out}/05-rated-result.png` });
    await closeSheet(p);
    await p.fill('#search', '');

    // Deck: play a preview → turntable bar, tonearm drops onto the record
    await p.locator('#recent li.row[data-id="1005"] [data-act="play"]').click();
    await p.waitForSelector('#deck:not([hidden])');
    await settle(p, 1200);
    const arm = await p.$eval('#tonearm', (el) => el.style.getPropertyValue('--arm'));
    check('Turntable deck plays and the tonearm tracks progress', arm !== '-32deg' && arm !== '' && (await p.locator('#deck-vinyl.spin').count()) === 1);
    await p.screenshot({ path: `${out}/06-turntable-deck.png` });
    await p.click('#deck-toggle');

    // Sign up: email + unique username (availability check)
    await p.click('#me-btn');
    await p.waitForSelector('#auth-form [name=email]');
    await p.fill('#auth-form [name=username]', 'listener_1');
    await p.waitForFunction(() => /taken/.test(document.querySelector('#u-hint').textContent));
    check('Sign-up flags a taken username', true);
    await p.fill('#auth-form [name=username]', 'maya');
    await p.waitForFunction(() => /available/.test(document.querySelector('#u-hint').textContent));
    await p.fill('#auth-form [name=email]', 'maya@example.com');
    await p.fill('#auth-form [name=password]', 'correct horse');
    await p.screenshot({ path: `${out}/07-sign-up.png` });
    await p.click('#auth-form button[type=submit]');
    await p.waitForSelector('#me-btn.has-avatar');
    check('Guest ratings move into the new account', /7 ratings/.test(await p.locator('#toast').innerText()));

    // Charts
    await p.click('.tab[data-view="charts"]');
    await p.waitForSelector('#chart-current li.row');
    await p.waitForSelector('#chart-streamed li.row');
    await settle(p, 900);
    check('12 genre tabs', (await p.locator('#genre-strip button').count()) === 12);
    check('Current Chart from Apple Music; Most Streamed clearly marked as placeholder', /Apple Music/i.test(await p.locator('#current-source').innerText()) && /Placeholder/i.test(await p.locator('#streamed-source').innerText()) && /Last\.fm/.test(await p.locator('#streamed-note').innerText()));
    check('Every chart row has Rate (or your score) and Add to list', (await p.$$eval('#chart-current li.row', (ls) => ls.every((l) => l.querySelector('.rate-btn, .sticker') && l.querySelector('[data-act="list"]')))));
    check('No horizontal overflow (Charts)', await noOverflow(p));
    await p.screenshot({ path: `${out}/08-charts.png` });
    await p.click('#genre-strip [data-genre="indie"]');
    await p.waitForFunction(() => /Placeholder/i.test(document.querySelector('#current-source').textContent));
    check('A genre with no live feed falls back to labelled placeholder data', true);
    await p.click('#genre-strip [data-genre="pop"]');
    await p.waitForSelector('#chart-current li.row[data-id="1007"]');
    // Add to a new list straight from a chart row
    await p.locator('#chart-current li.row[data-id="1007"] [data-act="list"]').click();
    await p.click('#pick-new');
    await p.fill('#new-list-form [name=name]', 'Gym Songs');
    await p.click('#new-list-form button');
    await settle(p, 500);
    check('List created from a chart row', /Added to “Gym Songs”/.test(await p.locator('#toast').innerText()));

    // Lists: ratings
    await p.click('.tab[data-view="lists"]');
    await settle(p, 700);
    const order = await p.$$eval('#ratings li.row', (ls) => ls.map((l) => l.dataset.id));
    const scores = await p.$$eval('#ratings .sticker', (s) => s.map((x) => x.textContent));
    check('Ratings are in taste order', JSON.stringify(order) === JSON.stringify(['1001', '1005', '1003', '1004', '1000', '1006', '1002']));
    check('Scores are re-spread from a top 10', JSON.stringify(scores) === JSON.stringify(['10', '8.6', '7.1', '5.7', '4.3', '2.9', '1.4']));
    await p.screenshot({ path: `${out}/09-my-ratings.png` });
    await p.click('#ratings-seg [data-seg="artists"]');
    await settle(p, 500);
    check('Artist averages still work', (await p.locator('#ratings li.group').count()) === 4);
    await p.screenshot({ path: `${out}/10-artist-averages.png` });
    await p.click('#ratings-seg [data-seg="songs"]');

    // Lists: custom list editing
    await p.click('#lists-strip [data-pane="mine"]');
    await p.click('[data-list]');
    await p.waitForSelector('#view-list.active');
    await p.click('[data-la="add"]');
    await p.click('#adder-strip [data-m="ratings"]');
    await p.locator('#adder-results li.row[data-id="1001"] [data-act="toggle"]').click();
    await p.locator('#adder-results li.row[data-id="1003"] [data-act="toggle"]').click();
    await p.keyboard.press('Escape');
    await p.waitForSelector('#sheet', { state: 'hidden' });
    check('Songs added from ratings', (await p.locator('#list-songs li.row').count()) === 3);
    const grip = await p.locator('#list-songs li.row').last().locator('.grip').boundingBox();
    const first = await p.locator('#list-songs li.row').first().boundingBox();
    await p.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2); await p.mouse.down();
    for (let i = 1; i <= 12; i++) await p.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2 + ((first.y + 8 - grip.y) * i) / 12);
    await p.mouse.up();
    await settle(p, 900);
    check('Drag re-orders a list', (await p.locator('#list-songs li.row').first().getAttribute('data-id')) === '1003');
    await p.click('#list-public');
    await settle(p, 300);
    check('Lists can be made private', /Private list/i.test(await p.locator('#list-detail').innerText()));
    await p.screenshot({ path: `${out}/11-list-detail.png` });
    await p.locator('#list-songs li.row[data-id="1007"] [data-act="remove"]').click();
    await settle(p, 400);
    check('Songs can be removed from a list', (await p.locator('#list-songs li.row').count()) === 2);
    await p.click('#view-list [data-back]');
    // A second, public list made from a rating's detail sheet
    await p.click('#lists-strip [data-pane="ratings"]');
    await p.locator('#ratings li.row[data-id="1005"] .meta').click();
    await p.click('[data-detail="list"]');
    await p.click('#pick-new');
    await p.fill('#new-list-form [name=name]', 'Best Pop Song');
    await p.click('#new-list-form button');
    await settle(p, 500);

    // Recommendations
    await p.click('.tab[data-view="recs"]');
    await p.waitForSelector('#recs .rec');
    await settle(p, 800);
    const recs = await p.$$eval('#recs .rec', (cs) => cs.map((c) => ({ id: c.dataset.id, why: c.querySelector('.why').textContent })));
    const gh = recs.find((r) => r.id === '1007');
    check('Collaborative filtering suggests what similar listeners love', !!gh && /people with similar taste rated this 9\+/.test(gh.why));
    check('Every suggestion has a reason and none are already rated', recs.length >= 2 && recs.every((r) => r.why.length > 10 && !['1000', '1001', '1002', '1003', '1004', '1005', '1006'].includes(r.id)));
    check('Rediscovery picks from favourite artists explain themselves', recs.some((r) => /^Because you rated .+ a \d/.test(r.why)));
    await p.screenshot({ path: `${out}/12-recommendations.png` });
    await rateVia(p, '#recs .rec[data-id="1007"] [data-act="rate"]');
    await closeSheet(p);
    await p.waitForFunction(() => !document.querySelector('#recs .rec[data-id="1007"]'));
    check('Suggestions refresh after rating', true);

    // Profile
    await p.click('.tab[data-view="profile"]');
    await settle(p, 600);
    await p.click('[data-p="edit"]');
    await p.fill('#edit-form [name=bio]', 'Pop hooks, R&B slow jams, anything with a big chorus.');
    await p.click('#edit-form button');
    await settle(p, 600);
    await p.setInputFiles('#avatar-file', { name: 'me.png', mimeType: 'image/png', buffer: covers[3] });
    await p.waitForSelector('.profile-card .avatar.xl img');
    const prof = await p.locator('#profile').innerText();
    check('Profile shows username, bio, rating count, top 10 and lists', /@maya/.test(prof) && /big chorus/.test(prof) && /Top 10/.test(prof) && /Gym Songs/.test(prof) && /Best Pop Song/.test(prof));
    const services = await p.$$eval('.services li', (ls) => ls.map((l) => l.innerText.replace(/\s+/g, ' ')));
    check('Connected services: Apple Music connected; Spotify needs setup; others “Coming soon”', /Apple Music.*Disconnect/i.test(services[0]) && /Spotify.*Not set up/i.test(services[1]) && services.slice(2).every((s) => /Coming soon/i.test(s)));
    check('No horizontal overflow (Profile)', await noOverflow(p));
    await p.screenshot({ path: `${out}/13-profile.png` });
    await p.screenshot({ path: `${out}/14-profile-full.png`, fullPage: true });
    await p.click('[data-p="share"]');
    await p.waitForSelector('#share-preview img', { timeout: 15000 });
    check('Share Top 10 image still works', (await p.evaluate(() => window.__encoreShareBlob && window.__encoreShareBlob.size)) > 40000);
    const png = await p.evaluate(async () => { const r = new FileReader(); return new Promise((res) => { r.onload = () => res(r.result); r.readAsDataURL(window.__encoreShareBlob); }); });
    require('fs').writeFileSync(`${out}/15-share-card.png`, Buffer.from(png.split(',')[1], 'base64'));
    await p.keyboard.press('Escape');
    await settle(p, 1200); // let sync flush

    // ================= Visitor: public profile =================
    const v = await (await browser.newContext(phone)).newPage();
    await mockApple(v, covers, {}, { musickit: false });
    await v.goto(base + '?u=maya');
    await v.waitForSelector('#view-user.active .profile-card');
    await settle(v, 800);
    const pub = await v.locator('#user-profile').innerText();
    check('Public profile shows public lists only', /Best Pop Song/.test(pub) && !/Gym Songs/.test(pub) && /big chorus/.test(pub));
    await v.screenshot({ path: `${out}/16-public-profile.png` });

    // ================= Error states =================
    const e = await (await browser.newContext(phone)).newPage();
    await mockApple(e, covers, {}, { recentFails: true });
    await e.goto(base);
    await e.locator('#recent-state .btn', { hasText: 'Connect Apple Music' }).click();
    await e.waitForSelector('#recent-state .state.error');
    check('Recently played shows an error state with Try again', /Try again/.test(await e.locator('#recent-state').innerText()));
    await e.screenshot({ path: `${out}/17-error-state.png` });

    // ================= Desktop =================
    const d = await (await browser.newContext({ viewport: { width: 1280, height: 820 }, serviceWorkers: 'block' })).newPage();
    await mockApple(d, covers);
    await d.goto(base);
    await d.click('#me-btn');
    await d.click('[data-switch="login"]');
    await d.fill('#auth-form [name=login]', 'maya@example.com');
    await d.fill('#auth-form [name=password]', 'correct horse');
    await d.click('#auth-form button[type=submit]');
    await d.waitForSelector('#me-btn.has-avatar');
    await settle(d, 1000);
    check('Sign in with email on another device', (await d.locator('#top-shelf .shelf-item').count()) === 8);
    check('No horizontal overflow at 1280px', await noOverflow(d));
    await d.screenshot({ path: `${out}/20-desktop-home.png` });
    await d.keyboard.press('Control+k');
    await d.keyboard.type('edm chart');
    await d.keyboard.press('Enter');
    await d.waitForSelector('#genre-strip [data-genre="edm"].active');
    await d.waitForSelector('#chart-current li.row');
    await settle(d, 800);
    check('Command palette jumps to a genre chart', (await d.locator('#chart-current li.row').first().getAttribute('data-id')) === '1005');
    await d.screenshot({ path: `${out}/21-desktop-charts.png` });
    await d.click('.tab[data-view="lists"]');
    await settle(d, 700);
    await d.screenshot({ path: `${out}/22-desktop-lists.png` });
    await d.click('.tab[data-view="profile"]');
    await settle(d, 700);
    await d.screenshot({ path: `${out}/23-desktop-profile.png` });
  } finally {
    await browser.close();
    server.close();
  }
}

if (require.main === module) main();
module.exports = { mockApple, makeCovers, rateVia, songs, rows, taste, settle };
