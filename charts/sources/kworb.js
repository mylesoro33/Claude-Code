'use strict';
/*
 * Kworb (no key): an unofficial site that republishes Spotify's numbers.
 *   songs.html          all-time most-streamed songs on Spotify, with total streams
 *   global_daily.html   today's Spotify global chart, with days on chart and peak
 * Read at most once a day / week and cached. Turn off with KWORB_ENABLED=0.
 */
const SOURCE = 'Spotify via Kworb';
const enabled = (env) => env.KWORB_ENABLED !== '0';
const decode = (s) => String(s).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const toNum = (s) => Number(String(s).replace(/[^0-9]/g, '')) || 0;

/** Parse a kworb table: header names → column index; "Artist - Title" cell split. */
function parseTable(html) {
  const head = (html.match(/<thead[\s\S]*?<\/thead>/i) || html.match(/<tr[^>]*>\s*<th[\s\S]*?<\/tr>/i) || [''])[0];
  const cols = [...head.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => decode(m[1]).toLowerCase());
  const idx = (re) => cols.findIndex((c) => re.test(c));
  const body = (html.match(/<tbody[\s\S]*?<\/tbody>/i) || [html])[0];
  const out = [];
  for (const tr of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
    if (cells.length < 2) continue;
    const at = idx(/artist and title|artist & title|track/);
    const cell = cells[at >= 0 ? at : 0];
    const links = [...cell.matchAll(/<a[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => decode(m[1]));
    let artist, title;
    if (links.length >= 2) { artist = links[0]; title = links[links.length - 1]; }
    else { const t = decode(cell); const m = t.match(/^(.+?) - (.+)$/); if (!m) continue; [, artist, title] = m; }
    const get = (re) => { const i = idx(re); return i >= 0 ? decode(cells[i]) : ''; };
    out.push({ artist, title: title.replace(/\s*\((w\/|feat\.?|with) [^)]*\)$/i, ''), streams: toNum(get(/^streams$|^total$/)), days: toNum(get(/^days$/)), peak: toNum(get(/^pk$|^peak$/)) || null });
  }
  return out;
}
async function mostStreamed({ getText }) {
  return parseTable(await getText('https://kworb.net/spotify/songs.html')).filter((r) => r.streams).map((r, i) => ({ ...r, chartRank: i + 1 }));
}
async function daily({ getText }) {
  return parseTable(await getText('https://kworb.net/spotify/country/global_daily.html')).map((r, i) => ({ ...r, chartRank: i + 1, weeks: r.days ? Math.ceil(r.days / 7) : null }));
}
module.exports = { SOURCE, enabled, parseTable, mostStreamed, daily };
