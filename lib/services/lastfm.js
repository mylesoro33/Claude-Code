'use strict';
/* Last.fm: public lookups by username ("Find my account"). Docs: last.fm/api */
const { makeCall } = require('../http');
const BASE = 'https://ws.audioscrobbler.com/2.0/';
async function lookup(input, { env, fetch }) {
  if (!env.LASTFM_API_KEY) throw Object.assign(new Error('Last.fm lookups need LASTFM_API_KEY.'), { status: 501 });
  const user = (String(input).match(/last\.fm\/(?:[a-z]{2}\/)?user\/([^/?#]+)/i) || [null, String(input).trim()])[1];
  const call = makeCall(fetch, BASE);
  const q = (method, extra) => call('', { query: { method, user, api_key: env.LASTFM_API_KEY, format: 'json', ...extra } });
  const [recent, top] = await Promise.all([q('user.getrecenttracks', { limit: 30 }), q('user.gettoptracks', { period: '3month', limit: 30 })]);
  if (recent && recent.error) throw Object.assign(new Error(recent.message || 'No Last.fm user by that name.'), { status: 404 });
  const tracks = [];
  const seen = new Set();
  const add = (t, from) => {
    const artist = (t.artist && (t.artist['#text'] || t.artist.name)) || '';
    const k = (artist + '|' + t.name).toLowerCase();
    if (!t.name || seen.has(k)) return;
    seen.add(k);
    tracks.push({ title: t.name, artist, album: t.album && t.album['#text'], playcount: t.playcount ? Number(t.playcount) : undefined, from });
  };
  ((recent.recenttracks && recent.recenttracks.track) || []).forEach((t) => add(t, 'Recently played'));
  ((top.toptracks && top.toptracks.track) || []).forEach((t) => add(t, 'Top tracks, last 3 months'));
  return { account: user, source: 'Last.fm', tracks };
}
module.exports = { key: 'lastfm', lookup };
