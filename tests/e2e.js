// End-to-end UI test with mocked Apple Music responses.
// Usage: node tests/e2e.js [screenshotDir]  (loads index.html from disk)
const { chromium } = require('playwright');
const out = process.argv[2] || '.';
const names = ['Midnight Drive', 'Golden Hour', 'Static', 'Paper Planes', 'Low Tide', 'Neon Rain', 'Saltwater', 'Glass House'];
const artists = ['Nova Lane', 'Kite Club', 'Nova Lane', 'The Oaks', 'Mira', 'Kite Club', 'The Oaks', 'Mira'];
const genres = ['Pop', 'Indie', 'Pop', 'Rock', 'R&B', 'Indie', 'Rock', 'R&B'];
const songs = names.map((n, i) => ({
  kind: 'song', wrapperType: 'track', trackId: 1000 + i, trackName: n, artistName: artists[i], collectionName: 'Album ' + (i + 1),
  artworkUrl100: 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1" fill="hsl(${i * 45},70%,50%)"/></svg>`),
  previewUrl: '', trackViewUrl: 'https://music.apple.com/', primaryGenreName: genres[i], releaseDate: '2025-01-01',
}));

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 390, height: 844 } });
  p.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await p.route('https://rss.marketingtools.apple.com/**', (r) => r.fulfill({ json: { feed: { results: songs.map((s) => ({ id: String(s.trackId) })) } } }));
  await p.route('https://itunes.apple.com/**', (r) => r.fulfill({ json: { results: songs } }));
  await p.goto('file://' + require('path').resolve(__dirname, '../index.html'));
  await p.waitForSelector('#results li.song');
  console.log('chart rows', await p.locator('#results li.song').count());

  const taste = [3, 9, 1, 7, 5, 8, 2, 6]; // hidden "true" preferences
  let questions = 0;
  for (let i = 0; i < 8; i++) {
    await p.locator(`#results li[data-id="${1000 + i}"] [data-act="rank"]`).click();
    await p.click('.react.liked');
    while (await p.locator('.versus').count()) {
      questions++;
      if (questions === 6) await p.screenshot({ path: out + '/compare.png' });
      const opp = Number(await p.locator('.versus [data-choose="old"]').getAttribute('data-id')) - 1000;
      await p.click(taste[i] > taste[opp] ? '.versus [data-choose="new"]' : '.versus [data-choose="old"]');
    }
    if (i === 7) await p.screenshot({ path: out + '/done.png' });
    await p.click('[data-done="close"]');
  }
  console.log('questions asked for 8 songs:', questions);

  await p.click('.tab[data-view="list"]');
  const titles = await p.locator('#ranked .title').allTextContents();
  const scores = await p.locator('#ranked .score').allTextContents();
  console.log(titles.map((t, i) => `${i + 1}. ${t} ${scores[i]}`).join('\n'));
  const expected = names.map((n, i) => [n, taste[i]]).sort((a, b) => b[1] - a[1]).map((x) => x[0]);
  console.log('order correct:', JSON.stringify(titles) === JSON.stringify(expected));
  await p.screenshot({ path: out + '/list.png' });

  await p.reload();
  await p.click('.tab[data-view="profile"]');
  console.log('persisted stats:', (await p.locator('#stats').innerText()).replace(/\n/g, ' '));
  await p.screenshot({ path: out + '/profile.png' });
  await b.close();
})();
