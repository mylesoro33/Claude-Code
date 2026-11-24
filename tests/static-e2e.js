// Guest-mode check for static hosting (GitHub Pages): no Encore server, the
// app talks to Apple directly. Serves the site files under /Claude-Code/ like Pages does.
// Usage: node tests/static-e2e.js [screenshotDir]
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { mockBrowser, makeCovers, rateVia, settle } = require('./e2e.js');
const out = process.argv[2] || '.';
const ROOT = path.join(__dirname, '..');
const SITE = ['index.html', 'app.js', 'ranking.js', 'genres.js', 'recommend.js', 'config.js', 'styles.css', 'sw.js', 'manifest.webmanifest', 'icon.svg', 'js', 'fonts', 'icons'];
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
const check = (label, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) process.exitCode = 1; };

(async () => {
  // Like GitHub Pages: plain files under /Claude-Code/, 404 page for anything else (including /api/*).
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let rel = decodeURIComponent(u.pathname).replace(/^\/Claude-Code\/?/, '') || 'index.html';
    const file = path.join(ROOT, rel);
    if (!u.pathname.startsWith('/Claude-Code/') || !SITE.includes(rel.split('/')[0]) || !fs.existsSync(file)) {
      res.writeHead(404, { 'Content-Type': 'text/html' }); return res.end('<h1>404</h1>');
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}/Claude-Code/`;
  const browser = await chromium.launch();
  try {
    const covers = await makeCovers(browser);
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, serviceWorkers: 'block' });
    const p = await ctx.newPage();
    await mockBrowser(p, covers);
    // Deezer's genre chart over JSONP (the only no-key chart a static site can read).
    await p.route('https://api.deezer.com/**', (r) => {
      const cb = new URL(r.request().url()).searchParams.get('callback');
      const data = [['Glass House', 'Mira'], ['Neon Rain', 'Kite Club']].map(([t, a], i) => ({ title: t, artist: { name: a }, album: { cover_medium: '' }, position: i + 1 }));
      r.fulfill({ contentType: 'text/javascript', body: `${cb}(${JSON.stringify({ data })})` });
    });
    await p.goto(base);
    await p.waitForSelector('#trending li.row');
    await settle(p, 1000);
    check('Trending loads straight from Apple (no server)', (await p.locator('#trending li.row').count()) === 8);
    check('Fonts, scripts and data layers load under the /Claude-Code/ path', await p.evaluate(() => document.fonts.check('800 20px Fraunces') && !!window.Charts && !!window.Recommend && !!window.Genres));
    check('No Sign in button and no waking-up banner without a server', (await p.locator('#me-btn').isHidden()) && (await p.locator('#wake').isHidden()));
    await p.locator('#recent-state .btn', { hasText: 'Connect Apple Music' }).click();
    await p.waitForFunction(() => /isn’t set up on this site/.test(document.querySelector('#recent-state').textContent));
    check('Connect Apple Music explains it needs a MusicKit key (no crash)', true);
    await p.fill('#search', 'all');
    await p.waitForSelector('#results li.row[data-id="1001"]');
    await rateVia(p, '#results li.row[data-id="1001"] .rate-btn');
    await settle(p, 1300);
    check('First rating is a 10', (await p.locator('#big-score').innerText()) === '10');
    await p.click('[data-done="close"]');
    await p.waitForSelector('#sheet', { state: 'hidden' });
    await rateVia(p, '#results li.row[data-id="1003"] .rate-btn');
    await p.click('[data-done="close"]');
    await p.waitForSelector('#sheet', { state: 'hidden' });
    await p.click('.tab[data-view="charts"]');
    await p.waitForSelector('#chart-current li.row');
    check('Charts read Deezer’s real chart without a server (no placeholder data)', /deezer/i.test(await p.locator('#current-source').innerText()) && (await p.locator('#chart-current li.row').count()) === 2 && !/Placeholder/i.test(await p.locator('#view-charts').innerText()));
    check('Most Streamed explains it needs the server or a Last.fm key', /needs the Encore server/.test(await p.locator('#view-charts').innerText()));
    await p.click('.tab[data-view="recs"]');
    await p.waitForSelector('#recs .rec');
    check('Recommendations fall back to charts and favourite artists without a server', /need the Encore server|Rate 1 more/.test(await p.locator('#recs-note').innerText()));
    await p.reload();
    await p.waitForSelector('#trending li.row');
    await p.click('.tab[data-view="lists"]');
    await settle(p, 600);
    check('Ratings survive a reload (saved in the browser)', (await p.locator('#ratings li.row').count()) === 2);
    await p.click('.tab[data-view="profile"]');
    await settle(p, 600);
    check('Profile explains browser-only saving', /saved in this browser/.test(await p.locator('#profile').innerText()));
    check('Find my account explains it needs the Encore server', /Profile lookups need the Encore server/.test(await p.locator('#profile').innerText()));
    check('No Export button anywhere', !/Export/i.test(await p.locator('body').innerText()) && (await p.locator('#palette-btn').count()) === 0);
    await p.screenshot({ path: `${out}/pages-profile.png` });
  } finally {
    await browser.close();
    server.close();
  }
})();
