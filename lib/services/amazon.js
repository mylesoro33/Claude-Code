'use strict';
/*
 * Amazon Music Web API adapter (closed beta). Sign-in is Login with Amazon;
 * every Amazon Music call also needs the x-api-key Amazon issues on approval.
 * Endpoint paths follow Amazon's beta documentation and are kept in one table
 * so they're easy to correct once you have access. Untested without a key.
 */
const { best } = require('../match');
const BASE = 'https://api.music.amazon.dev/v1';
const PATHS = {
  recent: '/me/recentlyPlayed/tracks',
  search: '/search/tracks',
  library: '/me/library/tracks',
  playlists: '/me/playlists',
  createPlaylist: '/playlists',
  playlistTracks: (id) => `/playlists/${encodeURIComponent(id)}/tracks`,
};
const pick = (d) => (d && (d.data || d.items || d.tracks || d.playlists)) || [];
const toTrack = (t) => t && ({ title: t.title || t.name, artist: (t.artists && t.artists[0] && (t.artists[0].name || t.artists[0])) || t.artistName || '', art: t.image || (t.images && t.images[0] && t.images[0].url), id: t.id || t.asin });

function api({ call, env, fetch }) {
  const needKey = () => { if (!env.AMAZON_MUSIC_API_KEY) throw Object.assign(new Error('Connected to Amazon. Waiting for Amazon Music API access (AMAZON_MUSIC_API_KEY).'), { status: 501 }); };
  const music = (path, opts = {}) => { needKey(); return call(BASE + path, { ...opts, headers: { 'x-api-key': env.AMAZON_MUSIC_API_KEY } }); };
  async function find(song) {
    const d = await music(PATHS.search, { query: { keywords: `${song.artist} ${song.title}`, limit: 8 } });
    return best(song, pick(d).map(toTrack), 2.5);
  }
  return {
    async account() { const p = await call('https://api.amazon.com/user/profile'); return p.name || 'Amazon'; },
    async recent() { return pick(await music(PATHS.recent, { query: { limit: 40 } })).map(toTrack).filter(Boolean); },
    async favorite(song) { const t = await find(song); if (!t) return null; await music(PATHS.library, { method: 'POST', body: { ids: [t.id] } }); return t; },
    async playlists() { return pick(await music(PATHS.playlists, { query: { limit: 50 } })).map((p) => ({ id: p.id, name: p.title || p.name, count: p.trackCount ?? null })); },
    async createPlaylist(name) { const p = await music(PATHS.createPlaylist, { method: 'POST', body: { title: name, visibility: 'PRIVATE' } }); const x = p.data || p; return { id: x.id, name: x.title || name, count: 0 }; },
    async addToPlaylist(id, song) { const t = await find(song); if (!t) return null; await music(PATHS.playlistTracks(id), { method: 'POST', body: { trackIds: [t.id] } }); return t; },
  };
}
module.exports = { key: 'amazon', base: BASE, api, PATHS };
