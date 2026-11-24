'use strict';
/** Pick the candidate that best matches "title by artist" (or null when nothing is close). */
const clean = (s) => String(s || '').toLowerCase()
  .replace(/\s*[([].*?(feat|ft\.|with|remaster|version|edit|live|official|audio|video|lyric)[^)\]]*[)\]]/g, '')
  .replace(/\s+-\s+(official|lyric|audio|video|remaster).*$/i, '')
  .replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();

function score(want, got) {
  const wt = clean(want.title), gt = clean(got.title);
  const wa = clean(want.artist), ga = clean(got.artist);
  let s = 0;
  if (wt && gt) s += wt === gt ? 3 : gt.includes(wt) || wt.includes(gt) ? 2 : 0;
  if (wa && ga) s += wa === ga ? 2 : ga.includes(wa) || wa.includes(ga) ? 1.5 : (gt.includes(wa) ? 1 : 0);
  return s;
}
function best(want, candidates, min = 3) {
  let top = null, topScore = -1;
  for (const c of candidates || []) { const s = score(want, c); if (s > topScore) { top = c; topScore = s; } }
  return topScore >= min ? top : null;
}
/** "Artist - Title (Official Video)" → { artist, title } for YouTube titles. */
function splitVideoTitle(title, channel = '') {
  const t = String(title || '').replace(/\s*[([](official|lyric|audio|video|music video|visualizer|hd|4k)[^)\]]*[)\]]/gi, '').trim();
  const m = t.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (m) return { artist: m[1].trim(), title: m[2].trim() };
  return { artist: String(channel).replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').trim(), title: t };
}
module.exports = { clean, score, best, splitVideoTitle };
