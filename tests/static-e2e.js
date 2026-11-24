// Guest-mode check for static hosting (GitHub Pages): no Encore server, the
// app talks to Apple directly. Serves the site files under /Claude-Code/ like Pages does.
// Usage: node tests/static-e2e.js [screenshotDir]
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { mockApple, makeCovers, rank, settle } = require('./e2e.js');
const out = process.argv[2] || '.';
const ROOT = path.join(__dirname, '..');
const SITE = ['index.html', 'app.js', 'ranking.js', 'styles.css', 'sw.js', 'manifest.webmanifest', 'icon.svg', 'js', 'fonts', 'icons'];
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
    await mockApple(p, covers);
    await p.goto(base);
    await p.waitForSelector('#results li.row');
    await settle(p, 1200);
    check('Charts load straight from Apple (no server)', (await p.locator('#results li.row').count()) === 8);
    check('Fonts, scripts and icons load under the /Claude-Code/ path', await p.evaluate(() => document.fonts.check('700 20px Unbounded') && !!window.Gestures && !!window.Palette));
    check('No Sign in button without a server', await p.locator('#account-btn').isHidden());
    check('No waking-up banner on static hosting', await p.locator('#wake').isHidden());
    for (const i of [0, 1, 2]) { await rank(p, i); await p.click('[data-done="close"]'); await p.waitForSelector('#sheet', { state: 'hidden' }); }
    await p.click('.tab[data-view="list"]');
    await settle(p, 800);
    check('Ranking works and the list fills', (await p.locator('#ranked li.row').count()) === 3);
    await p.reload();
    await p.waitForSelector('#results li.row');
    await p.click('.tab[data-view="list"]');
    await settle(p, 600);
    check('List survives a reload (saved in the browser)', (await p.locator('#ranked li.row').count()) === 3);
    await p.click('.tab[data-view="profile"]');
    await settle(p, 900);
    check('Profile explains browser-only saving and hides Apple Music linking', /saved in this browser/.test(await p.locator('#account-card').innerText()) && await p.locator('#am-card').isHidden());
    await p.screenshot({ path: `${out}/pages-profile.png` });
  } finally {
    await browser.close();
    server.close();
  }
})();
