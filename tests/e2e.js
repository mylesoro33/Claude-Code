// End-to-end UI test: real Encore server (in-process, temp DB) + mocked Apple catalog.
// Usage: node tests/e2e.js [screenshotDir]
const { chromium } = require('playwright');
const { createApp } = require('../server.js');
const out = process.argv[2] || '.';

const rows = [
  ['Midnight Drive', 'Nova Lane', 'Night Shift'], ['Golden Hour', 'Kite Club', 'Sunline'], ['Static', 'Nova Lane', 'Night Shift'],
  ['Paper Planes', 'The Oaks', 'Timber'], ['Low Tide', 'Mira', 'Harbor'], ['Neon Rain', 'Kite Club', 'Sunline'],
  ['Saltwater', 'The Oaks', 'Timber'], ['Glass House', 'Mira', 'Harbor'],
];
const songs = rows.map(([n, a, al], i) => ({
  kind: 'song', wrapperType: 'track', trackId: 1000 + i, trackName: n, artistName: a, collectionName: al,
  artistId: 50 + rows.findIndex((r) => r[1] === a), collectionId: 90 + rows.findIndex((r) => r[2] === al),
  // Song #3 has a broken artwork URL to exercise the placeholder fallback.
  artworkUrl100: i === 3 ? 'https://is1-ssl.mzstatic.com/image/thumb/broken/100x100bb.jpg'
    : 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="hsl(${(90 + rows.findIndex((r) => r[2] === al)) * 70},65%,50%)"/><circle cx="5" cy="5" r="3" fill="rgba(255,255,255,.35)"/></svg>`),
  previewUrl: '', trackViewUrl: 'https://music.apple.com/', primaryGenreName: 'Pop', releaseDate: '2025-01-01',
}));
const taste = [3, 9, 1, 7, 5, 8, 2, 6]; // hidden "true" preferences (all loved)

async function mockApple(page) {
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  const charts = { feed: { results: songs.map((s) => ({ id: String(s.trackId) })) } };
  await page.route('**/api/catalog/charts*', (r) => r.fulfill({ json: charts }));
  await page.route('**/api/catalog/lookup*', (r) => {
    const ids = new URL(r.request().url()).searchParams.get('id').split(',');
    r.fulfill({ json: { results: songs.filter((s) => ids.includes(String(s.trackId))) } });
  });
  await page.route('**/api/catalog/search*', (r) => r.fulfill({ json: { results: songs } }));
  await page.route('https://is1-ssl.mzstatic.com/**', (r) => r.abort());
}
async function rank(page, i) {
  await page.locator(`#results li[data-id="${1000 + i}"] [data-act="rank"]`).click();
  await page.click('.react.liked');
  let q = 0;
  while (await page.locator('.versus').count()) {
    q++;
    const opp = Number(await page.locator('.versus [data-choose="old"]').getAttribute('data-id')) - 1000;
    await page.click(taste[i] > taste[opp] ? '.versus [data-choose="new"]' : '.versus [data-choose="old"]');
  }
  return q;
}
const check = (label, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) process.exitCode = 1; };

(async () => {
  const server = createApp({ dbPath: ':memory:', env: {} });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch();
  try {
    // ---- Device 1: guest ranks 3 songs, then signs up ----
    const ctx1 = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const p = await ctx1.newPage();
    await mockApple(p);
    await p.goto(base);
    await p.waitForSelector('#results li.song');
    for (const i of [0, 1, 2]) { await rank(p, i); await p.click('[data-done="close"]'); }
    check('Sign in button shown when server is available', await p.locator('#account-btn').isVisible());

    await p.click('#account-btn');
    await p.click('[data-switch="signup"]');
    await p.fill('input[name=displayName]', 'Maya Chen');
    await p.fill('input[name=username]', 'maya');
    await p.fill('input[name=password]', 'correct horse');
    await p.click('#auth-form button');
    await p.waitForSelector('#account-btn .avatar');
    check('Guest songs moved into new account', (await p.locator('#toast').innerText()).includes('3 ranked songs'));

    for (const i of [3, 4, 5, 6]) { await rank(p, i); if (i !== 6) await p.click('[data-done="close"]'); }
    const done = await p.locator('.avg-box').innerText();
    check('Done screen shows artist + album averages', /The Oaks/.test(done) && /Timber/.test(done) && /2 songs ranked/.test(done));
    await p.screenshot({ path: out + '/done.png' });
    await p.click('[data-done="close"]');
    await rank(p, 7); await p.click('[data-done="close"]');

    // Cover art: every visible image actually rendered (real art or placeholder).
    await p.waitForTimeout(300);
    const broken = await p.$$eval('#results img', (imgs) => imgs.filter((i) => !i.complete || i.naturalWidth === 0).length);
    check('All cover art rendered', broken === 0);
    check('Broken artwork falls back to placeholder', (await p.getAttribute('#results li[data-id="1003"] img', 'src')).startsWith('data:image/svg'));

    // My List → Artists
    await p.click('.tab[data-view="list"]');
    await p.click('#list-seg [data-seg="artists"]');
    const artists = await p.$$eval('#ranked li.group', (lis) => lis.map((l) => [l.querySelector('.title').textContent, l.querySelector('.score').textContent]));
    console.log('Artists:', JSON.stringify(artists));
    // Kite Club = ranks 1,2 → 10.0 & 9.5 → 9.8 (avg of displayed scores rounded)
    check('Artist averages ranked highest first', artists[0][0] === 'Kite Club' && artists[0][1] === '9.8' && artists.length === 4);
    await p.screenshot({ path: out + '/artists.png' });
    await p.click('#list-seg [data-seg="albums"]');
    const albums = await p.$$eval('#ranked li.group .title', (t) => t.map((x) => x.textContent));
    check('Album view lists 4 albums', albums.length === 4 && albums[0] === 'Sunline');
    await p.locator('#ranked li.group').nth(1).click();
    await p.waitForSelector('.group-head');
    await p.waitForTimeout(400);
    await p.screenshot({ path: out + '/album.png' });
    await p.click('#modal-close');

    // Profile: Apple Music card when server has no MusicKit keys
    await p.click('.tab[data-view="profile"]');
    await p.click('[data-am="connect"]');
    await p.waitForSelector('#am-card .form-error');
    check('Apple Music shows a clear "not configured" message', /not configured/i.test(await p.locator('#am-card').innerText()));
    await p.screenshot({ path: out + '/profile.png', fullPage: true });
    await p.waitForTimeout(1200); // let sync flush

    // ---- Device 2: sign in, same list ----
    const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const p2 = await ctx2.newPage();
    await mockApple(p2);
    await p2.goto(base);
    await p2.click('#account-btn');
    await p2.fill('input[name=username]', 'maya');
    await p2.fill('input[name=password]', 'correct horse');
    await p2.click('#auth-form button');
    await p2.waitForSelector('#account-btn .avatar');
    await p2.click('.tab[data-view="list"]');
    const t2 = await p2.locator('#ranked .title').allTextContents();
    const expected = rows.map((r, i) => [r[0], taste[i]]).sort((a, b) => b[1] - a[1]).map((x) => x[0]);
    check('Second device gets the same synced, correctly ordered list', JSON.stringify(t2) === JSON.stringify(expected));

    // ---- Visitor: public profile via share link ----
    const ctx3 = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const p3 = await ctx3.newPage();
    await mockApple(p3);
    await p3.goto(base + '?u=maya');
    await p3.waitForSelector('#view-user.active #user-list li');
    check('Public profile visible to others', (await p3.locator('#user-name').innerText()) === 'Maya Chen' && (await p3.locator('#user-list li').count()) === 8);
    await p3.click('#user-seg [data-seg="artists"]');
    await p3.screenshot({ path: out + '/public.png' });
  } finally {
    await browser.close();
    server.close();
  }
})();
