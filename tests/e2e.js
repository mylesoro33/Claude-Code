// End-to-end UI test: real Encore server (in-process, temp DB) + mocked Apple
// catalog, artwork and preview audio. Checks every feature, at phone and
// desktop widths, and saves screenshots.
// Usage: node tests/e2e.js [screenshotDir]
const { chromium } = require('playwright');
const { createApp } = require('../server.js');
const out = process.argv[2] || '.';

const rows = [
  ['Midnight Drive', 'Nova Lane', 'Night Shift', 'Pop', ['#1b1f5e', '#ff4f9a', '#ffb347']],
  ['Golden Hour (Extended Sunset Version) [feat. The Very Long Name Orchestra]', 'Kite Club', 'Sunline', 'Indie', ['#ffcf5c', '#ff7a3d', '#2a1a4a']],
  ['Static', 'Nova Lane', 'Night Shift', 'Pop', ['#1b1f5e', '#ff4f9a', '#ffb347']],
  ['Paper Planes', 'The Oaks', 'Timber', 'Rock', null],
  ['Low Tide', 'Mira', 'Harbor', 'R&B', ['#0b3d4f', '#2ad1c9', '#e8fff9']],
  ['Neon Rain', 'Kite Club', 'Sunline', 'Indie', ['#ffcf5c', '#ff7a3d', '#2a1a4a']],
  ['Saltwater', 'The Oaks', 'Timber', 'Rock', null],
  ['Glass House', 'Mira', 'Harbor', 'R&B', ['#0b3d4f', '#2ad1c9', '#e8fff9']],
];
const albums = [...new Set(rows.map((r) => r[2]))];
const songs = rows.map(([n, a, al, g], i) => ({
  kind: 'song', wrapperType: 'track', trackId: 1000 + i, trackName: n, artistName: a, collectionName: al,
  artistId: 50 + i, collectionId: 90 + albums.indexOf(al), primaryGenreName: g, releaseDate: '2025-01-01',
  // "Timber" covers are broken on purpose → generated placeholder art.
  artworkUrl100: `https://is1-ssl.mzstatic.com/image/thumb/Music/mock${albums.indexOf(al)}/100x100bb.jpg`,
  previewUrl: `https://audio-ssl.itunes.apple.com/mock/${i}.m4a`, trackViewUrl: 'https://music.apple.com/', trackExplicitness: i === 2 ? 'explicit' : 'none',
}));
const taste = [3, 9, 1, 7, 5, 8, 2, 6]; // hidden "true" preferences (all loved)

function wav(seconds = 4, rate = 22050) {
  const n = seconds * rate;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const v = 0.3 * Math.sin(2 * Math.PI * 220 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 2 * t)) + 0.15 * Math.sin(2 * Math.PI * 660 * t);
    buf.writeInt16LE(Math.round(v * 32767 * 0.5), 44 + i * 2);
  }
  return buf;
}
const AUDIO = wav();

async function makeCovers(browser) {
  const p = await browser.newPage({ viewport: { width: 300, height: 300 } });
  const covers = {};
  for (const [, , al, , pal] of rows) {
    const i = albums.indexOf(al);
    if (!pal || covers[i]) continue;
    await p.setContent(`<body style="margin:0"><div style="width:300px;height:300px;position:relative;overflow:hidden;background:linear-gradient(135deg,${pal[0]},${pal[1]} 60%,${pal[2]})">
      <div style="position:absolute;width:220px;height:220px;border-radius:50%;left:${40 + i * 20}px;top:${30 + i * 15}px;background:radial-gradient(circle at 35% 35%,${pal[2]},${pal[1]} 55%,transparent 70%);opacity:.9"></div>
      <div style="position:absolute;left:18px;bottom:16px;font:800 30px/1 sans-serif;color:${pal[2]};letter-spacing:-1px;mix-blend-mode:screen">${al.toUpperCase()}</div></div></body>`);
    covers[i] = await p.screenshot({ type: 'png' });
  }
  await p.close();
  return covers;
}

async function mockApple(page, covers, counters = {}) {
  page.on('pageerror', (e) => { console.log('PAGEERROR', e.message); process.exitCode = 1; });
  const charts = { feed: { results: songs.map((s) => ({ id: String(s.trackId) })) } };
  const count = (k) => { counters[k] = (counters[k] || 0) + 1; };
  await page.route('**/api/catalog/charts*', (r) => { count('charts'); r.fulfill({ json: charts }); });
  await page.route('**/api/catalog/lookup*', (r) => {
    const ids = new URL(r.request().url()).searchParams.get('id').split(',');
    r.fulfill({ json: { results: songs.filter((s) => ids.includes(String(s.trackId))) } });
  });
  await page.route('**/api/catalog/search*', (r) => {
    count('search');
    const term = new URL(r.request().url()).searchParams.get('term').toLowerCase();
    r.fulfill({ json: { results: songs.filter((s) => `${s.trackName} ${s.artistName}`.toLowerCase().includes(term) || term === 'all') } });
  });
  // The same data when the app talks to Apple directly (no server yet, or the server is asleep).
  const cors = { 'Access-Control-Allow-Origin': '*' };
  await page.route('https://rss.marketingtools.apple.com/**', (r) => { count('charts'); r.fulfill({ json: charts, headers: cors }); });
  await page.route('https://itunes.apple.com/**', (r) => {
    const u = new URL(r.request().url());
    if (u.pathname === '/lookup') { const ids = u.searchParams.get('id').split(','); return r.fulfill({ json: { results: songs.filter((x) => ids.includes(String(x.trackId))) }, headers: cors }); }
    if (u.pathname === '/search') { count('search'); const t = (u.searchParams.get('term') || '').toLowerCase(); return r.fulfill({ json: { results: songs.filter((x) => `${x.trackName} ${x.artistName}`.toLowerCase().includes(t)) }, headers: cors }); }
    r.abort();
  });
  const serveArt = (r, url) => {
    const m = url.match(/mock(\d+)/);
    const png = m && covers[+m[1]];
    if (!png) return r.abort();
    r.fulfill({ body: png, contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' } });
  };
  await page.route('https://is1-ssl.mzstatic.com/**', (r) => serveArt(r, r.request().url()));
  await page.route((u) => u.pathname === '/api/art', (r) => serveArt(r, new URL(r.request().url()).searchParams.get('u') || ''));
  await page.route('https://audio-ssl.itunes.apple.com/**', (r) => r.fulfill({ body: AUDIO, contentType: 'audio/wav', headers: { 'Access-Control-Allow-Origin': '*' } }));
}

async function rank(page, i, { shotCompare, shotReact } = {}) {
  await page.locator(`#results li[data-id="${1000 + i}"] [data-act="rank"]`).click();
  await page.waitForSelector('.react.liked');
  if (shotReact) { await page.waitForTimeout(700); await page.screenshot({ path: `${out}/${shotReact}` }); }
  await page.click('.react.liked');
  let q = 0;
  while (await page.locator('.versus').count()) {
    q++;
    if (shotCompare && q === 1) { await page.waitForTimeout(500); await page.screenshot({ path: `${out}/${shotCompare}` }); }
    const opp = Number(await page.locator('.versus [data-choose="old"]').getAttribute('data-id')) - 1000;
    await page.click(taste[i] > taste[opp] ? '.versus [data-choose="new"]' : '.versus [data-choose="old"]');
    await page.waitForTimeout(260);
  }
  await page.waitForSelector('[data-done="close"]');
  return q;
}
const check = (label, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) process.exitCode = 1; };
const noOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const settle = (p, ms = 700) => p.waitForTimeout(ms);
async function closeSheet(p) { await p.click('[data-done="close"]').catch(() => p.keyboard.press('Escape')); await p.waitForSelector('#sheet', { state: 'hidden' }); }

/** Synthetic touch drag via CDP (pull-to-refresh is a touch gesture). */
async function touchDrag(page, x, y0, y1) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0 }] });
  for (let i = 1; i <= 12; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y0 + ((y1 - y0) * i) / 12 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
/** Horizontal pointer swipe on a row. */
async function swipe(page, sel, dx) {
  // Bring the row to mid-screen (the tab bar and mini player float over the bottom).
  await page.locator(sel).evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - window.innerHeight / 2));
  await page.waitForTimeout(250);
  const box = await page.locator(sel).boundingBox();
  const y = box.y + box.height / 2, x0 = box.x + box.width / 2;
  await page.mouse.move(x0, y); await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(x0 + (dx * i) / 10, y + i * 0.3);
  await page.mouse.up();
  await settle(page, 600);
}

async function main() {
  const server = createApp({ dbPath: ':memory:', env: {} });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const covers = await makeCovers(browser);
  const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, serviceWorkers: 'block' };
  try {
    // ================= Phone: guest → account =================
    const counters = {};
    const ctx1 = await browser.newContext(phone);
    const p = await ctx1.newPage();
    await mockApple(p, covers, counters);
    await p.goto(base);
    await p.waitForSelector('#results li.row');
    await settle(p, 1200);
    check('Discover renders chart rows', (await p.locator('#results li.row').count()) === 8);
    check('No horizontal overflow at 390px (Discover)', await noOverflow(p));
    const rowColor = await p.locator('#results li.row').first().evaluate((el) => el.style.getPropertyValue('--c'));
    check('Rows take their color from the album art', /^\d+,\d+,\d+$/.test(rowColor.trim()));
    await p.screenshot({ path: `${out}/01-discover.png` });

    // Preview playback + mini player
    await p.locator('#results li[data-id="1001"] [data-act="play"]').click();
    await p.waitForSelector('#mini:not([hidden])');
    await settle(p, 900);
    check('Mini player appears and is playing', (await p.locator('#mini-toggle').getAttribute('aria-label')) === 'Pause');
    check('Playing row shows the equalizer', (await p.locator('#results li[data-id="1001"] .eq').count()) === 1);
    await p.screenshot({ path: `${out}/02-discover-playing.png` });
    // Crossfade to the next song via the mini player
    await p.click('#mini-next');
    await settle(p, 700);
    check('Next song plays from the same list', (await p.locator('#mini-meta .t1').innerText()) === 'Static');
    await p.click('#mini-toggle');

    // Instant cached search
    await p.fill('#search', 'mira');
    await p.waitForFunction(() => document.querySelector('#results-title').textContent.includes('mira') && document.querySelectorAll('#results li.row').length === 2);
    const searches = counters.search;
    await p.fill('#search', '');
    await settle(p, 400);
    await p.fill('#search', 'mira');
    await settle(p, 300);
    check('Repeat search is served from cache (no new request)', searches === 1 && counters.search === 1 && (await p.locator('#results li.row').count()) === 2);
    await p.fill('#search', '');
    await p.waitForSelector('#results li.row[data-id="1007"]');

    // Rank 3 songs as a guest
    let shotDone = false;
    for (const i of [0, 1, 2]) {
      await rank(p, i, { shotCompare: i === 2 ? '04-compare.png' : null, shotReact: i === 1 ? '03-rank-react.png' : null });
      await closeSheet(p);
    }

    // Sign up (guest list moves in)
    await p.click('#account-btn');
    await p.click('[data-switch="signup"]');
    await p.fill('input[name=displayName]', 'Maya Chen');
    await p.fill('input[name=username]', 'maya');
    await p.fill('input[name=password]', 'correct horse');
    await p.screenshot({ path: `${out}/05-signup.png` });
    await p.click('#auth-form button');
    await p.waitForSelector('#account-btn .avatar');
    check('Guest songs moved into the new account', (await p.locator('#toast').innerText()).includes('3 ranked songs'));

    for (const i of [3, 4, 5, 6, 7]) {
      await rank(p, i);
      if (i === 6 && !shotDone) { await settle(p, 1500); await p.screenshot({ path: `${out}/06-ranked-score.png` }); shotDone = true; }
      await closeSheet(p);
    }
    const counted = await p.evaluate(() => [...document.querySelectorAll('#results .ring-num')].map((n) => n.textContent));
    check('Score rings show final values after the count-up', counted.length > 0 && counted.every((t) => /^(10|\d\.\d)$/.test(t) && t !== '0.0'));

    // My List + drag to rank
    await p.click('.tab[data-view="list"]');
    await settle(p, 900);
    const expected = rows.map((r, i) => [r[0], taste[i]]).sort((a, b) => b[1] - a[1]).map((x) => x[0]);
    const titles = async () => p.$$eval('#ranked .t1', (els) => els.map((e) => e.firstChild.textContent));
    check('My List is in the right order', JSON.stringify(await titles()) === JSON.stringify(expected));
    check('Long titles stay on one line (no overflow)', await noOverflow(p));
    await p.screenshot({ path: `${out}/07-my-list.png` });
    const last = p.locator('#ranked li.row').last();
    await p.evaluate(() => { const r = [...document.querySelectorAll('#ranked li.row')]; window.scrollTo(0, r[r.length - 1].getBoundingClientRect().top + scrollY - 420); });
    await settle(p, 300);
    const grip = await last.locator('.grip').boundingBox();
    const firstBox = await p.locator('#ranked li.row').first().boundingBox();
    await p.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await p.mouse.down();
    for (let i = 1; i <= 16; i++) await p.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2 + ((firstBox.y + 10 - grip.y) * i) / 16);
    await settle(p, 200);
    await p.screenshot({ path: `${out}/08-dragging.png` });
    await p.mouse.up();
    await settle(p, 900);
    const after = await titles();
    check('Drag-to-rank moves the last song to #1', after[0] === expected[expected.length - 1] && /Moved to #1/.test(await p.locator('#toast').innerText()));
    await p.click('.toast-act');
    await settle(p, 400);
    check('Undo restores the previous order', JSON.stringify(await titles()) === JSON.stringify(expected));

    // Artists / albums
    await p.click('#list-seg [data-seg="artists"]');
    await settle(p, 900);
    const artists = await p.$$eval('#ranked li.group', (lis) => lis.map((l) => [l.querySelector('.t1').textContent, l.querySelector('.ring').dataset.value]));
    check('Artist averages, highest first', artists[0][0] === 'Kite Club' && artists[0][1] === '9.8' && artists.length === 4);
    check('A perfect score reads "10" so it fits the ring', (await p.$$eval('#results .ring-num, #ranked .ring-num', (n) => n.map((x) => x.textContent))).every((t) => t !== '10.0'));
    await p.screenshot({ path: `${out}/09-artists.png` });
    await p.click('#list-seg [data-seg="albums"]');
    await settle(p, 600);
    await p.locator('#ranked li.group').nth(1).locator('.cover').click();
    await settle(p, 1400);
    check('Album page opens with its songs', (await p.locator('#view-group.active #group-list li.row').count()) === 2);
    await p.screenshot({ path: `${out}/10-album-page.png` });
    await p.click('#view-group [data-back]');
    await settle(p, 500);
    check('Back returns to My List', await p.locator('#view-list.active').count() === 1);

    // Discover gestures: swipe right → Later, swipe left → skip, pull to refresh
    await p.click('.tab[data-view="discover"]');
    await settle(p, 600);
    await swipe(p, '#results li.row[data-id="1006"] .row-body', 230);
    check('Swipe right saves to Later', (await p.locator('#later-count').innerText()) === '1');
    const before = await p.locator('#results li.row').count();
    await swipe(p, '#results li.row[data-id="1002"] .row-body', -230);
    check('Swipe left skips the song', (await p.locator('#results li.row').count()) === before - 1);
    const chartsBefore = counters.charts;
    await p.evaluate(() => window.scrollTo(0, 0));
    await touchDrag(p, 195, 260, 520);
    await settle(p, 900);
    check('Pull to refresh reloads the charts', counters.charts > chartsBefore);

    // Later
    await p.click('.tab[data-view="later"]');
    await settle(p, 700);
    await p.screenshot({ path: `${out}/11-later.png` });

    // Profile + Taste Profile + share card
    await p.click('.tab[data-view="profile"]');
    await settle(p, 1200);
    check('Taste Profile shows distribution, genres and artist averages', (await p.locator('#taste .dist .col').count()) === 10 && (await p.locator('#taste .hbar').count()) >= 6);
    await p.screenshot({ path: `${out}/12-profile.png` });
    await p.screenshot({ path: `${out}/13-profile-full.png`, fullPage: true });
    await p.click('#share-btn');
    await p.waitForSelector('#share-preview img', { timeout: 15000 });
    await settle(p, 700);
    const size = await p.evaluate(() => window.__encoreShareBlob && window.__encoreShareBlob.size);
    check('Share card exports a PNG', size > 50000);
    await p.screenshot({ path: `${out}/14-share-sheet.png` });
    const png = await p.evaluate(async () => { const b = window.__encoreShareBlob; const r = new FileReader(); return new Promise((res) => { r.onload = () => res(r.result); r.readAsDataURL(b); }); });
    require('fs').writeFileSync(`${out}/15-share-card.png`, Buffer.from(png.split(',')[1], 'base64'));
    await p.keyboard.press('Escape');
    await settle(p, 1200); // let sync flush

    // ================= Desktop =================
    const ctxD = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
    const d = await ctxD.newPage();
    await mockApple(d, covers);
    await d.goto(base);
    await d.click('#account-btn');
    await d.fill('input[name=username]', 'maya');
    await d.fill('input[name=password]', 'correct horse');
    await d.click('#auth-form button');
    await d.waitForSelector('#account-btn .avatar');
    await settle(d, 1200);
    check('No horizontal overflow at 1280px', await noOverflow(d));
    await d.screenshot({ path: `${out}/20-desktop-discover.png` });
    await d.keyboard.press('2');
    await settle(d, 900);
    check('Keyboard shortcut 2 opens My List', await d.locator('#view-list.active').count() === 1);
    check('Second device has the synced list', (await d.locator('#ranked li.row').count()) === 8);
    await d.screenshot({ path: `${out}/21-desktop-list.png` });
    await d.click('#list-seg [data-seg="albums"]');
    await settle(d, 500);
    await d.locator('#ranked li.group').first().locator('.cover').click();
    await settle(d, 1300);
    await d.screenshot({ path: `${out}/22-desktop-album.png` });
    await d.keyboard.press('Escape');
    await d.keyboard.press('4');
    await settle(d, 1200);
    await d.screenshot({ path: `${out}/23-desktop-profile.png` });
    await d.keyboard.press('Control+k');
    await d.waitForSelector('.palette.in');
    await d.keyboard.type('neon');
    await d.waitForSelector('.palette-list .song-opt');
    await settle(d, 400);
    check('Command palette finds songs on Apple Music', (await d.locator('.palette-list .song-opt').count()) >= 1);
    await d.screenshot({ path: `${out}/24-desktop-palette.png` });
    await d.keyboard.press('Escape');
    await d.keyboard.press('Control+k');
    await d.keyboard.type('later'); // typed immediately: the palette must already have focus
    await d.keyboard.press('Enter');
    await settle(d, 500);
    check('Palette command navigates (Go to Later)', await d.locator('#view-later.active').count() === 1);
    // Ranking with the keyboard on desktop
    await d.keyboard.press('1');
    await settle(d, 600);
    await d.fill('#search', 'all');
    await d.waitForSelector('#results li.row[data-id="1002"]');
    await d.locator('#results li.row[data-id="1002"] [data-act="open"]').first().click();
    await d.waitForSelector('[data-detail="rank"]');
    await d.click('[data-detail="rank"]');
    await d.click('.react.fine');
    await settle(d, 500);
    await d.screenshot({ path: `${out}/25-desktop-compare.png` });
    await d.keyboard.press('ArrowLeft');
    await settle(d, 600);
    check('Arrow keys pick a side while ranking', (await d.locator('.versus').count()) + (await d.locator('[data-done="close"]').count()) >= 1);

    // ================= Visitor: public profile =================
    const ctx3 = await browser.newContext(phone);
    const p3 = await ctx3.newPage();
    await mockApple(p3, covers);
    await p3.goto(base + '?u=maya');
    await p3.waitForSelector('#view-user.active #user-list li.row');
    await settle(p3, 900);
    check('Public profile visible to others', (await p3.locator('#user-name').innerText()) === 'Maya Chen');
    await p3.screenshot({ path: `${out}/16-public-profile.png` });

    // ================= Waking-up screen (slow server) =================
    const ctx4 = await browser.newContext(phone);
    const p4 = await ctx4.newPage();
    await mockApple(p4, covers);
    await p4.route('**/api/me', async (r) => { await new Promise((res) => setTimeout(res, 4500)); r.continue(); });
    await p4.goto(base);
    await p4.waitForSelector('#wake:not([hidden])', { timeout: 4000 });
    await p4.waitForSelector('#results li.row');
    await settle(p4, 300);
    check('Waking-up banner shows while the server is slow, app stays usable', (await p4.locator('#results li.row').count()) === 8 && await p4.locator('#wake:not([hidden])').count() === 1);
    await p4.screenshot({ path: `${out}/17-waking-up.png` });
    await p4.waitForSelector('#wake', { state: 'hidden', timeout: 8000 });
    check('Banner clears once the server answers', true);

    // ================= Empty states =================
    const ctx5 = await browser.newContext(phone);
    const p5 = await ctx5.newPage();
    await mockApple(p5, covers);
    await p5.goto(base + '#list');
    await settle(p5, 900);
    check('Empty My List shows a designed empty state', (await p5.locator('#ranked-state .state').count()) === 1);
    await p5.screenshot({ path: `${out}/18-empty-list.png` });
    await p5.route('**/api/catalog/search*', (r) => r.fulfill({ status: 502, json: { error: 'x' } }));
    await p5.route('https://itunes.apple.com/**', (r) => r.abort());
    await p5.click('.tab[data-view="discover"]');
    await p5.fill('#search', 'zzz');
    await p5.waitForSelector('#results-state .state.error', { timeout: 15000 });
    await settle(p5, 400);
    check('Search failure shows an error state with retry', (await p5.locator('#results-state [data-state-action]').count()) === 1);
    await p5.screenshot({ path: `${out}/19-error-state.png` });
  } finally {
    await browser.close();
    server.close();
  }
}

if (require.main === module) main();
module.exports = { mockApple, makeCovers, rank, songs, rows, taste, settle };
