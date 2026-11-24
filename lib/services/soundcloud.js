'use strict';
/* SoundCloud API adapter. "Recent" = Likes (no listening history in the API). Docs: developers.soundcloud.com/docs/api */
const { best } = require('../match');
const { makeCall } = require('../http');
const BASE = 'https://api.soundcloud.com';
const toTrack = (t) => t && ({ title: t.title, artist: (t.publisher_metadata && t.publisher_metadata.artist) || (t.user && t.user.username) || '', art: t.artwork_url, id: t.id || t.urn });

function api({ call }) {
  async function find(song) {
    const d = await call('/tracks', { query: { q: `${song.artist} ${song.title}`, limit: 8 } });
    return best(song, (Array.isArray(d) ? d : d.collection || []).map(toTrack), 2.5);
  }
  return {
    async account() { const m = await call('/me'); return m.username; },
    async recent() {
      const d = await call('/me/likes/tracks', { query: { limit: 40, linked_partitioning: 'true' } });
      return (Array.isArray(d) ? d : d.collection || []).map(toTrack).filter(Boolean);
    },
    async favorite(song) {
      const t = await find(song);
      if (!t) return null;
      await call(`/likes/tracks/${encodeURIComponent(t.id)}`, { method: 'POST' });
      return t;
    },
    async playlists() {
      const d = await call('/me/playlists', { query: { limit: 50, show_tracks: 'false' } });
      return (Array.isArray(d) ? d : d.collection || []).map((p) => ({ id: p.id || p.urn, name: p.title, count: p.track_count }));
    },
    async createPlaylist(name) {
      const p = await call('/playlists', { method: 'POST', body: { playlist: { title: name, sharing: 'private', description: 'Made with Encore' } } });
      return { id: p.id || p.urn, name: p.title, count: 0 };
    },
    async addToPlaylist(id, song) {
      const t = await find(song);
      if (!t) return null;
      const p = await call(`/playlists/${encodeURIComponent(id)}`);
      const tracks = (p.tracks || []).map((x) => ({ id: x.id || x.urn }));
      tracks.push({ id: t.id });
      await call(`/playlists/${encodeURIComponent(id)}`, { method: 'PUT', body: { playlist: { tracks } } });
      return t;
    },
  };
}

/** Public lookup: a profile's public likes (by profile URL or username). Uses the app's client credentials. */
async function lookup(input, { env, fetch }) {
  if (!env.SOUNDCLOUD_CLIENT_ID || !env.SOUNDCLOUD_CLIENT_SECRET) throw Object.assign(new Error('SoundCloud lookups need SOUNDCLOUD_CLIENT_ID and SOUNDCLOUD_CLIENT_SECRET.'), { status: 501 });
  const tok = await makeCall(fetch, '')('https://secure.soundcloud.com/oauth/token', {
    method: 'POST', form: { grant_type: 'client_credentials' },
    headers: { Authorization: 'Basic ' + Buffer.from(`${env.SOUNDCLOUD_CLIENT_ID}:${env.SOUNDCLOUD_CLIENT_SECRET}`).toString('base64') },
  });
  const call = makeCall(fetch, BASE, async () => ({ Authorization: 'OAuth ' + tok.access_token }));
  const s = String(input).trim();
  const url = /^https?:/.test(s) ? s : `https://soundcloud.com/${s.replace(/^@/, '')}`;
  const user = await call('/resolve', { query: { url } });
  if (!user || !user.id) throw Object.assign(new Error('No SoundCloud profile found.'), { status: 404 });
  const d = await call(`/users/${user.id}/likes/tracks`, { query: { limit: 40, linked_partitioning: 'true' } });
  return { account: user.username, source: 'SoundCloud public likes', tracks: (Array.isArray(d) ? d : d.collection || []).map(toTrack).filter(Boolean) };
}

module.exports = { key: 'soundcloud', base: BASE, api, lookup, authScheme: 'OAuth' };
