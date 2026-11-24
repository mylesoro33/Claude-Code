const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const { createCharts, songKey } = require('../charts');
const kworb = require('../charts/sources/kworb');
const billboard = require('../charts/sources/billboard');
const Genres = require('../genres.js');

const appleFeed = (songs) => ({ feed: { entry: songs.map(([title, artist, id, genre]) => ({ 'im:name': { label: title }, 'im:artist': { label: artist }, 'im:image': [{ label: `https://is1-ssl.mzstatic.com/${id}/170x170bb.png` }], id: { attributes: { 'im:id': String(id) } }, category: { attributes: { label: genre } } })) } });
const KWORB_SONGS = `<table><thead><tr><th>Artist and Title</th><th>Streams</th><th>Daily</th></tr></thead><tbody>
<tr><td class="text"><div><a href="../artist/1.html">The Weeknd</a> - <a href="../track/a.html">Blinding Lights</a></div></td><td>4,912,345,678</td><td>2,000,000</td></tr>
<tr><td class="text"><div><a href="../artist/2.html">Drake</a> - <a href="../track/b.html">One Dance (feat. Wizkid &amp; Kyla)</a></div></td><td>3,500,000,000</td><td>1,000,000</td></tr>
<tr><td class="text"><div><a href="../artist/3.html">Tame Impala</a> - <a href="../track/c.html">The Less I Know The Better</a></div></td><td>2,100,000,000</td><td>900,000</td></tr>
</tbody></table>`;
const KWORB_DAILY = `<table><thead><tr><th>Pos</th><th>P+</th><th>Artist and Title</th><th>Days</th><th>Pk</th><th>(x?)</th><th>Streams</th><th>Streams+</th><th>7Day</th><th>7Day+</th><th>Total</th></tr></thead><tbody>
<tr><td>1</td><td>=</td><td class="text mp"><div><a href="../artist/3.html">Tame Impala</a> - <a href="../track/c.html">Dracula</a></div></td><td>21</td><td>1</td><td></td><td>5,000,000</td><td>+1</td><td>30,000,000</td><td>+1</td><td>90,000,000</td></tr>
</tbody></table>`;
const TAGS = { 'the weeknd': ['rnb', 'pop'], drake: ['Hip-Hop', 'rap'], 'tame impala': ['psychedelic', 'indie', 'rock'], 'morgan wallen': ['country'], 'sabrina carpenter': ['pop'] };

function fakeWeb() {
  const calls = [];
  const res = (body, status = 200) => ({ ok: status < 400, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  async function fetch(url) {
    const u = new URL(url);
    calls.push(u.host + u.pathname + (u.search ? '?' + u.searchParams.get('method') : ''));
    if (u.host === 'itunes.apple.com' && /genre=14\//.test(u.pathname)) return res(appleFeed([['Espresso', 'Sabrina Carpenter', 11, 'Pop'], ['One Dance', 'Drake', 12, 'Pop'], ['Blinding Lights', 'The Weeknd', 13, 'Pop']]));
    if (u.host === 'itunes.apple.com' && /genre=18\//.test(u.pathname)) return res(appleFeed([['Not Like Us', 'Kendrick Lamar', 21, 'Hip-Hop/Rap'], ['One Dance', 'Drake', 12, 'Hip-Hop/Rap']]));
    if (u.host === 'itunes.apple.com' && /genre=6\//.test(u.pathname)) return res(appleFeed([['Last Night', 'Morgan Wallen', 31, 'Country']]));
    if (u.host === 'itunes.apple.com' && /rss\/topsongs/.test(u.pathname)) return res(appleFeed([]));
    if (u.host === 'rss.marketingtools.apple.com') return res({ feed: { results: [{ id: '11', name: 'Espresso', artistName: 'Sabrina Carpenter' }, { id: '12', name: 'One Dance', artistName: 'Drake' }] } });
    if (u.host === 'itunes.apple.com' && u.pathname === '/search') {
      if (u.searchParams.get('entity') === 'musicArtist') return res({ results: [{ artistName: u.searchParams.get('term'), primaryGenreName: u.searchParams.get('term') === 'Kendrick Lamar' ? 'Hip-Hop/Rap' : 'Pop' }] });
      return res({ results: [{ trackId: 99, artistName: u.searchParams.get('term').split(' ')[0], artworkUrl100: 'https://is1-ssl.mzstatic.com/x/100x100bb.jpg', previewUrl: 'p' }] });
    }
    if (u.host === 'api.deezer.com') return res({ data: [] });
    if (u.host === 'kworb.net' && u.pathname.endsWith('songs.html')) return res(KWORB_SONGS);
    if (u.host === 'kworb.net') return res(KWORB_DAILY);
    if (u.host === 'ws.audioscrobbler.com') {
      const m = u.searchParams.get('method');
      if (m === 'artist.gettoptags') return res({ toptags: { tag: (TAGS[u.searchParams.get('artist').toLowerCase()] || []).map((name) => ({ name })) } });
      if (m === 'tag.gettoptracks') return res({ tracks: { track: u.searchParams.get('tag') === 'country' ? [{ name: 'Tennessee Whiskey', artist: { name: 'Morgan Wallen' } }] : [] } });
      if (m === 'track.getinfo') return res({ track: { playcount: '1234567' } });
    }
    return res({ error: 'unmocked' }, 404);
  }
  return { fetch, calls };
}
function make(web, { at = Date.parse('2026-11-02T12:00:00Z'), env = { LASTFM_API_KEY: 'k' } } = {}) {
  let t = at;
  const charts = createCharts({ db: new DatabaseSync(':memory:'), env, fetch: web.fetch, rpm: {}, now: () => t, log: () => {} });
  return { charts, setNow: (v) => { t = v; } };
}
const titles = (rows) => rows.map((r) => r.title);

test('each genre comes from its own endpoint, and every song appears in exactly one genre', async () => {
  const web = fakeWeb();
  const { charts } = make(web);
  const out = await charts.buildCurrent();
  assert.deepEqual(titles(out.genres.pop.rows), ['Espresso'], 'Drake and The Weeknd moved out of Pop');
  assert.deepEqual(titles(out.genres.hiphop.rows), ['Not Like Us', 'One Dance'], 'One Dance listed once, under its primary genre');
  assert.deepEqual(titles(out.genres.rnb.rows), ['Blinding Lights'], 'The Weeknd’s primary genre is R&B');
  assert.deepEqual(titles(out.genres.indie.rows), ['Dracula'], 'Indie (no Apple feed) filled from Spotify’s daily chart by artist genre');
  const seen = new Map();
  for (const g of Genres.GENRES) for (const r of out.genres[g.key].rows) {
    const k = songKey(r.artist, r.title);
    assert.ok(!seen.has(k), `${r.title} is in both ${seen.get(k)} and ${g.key}`);
    seen.set(k, g.key);
  }
  assert.ok(web.calls.some((c) => /genre=14/.test(c)) && web.calls.some((c) => /genre=18/.test(c)), 'separate per-genre requests');
  assert.deepEqual(titles(out.genres.all.rows), ['Espresso', 'One Dance'], 'the all-genres chart is not de-duplicated');
  assert.ok(out.genres.pop.rows[0].art && out.genres.pop.rows[0].appleId, 'rows carry artwork and an Apple id');
});

test('weeks on chart and peak come from daily snapshots; Billboard numbers win when present', async () => {
  const web = fakeWeb();
  const { charts, setNow } = make(web);
  await charts.buildCurrent();
  setNow(Date.parse('2026-11-10T12:00:00Z'));
  const out = await charts.buildCurrent();
  const r = out.genres.hiphop.rows.find((x) => x.title === 'Not Like Us');
  assert.deepEqual([r.weeks, r.peak, r.tracked], [2, 1, true]);
  const norm = billboard.normalize({ content: { 1: { rank: '1', title: 'A Bar Song', artist: 'Shaboozey', 'weeks on chart': '30', 'peak position': '1' } } });
  assert.deepEqual([norm[0].weeks, norm[0].peak, norm[0].chartRank], [30, 1, 1]);
  assert.equal(billboard.normalize({ chart: { entries: [{ rank: 2, title: 'X', artist: 'Y', weeks_on_chart: 5, peak_position: 2 }] } })[0].weeks, 5);
  assert.equal(billboard.configured({}), false);
});

test('Most Streamed: real stream counts per genre, unique across genres, topped up by Last.fm plays', async () => {
  const { charts } = make(fakeWeb());
  const out = await charts.buildStreamed();
  assert.deepEqual(out.genres.rnb.rows.map((r) => [r.title, r.streams, r.unit]), [['Blinding Lights', 4912345678, 'Spotify streams']]);
  assert.deepEqual(titles(out.genres.hiphop.rows), ['One Dance'], '“(feat. …)” trimmed from the title');
  assert.deepEqual(out.genres.country.rows.map((r) => [r.title, r.unit]), [['Tennessee Whiskey', 'Last.fm plays']]);
  assert.equal(out.genres.all.rows.length, 3);
});

test('cached: a second request within the refresh window does not refetch', async () => {
  const web = fakeWeb();
  const { charts } = make(web);
  const a = await charts.forGenre('pop');
  assert.ok(a.current.updatedAt && a.current.rows.length);
  const n = web.calls.length;
  await charts.forGenre('hiphop');
  assert.equal(web.calls.length, n);
  const none = make(fakeWeb(), { env: { KWORB_ENABLED: '0' } });
  const s = await none.charts.forGenre('pop');
  assert.match(s.streamed.note, /needs Kworb .* or a Last\.fm key/);
});

test('kworb parser and genre tag mapping', () => {
  const rows = kworb.parseTable(KWORB_SONGS);
  assert.deepEqual(rows[1], { artist: 'Drake', title: 'One Dance', streams: 3500000000, days: 0, peak: null });
  assert.equal(kworb.parseTable(KWORB_DAILY)[0].days, 21);
  assert.equal(Genres.fromTags(['seen live', 'indie pop', 'pop']), 'indie');
  assert.equal(Genres.fromTags(['pop rap']), 'hiphop');
  assert.equal(Genres.fromName('Música Mexicana'), 'latin');
  assert.equal(Genres.fromName('K-Pop'), 'kpop');
});
