'use strict';
/*
 * Billboard charts through a provider you license. Billboard has no free public
 * API and Encore doesn't scrape billboard.com.
 *   BILLBOARD_PROVIDER=rapidapi  BILLBOARD_API_KEY=…  BILLBOARD_API_HOST=…
 * Vendors differ slightly; normalize() accepts the common shapes:
 *   { content: { "1": { rank, title, artist, "weeks on chart", "peak position" } } }
 *   { chart: { entries: [ { rank, title, artist, weeks_on_chart, peak_position } ] } }
 *   [ { rank, title, artist, weeks, peak } ]
 */
const SOURCE = 'Billboard';
const configured = (env) => env.BILLBOARD_PROVIDER === 'rapidapi' && !!env.BILLBOARD_API_KEY && !!env.BILLBOARD_API_HOST;
const num = (v) => (v === undefined || v === null || v === '' ? null : Number(String(v).replace(/[^0-9]/g, '')) || null);
function normalize(d) {
  let rows = [];
  if (Array.isArray(d)) rows = d;
  else if (d && d.content) rows = Object.values(d.content);
  else if (d && d.chart && Array.isArray(d.chart.entries)) rows = d.chart.entries;
  else if (d && Array.isArray(d.data)) rows = d.data;
  else if (d && Array.isArray(d.entries)) rows = d.entries;
  return rows.map((r, i) => ({
    chartRank: num(r.rank ?? r.position ?? r.this_week) || i + 1,
    title: r.title || r.song || r.name,
    artist: r.artist || r.artist_name || r.performer,
    art: r.image || r.cover || r.image_url || '',
    weeks: num(r['weeks on chart'] ?? r.weeks_on_chart ?? r.weeks ?? r.weeksOnChart),
    peak: num(r['peak position'] ?? r.peak_position ?? r.peak ?? r.peakPosition),
  })).filter((r) => r.title && r.artist).sort((a, b) => a.chartRank - b.chartRank);
}
async function current(genre, { get, env, slug }) {
  const chart = slug || genre.billboard;
  if (!configured(env) || !chart) return [];
  const d = await get(`https://${env.BILLBOARD_API_HOST}/${chart}`, { headers: { 'X-RapidAPI-Key': env.BILLBOARD_API_KEY, 'X-RapidAPI-Host': env.BILLBOARD_API_HOST } });
  return normalize(d);
}
module.exports = { SOURCE, configured, normalize, current };
