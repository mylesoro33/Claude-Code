'use strict';
/* Spotify Web API adapter. Docs: developer.spotify.com/documentation/web-api */
const { best } = require('../match');
const { makeCall } = require('../http');
const BASE = 'https://api.spotify.com/v1';
const toTrack = (t) => t && ({ title: t.name, artist: (t.artists || []).map((a) => a.name)[0] || '', album: t.album && t.album.name, art: t.album && t.album.images && t.album.images[0] && t.album.images[0].url, id: t.id });

function api({ call }) {
  let meCache = null;
  const me = async () => (meCache = meCache || (await call('/me')));
  async function find(song) {
    const q = `track:${song.title} artist:${song.artist}`;
    const d = await call('/search', { query: { q, type: 'track', limit: 8 } });
    let hit = best(song, (d.tracks && d.tracks.items || []).map(toTrack));
    if (!hit) {
      const d2 = await call('/search', { query: { q: `${song.artist} ${song.title}`, type: 'track', limit: 8 } });
      hit = best(song, (d2.tracks && d2.tracks.items || []).map(toTrack));
    }
    return hit;
  }
  return {
    async account() { const m = await me(); return m.display_name || m.id; },
    async recent() {
      const d = await call('/me/player/recently-played', { query: { limit: 40 } });
      const seen = new Set();
      return (d.items || []).map((i) => toTrack(i.track)).filter((t) => t && !seen.has(t.id) && seen.add(t.id));
    },
    async favorite(song) {
      const t = await find(song);
      if (!t) return null;
      await call('/me/tracks', { method: 'PUT', query: { ids: t.id } });
      return t;
    },
    async playlists() {
      const m = await me();
      const d = await call('/me/playlists', { query: { limit: 50 } });
      return (d.items || []).filter((p) => p && (p.owner && p.owner.id === m.id || p.collaborative))
        .map((p) => ({ id: p.id, name: p.name, count: p.tracks ? p.tracks.total : null }));
    },
    async createPlaylist(name) {
      const m = await me();
      const p = await call(`/users/${encodeURIComponent(m.id)}/playlists`, { method: 'POST', body: { name, public: false, description: 'Made with Encore' } });
      return { id: p.id, name: p.name, count: 0 };
    },
    async addToPlaylist(id, song) {
      const t = await find(song);
      if (!t) return null;
      await call(`/playlists/${encodeURIComponent(id)}/tracks`, { method: 'POST', body: { uris: [`spotify:track:${t.id}`] } });
      return t;
    },
  };
}

/** Public lookup: a user's public playlists (Spotify doesn't expose anyone's recent or top tracks publicly). */
async function lookup(input, { env, fetch }) {
  if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET) throw Object.assign(new Error('Spotify lookups need SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET.'), { status: 501 });
  const m = String(input).match(/open\.spotify\.com\/(?:intl-[a-z]+\/)?user\/([^/?#]+)/i) || String(input).match(/^spotify:user:(.+)$/) || [null, String(input).trim()];
  const user = decodeURIComponent(m[1]);
  const tok = await makeCall(fetch, '')('https://accounts.spotify.com/api/token', {
    method: 'POST', form: { grant_type: 'client_credentials' },
    headers: { Authorization: 'Basic ' + Buffer.from(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`).toString('base64') },
  });
  const call = makeCall(fetch, BASE, async () => ({ Authorization: 'Bearer ' + tok.access_token }));
  const profile = await call(`/users/${encodeURIComponent(user)}`);
  const pls = await call(`/users/${encodeURIComponent(user)}/playlists`, { query: { limit: 5 } });
  const tracks = [];
  for (const p of (pls.items || []).slice(0, 3)) {
    const d = await call(`/playlists/${p.id}/tracks`, { query: { limit: 30, fields: 'items(track(id,name,artists(name),album(name,images)))' } });
    (d.items || []).forEach((i) => i.track && tracks.push({ ...toTrack(i.track), from: p.name }));
  }
  const seen = new Set();
  return { account: profile.display_name || user, source: 'Spotify public playlists', tracks: tracks.filter((t) => !seen.has(t.id) && seen.add(t.id)) };
}

module.exports = { key: 'spotify', base: BASE, api, lookup };
