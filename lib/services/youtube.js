'use strict';
/*
 * YouTube Music via the YouTube Data API v3 (there is no YouTube Music API).
 * "Recent" = the user's Liked videos (the API has no watch history).
 * Docs: developers.google.com/youtube/v3/docs
 */
const { best, splitVideoTitle } = require('../match');
const { makeCall } = require('../http');
const BASE = 'https://www.googleapis.com/youtube/v3';
const toTrack = (v) => { const sn = v.snippet || {}; const s = splitVideoTitle(sn.title, sn.channelTitle || sn.videoOwnerChannelTitle); return { ...s, id: (v.id && v.id.videoId) || v.id || (sn.resourceId && sn.resourceId.videoId), art: sn.thumbnails && (sn.thumbnails.high || sn.thumbnails.default || {}).url }; };

function api({ call }) {
  async function find(song) {
    const d = await call('/search', { query: { part: 'snippet', type: 'video', videoCategoryId: '10', maxResults: 5, q: `${song.artist} ${song.title}` } });
    return best(song, (d.items || []).map(toTrack), 2.5);
  }
  return {
    async account() { const d = await call('/channels', { query: { part: 'snippet', mine: 'true' } }); return (d.items && d.items[0] && d.items[0].snippet.title) || 'YouTube'; },
    async recent() {
      const d = await call('/videos', { query: { part: 'snippet', myRating: 'like', maxResults: 50 } });
      return (d.items || []).filter((v) => !v.snippet.categoryId || v.snippet.categoryId === '10').map(toTrack);
    },
    async favorite(song) {
      const v = await find(song);
      if (!v) return null;
      await call('/videos/rate', { method: 'POST', query: { id: v.id, rating: 'like' } });
      return v;
    },
    async playlists() {
      const d = await call('/playlists', { query: { part: 'snippet,contentDetails', mine: 'true', maxResults: 50 } });
      return (d.items || []).map((p) => ({ id: p.id, name: p.snippet.title, count: p.contentDetails ? p.contentDetails.itemCount : null }));
    },
    async createPlaylist(name) {
      const p = await call('/playlists', { method: 'POST', query: { part: 'snippet,status' }, body: { snippet: { title: name, description: 'Made with Encore' }, status: { privacyStatus: 'private' } } });
      return { id: p.id, name: p.snippet.title, count: 0 };
    },
    async addToPlaylist(id, song) {
      const v = await find(song);
      if (!v) return null;
      await call('/playlistItems', { method: 'POST', query: { part: 'snippet' }, body: { snippet: { playlistId: id, resourceId: { kind: 'youtube#video', videoId: v.id } } } });
      return v;
    },
  };
}

/** Public lookup: a channel's public playlists (by @handle, channel URL or channel id). Needs YOUTUBE_API_KEY. */
async function lookup(input, { env, fetch }) {
  if (!env.YOUTUBE_API_KEY) throw Object.assign(new Error('YouTube lookups need YOUTUBE_API_KEY.'), { status: 501 });
  const call = makeCall(fetch, BASE);
  const key = env.YOUTUBE_API_KEY;
  const s = String(input).trim();
  const handle = (s.match(/youtube\.com\/(@[\w.-]+)/i) || s.match(/^(@[\w.-]+)$/) || [])[1];
  const chanId = (s.match(/youtube\.com\/channel\/(UC[\w-]+)/i) || s.match(/^(UC[\w-]{20,})$/) || [])[1];
  const ch = await call('/channels', { query: { part: 'snippet', key, ...(chanId ? { id: chanId } : { forHandle: handle || '@' + s.replace(/^@/, '') }) } });
  const c = ch.items && ch.items[0];
  if (!c) throw Object.assign(new Error('No YouTube channel found for that name.'), { status: 404 });
  const pls = await call('/playlists', { query: { part: 'snippet', channelId: c.id, maxResults: 5, key } });
  const tracks = [];
  for (const p of (pls.items || []).slice(0, 3)) {
    const d = await call('/playlistItems', { query: { part: 'snippet', playlistId: p.id, maxResults: 30, key } });
    (d.items || []).forEach((i) => tracks.push({ ...toTrack(i), from: p.snippet.title }));
  }
  return { account: c.snippet.title, source: 'YouTube public playlists', tracks };
}

module.exports = { key: 'youtube', base: BASE, api, lookup };
