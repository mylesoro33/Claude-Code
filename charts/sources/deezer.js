'use strict';
/* Deezer genre charts (no key): api.deezer.com/chart/{genreId}/tracks. */
const SOURCE = 'Deezer';
async function current(genre, { get }) {
  if (genre.deezerId === null || genre.deezerId === undefined) return [];
  const d = await get(`https://api.deezer.com/chart/${genre.deezerId}/tracks?limit=100`);
  return ((d && d.data) || []).map((t, i) => ({
    chartRank: t.position || i + 1, title: t.title_short || t.title, artist: t.artist && t.artist.name,
    art: t.album && (t.album.cover_xl || t.album.cover_big || t.album.cover_medium), album: t.album && t.album.title,
  })).filter((r) => r.title && r.artist);
}
module.exports = { SOURCE, current };
