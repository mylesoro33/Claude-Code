'use strict';
/* Last.fm (LASTFM_API_KEY): top tracks by tag with real play counts, and artist tags for genre assignment. */
const SOURCE = 'Last.fm';
const URL_ = 'https://ws.audioscrobbler.com/2.0/';
const qs = (o) => new URLSearchParams({ ...o, format: 'json' }).toString();
async function tagTop(genre, { get, env, mapLimit }) {
  if (!env.LASTFM_API_KEY || !genre.lastfmTag) return [];
  const d = await get(`${URL_}?${qs({ method: 'tag.gettoptracks', tag: genre.lastfmTag, limit: 40, api_key: env.LASTFM_API_KEY })}`);
  const tracks = ((d.tracks && d.tracks.track) || []).map((t) => ({ title: t.name, artist: t.artist && t.artist.name })).filter((t) => t.title && t.artist).slice(0, 30);
  const infos = await mapLimit(tracks, 4, (t) => get(`${URL_}?${qs({ method: 'track.getinfo', artist: t.artist, track: t.title, api_key: env.LASTFM_API_KEY })}`));
  return tracks.map((t, i) => ({ ...t, plays: Number(infos[i] && infos[i].track && infos[i].track.playcount) || 0, art: '' }))
    .filter((t) => t.plays).sort((a, b) => b.plays - a.plays).map((t, i) => ({ ...t, chartRank: i + 1 }));
}
async function artistTags(artist, { get, env }) {
  if (!env.LASTFM_API_KEY) return null;
  const d = await get(`${URL_}?${qs({ method: 'artist.gettoptags', artist, autocorrect: 1, api_key: env.LASTFM_API_KEY })}`);
  return ((d.toptags && d.toptags.tag) || []).slice(0, 8).map((t) => t.name);
}
module.exports = { SOURCE, tagTop, artistTags };
