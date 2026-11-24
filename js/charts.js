/*
 * Charts in the browser. With the Encore server, everything comes from
 * /api/charts (all sources, one genre per song, cached server-side).
 *
 * Without a server (GitHub Pages) there's a smaller fallback, still one genre per song:
 *   Charts tab    → Deezer's genre charts (no key, JSONP)
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
  // ---- Without a server: songs stay unique across genres ----
  // Every genre's chart is read, and each song is kept only in the genre where it ranks highest.
  const songKey = (r) => `${String(r.artist || '').toLowerCase().replace(/\s*(,|&| feat\.?| ft\.?| x | with ).*$/, '').replace(/[^a-z0-9]+/g, ' ').trim()}|${String(r.title || '').toLowerCase().replace(/\s*[([].*?[)\]]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()}`;
  function unique(pairs) {
    const best = new Map();
    for (const [key, rows] of pairs) (rows || []).forEach((r, i) => { const k = songKey(r); const b = best.get(k); if (!b || i < b.i) best.set(k, { key, i }); });
    return Object.fromEntries(pairs.map(([key, rows]) => [key, rows && rows.filter((r) => best.get(songKey(r)).key === key).map((r, i) => ({ ...r, rank: i + 1 }))]));
  }
  const pools = {}; // kind → { t, p: Promise<{ genreKey: rows | null }> }
  function pooled(kind, fresh, build) {
    const hit = pools[kind];
    if (!fresh && hit && Date.now() - hit.t < 10 * 60e3) return hit.p;
    const p = build();
    pools[kind] = { t: Date.now(), p };
    p.catch(() => { delete pools[kind]; });
    return p;
  }
  const genres = () => window.Genres.GENRES;
  const deezerRow = (t) => ({ title: t.title_short || t.title, artist: t.artist && t.artist.name, art: t.album && (t.album.cover_xl || t.album.cover_medium), appleId: null });
  const deezerGenres = (fresh) => pooled('deezer', fresh, async () => unique(await Promise.all(genres().filter((g) => g.deezerId != null && g.deezerId !== 0)
    .map((g) => jsonp(`https://api.deezer.com/chart/${g.deezerId}/tracks?limit=50`).then((d) => [g.key, (d.data || []).map(deezerRow)], () => [g.key, null])))));
  const lfm = (q) => getJson('https://ws.audioscrobbler.com/2.0/?format=json&api_key=' + encodeURIComponent(ctx.config.lastfmApiKey) + q);
  const lastfmGenres = (fresh) => pooled('lastfm', fresh, async () => unique(await Promise.all(genres().filter((g) => g.lastfmTag)
    .map((g) => lfm(`&method=tag.gettoptracks&limit=50&tag=${encodeURIComponent(g.lastfmTag)}`).then((d) => [g.key, ((d.tracks && d.tracks.track) || []).map((t) => ({ title: t.name, artist: t.artist.name }))], () => [g.key, null])))));

  async function standalone(key, fresh) {
    const g = window.Genres.byKey[key];
    const out = {};
    // Charts tab: Deezer's genre charts (no key).
    try {
      if (key === 'all') {
        const d = await jsonp('https://api.deezer.com/chart/0/tracks?limit=50');
        out.current = { source: 'Deezer', updatedAt: Date.now(), rows: (d.data || []).map((t, i) => ({ ...deezerRow(t), rank: i + 1 })) };
      } else if (g.deezerId == null) out.current = { rows: [], note: `There’s no free ${g.label} chart to read without the Encore server.` };
      else {
        const rows = (await deezerGenres(fresh))[key];
        out.current = rows ? { source: 'Deezer', updatedAt: Date.now(), rows } : { rows: [], note: 'Deezer’s chart didn’t load. Check your connection.' };
      }
    } catch (_) { out.current = { rows: [], note: 'Deezer’s chart didn’t load. Check your connection.' }; }
    // Most Streamed tab: Last.fm all-time play counts (needs lastfmApiKey in config.js).
    if (!ctx.config.lastfmApiKey || !g.lastfmTag) out.streamed = { rows: [], note: 'Most Streamed needs the Encore server (Spotify stream counts) or a Last.fm key in config.js.' };
    else {
      try {
        const tracks = ((await lastfmGenres(fresh))[key] || []).slice(0, 20);
        const infos = await Promise.all(tracks.map((t) => lfm(`&method=track.getinfo&artist=${encodeURIComponent(t.artist)}&track=${encodeURIComponent(t.title)}`).catch(() => null)));
        const rows = tracks.map((t, i) => ({ title: t.title, artist: t.artist, streams: Number(infos[i] && infos[i].track && infos[i].track.playcount) || 0, unit: 'Last.fm plays' }))
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
      const ck = key + '|' + ctx.country() + '|' + (ctx.server() ? 'server' : 'browser');
      const hit = cache.get(ck);
      if (!fresh && hit && Date.now() - hit.t < 10 * 60e3) return hit.v;
      const v = ctx.server() ? await fromServer(key) : await standalone(key, fresh);
      if (!(v.current && v.current.building) && !(v.streamed && v.streamed.building)) cache.set(ck, { t: Date.now(), v });
      return v;
    },
  };
})();
