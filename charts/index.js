'use strict';
/*
 * Encore charts: one data layer, one module per source (charts/sources/*).
 *
 * Current Chart (refreshed daily), per genre, from that genre's own endpoint:
 *   Billboard (if you license a provider) → Apple Music genre chart → Deezer genre chart,
 *   plus Spotify's daily global chart (Kworb) for genres with no feed of their own.
 * Most Streamed (refreshed weekly): Spotify all-time stream counts (Kworb),
 *   topped up with Last.fm play counts by tag for genres Kworb barely covers.
 *
 * Uniqueness: every song gets ONE primary genre (its primary artist's genre,
 * from Last.fm tags or Apple's artist genre, cached), and appears only in
 * that genre's chart. The all-genres chart is the one exception.
 *
 * Weeks on chart / peak: from Billboard when it supplies them, otherwise from
 * Encore's own daily snapshots (so they count from when your server started).
 */
const { GENRES, ALL, fromName, fromTags } = require('../genres.js');
const apple = require('./sources/apple');
const deezer = require('./sources/deezer');
const billboard = require('./sources/billboard');
const kworb = require('./sources/kworb');
const lastfm = require('./sources/lastfm');
const itunes = require('./sources/itunes');

const DAY = 864e5;
const KEYS = new Set(GENRES.map((g) => g.key));
const songKey = (artist, title) => `${String(artist).toLowerCase().replace(/\s*(,|&| feat\.?| ft\.?| x | with ).*$/, '').replace(/[^a-z0-9]+/g, ' ').trim()}|${String(title).toLowerCase().replace(/\s*[([].*?[)\]]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()}`;
const primaryArtist = (a) => String(a || '').split(/\s*(?:,|&| feat\.?| ft\.?| x | with )\s*/i)[0].trim();

function createCharts({ db, env, fetch, log = () => {}, now = Date.now, rpm = { 'itunes.apple.com': 18 }, lookupsPerRun = Number(env.CHART_LOOKUPS_PER_RUN) || 150, country = 'us' }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chart_cache (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS chart_history (chart TEXT NOT NULL, song TEXT NOT NULL, day TEXT NOT NULL, rank INTEGER NOT NULL, PRIMARY KEY (chart, song, day));
    CREATE TABLE IF NOT EXISTS artist_genre (artist TEXT PRIMARY KEY, genre TEXT NOT NULL, raw TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS song_match (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);`);
  const q = {
    cacheGet: db.prepare('SELECT data, updated_at FROM chart_cache WHERE key = ?'),
    cachePut: db.prepare('INSERT INTO chart_cache (key, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at'),
    histPut: db.prepare('INSERT OR REPLACE INTO chart_history (chart, song, day, rank) VALUES (?, ?, ?, ?)'),
    histGet: db.prepare('SELECT day, rank FROM chart_history WHERE chart = ? AND song = ?'),
    genreGet: db.prepare('SELECT genre FROM artist_genre WHERE artist = ?'),
    genrePut: db.prepare('INSERT OR REPLACE INTO artist_genre (artist, genre, raw, updated_at) VALUES (?, ?, ?, ?)'),
    matchGet: db.prepare('SELECT data FROM song_match WHERE key = ?'),
    matchPut: db.prepare('INSERT OR REPLACE INTO song_match (key, data, updated_at) VALUES (?, ?, ?)'),
  };

  // ---- polite HTTP: per-host spacing (Apple's search API allows ~20 calls a minute) ----
  const lastCall = new Map();
  async function pace(host) {
    const per = rpm[host];
    if (!per) return;
    const gap = 60000 / per;
    const wait = (lastCall.get(host) || 0) + gap - Date.now();
    lastCall.set(host, Math.max(Date.now(), (lastCall.get(host) || 0) + gap));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  async function raw(url, opts = {}) {
    await pace(new URL(url).host);
    const res = await fetch(url, { headers: { 'User-Agent': 'Encore/4.0 (+charts)', ...(opts.headers || {}) } });
    if (!res.ok) throw Object.assign(new Error(`${new URL(url).host} ${res.status}`), { status: res.status });
    return res;
  }
  const get = async (url, opts) => JSON.parse(await (await raw(url, opts)).text());
  const getText = async (url) => (await raw(url)).text();
  async function mapLimit(items, n, fn) {
    const out = new Array(items.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch { out[k] = null; } }
    }));
    return out;
  }
  const ctx = { get, getText, env, country, mapLimit };

  // ---- one primary genre per artist, cached ----
  let budget = 0;
  async function genreOf(artist, hint) {
    const a = primaryArtist(artist).toLowerCase();
    const cached = q.genreGet.get(a);
    if (cached) return cached.genre || hint || null;
    if (budget <= 0) return hint || null; // looked up on a later run
    budget--;
    let raw = '', key = null;
    try {
      const tags = await lastfm.artistTags(primaryArtist(artist), ctx);
      if (tags && tags.length) { raw = tags.join(', '); key = fromTags(tags); }
      if (!key) { const g = await itunes.artistGenre(primaryArtist(artist), ctx); raw = raw || g || ''; key = fromName(g); }
    } catch (e) { log(`genre lookup ${artist}: ${e.message}`); return hint || null; }
    q.genrePut.run(a, key || '', raw, now());
    return key || hint || null;
  }

  // ---- match chart rows to playable Apple songs (art, preview, id), cached ----
  async function withApple(rows, max) {
    let n = 0;
    for (const r of rows) {
      if (r.appleId) continue;
      const k = songKey(r.artist, r.title);
      const hit = q.matchGet.get(k);
      if (hit) { Object.assign(r, JSON.parse(hit.data)); continue; }
      if (n++ >= max || budget <= 0) continue;
      budget--;
      try {
        const m = await itunes.findSong(r.title, primaryArtist(r.artist), ctx);
        q.matchPut.run(k, JSON.stringify(m || {}), now());
        if (m) Object.assign(r, { appleId: m.appleId, art: r.art || m.art, preview: m.preview });
      } catch (e) { log(`match ${r.title}: ${e.message}`); }
    }
    return rows;
  }

  const today = () => new Date(now()).toISOString().slice(0, 10);
  /** Record today's positions and return weeks-on-chart and peak from our own history. */
  function track(chart, rows) {
    const d = today();
    for (const r of rows) {
      const k = songKey(r.artist, r.title);
      q.histPut.run(chart, k, d, r.rank);
      if (r.weeks && r.peak) continue; // Billboard gave us the real numbers
      const hist = q.histGet.all(chart, k);
      const weeks = new Set(hist.map((h) => Math.floor(Date.parse(h.day) / (7 * DAY)))).size;
      r.weeks = r.weeks || weeks;
      r.peak = Math.min(r.peak || Infinity, ...hist.map((h) => h.rank));
      r.tracked = true;
    }
    return rows;
  }
  const clean = (r, extra = {}) => ({ rank: r.rank, title: r.title, artist: r.artist, art: r.art || '', appleId: r.appleId || null, preview: r.preview || '', weeks: r.weeks || null, peak: Number.isFinite(r.peak) ? r.peak : null, tracked: !!r.tracked, ...extra });

  async function buildCurrent() {
    budget = lookupsPerRun;
    const feeds = {};
    for (const g of GENRES) {
      let rows = [], source = '';
      for (const [mod, name] of [[billboard, billboard.SOURCE], [apple, apple.SOURCE], [deezer, deezer.SOURCE]]) {
        try { rows = await mod.current(g, ctx); } catch (e) { log(`${name} ${g.key}: ${e.message}`); rows = []; }
        if (rows.length) { source = name; break; }
      }
      feeds[g.key] = { source, rows: rows.slice(0, 100) };
    }
    let daily = [];
    if (kworb.enabled(env)) { try { daily = await kworb.daily(ctx); } catch (e) { log(`kworb daily: ${e.message}`); } }

    // Pool every appearance; assign each song one primary genre.
    const pool = new Map();
    const add = (r, genre, source) => {
      const k = songKey(r.artist, r.title);
      let s = pool.get(k);
      if (!s) { s = { k, row: { ...r }, seen: [] }; pool.set(k, s); }
      s.seen.push({ genre, rank: r.chartRank, source, weeks: r.weeks, peak: r.peak });
      if (!s.row.art && r.art) s.row.art = r.art;
      if (!s.row.appleId && r.appleId) s.row.appleId = r.appleId;
    };
    for (const g of GENRES) for (const r of feeds[g.key].rows) add(r, g.key, feeds[g.key].source);
    for (const r of daily.slice(0, 200)) add(r, null, kworb.SOURCE);
    const charts = Object.fromEntries(GENRES.map((g) => [g.key, []]));
    // Songs seen on more genre charts get looked up first; they're the ones that collide.
    const songs = [...pool.values()].sort((a, b) => b.seen.length - a.seen.length || Math.min(...a.seen.map((x) => x.rank)) - Math.min(...b.seen.map((x) => x.rank)));
    for (const s of songs) {
      const own = s.seen.filter((x) => x.genre).sort((a, b) => a.rank - b.rank);
      const hint = fromName(s.row.genreName) || (own[0] && own[0].genre) || null;
      let g = await genreOf(s.row.artist, hint);
      if (!KEYS.has(g)) g = own[0] ? own[0].genre : null;
      if (!g) continue;
      const inOwn = s.seen.find((x) => x.genre === g);
      const best = inOwn || s.seen.slice().sort((a, b) => a.rank - b.rank)[0];
      // A genre's own chart order comes first; songs that belong to it from other charts follow.
      charts[g].push({ ...s.row, sort: inOwn ? inOwn.rank : 1000 + best.rank, weeks: inOwn && inOwn.weeks, peak: inOwn && inOwn.peak, via: best.source });
    }
    const out = { updatedAt: now(), genres: {} };
    for (const g of GENRES) {
      const rows = charts[g.key].sort((a, b) => a.sort - b.sort).slice(0, 50).map((r, i) => ({ ...r, rank: i + 1 }));
      await withApple(rows.slice(0, 30), 30);
      const sources = [...new Set(rows.map((r) => r.via))].filter(Boolean);
      out.genres[g.key] = { source: sources.join(' + ') || feeds[g.key].source || '', rows: track(g.key, rows).map((r) => clean(r)) };
    }
    // All genres: the overall chart, never de-duplicated.
    let all = [], allSource = '';
    for (const [fn, name] of [[() => billboard.current(ALL, ctx), billboard.SOURCE], [() => apple.current(ALL, ctx), apple.SOURCE], [async () => daily, kworb.SOURCE]]) {
      try { all = await fn(); } catch (e) { log(`${name} all: ${e.message}`); all = []; }
      if (all.length) { allSource = name; break; }
    }
    all = all.slice(0, 100).map((r, i) => ({ ...r, rank: i + 1 }));
    await withApple(all.slice(0, 30), 30);
    out.genres.all = { source: allSource, rows: track('all', all).map((r) => clean(r)) };
    if (billboard.configured(env)) {
      try {
        const albums = (await billboard.current(ALL, { ...ctx, slug: ALL.billboardAlbums })).slice(0, 50).map((r, i) => ({ ...r, rank: i + 1 }));
        out.albums = { source: 'Billboard 200', rows: albums.map((r) => clean(r, { album: true })) };
      } catch (e) { log(`billboard 200: ${e.message}`); }
    }
    q.cachePut.run('current', JSON.stringify(out), out.updatedAt);
    return out;
  }

  async function buildStreamed() {
    budget = lookupsPerRun;
    const out = { updatedAt: now(), genres: {} };
    const per = Object.fromEntries(GENRES.map((g) => [g.key, []]));
    const taken = new Set();
    let top = [];
    if (kworb.enabled(env)) { try { top = await kworb.mostStreamed(ctx); } catch (e) { log(`kworb songs: ${e.message}`); } }
    for (const r of top.slice(0, 1500)) {
      const g = await genreOf(r.artist, null);
      if (!KEYS.has(g) || per[g].length >= 25) continue;
      const k = songKey(r.artist, r.title);
      if (taken.has(k)) continue;
      taken.add(k);
      per[g].push({ ...r, streams: r.streams, unit: 'Spotify streams', via: kworb.SOURCE });
    }
    for (const g of GENRES) {
      if (per[g.key].length < 10) {
        let more = [];
        try { more = await lastfm.tagTop(g, ctx); } catch (e) { log(`lastfm ${g.key}: ${e.message}`); }
        for (const r of more) {
          const k = songKey(r.artist, r.title);
          if (taken.has(k) || per[g.key].length >= 25) continue;
          // Only songs whose primary genre really is this one (keeps genres unique).
          const pg = await genreOf(r.artist, g.key);
          if (pg !== g.key) continue;
          taken.add(k);
          per[g.key].push({ ...r, streams: r.plays, unit: 'Last.fm plays', via: lastfm.SOURCE });
        }
      }
      const rows = per[g.key].map((r, i) => ({ ...r, rank: i + 1 }));
      await withApple(rows.slice(0, 25), 25);
      out.genres[g.key] = { source: [...new Set(rows.map((r) => r.via))].join(' + '), rows: rows.map((r) => clean(r, { streams: r.streams, unit: r.unit })) };
    }
    const all = top.slice(0, 50).map((r, i) => ({ ...r, rank: i + 1 }));
    await withApple(all.slice(0, 25), 25);
    out.genres.all = { source: all.length ? kworb.SOURCE : '', rows: all.map((r) => clean(r, { streams: r.streams, unit: 'Spotify streams' })) };
    q.cachePut.run('streamed', JSON.stringify(out), out.updatedAt);
    return out;
  }

  // ---- cache + refresh schedule ----
  const MAX_AGE = { current: DAY, streamed: 7 * DAY };
  const building = {};
  function read(kind) { const r = q.cacheGet.get(kind); return r ? JSON.parse(r.data) : null; }
  function refresh(kind, { force = false } = {}) {
    const cur = read(kind);
    if (!force && cur && now() - cur.updatedAt < MAX_AGE[kind]) return Promise.resolve(cur);
    if (!building[kind]) {
      building[kind] = (kind === 'current' ? buildCurrent() : buildStreamed())
        .catch((e) => { log(`charts ${kind}: ${e.message}`); return cur; })
        .finally(() => { building[kind] = null; });
    }
    return building[kind];
  }
  const NOTES = {
    current: () => 'Charts are being gathered. The first run takes a few minutes, then they refresh daily.',
    streamed: () => (!kworb.enabled(env) && !env.LASTFM_API_KEY ? 'Most Streamed needs Kworb (KWORB_ENABLED=1) or a Last.fm key (LASTFM_API_KEY).' : 'Stream counts are being gathered. The first run takes a few minutes, then they refresh weekly.'),
  };
  /** What the app shows for one genre tab. Never waits on a rebuild if there's a cached copy. */
  async function forGenre(key) {
    const out = {};
    for (const kind of ['current', 'streamed']) {
      let data = read(kind);
      if (!data || now() - data.updatedAt >= MAX_AGE[kind]) { const p = refresh(kind); if (!data) data = await Promise.race([p, new Promise((r) => setTimeout(() => r(null), 8000))]); }
      const g = data && data.genres[key];
      out[kind] = g && g.rows.length
        ? { source: g.source, updatedAt: data.updatedAt, rows: g.rows, building: !!building[kind] }
        : { source: '', updatedAt: data ? data.updatedAt : null, rows: [], building: !!building[kind], note: data ? (kind === 'streamed' ? NOTES.streamed() : 'No chart for this genre right now.') : NOTES[kind]() };
    }
    if (key === 'all') { const c = read('current'); if (c && c.albums) out.albums = { ...c.albums, updatedAt: c.updatedAt }; }
    return out;
  }
  function schedule() {
    const tick = () => { refresh('current').catch(() => {}); refresh('streamed').catch(() => {}); };
    const t1 = setTimeout(tick, 5000); t1.unref && t1.unref();
    const t2 = setInterval(tick, 60 * 60e3); t2.unref && t2.unref();
    return () => { clearTimeout(t1); clearInterval(t2); };
  }
  return { forGenre, refresh, buildCurrent, buildStreamed, schedule, songKey };
}

module.exports = { createCharts, songKey, primaryArtist };
