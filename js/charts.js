/*
 * Encore charts data layer — the one place that decides where chart data comes from.
 *
 *   Charts.current(genreKey)  → top songs in the genre right now
 *   Charts.streamed(genreKey) → most-played songs of all time in the genre
 *
 * Both resolve to { songs, source, placeholder, note }.
 *
 * Sources, tried in order:
 *   current:  1. Encore server /api/charts/current (Apple genre feed)
 *             2. Apple's genre feed straight from the browser
 *             3. Placeholder (genres.js sample list), clearly labelled
 *   streamed: 1. Encore server /api/charts/streamed (Last.fm, server key)
 *             2. Last.fm straight from the browser (config.js lastfmApiKey)
 *             3. Placeholder, clearly labelled
 *
 * To plug in another provider later, add it to the `providers` arrays below:
 * each provider is async (genre, ctx) → songs[] (throw to fall through).
 */
(function () {
  const cache = new Map();
  const TTL = 30 * 60 * 1000;
  let ctx = null; // { server(), country(), lookup(ids), resolve(title, artist), config }

  async function getJson(url, timeout = 8000) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), timeout);
    try {
      const r = await fetch(url, { signal: c.signal });
      if (!r.ok) throw new Error(String(r.status));
      return await r.json();
    } finally { clearTimeout(t); }
  }
  async function resolveAll(pairs) {
    const out = [];
    let i = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (i < pairs.length) {
        const k = i++;
        try { out[k] = await ctx.resolve(pairs[k][0], pairs[k][1]); } catch (_) { out[k] = null; }
      }
    }));
    return out.filter(Boolean);
  }

  const providers = {
    current: [
      { name: 'Apple Music', run: async (g) => {
        if (!ctx.server()) throw new Error('no server');
        const d = await getJson(`/api/charts/current?genre=${g.key}&country=${ctx.country()}`, 15000);
        return d.songs;
      } },
      { name: 'Apple Music', run: async (g) => {
        if (!g.appleId) throw new Error('no feed');
        const d = await getJson(`https://itunes.apple.com/${ctx.country()}/rss/topsongs/limit=50/genre=${g.appleId}/json`);
        const ids = ((d.feed && d.feed.entry) || []).map((e) => e.id && e.id.attributes && e.id.attributes['im:id']).filter(Boolean);
        return ctx.lookup(ids);
      } },
    ],
    streamed: [
      { name: 'Last.fm', run: async (g) => {
        if (!ctx.server()) throw new Error('no server');
        const d = await getJson(`/api/charts/streamed?genre=${g.key}&country=${ctx.country()}`, 30000);
        return d.songs;
      } },
      { name: 'Last.fm', run: async (g) => {
        const key = ctx.config.lastfmApiKey;
        if (!key) throw new Error('no key');
        const qs = new URLSearchParams({ method: 'tag.gettoptracks', tag: g.lastfmTag, api_key: key, format: 'json', limit: '25' });
        const d = await getJson(`https://ws.audioscrobbler.com/2.0/?${qs}`);
        const pairs = ((d.tracks && d.tracks.track) || []).map((t) => [t.name, t.artist && t.artist.name]).filter((p) => p[0] && p[1]);
        return resolveAll(pairs);
      } },
    ],
  };

  async function load(kind, key, { fresh = false } = {}) {
    const g = window.Genres.byKey[key];
    if (!g) throw new Error('Unknown genre ' + key);
    const ck = `${kind}|${key}|${ctx.country()}`;
    const hit = cache.get(ck);
    if (!fresh && hit && Date.now() - hit.t < TTL) return hit.v;
    let v = null;
    for (const p of providers[kind]) {
      try {
        const songs = await p.run(g);
        if (songs && songs.length) { v = { songs, source: p.name, placeholder: false, note: '' }; break; }
      } catch (_) { /* next provider */ }
    }
    if (!v) {
      const songs = await resolveAll(g.sample);
      v = {
        songs, source: 'Sample data', placeholder: true,
        note: kind === 'streamed'
          ? 'Placeholder list of well-known songs, not live stream counts. Add a Last.fm API key to show real Most Streamed data.'
          : 'Placeholder list, not the live chart. Apple’s chart feed couldn’t be reached for this genre.',
      };
    }
    cache.set(ck, { t: Date.now(), v });
    return v;
  }

  window.Charts = {
    init(context) { ctx = context; },
    current: (key, opts) => load('current', key, opts),
    streamed: (key, opts) => load('streamed', key, opts),
    providers,
  };
})();
