/*
 * Charts in the browser. With the Encore server, everything comes from
 * /api/charts (all sources, one genre per song, cached server-side).
 *
 * Without a server (GitHub Pages) there's a smaller fallback:
 *   Current Chart → Deezer's genre chart (no key, JSONP), not de-duplicated
 *   Most Streamed → Last.fm play counts by tag, if config.js has lastfmApiKey
 */
(function () {
  let ctx = null; // { server(), country(), config }
  const cache = new Map();
  let seq = 0;
  function jsonp(url, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const cb = '__encore_dz' + (++seq);
      const s = document.createElement('script');
      const t = setTimeout(() => { done(); reject(new Error('timeout')); }, timeout);
      function done() { clearTimeout(t); delete window[cb]; s.remove(); }
      window[cb] = (d) => { done(); resolve(d); };
      s.onerror = () => { done(); reject(new Error('network')); };
      s.src = url + (url.includes('?') ? '&' : '?') + 'output=jsonp&callback=' + cb;
      document.head.appendChild(s);
    });
  }
  async function getJson(url, timeout = 30000) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), timeout);
    try { const r = await fetch(url, { signal: c.signal }); if (!r.ok) throw new Error(String(r.status)); return await r.json(); }
    finally { clearTimeout(t); }
  }

  async function fromServer(key) {
    return getJson(`/api/charts?genre=${encodeURIComponent(key)}`);
  }
  async function standalone(key) {
    const g = window.Genres.byKey[key];
    const out = {};
    if (g.deezerId === null || g.deezerId === undefined) out.current = { rows: [], note: `There’s no free ${g.label} chart to read without the Encore server.` };
    else {
      try {
        const d = await jsonp(`https://api.deezer.com/chart/${g.deezerId}/tracks?limit=50`);
        out.current = { source: 'Deezer', updatedAt: Date.now(), note: 'Without the Encore server, songs can repeat across genres.', rows: (d.data || []).map((t, i) => ({ rank: i + 1, title: t.title_short || t.title, artist: t.artist && t.artist.name, art: t.album && (t.album.cover_xl || t.album.cover_medium), appleId: null })) };
      } catch (_) { out.current = { rows: [], note: 'Deezer’s chart didn’t load. Check your connection.' }; }
    }
    const key2 = ctx.config.lastfmApiKey;
    if (!key2 || !g.lastfmTag) out.streamed = { rows: [], note: 'Most Streamed needs the Encore server (Spotify stream counts) or a Last.fm key in config.js.' };
    else {
      try {
        const base = 'https://ws.audioscrobbler.com/2.0/?format=json&api_key=' + encodeURIComponent(key2);
        const d = await getJson(`${base}&method=tag.gettoptracks&limit=25&tag=${encodeURIComponent(g.lastfmTag)}`);
        const tracks = ((d.tracks && d.tracks.track) || []).slice(0, 20);
        const infos = await Promise.all(tracks.map((t) => getJson(`${base}&method=track.getinfo&artist=${encodeURIComponent(t.artist.name)}&track=${encodeURIComponent(t.name)}`).catch(() => null)));
        const rows = tracks.map((t, i) => ({ title: t.name, artist: t.artist.name, streams: Number(infos[i] && infos[i].track && infos[i].track.playcount) || 0, unit: 'Last.fm plays' }))
          .filter((r) => r.streams).sort((a, b) => b.streams - a.streams).map((r, i) => ({ ...r, rank: i + 1 }));
        out.streamed = { source: 'Last.fm', updatedAt: Date.now(), rows };
      } catch (_) { out.streamed = { rows: [], note: 'Last.fm didn’t answer. Try again in a moment.' }; }
    }
    return out;
  }

  window.Charts = {
    init(c) { ctx = c; },
    /** { current: {source, updatedAt, rows, note, building}, streamed: {…}, albums? } */
    async load(key, { fresh = false } = {}) {
      const ck = key + '|' + ctx.country();
      const hit = cache.get(ck);
      if (!fresh && hit && Date.now() - hit.t < 10 * 60e3) return hit.v;
      const v = ctx.server() ? await fromServer(key) : await standalone(key);
      if (!(v.current && v.current.building) && !(v.streamed && v.streamed.building)) cache.set(ck, { t: Date.now(), v });
      return v;
    },
  };
})();
