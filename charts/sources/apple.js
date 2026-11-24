'use strict';
/*
 * Apple Music charts (no key). Genre charts come from Apple's per-genre top-songs
 * feed; the all-genres chart from Apple's "most played" feed.
 */
const SOURCE = 'Apple Music';
async function current(genre, { get, country = 'us' }) {
  if (genre.key === 'all') {
    const d = await get(`https://rss.marketingtools.apple.com/api/v2/${country}/music/most-played/100/songs.json`);
    return ((d.feed && d.feed.results) || []).map((r, i) => ({ chartRank: i + 1, title: r.name, artist: r.artistName, art: r.artworkUrl100, appleId: String(r.id), genreName: r.genres && r.genres[0] && r.genres[0].name }));
  }
  if (!genre.appleId) return [];
  const d = await get(`https://itunes.apple.com/${country}/rss/topsongs/limit=100/genre=${genre.appleId}/json`);
  const entries = (d.feed && d.feed.entry) || [];
  return (Array.isArray(entries) ? entries : [entries]).map((e, i) => ({
    chartRank: i + 1,
    title: e['im:name'] && e['im:name'].label,
    artist: e['im:artist'] && e['im:artist'].label,
    art: e['im:image'] && e['im:image'].length ? e['im:image'][e['im:image'].length - 1].label : '',
    appleId: e.id && e.id.attributes && e.id.attributes['im:id'],
    genreName: e.category && e.category.attributes && e.category.attributes.label,
  })).filter((r) => r.title && r.artist);
}
module.exports = { SOURCE, current };
