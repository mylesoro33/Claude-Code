'use strict';
/* Apple catalog lookups (no key): an artist's primary genre, and matching chart rows to playable Apple songs. */
async function artistGenre(artist, { get, country = 'us' }) {
  const d = await get(`https://itunes.apple.com/search?${new URLSearchParams({ term: artist, entity: 'musicArtist', limit: '3', country })}`);
  const want = String(artist).toLowerCase();
  const rs = (d.results || []);
  const hit = rs.find((r) => String(r.artistName).toLowerCase() === want) || rs[0];
  return hit ? hit.primaryGenreName : null;
}
async function findSong(title, artist, { get, country = 'us' }) {
  const d = await get(`https://itunes.apple.com/search?${new URLSearchParams({ term: `${artist} ${title}`, media: 'music', entity: 'song', limit: '5', country })}`);
  const a = String(artist).toLowerCase();
  const rs = (d.results || []).filter((r) => r.trackId);
  const hit = rs.find((r) => String(r.artistName).toLowerCase().includes(a)) || rs[0];
  return hit ? { appleId: String(hit.trackId), art: hit.artworkUrl100, preview: hit.previewUrl, album: hit.collectionName, genreName: hit.primaryGenreName } : null;
}
module.exports = { artistGenre, findSong };
