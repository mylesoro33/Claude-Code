/* Encore — rate songs head to head, build lists, dig through charts. */
(() => {
  'use strict';
  const R = window.Ranking;
  const M = window.Motion;
  const I = window.Icons;
  const G = window.Genres;
  const CFG = window.ENCORE_CONFIG || {};
  const GUEST_KEY = 'encore.v1';
  const LAST_USER = 'encore.lastUser';
  const AM_FLAG = 'encore.am';
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (v) => (v >= 9.995 ? '10' : v.toFixed(1));
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

  // =====================================================================
  // State + persistence (guest = this browser; account = synced to server)
  // =====================================================================
  const defaultState = () => ({ songs: {}, order: [], lists: [], connections: {}, ratedAt: {}, country: guessCountry() });
  const sync = { server: false, awake: false, user: null, version: 0, dirty: false, timer: null, status: '', config: null };
  let state = defaultState();

  function guessCountry() {
    const m = (navigator.language || 'en-US').match(/-([A-Z]{2})$/i);
    return m ? m[1].toLowerCase() : 'us';
  }
  const accountKey = (u) => 'encore.user.' + u.username.toLowerCase();
  function readJSON(key) { try { return JSON.parse(localStorage.getItem(key)); } catch (_) { return null; } }
  function writeJSON(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (_) { /* full / private mode */ } }
  function removeKey(key) { try { localStorage.removeItem(key); } catch (_) { /* ignore */ } }
  /** Fill defaults and migrate older saved data (loved/fine/didn't-like buckets, Later list). */
  function normalize(s) {
    const out = Object.assign(defaultState(), s || {});
    if (!Array.isArray(out.order)) out.order = R.fromLegacy(out.rankings);
    if (!out.ratedAt || !Object.keys(out.ratedAt).length) out.ratedAt = out.rankedAt || {};
    delete out.rankings; delete out.later; delete out.rankedAt;
    out.lists = Array.isArray(out.lists) ? out.lists : [];
    out.connections = out.connections && typeof out.connections === 'object' ? out.connections : {};
    return out;
  }
  const rated = () => state.order.length;

  function save() {
    if (sync.user) {
      sync.dirty = true;
      writeJSON(accountKey(sync.user), { state, version: sync.version, dirty: true });
      clearTimeout(sync.timer);
      sync.timer = setTimeout(push, 700);
      setSyncStatus('Saving…');
    } else writeJSON(GUEST_KEY, state);
  }
  async function api(path, opts = {}) {
    const ctrl = new AbortController();
    const timer = opts.timeout ? setTimeout(() => ctrl.abort(), opts.timeout) : 0;
    try {
      const res = await fetch(path, {
        method: opts.method || 'GET', credentials: 'same-origin',
        headers: opts.body ? { 'Content-Type': 'application/json' } : {},
        body: opts.body ? JSON.stringify(opts.body) : undefined, signal: ctrl.signal,
      });
      let data = null;
      try { data = await res.json(); } catch (_) { /* non-JSON */ }
      return { ok: res.ok, status: res.status, data: data || {}, json: data !== null };
    } finally { clearTimeout(timer); }
  }
  async function push() {
    if (!sync.user) return;
    const user = sync.user;
    try {
      const r = await api('/api/state', { method: 'PUT', body: { state, baseVersion: sync.version } });
      if (sync.user !== user) return;
      if (r.ok) {
        sync.version = r.data.version; sync.dirty = false;
        writeJSON(accountKey(user), { state, version: sync.version, dirty: false });
        setSyncStatus('Synced');
      } else if (r.status === 409) { adoptServer(r.data.state, r.data.version); toast('Updated with changes from another device'); }
      else if (r.status === 401) { signedOut(); toast('You were signed out'); }
      else setSyncStatus('Sync failed. Retrying soon');
    } catch (_) { setSyncStatus('Offline. Will sync when you reconnect'); }
  }
  function adoptServer(serverState, version) {
    state = normalize(serverState);
    sync.version = version; sync.dirty = false;
    writeJSON(accountKey(sync.user), { state, version, dirty: false });
    setSyncStatus('Synced');
    afterStateChange();
  }
  function setSyncStatus(s) { sync.status = s; const el = $('#sync-status'); if (el) el.textContent = s; }
  /** Choose the right data once we know who is signed in. Returns a note for the welcome toast. */
  function signedIn(user, server) {
    let note = '';
    sync.user = user;
    writeJSON(LAST_USER, user);
    const cache = readJSON(accountKey(user));
    const guest = normalize(readJSON(GUEST_KEY));
    if (cache && cache.dirty && cache.version === server.version) { state = normalize(cache.state); sync.version = server.version; save(); }
    else if (!server.state && (guest.order.length || guest.lists.length)) {
      state = guest; sync.version = server.version; save();
      note = `Moved your ${guest.order.length} ratings into your account`;
    } else {
      state = normalize(server.state); sync.version = server.version;
      writeJSON(accountKey(user), { state, version: sync.version, dirty: false });
      setSyncStatus('Synced');
    }
    afterStateChange();
    return note;
  }
  function signedOut() {
    sync.user = null; sync.version = 0; clearTimeout(sync.timer);
    removeKey(LAST_USER);
    state = normalize(readJSON(GUEST_KEY));
    afterStateChange();
  }
  function afterStateChange() {
    $('#country').value = state.country;
    renderAll();
    refreshSongMeta();
    scheduleRecs();
  }

  // =====================================================================
  // Apple Music catalog (iTunes Search API) with an instant cache
  // =====================================================================
  const memo = new Map();
  const MEMO_TTL = 10 * 60 * 1000;
  let jsonpSeq = 0;
  function jsonp(url, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const cb = '__encore_cb' + (++jsonpSeq);
      const s = document.createElement('script');
      const timer = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, timeoutMs);
      function cleanup() { clearTimeout(timer); delete window[cb]; s.remove(); }
      window[cb] = (data) => { cleanup(); resolve(data); };
      s.onerror = () => { cleanup(); reject(new Error('network')); };
      s.src = url + (url.includes('?') ? '&' : '?') + 'callback=' + cb;
      document.head.appendChild(s);
    });
  }
  async function getJson(url, timeout) {
    const ctrl = new AbortController();
    const t = timeout ? setTimeout(() => ctrl.abort(), timeout) : 0;
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(String(res.status));
      return await res.json();
    } finally { clearTimeout(t); }
  }
  const memoKey = (kind, params) => kind + '|' + state.country + '|' + new URLSearchParams(params).toString();
  function peekCatalog(kind, params) {
    const hit = memo.get(memoKey(kind, params));
    return hit && Date.now() - hit.t < MEMO_TTL ? hit.data : null;
  }
  async function catalog(kind, params, { fresh = false } = {}) {
    const key = memoKey(kind, params);
    if (!fresh) { const hit = peekCatalog(kind, params); if (hit) return hit; }
    const data = await fetchCatalog(kind, params);
    memo.set(key, { t: Date.now(), data });
    if (memo.size > 150) memo.delete(memo.keys().next().value);
    return data;
  }
  async function fetchCatalog(kind, params) {
    const qs = new URLSearchParams({ ...params, country: state.country }).toString();
    if (sync.server) {
      try { return await getJson(`/api/catalog/${kind}?${qs}`, sync.awake ? 15000 : 3500); } catch (_) { /* fall through */ }
    }
    if (kind === 'charts') {
      try { return await getJson(`https://rss.marketingtools.apple.com/api/v2/${state.country}/music/most-played/50/songs.json`, 8000); }
      catch (_) {
        const d = await jsonp(`https://itunes.apple.com/${state.country}/rss/topsongs/limit=50/json`);
        return { feed: { results: d.feed.entry.map((e) => ({ id: e.id.attributes['im:id'] })) } };
      }
    }
    const extra = kind === 'search' ? '&media=music&entity=song&limit=40' : '&entity=song';
    const url = `https://itunes.apple.com/${kind}?${qs}${extra}`;
    try { return await getJson(url, 8000); } catch (_) { return jsonp(url); }
  }
  function toSong(r) {
    return {
      id: String(r.trackId), title: r.trackName, artist: r.artistName, album: r.collectionName || '',
      art: r.artworkUrl100 || r.artworkUrl60 || '', preview: r.previewUrl || '', url: r.trackViewUrl || '',
      genre: r.primaryGenreName || '', year: r.releaseDate ? String(r.releaseDate).slice(0, 4) : '',
      explicit: r.trackExplicitness === 'explicit', artistId: r.artistId ? String(r.artistId) : '', albumId: r.collectionId ? String(r.collectionId) : '',
    };
  }
  const songsFrom = (d) => (d.results || []).filter((r) => r.trackId && (r.kind === 'song' || r.wrapperType === 'track')).map(toSong);
  async function searchSongs(term, opts) { return songsFrom(await catalog('search', { term }, opts)); }
  async function lookupSongs(ids, opts) {
    const out = {};
    for (let i = 0; i < ids.length; i += 100) {
      const d = await catalog('lookup', { id: ids.slice(i, i + 100).join(',') }, opts);
      (d.results || []).filter((r) => r.trackId).forEach((r) => { out[r.trackId] = toSong(r); });
    }
    return ids.map((id) => out[id]).filter(Boolean);
  }
  async function topSongs(opts) {
    const d = await catalog('charts', {}, opts);
    const feed = (d.feed && d.feed.results) || [];
    let songs = [];
    try { songs = await lookupSongs(feed.map((r) => r.id), opts); } catch (_) { /* use the feed */ }
    if (songs.length) return songs;
    return feed.map((r) => ({ id: String(r.id), title: r.name, artist: r.artistName, album: '', art: r.artworkUrl100 || '', preview: '', url: r.url || '', genre: (r.genres?.[0]?.name) || '', year: '', explicit: false }));
  }
  /** Match "title by artist" (from Spotify, Last.fm or a sample list) to an Apple Music song. Cached. */
  const RESOLVE_KEY = 'encore.resolved';
  const resolved = readJSON(RESOLVE_KEY) || {};
  async function resolveTrack(title, artist) {
    const k = (artist + '|' + title).toLowerCase();
    if (resolved[k]) return resolved[k];
    const songs = await searchSongs(`${artist} ${title}`);
    const a = artist.toLowerCase();
    const t = title.toLowerCase().replace(/\s*\(.*$/, '');
    const hit = songs.find((s) => s.artist.toLowerCase().includes(a) && s.title.toLowerCase().includes(t)) || songs.find((s) => s.artist.toLowerCase().includes(a)) || songs[0];
    if (hit) {
      resolved[k] = hit;
      const keys = Object.keys(resolved);
      if (keys.length > 400) delete resolved[keys[0]];
      writeJSON(RESOLVE_KEY, resolved);
    }
    return hit || null;
  }
  async function mapLimit(items, n, fn) {
    const out = new Array(items.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch (_) { out[k] = null; } }
    }));
    return out;
  }
  let refreshing = false;
  async function refreshSongMeta() {
    if (refreshing) return;
    const ids = Object.values(state.songs).filter((s) => /^\d+$/.test(s.id) && (!s.art || !s.albumId)).map((s) => s.id);
    if (!ids.length) return;
    refreshing = true;
    try {
      const fresh = await lookupSongs(ids);
      fresh.forEach((s) => { if (state.songs[s.id]) state.songs[s.id] = { ...state.songs[s.id], ...s }; });
      if (fresh.length) { save(); renderAll(); }
    } catch (_) { /* offline */ }
    refreshing = false;
  }
  const remember = (song) => { state.songs[song.id] = { ...(state.songs[song.id] || {}), ...song }; };

  // =====================================================================
  // Records, sleeves, stickers
  // =====================================================================
  function artUrl(song, px) {
    const a = song && song.art;
    if (!a) return placeholderArt(song);
    return a.replace('{w}', px).replace('{h}', px).replace(/\/\d+x\d+(bb|cc|sr)?(\.\w+)(\?.*)?$/, `/${px}x${px}bb$2`);
  }
  function placeholderArt(song) {
    const str = (song && (song.album || song.title)) || 'x';
    let h = 0; for (const c of str) h = (h * 31 + c.charCodeAt(0)) % 360;
    const hues = [18, 32, 8, 42, 350, 26];
    const hue = hues[h % hues.length];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="hsl(${hue},42%,${24 + (h % 3) * 6}%)"/><circle cx="50" cy="50" r="30" fill="none" stroke="rgba(242,232,213,.35)" stroke-width="1.5"/><circle cx="50" cy="50" r="20" fill="none" stroke="rgba(242,232,213,.25)" stroke-width="1.5"/><circle cx="50" cy="50" r="4" fill="rgba(242,232,213,.6)"/></svg>`;
    return 'data:image/svg+xml,' + encodeURIComponent(svg);
  }
  function artImg(song, px, { eager = false } = {}) {
    return `<img src="${esc(artUrl(song, px))}" data-ph="${esc(placeholderArt(song))}" alt="" ${eager ? '' : 'loading="lazy"'} decoding="async" width="${px}" height="${px}" />`;
  }
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (img.tagName === 'IMG' && img.dataset.ph && img.src !== img.dataset.ph) img.src = img.dataset.ph;
  }, true);
  const vinyl = (song, d, { spin = false, px = 120 } = {}) => `<span class="vinyl ${spin ? 'spin' : ''}" style="--d:${d}" data-vinyl="${esc(song.id)}"><span class="lbl">${artImg(song, px)}</span></span>`;
  const sleeve = (song, px = 160, play = false) => `<span class="sleeve">${artImg(song, px)}${play ? `<span class="play">${isPlaying(song.id) ? I.pause : I.play}</span>` : ''}</span>`;
  const pack = (song, d = 56) => `<span class="pack" style="--d:${d}px">${vinyl(song, d + 'px', { spin: isPlaying(song.id), px: 120 })}${sleeve(song, 160, true)}</span>`;
  const sticker = (score, { lg = false } = {}) => `<span class="sticker ${score >= 9 ? 'top' : ''} ${lg ? 'lg' : ''}" aria-label="Score ${fmt(score)}">${fmt(score)}</span>`;

  // =====================================================================
  // Scores, artist / album averages
  // =====================================================================
  const scoreMapOf = (order) => { const m = {}; R.flatten(order).forEach((e) => { m[e.id] = e; }); return m; };
  const norm = (s) => String(s || '').toLowerCase().replace(/\s*[-–]\s*(single|ep)$/i, '').replace(/\s+/g, ' ').trim();
  function groupStats(order, songs, kind) {
    const groups = new Map();
    for (const e of R.flatten(order)) {
      const s = songs[e.id];
      if (!s || (kind === 'album' && !s.album)) continue;
      const key = kind === 'artist' ? norm(s.artist) : norm(s.album) + '|' + norm(s.artist);
      let g = groups.get(key);
      if (!g) { g = { key, kind, name: kind === 'artist' ? s.artist : s.album, artist: s.artist, entries: [], sum: 0, top: s }; groups.set(key, g); }
      g.entries.push(e); g.sum += e.score;
    }
    return [...groups.values()].map((g) => ({ ...g, count: g.entries.length, avg: R.round1(g.sum / g.entries.length) }));
  }
  function groupOf(order, songs, kind, song) {
    const key = kind === 'artist' ? norm(song.artist) : norm(song.album) + '|' + norm(song.artist);
    return groupStats(order, songs, kind).find((g) => g.key === key) || null;
  }
  const avgLine = (g, label) => (g ? `<div class="avg-line">${sticker(g.avg)}<span><b>${esc(g.name)}</b> · your ${label} average across ${g.count} song${g.count > 1 ? 's' : ''}</span></div>` : '');

  /** Apple genre names → chart genre keys. */
  function genreKeyFor(name) {
    const n = String(name || '').toLowerCase();
    if (/k-?pop/.test(n)) return 'kpop';
    if (/hip|rap/.test(n)) return 'hiphop';
    if (/r&b|soul/.test(n)) return 'rnb';
    if (/country/.test(n)) return 'country';
    if (/latin|urbano|reggaeton|mexican/.test(n)) return 'latin';
    if (/dance|electronic|edm|house/.test(n)) return 'edm';
    if (/indie/.test(n)) return 'indie';
    if (/alternative/.test(n)) return 'alternative';
    if (/rock|metal/.test(n)) return 'rock';
    if (/jazz/.test(n)) return 'jazz';
    if (/gospel|christian/.test(n)) return 'gospel';
    if (/pop/.test(n)) return 'pop';
    return null;
  }

  // =====================================================================
  // Rows
  // =====================================================================
  /** o: rank, mine (my entry), theirs (someone else's entry), rateLabel, addList, grip, remove, under, why */
  function songRow(song, o = {}) {
    const li = document.createElement('li');
    li.className = 'row';
    li.dataset.id = song.id;
    if (pb.song && pb.song.id === song.id) li.classList.add('now');
    const mine = o.mine === undefined ? scoreMapOf(state.order)[song.id] : o.mine;
    const inList = o.addList && state.lists.some((l) => l.songIds.includes(song.id));
    let right = '';
    if (o.theirs) right += sticker(o.theirs.score);
    else if (mine) right += `<button class="icon-btn" data-act="open" aria-label="Your score ${fmt(mine.score)}">${sticker(mine.score)}</button>`;
    else right += `<button class="rate-btn" data-act="rate">${esc(o.rateLabel || 'Rate')}</button>`;
    if (o.addList) right += `<button class="add-list ${inList ? 'on' : ''}" data-act="list" aria-label="Add to a list">${inList ? I.check : I.listAdd}</button>`;
    if (o.remove) right += `<button class="icon-btn" data-act="remove" aria-label="Remove from this list">${I.minus}</button>`;
    if (o.grip) right += `<span class="grip" role="button" aria-label="Drag to re-order">${I.grip}</span>`;
    const rank = o.rank != null ? `<div class="rank ${o.rank <= 3 ? 'hot' : ''}">${o.rank}</div>` : '';
    li.innerHTML = `
      ${o.under ? `<div class="row-under" aria-hidden="true"><span class="u-left">${o.under.right}</span><span class="u-right">${o.under.left}</span></div>` : ''}
      <div class="row-body">
        ${rank}
        <button data-act="play" aria-label="Play ${esc(song.title)}">${pack(song)}</button>
        <div class="meta" data-act="open">
          <div class="t1">${esc(song.title)}${song.explicit ? '<span class="e" aria-label="Explicit">E</span>' : ''}</div>
          <div class="t2">${esc(song.artist)}</div>
          ${o.why ? `<div class="why">${esc(o.why)}</div>` : `<div class="t3">${esc(song.album)}${song.year ? ' · ' + song.year : ''}</div>`}
        </div>
        <div class="actions">${right}</div>
      </div>`;
    return li;
  }
  function groupRow(g, i) {
    const li = document.createElement('li');
    li.className = 'row group';
    li.dataset.key = g.key;
    li.innerHTML = `<div class="row-body">
        <div class="rank ${i < 3 ? 'hot' : ''}">${i + 1}</div>
        <button data-act="group" aria-label="Open ${esc(g.name)}">${g.kind === 'artist' ? `<span class="pack" style="--d:56px">${vinyl(g.top, '56px')}</span>` : pack(g.top)}</button>
        <div class="meta" data-act="group"><div class="t1">${esc(g.name)}</div>
          <div class="t2">${g.kind === 'album' ? esc(g.artist) + ' · ' : ''}${g.count} song${g.count > 1 ? 's' : ''} rated</div>
          <div class="bar"><i style="--p:${g.avg / 10}"></i></div></div>
        <div class="actions"><button class="icon-btn" data-act="group" aria-label="Average ${fmt(g.avg)}">${sticker(g.avg)}</button></div>
      </div>`;
    return li;
  }
  function skeleton(ul, n = 5) {
    ul.innerHTML = Array.from({ length: n }, () => '<li class="skel" aria-hidden="true"><i class="s-pack"></i><i class="s-lines"><b></b><b></b></i><i class="s-btn"></i></li>').join('');
  }
  function stateBlock(el, s = {}) {
    if (!s.title) { el.innerHTML = ''; return; }
    el.innerHTML = `<div class="state ${s.error ? 'error' : ''}">${s.error ? '' : '<span class="vinyl" style="--d:64px"><span class="lbl"></span></span>'}<h3>${esc(s.title)}</h3>${s.body ? `<p>${s.body}</p>` : ''}${s.actions && s.actions.length ? `<div class="btn-row center">${s.actions.map((a, i) => `<button class="btn ${i === 0 ? 'primary' : ''}" data-sa="${i}">${esc(a.label)}</button>`).join('')}</div>` : ''}</div>`;
    (s.actions || []).forEach((a, i) => { $(`[data-sa="${i}"]`, el).onclick = a.run; });
  }
  const listSongs = (ul, lookup) => $$(':scope > li.row[data-id]', ul).map((li) => lookup(li.dataset.id)).filter(Boolean);
  function bindList(ul, lookup, extra = {}) {
    ul.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      const li = e.target.closest('li.row');
      if (!btn || !li) return;
      if (btn.dataset.act === 'group') {
        const g = (ul._groups || []).find((x) => x.key === li.dataset.key);
        if (g) openGroup(g, ul._data || mineData(), $('.pack', li));
        return;
      }
      const song = lookup(li.dataset.id);
      if (!song) return;
      const act = btn.dataset.act;
      if (act === 'play') playFrom(song, listSongs(ul, lookup));
      else if (act === 'rate') startRating(song);
      else if (act === 'list') openAddToList(song);
      else if (act === 'open') openDetail(song, extra.other ? extra.other() : null);
      else if (act === 'remove' && extra.onRemove) extra.onRemove(song, li);
    });
  }
  const mineData = () => ({ order: state.order, songs: state.songs, mine: true });
  const lookupAny = (id) => state.songs[id] || lastResults.find((s) => s.id === id) || trending.find((s) => s.id === id) || recentSongs.find((s) => s.id === id) || chartSongs.find((s) => s.id === id) || recSongs.find((s) => s.id === id) || (viewing && viewing.songs[id]) || null;

  // =====================================================================
  // HOME: search, recently played, top records, trending
  // =====================================================================
  let lastResults = [];
  let searchTimer = null;
  let searchSeq = 0;
  let trending = [];
  const skipped = new Set();

  async function runSearch({ fresh = false } = {}) {
    const term = $('#search').value.trim();
    $('#search-results').hidden = !term;
    $('#home-feed').hidden = !!term;
    if (!term) return;
    const seq = ++searchSeq;
    $('#results-title').textContent = `Results for “${term}”`;
    const cached = !fresh && peekCatalog('search', { term });
    if (cached) return showResults(songsFrom(cached), term);
    stateBlock($('#results-state'));
    skeleton($('#results'));
    try {
      const songs = await searchSongs(term, { fresh });
      if (seq === searchSeq) showResults(songs, term);
    } catch (_) {
      if (seq !== searchSeq) return;
      $('#results').innerHTML = '';
      stateBlock($('#results-state'), { error: true, title: 'Can’t reach Apple Music', body: 'Check your connection, then try again.', actions: [{ label: 'Try again', run: () => runSearch({ fresh: true }) }] });
    }
  }
  function showResults(songs, term) {
    lastResults = songs.filter((s) => !skipped.has(s.id));
    renderResults();
    stateBlock($('#results-state'), lastResults.length ? {} : { title: 'No songs found', body: `Nothing on Apple Music matches “${esc(term)}”. Try the artist’s name.` });
  }
  function renderResults() {
    const ul = $('#results');
    ul.innerHTML = '';
    lastResults.forEach((s) => ul.appendChild(songRow(s, { addList: true, under: { right: I.check + 'Rate', left: 'Skip' + I.skip } })));
  }
  function skipResult(li) {
    const id = li.dataset.id;
    skipped.add(id);
    M.flip($('#results'), ':scope > li.row', () => { lastResults = lastResults.filter((s) => s.id !== id); li.remove(); });
    toast('Skipped', { action: 'Undo', run: () => { skipped.delete(id); runSearch(); } });
  }

  async function loadTrending({ fresh = false } = {}) {
    const ul = $('#trending');
    if (!trending.length) skeleton(ul, 4);
    try {
      trending = (await topSongs({ fresh })).slice(0, 10);
      renderTrending();
      stateBlock($('#trending-state'));
    } catch (_) {
      ul.innerHTML = '';
      stateBlock($('#trending-state'), { error: true, title: 'Charts didn’t load', body: 'Apple Music didn’t answer. Try again in a moment.', actions: [{ label: 'Try again', run: () => loadTrending({ fresh: true }) }] });
    }
  }
  function renderTrending() {
    const ul = $('#trending');
    if (!trending.length) return;
    ul.innerHTML = '';
    trending.forEach((s, i) => ul.appendChild(songRow(s, { rank: i + 1, addList: true })));
  }
  function renderTopShelf() {
    const shelf = $('#top-shelf');
    const top = R.flatten(state.order).slice(0, 10).filter((e) => state.songs[e.id]);
    shelf.innerHTML = top.map((e) => {
      const s = state.songs[e.id];
      return `<button class="shelf-item" data-id="${esc(s.id)}" aria-label="${esc(s.title)}, ${fmt(e.score)}"><span style="position:relative">${pack(s, 104)}${sticker(e.score)}</span><span class="t1" style="font-size:var(--fs-sm)">${esc(s.title)}</span><span class="t3">${esc(s.artist)}</span></button>`;
    }).join('');
    stateBlock($('#top-shelf-state'), top.length ? {} : { title: 'Start your collection', body: 'Rate any song and it becomes your first record, with a 10. Every song after that gets placed head to head.', actions: [{ label: 'Find a song', run: () => $('#search').focus() }] });
    shelf.hidden = !top.length;
  }
  $('#top-shelf').addEventListener('click', (e) => { const b = e.target.closest('[data-id]'); if (b) openDetail(state.songs[b.dataset.id]); });

  // ----- Recently played (Apple Music / Spotify) -----
  let recentSongs = [];
  let recentStatus = 'idle'; // idle | loading | ready | error
  let recentError = '';
  const amPossible = () => !!(CFG.musickitDeveloperToken || (sync.config && sync.config.appleMusic));
  const spotifyClientId = () => (sync.config && sync.config.spotifyClientId) || CFG.spotifyClientId || '';
  const anyHistory = () => amConnected() || Services.Spotify.connected();
  async function loadRecent() {
    if (!anyHistory()) { recentStatus = 'idle'; renderRecent(); return; }
    recentStatus = 'loading'; renderRecent();
    try {
      const out = [];
      const errors = [];
      if (amConnected()) { try { out.push(...(await amRecent())); } catch (_) { errors.push('Apple Music'); } }
      if (Services.Spotify.connected()) {
        try {
          const tracks = (await Services.Spotify.recent()).slice(0, 20);
          out.push(...(await mapLimit(tracks, 4, (t) => resolveTrack(t.title, t.artist))).filter(Boolean));
        } catch (_) { errors.push('Spotify'); }
      }
      const seen = new Set();
      recentSongs = out.filter((s) => !seen.has(s.id) && seen.add(s.id));
      if (!recentSongs.length && errors.length) throw new Error(`${errors.join(' and ')} didn’t answer.`);
      recentStatus = 'ready';
      scheduleRecs();
    } catch (err) {
      recentStatus = 'error'; recentError = err.message || 'Couldn’t load your listening history.';
    }
    renderRecent();
  }
  function renderRecent() {
    const ul = $('#recent');
    const st = $('#recent-state');
    const src = [amConnected() && 'Apple Music', Services.Spotify.connected() && 'Spotify'].filter(Boolean).join(' + ');
    $('#recent-source').textContent = src;
    if (recentStatus === 'loading') { stateBlock(st); skeleton(ul, 4); return; }
    if (!anyHistory()) {
      ul.innerHTML = '';
      const actions = [{ label: 'Connect Apple Music', run: amConnect }];
      if (spotifyClientId()) actions.push({ label: 'Connect Spotify', run: spotifyConnect });
      stateBlock(st, { title: 'See what you’ve been playing', body: 'Connect Apple Music and your recently played songs show up here, one tap from a rating.' + (am.error ? `<br><span style="color:var(--danger)">${esc(am.error)}</span>` : ''), actions });
      return;
    }
    if (recentStatus === 'error') {
      ul.innerHTML = '';
      stateBlock(st, { error: true, title: 'Couldn’t load your recent plays', body: esc(recentError) + ' Your ratings are safe.', actions: [{ label: 'Try again', run: loadRecent }] });
      return;
    }
    ul.innerHTML = '';
    const mine = scoreMapOf(state.order);
    recentSongs.slice(0, 15).forEach((s) => ul.appendChild(songRow(s, { mine: mine[s.id], rateLabel: 'Rate this', addList: true })));
    stateBlock(st, recentSongs.length ? {} : { title: 'Nothing played lately', body: 'Play something on ' + src + ', then pull down to refresh.' });
  }

  // =====================================================================
  // CHARTS
  // =====================================================================
  let genre = 'pop';
  let chartSongs = [];
  let chartSeq = 0;
  function renderGenreStrip() {
    $('#genre-strip').innerHTML = G.GENRES.map((g) => `<button class="${g.key === genre ? 'active' : ''}" data-genre="${g.key}" role="tab" aria-selected="${g.key === genre}">${esc(g.label)}</button>`).join('');
  }
  $('#genre-strip').addEventListener('click', (e) => {
    const b = e.target.closest('[data-genre]');
    if (!b || b.dataset.genre === genre) return;
    genre = b.dataset.genre;
    $$('#genre-strip button').forEach((x) => { const on = x === b; x.classList.toggle('active', on); x.setAttribute('aria-selected', on); });
    b.scrollIntoView({ inline: 'center', block: 'nearest', behavior: M.reduced() ? 'auto' : 'smooth' });
    loadCharts();
  });
  const sourceBadge = (v) => (v.placeholder ? '<span class="badge warn">Placeholder data</span>' : `<span class="label">via ${esc(v.source)}</span>`);
  async function loadCharts({ fresh = false } = {}) {
    const seq = ++chartSeq;
    const parts = [['current', 20], ['streamed', 15]];
    parts.forEach(([kind]) => { skeleton($(`#chart-${kind}`), 5); $(`#${kind}-source`).innerHTML = ''; $(`#${kind}-note`).innerHTML = ''; stateBlock($(`#chart-${kind}-state`)); });
    await Promise.all(parts.map(async ([kind, n]) => {
      try {
        const v = await Charts[kind](genre, { fresh });
        if (seq !== chartSeq) return;
        $(`#${kind}-source`).innerHTML = sourceBadge(v);
        $(`#${kind}-note`).innerHTML = v.note ? `<p class="note">${esc(v.note)}</p>` : '';
        const ul = $(`#chart-${kind}`);
        ul.innerHTML = '';
        v.songs.slice(0, n).forEach((s, i) => { chartSongs.push(s); ul.appendChild(songRow(s, { rank: i + 1, addList: true })); });
        if (chartSongs.length > 400) chartSongs = chartSongs.slice(-200);
        stateBlock($(`#chart-${kind}-state`), v.songs.length ? {} : { title: 'Nothing here yet', body: 'This chart came back empty. Try another genre.' });
      } catch (_) {
        if (seq !== chartSeq) return;
        $(`#chart-${kind}`).innerHTML = '';
        stateBlock($(`#chart-${kind}-state`), { error: true, title: 'This chart didn’t load', body: 'Check your connection, then try again.', actions: [{ label: 'Try again', run: () => loadCharts({ fresh: true }) }] });
      }
    }));
  }

  // =====================================================================
  // LISTS: my ratings + custom lists
  // =====================================================================
  const listsUI = { pane: 'ratings', seg: 'songs' };
  const canDrag = () => listsUI.seg === 'songs' && !$('#ratings-filter').value.trim() && rated() > 1;
  function renderRatings() {
    const n = rated();
    $('#ratings-count').textContent = n ? `(${n})` : '';
    $('#lists-count').textContent = state.lists.length ? `(${state.lists.length})` : '';
    $('#drag-hint').hidden = !canDrag();
    const ol = $('#ratings');
    ol.innerHTML = '';
    const q = $('#ratings-filter').value.trim().toLowerCase();
    let shown = 0;
    if (listsUI.seg === 'songs') {
      R.flatten(state.order).forEach((e) => {
        const s = state.songs[e.id];
        if (!s || (q && !`${s.title} ${s.artist} ${s.album} ${s.genre}`.toLowerCase().includes(q))) return;
        ol.appendChild(songRow(s, { rank: e.rank, mine: e, grip: canDrag() }));
        shown++;
      });
    } else {
      const kind = listsUI.seg === 'artists' ? 'artist' : 'album';
      const groups = groupStats(state.order, state.songs, kind).filter((g) => !q || `${g.name} ${g.artist}`.toLowerCase().includes(q))
        .sort((a, b) => b.avg - a.avg || b.count - a.count);
      groups.forEach((g, i) => ol.appendChild(groupRow(g, i)));
      ol._groups = groups; ol._data = mineData();
      shown = groups.length;
    }
    const st = $('#ratings-state');
    if (!n) stateBlock(st, { title: 'No ratings yet', body: 'Your first song gets a 10. Every song after that is placed with a couple of “better or worse?” picks.', actions: [{ label: 'Find a song', run: () => { showView('home'); $('#search').focus(); } }] });
    else if (!shown) stateBlock(st, { title: 'No matches', body: 'Nothing in your ratings matches that filter.' });
    else stateBlock(st);
  }
  const lockIco = () => I.lock.replace('class="ico"', 'class="ico" style="width:12px;height:12px"');
  function crateHtml(l, songs, showPrivacy) {
    const covers = l.songIds.slice(0, 3).map((id) => songs[id]).filter(Boolean);
    return `<button class="crate" data-list="${esc(l.id)}"><span class="crate-stack">${covers.length ? covers.map((s) => sleeve(s, 200)).join('') : `<span class="empty-sleeve">${I.stack}</span>`}</span>
      <h3>${esc(l.name)}</h3><span class="t3">${l.songIds.length} song${l.songIds.length === 1 ? '' : 's'}${showPrivacy ? ' · ' + (l.isPublic ? 'Public' : lockIco() + 'Private') : ''}</span></button>`;
  }
  function renderCrates() {
    $('#crates').innerHTML = `<button class="new-crate" id="new-list">${I.plus}<span>New list</span></button>` + state.lists.map((l) => crateHtml(l, state.songs, true)).join('');
  }
  $('#crates').addEventListener('click', (e) => {
    if (e.target.closest('#new-list')) return openNewList();
    const c = e.target.closest('[data-list]');
    if (c) openList(c.dataset.list);
  });
  function openNewList(thenAdd) {
    openSheet(`<p class="label kicker">New list</p><h3 class="prompt">Name your list</h3>
      <form class="form" id="new-list-form">
        <input class="input" name="name" maxlength="60" required placeholder="Best Rap Song, Gym Songs, Road Trip…" aria-label="List name" />
        <label class="toggle" style="border:0"><span>Public<br /><small class="muted">Shows on your profile</small></span><span class="switch"><input type="checkbox" name="isPublic" checked /><i></i></span></label>
        <button class="btn primary wide" type="submit">Create list</button>
      </form>`);
    setTimeout(() => $('#new-list-form input')?.focus(), 320);
    $('#new-list-form').onsubmit = (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const name = String(f.get('name')).trim();
      if (!name) return;
      const list = { id: uid(), name, songIds: thenAdd ? [thenAdd.id] : [], isPublic: f.get('isPublic') === 'on', createdAt: Date.now(), updatedAt: Date.now() };
      if (thenAdd) remember(thenAdd);
      state.lists.unshift(list);
      save(); renderAll();
      closeSheet();
      toast(thenAdd ? `Added to “${name}”` : `Created “${name}”`);
      if (!thenAdd) setTimeout(() => openList(list.id), 100);
    };
  }
  function toggleInList(listId, song) {
    const l = state.lists.find((x) => x.id === listId);
    if (!l) return false;
    remember(song);
    const i = l.songIds.indexOf(song.id);
    if (i >= 0) l.songIds.splice(i, 1); else l.songIds.push(song.id);
    l.updatedAt = Date.now();
    save();
    return i < 0;
  }
  function openAddToList(song) {
    openSheet(`<p class="label kicker">Add to list</p><h3 class="prompt">${esc(song.title)}</h3>
      ${state.lists.length ? '' : '<p class="center muted">You don’t have any lists yet.</p>'}
      <ul class="pick-lists">${state.lists.map((l) => `<li data-l="${esc(l.id)}" class="${l.songIds.includes(song.id) ? 'on' : ''}" role="checkbox" aria-checked="${l.songIds.includes(song.id)}" tabindex="0"><span>${esc(l.name)}</span><small class="muted">${l.songIds.length}</small><i class="check">${I.check}</i></li>`).join('')}</ul>
      <div class="btn-row"><button class="btn wide" id="pick-new">${I.plus}New list with this song</button></div>`);
    $$('.pick-lists li').forEach((li) => {
      const flip = () => { const added = toggleInList(li.dataset.l, song); li.classList.toggle('on', added); li.setAttribute('aria-checked', added); M.haptic(8); renderAll(); };
      li.onclick = flip;
      li.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } };
    });
    $('#pick-new').onclick = () => openNewList(song);
  }

  // ----- List detail -----
  let openListId = null;
  function openList(id) {
    openListId = id;
    renderListDetail();
    showView('list', { mode: 'push' });
  }
  function renderListDetail() {
    const l = state.lists.find((x) => x.id === openListId);
    if (!l) return;
    $('#list-detail').innerHTML = `<div class="list-head">
        <p class="label accent">${l.isPublic ? 'Public list' : 'Private list'} · ${l.songIds.length} song${l.songIds.length === 1 ? '' : 's'}</p>
        <h1 class="display" id="list-name">${esc(l.name)}</h1>
        <div class="btn-row" style="margin:0"><button class="btn primary sm" data-la="add">${I.plus}Add songs</button><button class="btn sm" data-la="rename">${I.edit}Rename</button><button class="btn quiet sm danger" data-la="delete">${I.trash}Delete</button></div>
        <label class="toggle"><span>Public<br /><small class="muted">Anyone who can see your profile can see this list</small></span><span class="switch"><input type="checkbox" id="list-public" ${l.isPublic ? 'checked' : ''} /><i></i></span></label>
        ${l.songIds.length > 1 ? '<p class="label" style="margin:0">Drag the handle to re-order</p>' : ''}
      </div>`;
    const ol = $('#list-songs');
    ol.innerHTML = '';
    const mine = scoreMapOf(state.order);
    l.songIds.forEach((sid, i) => { const s = state.songs[sid]; if (s) ol.appendChild(songRow(s, { rank: i + 1, mine: mine[sid] || null, remove: true, grip: l.songIds.length > 1 })); });
    stateBlock($('#list-state'), l.songIds.length ? {} : { title: 'An empty crate', body: 'Add songs from search, your ratings, or any chart.', actions: [{ label: 'Add songs', run: () => openListAdder(l) }] });
  }
  $('#list-detail').addEventListener('click', (e) => {
    const b = e.target.closest('[data-la]');
    const l = state.lists.find((x) => x.id === openListId);
    if (!b || !l) return;
    if (b.dataset.la === 'add') openListAdder(l);
    if (b.dataset.la === 'rename') {
      openSheet(`<p class="label kicker">Rename</p><h3 class="prompt">${esc(l.name)}</h3><form class="form" id="rename-list"><input class="input" name="name" maxlength="60" required value="${esc(l.name)}" aria-label="List name" /><button class="btn primary wide">Save</button></form>`);
      $('#rename-list').onsubmit = (ev) => { ev.preventDefault(); const nm = String(new FormData(ev.target).get('name')).trim(); if (nm) { l.name = nm; l.updatedAt = Date.now(); save(); renderAll(); } closeSheet(); };
    }
    if (b.dataset.la === 'delete') {
      openSheet(`<p class="label kicker">Delete list</p><h3 class="prompt">Delete “${esc(l.name)}”?</h3><p class="center muted">The songs stay in your ratings.</p><div class="btn-row center"><button class="btn" data-dismiss>Keep it</button><button class="btn primary" id="confirm-del">Delete list</button></div>`);
      $('#confirm-del').onclick = () => {
        const at = state.lists.indexOf(l);
        state.lists.splice(at, 1); save(); closeSheet(); back(); renderAll();
        toast('List deleted', { action: 'Undo', run: () => { state.lists.splice(at, 0, l); save(); renderAll(); } });
      };
    }
  });
  $('#list-detail').addEventListener('change', (e) => {
    if (e.target.id !== 'list-public') return;
    const l = state.lists.find((x) => x.id === openListId);
    if (!l) return;
    l.isPublic = e.target.checked; l.updatedAt = Date.now(); save(); renderAll();
    toast(l.isPublic ? 'List is public' : 'List is private');
  });
  function openListAdder(l) {
    let mode = 'search';
    let shown = [];
    const draw = () => {
      const ul = $('#adder-results');
      if (!ul) return;
      ul.innerHTML = '';
      shown.forEach((s) => {
        const li = songRow(s, { mine: null });
        const on = l.songIds.includes(s.id);
        $('.actions', li).innerHTML = `<button class="add-list ${on ? 'on' : ''}" data-act="toggle" aria-label="${on ? 'Remove from list' : 'Add to list'}">${on ? I.check : I.plus}</button>`;
        ul.appendChild(li);
      });
      if (!shown.length) ul.innerHTML = `<li class="muted small" style="padding:var(--s-4) 0">${mode === 'search' ? 'Search Apple Music to find songs.' : 'You haven’t rated anything yet.'}</li>`;
    };
    openSheet(`<p class="label kicker">Add to ${esc(l.name)}</p>
      <div class="strip" id="adder-strip" style="margin-top:var(--s-3)"><button class="active" data-m="search">Search</button><button data-m="ratings">From my ratings</button></div>
      <div class="field" style="margin-top:var(--s-3)">${I.search}<input id="adder-q" type="search" placeholder="Search Apple Music" autocomplete="off" aria-label="Search" /></div>
      <ul class="rows" id="adder-results"></ul>`);
    const ratingsSongs = () => state.order.map((id) => state.songs[id]).filter(Boolean);
    draw();
    let t;
    $('#adder-q').addEventListener('input', (e) => {
      clearTimeout(t);
      const q = e.target.value.trim();
      t = setTimeout(async () => {
        if (mode === 'ratings') { shown = ratingsSongs().filter((s) => `${s.title} ${s.artist}`.toLowerCase().includes(q.toLowerCase())); return draw(); }
        if (!q) { shown = []; return draw(); }
        try { shown = await searchSongs(q); } catch (_) { shown = []; }
        draw();
      }, 200);
    });
    $$('#adder-strip button').forEach((b) => (b.onclick = () => {
      mode = b.dataset.m;
      $$('#adder-strip button').forEach((x) => x.classList.toggle('active', x === b));
      $('#adder-q').placeholder = mode === 'search' ? 'Search Apple Music' : 'Filter your ratings';
      $('#adder-q').value = '';
      shown = mode === 'ratings' ? ratingsSongs() : [];
      draw();
    }));
    $('#adder-results').addEventListener('click', (e) => {
      const b = e.target.closest('[data-act="toggle"]');
      const li = e.target.closest('li.row');
      if (!b || !li) return;
      const s = shown.find((x) => x.id === li.dataset.id);
      if (!s) return;
      const added = toggleInList(l.id, s);
      b.classList.toggle('on', added);
      b.innerHTML = added ? I.check : I.plus;
      M.haptic(8);
      renderListDetail(); renderCrates();
    });
    setTimeout(() => $('#adder-q')?.focus(), 320);
  }

  // ----- Artist / album page -----
  function openGroup(g, data, fromEl) {
    const whose = data.mine ? 'Your' : esc(data.user.displayName) + '’s';
    $('#group-hero').innerHTML = `<div class="profile-card">
        <div class="record-out out" style="width:min(56vw,200px)">${vinyl(g.top, '100%', { px: 300 })}${g.kind === 'album' ? sleeve(g.top, 600) : ''}</div>
        <p class="label accent" style="margin-top:var(--s-5)">${g.kind === 'artist' ? 'Artist' : 'Album · ' + esc(g.artist)}</p>
        <h1 class="display" id="group-name">${esc(g.name)}</h1>
        <div class="result" style="margin:var(--s-2) 0 0">${sticker(g.avg, { lg: true })}<div class="place">${whose} average across ${g.count} rated song${g.count > 1 ? 's' : ''}</div></div>
      </div>`;
    const ol = $('#group-list');
    ol.innerHTML = '';
    const mine = scoreMapOf(state.order);
    g.entries.forEach((e) => { const s = data.songs[e.id]; if (s) ol.appendChild(songRow(s, { rank: e.rank, mine: data.mine ? e : mine[e.id] || null, theirs: data.mine ? null : e, addList: data.mine })); });
    ol._data = data;
    showView('group', { mode: 'push' });
    M.shared(fromEl, $('#group-hero .record-out'), { radiusTo: 2 });
  }

  // =====================================================================
  // RECOMMENDATIONS
  // =====================================================================
  let recSongs = [];
  let recsTimer = null;
  let recsSeq = 0;
  let recsDirty = true;
  function scheduleRecs() { recsDirty = true; clearTimeout(recsTimer); recsTimer = setTimeout(() => { if (activeView === 'recs') loadRecs(); }, 400); }
  async function loadRecs() {
    const seq = ++recsSeq;
    recsDirty = false;
    const box = $('#recs');
    if (!recSongs.length) { box.innerHTML = '<ul class="rows" id="recs-skel"></ul>'; skeleton($('#recs-skel'), 4); }
    stateBlock($('#recs-state'));
    const items = [];
    let community = 0;
    const heard = recentSongs.slice(0, 50);
    try {
      if (sync.server && sync.awake) {
        const songs = {};
        state.order.forEach((id) => { if (state.songs[id]) songs[id] = state.songs[id]; });
        const r = await api('/api/recommendations', { method: 'POST', body: { order: state.order, songs, heard, limit: 30 }, timeout: 20000 }).catch(() => ({ ok: false }));
        if (r.ok) { items.push(...r.data.items); community = r.data.community || 0; }
      }
      if (!items.length) items.push(...Recommend.recommend({ me: { order: state.order, songs: state.songs, heard }, others: [] }).items);
      // Rediscover favourite artists' other songs: familiar, not random.
      if (items.length < 12 && rated()) {
        const favs = groupStats(state.order, state.songs, 'artist').filter((g) => g.avg >= 6).sort((a, b) => b.avg - a.avg).slice(0, 3);
        for (const g of favs) {
          try {
            const best = g.entries[0];
            const songs = (await searchSongs(g.name)).filter((s) => norm(s.artist) === g.key && !state.order.includes(s.id)).slice(0, 3);
            songs.forEach((s) => items.push({ song: s, predicted: null, kind: 'artist', reason: `Because you rated ${state.songs[best.id].title} a ${fmt(best.score)}` }));
          } catch (_) { /* skip */ }
        }
      }
      // New users: fall back to the genre charts.
      if (rated() < 3 || items.length < 8) {
        const counts = {};
        state.order.forEach((id) => { const k = genreKeyFor(state.songs[id]?.genre); if (k) counts[k] = (counts[k] || 0) + 1; });
        const keys = Object.keys(counts).sort((a, b) => counts[b] - counts[a]).slice(0, 2);
        if (!keys.length) keys.push('pop', 'hiphop');
        for (const k of keys) {
          try {
            const v = await Charts.current(k);
            v.songs.filter((s) => !state.order.includes(s.id)).slice(0, 6).forEach((s) => items.push({ song: s, predicted: null, kind: 'chart', reason: `#${v.songs.indexOf(s) + 1} on the ${G.byKey[k].label} chart${v.placeholder ? ' (sample list)' : ' right now'}` }));
          } catch (_) { /* skip */ }
        }
      }
    } catch (_) { /* show whatever we have */ }
    if (seq !== recsSeq) return;
    const seen = new Set();
    const list = items.filter((x) => x && x.song && !state.order.includes(x.song.id) && !seen.has(x.song.id) && seen.add(x.song.id)).slice(0, 30);
    recSongs = list.map((x) => x.song);
    const left = 3 - rated();
    const note = left > 0
      ? `Rate ${left} more song${left === 1 ? '' : 's'} to unlock picks from listeners like you. Until then, here’s what’s charting in your genres.`
      : !(sync.server && sync.awake) ? 'Picks from listeners like you need the Encore server. For now these come from your listening history, favourite artists and the charts.'
        : !community ? 'Nobody with similar ratings yet. As more people rate songs, these get more personal.' : '';
    $('#recs-note').innerHTML = note ? `<p class="note">${esc(note)}</p>` : '';
    box.innerHTML = list.map((x) => `<div class="rec" data-id="${esc(x.song.id)}">
        <button data-act="play" aria-label="Play ${esc(x.song.title)}">${pack(x.song, 84)}</button>
        <div class="meta" data-act="open"><div class="t1">${esc(x.song.title)}</div><div class="t2">${esc(x.song.artist)}</div>
          <div class="why">${esc(x.reason)}</div>${x.predicted ? `<div class="predict">Listeners like you average ${fmt(x.predicted)}</div>` : ''}</div>
        <div class="btn-row"><button class="btn primary sm" data-act="rate">Rate</button><button class="btn sm" data-act="list">${I.listAdd}Add to list</button></div>
      </div>`).join('');
    stateBlock($('#recs-state'), list.length ? {} : { title: 'Nothing to suggest yet', body: 'Rate a few songs or connect a music service, and suggestions show up here.', actions: [{ label: 'Find a song', run: () => { showView('home'); $('#search').focus(); } }] });
  }
  $('#recs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    const card = e.target.closest('.rec');
    if (!b || !card) return;
    const s = recSongs.find((x) => x.id === card.dataset.id);
    if (!s) return;
    if (b.dataset.act === 'play') playFrom(s, recSongs);
    if (b.dataset.act === 'rate') startRating(s);
    if (b.dataset.act === 'list') openAddToList(s);
    if (b.dataset.act === 'open') openDetail(s);
  });

  // =====================================================================
  // PROFILE
  // =====================================================================
  function initials(name) { return esc((name || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase()); }
  const avatarHtml = (u, cls = '') => `<span class="avatar ${cls}">${u && u.avatar ? `<img src="${esc(u.avatar)}" alt="" class="in" />` : u ? initials(u.displayName) : I.user}</span>`;
  function renderMeButton() {
    const b = $('#me-btn');
    b.hidden = !sync.server;
    b.classList.toggle('has-avatar', !!sync.user);
    if (sync.user) { b.innerHTML = avatarHtml(sync.user); b.setAttribute('aria-label', 'Your profile'); }
    else { b.textContent = 'Sign in'; b.removeAttribute('aria-label'); }
  }
  $('#me-btn').onclick = () => (sync.user ? showView('profile') : openAuth('signup'));

  function top10Html(order, songs) {
    const top = R.flatten(order).slice(0, 10).filter((e) => songs[e.id]);
    if (!top.length) return '';
    return `<div class="section"><div class="section-head"><h2>Top 10</h2></div><ol class="rows">${top.map((e) => {
      const s = songs[e.id];
      return `<li class="row" data-id="${esc(s.id)}"><div class="row-body"><div class="rank ${e.rank <= 3 ? 'hot' : ''}">${e.rank}</div><button data-act="play" aria-label="Play ${esc(s.title)}">${pack(s)}</button><div class="meta" data-act="open"><div class="t1">${esc(s.title)}</div><div class="t2">${esc(s.artist)}</div></div><div class="actions">${sticker(e.score)}</div></div></li>`;
    }).join('')}</ol></div>`;
  }
  function listsHtml(lists, songs, own) {
    if (!lists.length && !own) return '';
    return `<div class="section"><div class="section-head"><h2>Lists</h2>${own ? `<button class="btn quiet sm" data-p="new-list">${I.plus}New</button>` : ''}</div>
      ${lists.length ? `<div class="crates">${lists.map((l) => crateHtml(l, songs, own)).join('')}</div>` : '<p class="muted small">No lists yet. Make one for gym songs, road trips, or your best rap song.</p>'}</div>`;
  }
  function servicesHtml() {
    return `<div class="section"><div class="section-head"><h2>Connected services</h2></div><ul class="services">${Services.LIST.map((svc) => {
      let status = '';
      let btn = '';
      if (svc.key === 'apple') {
        if (amConnected()) { status = 'Connected · recently played shows on Home'; btn = `<button class="btn sm" data-svc="apple-playlist">Save Top 25</button><button class="btn quiet sm" data-svc="apple-off">Disconnect</button>`; }
        else { status = am.error ? `<span style="color:var(--danger)">${esc(am.error)}</span>` : 'Recently played on Home, and full songs instead of previews'; btn = '<button class="btn primary sm" data-svc="apple-on">Connect</button>'; }
      } else if (svc.key === 'spotify') {
        if (Services.Spotify.connected()) { status = 'Connected' + (Services.Spotify.profile() ? ' as ' + esc(Services.Spotify.profile()) : ''); btn = '<button class="btn quiet sm" data-svc="spotify-off">Disconnect</button>'; }
        else if (spotifyClientId()) { status = 'Recently played from Spotify on Home'; btn = '<button class="btn primary sm" data-svc="spotify-on">Connect</button>'; }
        else { status = 'Needs a Spotify app client ID from the site owner'; btn = '<span class="badge">Not set up</span>'; }
      } else { status = esc(svc.why); btn = '<span class="badge">Coming soon</span>'; }
      const on = (svc.key === 'apple' && amConnected()) || (svc.key === 'spotify' && Services.Spotify.connected());
      return `<li><span class="svc-mark ${on ? 'on' : ''}" aria-hidden="true">${esc(svc.name[0])}</span><div><div class="t1">${esc(svc.name)}</div><div class="t3" style="white-space:normal">${status}</div></div><div class="actions" style="gap:6px;flex-wrap:wrap;justify-content:flex-end">${btn}</div></li>`;
    }).join('')}</ul></div>`;
  }
  function renderProfile() {
    const el = $('#profile');
    const u = sync.user;
    const n = rated();
    const counts = `<div class="counts"><div><b>${n}</b><span class="label">Ratings</span></div><div><b>${state.lists.length}</b><span class="label">Lists</span></div></div>`;
    let head;
    if (u) {
      head = `<div class="profile-card">
          <button class="avatar-btn" data-p="avatar" aria-label="Change your photo">${avatarHtml(u, 'xl')}<span class="cam">${I.camera}</span></button>
          <h1 class="display">${esc(u.displayName)}</h1>
          <div class="muted">@${esc(u.username)} · <span id="sync-status">${esc(sync.status || 'Synced')}</span></div>
          ${u.bio ? `<p class="bio">${esc(u.bio)}</p>` : '<p class="muted small">Add a bio so people know what you’re into.</p>'}
          ${counts}
          <div class="btn-row center"><button class="btn sm" data-p="edit">${I.edit}Edit profile</button>${n ? `<button class="btn sm" data-p="share">${I.share}Share Top 10</button>` : ''}</div>
        </div>`;
    } else {
      head = `<div class="profile-card">${avatarHtml(null, 'xl')}<h1 class="display">Your crate</h1>
          <p class="muted" style="max-width:40ch">${sync.server ? 'You’re rating as a guest, so everything lives in this browser. Make an account to keep it everywhere and share your profile.' : 'Everything you rate is saved in this browser. Use Export below to back it up or move it to another device.'}</p>
          ${counts}
          <div class="btn-row center">${sync.server ? '<button class="btn primary" data-p="signup">Create account</button><button class="btn" data-p="login">Sign in</button>' : ''}${n ? `<button class="btn sm" data-p="share">${I.share}Share Top 10</button>` : ''}</div></div>`;
    }
    const settings = `<div class="section"><div class="section-head"><h2>Settings</h2></div>
        ${u ? `<label class="toggle"><span>Public profile<br /><small class="muted">People can find you and see your ratings and public lists</small></span><span class="switch"><input type="checkbox" id="public-toggle" ${u.isPublic ? 'checked' : ''} /><i></i></span></label>` : ''}
        <div class="btn-row">${u && u.isPublic ? `<button class="btn sm" data-p="copy">${I.share}Copy profile link</button>` : ''}<button class="btn sm" data-p="export">${I.download}Export</button><button class="btn sm" data-p="import">Import</button>${u ? '<button class="btn quiet sm" data-p="logout">Sign out</button>' : ''}</div></div>`;
    const people = sync.server ? `<div class="section"><div class="section-head"><h2>Find people</h2></div><div class="field" style="height:44px">${I.search}<input id="people-search" type="search" placeholder="Search by name or username" autocomplete="off" aria-label="Search people" /></div><ul id="people-results" class="people"></ul></div>` : '';
    el.innerHTML = head + top10Html(state.order, state.songs) + listsHtml(state.lists, state.songs, true) + servicesHtml() + people + settings;
  }
  $('#profile').addEventListener('click', async (e) => {
    const svc = e.target.closest('[data-svc]');
    if (svc) {
      const k = svc.dataset.svc;
      if (k === 'apple-on') amConnect();
      if (k === 'apple-off') amDisconnect();
      if (k === 'apple-playlist') amExportPlaylist();
      if (k === 'spotify-on') spotifyConnect();
      if (k === 'spotify-off') { Services.Spotify.disconnect(); delete state.connections.spotify; save(); renderAll(); loadRecent(); toast('Spotify disconnected'); }
      return;
    }
    const person = e.target.closest('[data-user]');
    if (person) return openUser(person.dataset.user);
    const crate = e.target.closest('[data-list]');
    if (crate) return openList(crate.dataset.list);
    const b = e.target.closest('[data-p]');
    if (!b) return;
    const a = b.dataset.p;
    if (a === 'signup' || a === 'login') openAuth(a);
    if (a === 'edit') openEditProfile();
    if (a === 'avatar') $('#avatar-file').click();
    if (a === 'share') openShare();
    if (a === 'new-list') openNewList();
    if (a === 'export') exportData();
    if (a === 'import') $('#import-file').click();
    if (a === 'logout') { await api('/api/logout', { method: 'POST', body: {} }).catch(() => {}); signedOut(); toast('Signed out'); }
    if (a === 'copy') {
      const link = `${location.origin}${location.pathname}?u=${encodeURIComponent(sync.user.username)}`;
      try { await navigator.clipboard.writeText(link); toast('Link copied'); }
      catch (_) { openSheet(`<p class="label kicker">Your profile link</p><input class="input" readonly value="${esc(link)}" onclick="this.select()" style="margin-top:var(--s-4)" aria-label="Profile link" />`); }
    }
  });
  $('#profile').addEventListener('change', async (e) => {
    if (e.target.id !== 'public-toggle') return;
    const want = e.target.checked;
    const r = await api('/api/me', { method: 'PATCH', body: { isPublic: want } }).catch(() => ({ ok: false }));
    if (r.ok) { sync.user = r.data.user; writeJSON(LAST_USER, sync.user); toast(want ? 'Your profile is public' : 'Your profile is private'); renderProfile(); }
    else { e.target.checked = !want; toast('Couldn’t change that. Try again'); }
  });
  $('#profile').addEventListener('input', (e) => { if (e.target.id === 'people-search') searchPeople(e.target.value); });
  bindList($('#profile'), (id) => state.songs[id]);
  /** Resize a picked photo to a 192px square JPEG before upload. */
  $('#avatar-file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f || !sync.user) return;
    try {
      const bmp = await createImageBitmap(f);
      const c = document.createElement('canvas');
      c.width = c.height = 192;
      const side = Math.min(bmp.width, bmp.height);
      c.getContext('2d').drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, 192, 192);
      const r = await api('/api/me', { method: 'PATCH', body: { avatar: c.toDataURL('image/jpeg', 0.82) } });
      if (!r.ok) throw new Error(r.data.error);
      sync.user = r.data.user; writeJSON(LAST_USER, sync.user); renderAll(); toast('Photo updated');
    } catch (err) { toast((err && err.message) || 'That image couldn’t be used'); }
  });
  function openEditProfile() {
    const u = sync.user;
    openSheet(`<p class="label kicker">Profile</p><h3 class="prompt">Edit profile</h3>
      <form class="form" id="edit-form">
        <label><span class="label">Name</span><input class="input" name="displayName" maxlength="40" value="${esc(u.displayName)}" /></label>
        <label><span class="label">Bio</span><textarea class="input" name="bio" maxlength="280" placeholder="What do you listen to?">${esc(u.bio || '')}</textarea></label>
        <label><span class="label">Email</span><input class="input" name="email" type="email" value="${esc(u.email || '')}" autocomplete="email" /></label>
        <p class="form-error" id="edit-error" hidden></p>
        <button class="btn primary wide" type="submit">Save</button>
      </form>`);
    $('#edit-form').onsubmit = async (e) => {
      e.preventDefault();
      const r = await api('/api/me', { method: 'PATCH', body: Object.fromEntries(new FormData(e.target)) }).catch(() => ({ ok: false, data: { error: 'Can’t reach the server.' } }));
      if (!r.ok) { const er = $('#edit-error'); er.textContent = r.data.error || 'Couldn’t save.'; er.hidden = false; return; }
      sync.user = r.data.user; writeJSON(LAST_USER, sync.user); closeSheet(); renderAll(); toast('Profile saved');
    };
  }
  let peopleTimer;
  function searchPeople(q) {
    clearTimeout(peopleTimer);
    peopleTimer = setTimeout(async () => {
      const ul = $('#people-results');
      if (!ul) return;
      if (!q.trim()) { ul.innerHTML = ''; return; }
      const r = await api('/api/users?q=' + encodeURIComponent(q.trim())).catch(() => ({ ok: false }));
      const users = (r.ok && r.data.users) || [];
      ul.innerHTML = users.length ? users.map((x) => `<li data-user="${esc(x.username)}" tabindex="0">${avatarHtml(x)}<div><b>${esc(x.displayName)}</b><div class="t3">@${esc(x.username)} · ${x.ranked} ratings</div></div>${I.chevron}</li>`).join('') : '<li class="muted small" style="cursor:default">No public profiles match.</li>';
    }, 220);
  }

  // ----- Someone else's profile -----
  let viewing = null;
  async function openUser(username) {
    const r = await api('/api/users/' + encodeURIComponent(username)).catch(() => ({ ok: false }));
    if (!r.ok) { toast('That profile is private or doesn’t exist'); return; }
    viewing = { ...r.data, mine: false };
    renderUser();
    showView('user', { mode: 'push' });
  }
  function renderUser() {
    const v = viewing;
    const mine = scoreMapOf(state.order);
    const common = R.flatten(v.order).filter((e) => mine[e.id]);
    const match = common.length >= 3 ? `<span class="badge warn">${Math.max(0, Math.round(100 - (common.reduce((a, e) => a + Math.abs(e.score - mine[e.id].score), 0) / common.length) * 10))}% taste match</span>` : '';
    const svcNames = (v.connections || []).map((k) => esc((Services.LIST.find((s) => s.key === k) || {}).name || k));
    $('#user-profile').innerHTML = `<div class="profile-card">${avatarHtml(v.user, 'xl')}<h1 class="display" id="user-name">${esc(v.user.displayName)}</h1><div class="muted">@${esc(v.user.username)}</div>
        ${v.user.bio ? `<p class="bio">${esc(v.user.bio)}</p>` : ''}
        <div class="counts"><div><b>${v.order.length}</b><span class="label">Ratings</span></div><div><b>${v.lists.length}</b><span class="label">Lists</span></div><div><b>${common.length}</b><span class="label">In common</span></div></div>
        ${match}${svcNames.length ? `<p class="t3">Listens on ${svcNames.join(', ')}</p>` : ''}</div>
      ${top10Html(v.order, v.songs)}${listsHtml(v.lists, v.songs, false)}`;
  }
  $('#user-profile').addEventListener('click', (e) => {
    const crate = e.target.closest('[data-list]');
    if (!crate || !viewing) return;
    const l = viewing.lists.find((x) => x.id === crate.dataset.list);
    if (!l) return;
    const mine = scoreMapOf(state.order);
    openSheet(`<p class="label kicker">${esc(viewing.user.displayName)}’s list</p><h3 class="prompt">${esc(l.name)}</h3><ol class="rows" id="their-list"></ol>`);
    l.songIds.forEach((id, i) => { const s = viewing.songs[id]; if (s) $('#their-list').appendChild(songRow(s, { rank: i + 1, mine: mine[id] || null, addList: true })); });
    bindList($('#their-list'), (id) => viewing.songs[id]);
  });
  bindList($('#user-profile'), (id) => viewing && viewing.songs[id], { other: () => viewing });

  // ----- Accounts -----
  function openAuth(mode) {
    const signup = mode === 'signup';
    openSheet(`<p class="label kicker">${signup ? 'Join Encore' : 'Welcome back'}</p>
      <h3 class="prompt">${signup ? 'Create your account' : 'Sign in'}</h3>
      <form class="form" id="auth-form" novalidate>
        ${signup ? `<label><span class="label">Email</span><input class="input" name="email" type="email" autocomplete="email" required /></label>
        <label><span class="label">Username</span><input class="input" name="username" autocomplete="username" autocapitalize="none" required minlength="3" maxlength="24" /><span class="hint" id="u-hint">3–24 letters, numbers, _ or .</span></label>`
        : '<label><span class="label">Email or username</span><input class="input" name="login" autocomplete="username" autocapitalize="none" required /></label>'}
        <label><span class="label">Password</span><input class="input" name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" required />${signup ? '<span class="hint">At least 8 characters</span>' : ''}</label>
        <p class="form-error" id="auth-error" hidden></p>
        <button class="btn primary wide" type="submit">${signup ? 'Create account' : 'Sign in'}</button>
      </form>
      <p class="center small muted">${signup ? 'Already have an account?' : 'New to Encore?'} <a href="#" data-switch="${signup ? 'login' : 'signup'}">${signup ? 'Sign in' : 'Create one'}</a></p>`);
    setTimeout(() => $('#sheet-body input')?.focus(), 320);
    $('[data-switch]').onclick = (e) => { e.preventDefault(); openAuth(e.target.dataset.switch); };
    if (signup) {
      let t;
      $('#auth-form [name=username]').addEventListener('input', (e) => {
        clearTimeout(t);
        const hint = $('#u-hint');
        const v = e.target.value.trim();
        t = setTimeout(async () => {
          if (!v) { hint.className = 'hint'; hint.textContent = '3–24 letters, numbers, _ or .'; return; }
          const r = await api('/api/username-available?u=' + encodeURIComponent(v)).catch(() => null);
          if (!r || !r.ok) return;
          hint.className = 'hint ' + (r.data.available ? 'ok' : 'bad');
          hint.textContent = !r.data.valid ? 'Use 3–24 letters, numbers, _ or .' : r.data.available ? `@${v} is available` : `@${v} is taken`;
        }, 250);
      });
    }
    $('#auth-form').onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      const btn = e.target.querySelector('button[type=submit]');
      btn.disabled = true; btn.textContent = signup ? 'Creating…' : 'Signing in…';
      const r = await api(signup ? '/api/signup' : '/api/login', { method: 'POST', body: f, timeout: 70000 }).catch(() => ({ ok: false, data: { error: 'Can’t reach the server. Check your connection.' } }));
      btn.disabled = false; btn.textContent = signup ? 'Create account' : 'Sign in';
      if (!r.ok) {
        const er = $('#auth-error'); er.textContent = r.data.error || 'Something went wrong. Try again.'; er.hidden = false;
        if (r.data.field) $(`#auth-form [name=${r.data.field}]`)?.focus();
        M.haptic([10, 40, 10]); return;
      }
      closeSheet();
      const note = signedIn(r.data.user, r.data);
      toast((signup ? `Welcome, @${r.data.user.username}!` : `Signed in as @${r.data.user.username}`) + (note ? ' ' + note + '.' : ''));
    };
  }

  // =====================================================================
  // Apple Music (MusicKit JS) + Spotify
  // =====================================================================
  const am = { music: null, devToken: null, loading: null, error: '' };
  const amConnected = () => !!(am.music && am.music.isAuthorized);
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.async = true; s.onload = resolve; s.onerror = () => reject(new Error('Couldn’t load Apple Music. Check your connection.'));
      document.head.appendChild(s);
    });
  }
  function amInit() {
    if (am.loading) return am.loading;
    am.loading = (async () => {
      let token = CFG.musickitDeveloperToken || '';
      if (!token && sync.server) { const r = await api('/api/apple/developer-token').catch(() => ({ ok: false })); if (r.ok) token = r.data.token; }
      if (!token) throw new Error('Apple Music isn’t set up on this site yet. The site owner needs to add a MusicKit key.');
      am.devToken = token;
      if (!window.MusicKit) {
        const ready = new Promise((res) => document.addEventListener('musickitloaded', res, { once: true }));
        await loadScript('https://js-cdn.music.apple.com/musickit/v3/musickit.js');
        if (!window.MusicKit) await ready;
      }
      am.music = await MusicKit.configure({ developerToken: token, app: { name: 'Encore', build: '4.0' } });
      am.music.addEventListener('playbackStateDidChange', () => {
        refreshPlaying();
        const st = am.music.playbackState;
        if (pb.full && (st === MusicKit.PlaybackStates.completed || st === MusicKit.PlaybackStates.ended)) next();
      });
      return am.music;
    })();
    am.loading.catch(() => { am.loading = null; });
    return am.loading;
  }
  async function amConnect() {
    try {
      const music = await amInit();
      await music.authorize();
      try { localStorage.setItem(AM_FLAG, '1'); } catch (_) { /* ignore */ }
      if (music.storefrontId && music.storefrontId !== state.country) state.country = music.storefrontId;
      state.connections.apple = { connectedAt: Date.now(), name: '' };
      am.error = '';
      save();
      toast('Apple Music connected');
      loadRecent();
    } catch (err) {
      am.error = (err && err.message) || 'Couldn’t connect Apple Music. Try again.';
      if (/cancel|denied/i.test(am.error)) am.error = 'Apple Music connection cancelled.';
      toast(am.error);
    }
    renderAll();
  }
  async function amDisconnect() {
    try { await am.music?.unauthorize(); } catch (_) { /* ignore */ }
    removeKey(AM_FLAG);
    delete state.connections.apple;
    save(); renderAll(); loadRecent();
    toast('Apple Music disconnected');
  }
  async function amFetch(path, opts = {}) {
    const res = await fetch('https://api.music.apple.com' + path, {
      method: opts.method || 'GET',
      headers: { Authorization: 'Bearer ' + am.devToken, 'Music-User-Token': am.music.musicUserToken, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok) throw new Error('Apple Music error ' + res.status);
    return res.status === 204 ? {} : res.json();
  }
  function amToSong(r) {
    const a = r.attributes || {};
    return {
      id: String(r.id), title: a.name, artist: a.artistName, album: a.albumName || '', art: a.artwork && a.artwork.url ? a.artwork.url : '',
      preview: (a.previews && a.previews[0] && a.previews[0].url) || '', url: a.url || '', genre: (a.genreNames || []).find((g) => g !== 'Music') || '',
      year: (a.releaseDate || '').slice(0, 4), explicit: a.contentRating === 'explicit', artistId: '', albumId: '',
    };
  }
  async function amRecent() {
    const d = await amFetch('/v1/me/recent/played/tracks?types=songs&limit=30');
    const seen = new Set();
    return (d.data || []).filter((r) => r.type === 'songs' && !seen.has(r.id) && seen.add(r.id)).map(amToSong);
  }
  async function amExportPlaylist(n = 25) {
    const ids = state.order.slice(0, n).filter((id) => /^\d+$/.test(id));
    if (!ids.length) { toast('Rate some songs first'); return; }
    try {
      await amFetch('/v1/me/library/playlists', { method: 'POST', body: { attributes: { name: `Encore Top ${ids.length}`, description: 'My highest-rated songs on Encore' }, relationships: { tracks: { data: ids.map((id) => ({ id, type: 'songs' })) } } } });
      toast(`“Encore Top ${ids.length}” is in your Apple Music library`);
    } catch (_) { toast('Couldn’t create the playlist. Try again'); }
  }
  function spotifyConnect() {
    const id = spotifyClientId();
    if (!id) { toast('Spotify isn’t set up on this site yet'); return; }
    Services.Spotify.connect(id).catch(() => toast('Couldn’t start Spotify sign-in'));
  }

  // =====================================================================
  // Playback: crossfaded previews, or full songs via Apple Music
  // =====================================================================
  const AE = window.AudioEngine;
  const pb = { queue: [], index: -1, song: null, full: false };
  const musicPlaying = () => !!(am.music && window.MusicKit && am.music.playbackState === MusicKit.PlaybackStates.playing);
  function isPlaying(id) {
    if (!pb.song || pb.song.id !== id) return false;
    return pb.full ? musicPlaying() : AE.playing;
  }
  function playFrom(song, list) {
    if (pb.song && pb.song.id === song.id) { togglePlay(); return; }
    const queue = (list && list.length ? list : [song]).filter((s) => s.preview || (amConnected() && /^\d+$/.test(s.id)));
    let idx = queue.findIndex((s) => s.id === song.id);
    if (idx < 0) { queue.unshift(song); idx = 0; }
    pb.queue = queue; pb.index = idx;
    startSong(song);
  }
  async function startSong(song, dir = 0) {
    pb.song = song;
    renderDeck(dir);
    if (amConnected() && /^\d+$/.test(song.id)) {
      try { AE.stop(); pb.full = true; await am.music.setQueue({ song: song.id, startPlaying: true }); refreshPlaying(); return; }
      catch (_) { pb.full = false; }
    }
    if (am.music) { try { am.music.stop(); } catch (_) { /* ignore */ } }
    pb.full = false;
    if (!song.preview) { toast('No preview for this song'); refreshPlaying(); return; }
    AE.play(song).catch(() => toast('Couldn’t play this preview'));
    refreshPlaying();
  }
  function togglePlay() {
    if (!pb.song) return;
    if (pb.full) { musicPlaying() ? am.music.pause() : am.music.play(); } else AE.toggle();
    M.haptic(6);
  }
  function next() { if (pb.index < pb.queue.length - 1) { pb.index++; startSong(pb.queue[pb.index], 1); } else refreshPlaying(); }
  function prev() { if (pb.index > 0) { pb.index--; startSong(pb.queue[pb.index], -1); } }
  AE.on('state', (s) => { refreshPlaying(); if (s === 'ended') next(); if (s === 'error') toast('This preview couldn’t load'); });
  function refreshPlaying() {
    const id = pb.song && pb.song.id;
    $$('li.row[data-id]').forEach((li) => li.classList.toggle('now', li.dataset.id === id));
    $$('[data-vinyl]').forEach((v) => v.classList.toggle('spin', isPlaying(v.dataset.vinyl)));
    $$('.sleeve .play').forEach((p) => { const host = p.closest('[data-id]'); if (host) p.innerHTML = isPlaying(host.dataset.id) ? I.pause : I.play; });
    $$('.play-fab').forEach((b) => { b.innerHTML = isPlaying(b.dataset.id) ? I.pause : I.play; });
    const playing = !!(id && isPlaying(id));
    $('#deck-toggle').innerHTML = playing ? I.pause : I.play;
    $('#deck-toggle').setAttribute('aria-label', playing ? 'Pause' : 'Play');
    $('#deck-vinyl').classList.toggle('spin', playing);
    $('#deck-next').disabled = !(pb.index < pb.queue.length - 1);
  }
  function renderDeck(dir) {
    const deck = $('#deck');
    const s = pb.song;
    if (!s) { deck.hidden = true; document.body.classList.remove('has-deck'); return; }
    deck.hidden = false;
    document.body.classList.add('has-deck');
    $('#deck-vinyl .lbl').innerHTML = artImg(s, 120, { eager: true });
    const meta = $('#deck-meta');
    meta.innerHTML = `<div class="t1">${esc(s.title)}</div><div class="t3">${esc(s.artist)} · ${pb.full ? 'Apple Music' : 'Preview'}</div>`;
    meta.classList.remove('slide-l', 'slide-r');
    if (dir) { void meta.offsetWidth; meta.classList.add(dir > 0 ? 'slide-l' : 'slide-r'); }
  }
  // The tonearm and the groove line follow playback every frame.
  (function deckLoop() {
    const arm = $('#tonearm');
    const bar = $('#deck-progress');
    function frame() {
      requestAnimationFrame(frame);
      if ($('#deck').hidden) return;
      const playing = pb.song && isPlaying(pb.song.id);
      const p = pb.full && am.music ? am.music.currentPlaybackProgress || 0 : AE.progress();
      // Resting off the record at −32°, dropped on the outer groove at −8°, swinging in to +20° at the run-out.
      arm.style.setProperty('--arm', playing || p > 0 ? `${-8 + p * 28}deg` : '-32deg');
      bar.style.setProperty('--p', p);
    }
    requestAnimationFrame(frame);
  })();
  $('#deck-toggle').onclick = togglePlay;
  $('#deck-next').onclick = () => { next(); M.haptic(6); };
  $('#deck-platter').onclick = () => pb.song && openDetail(pb.song);
  $('#deck-meta').onclick = () => pb.song && openDetail(pb.song);
  (function deckSwipe() {
    const deck = $('#deck');
    let x0 = null, dx = 0, id = null, moved = false;
    deck.addEventListener('pointerdown', (e) => { if (e.target.closest('#deck-toggle, #deck-next')) return; x0 = e.clientX; dx = 0; id = e.pointerId; moved = false; });
    deck.addEventListener('pointermove', (e) => {
      if (x0 == null || e.pointerId !== id) return;
      dx = e.clientX - x0;
      if (!moved && Math.abs(dx) > 10) { moved = true; deck.setPointerCapture(id); }
      if (moved) $('#deck-meta').style.transform = `translateX(${dx * 0.6}px)`;
    });
    const end = () => {
      if (x0 == null) return;
      x0 = null; $('#deck-meta').style.transform = '';
      if (!moved) return;
      deck.addEventListener('click', (ev) => { ev.stopPropagation(); ev.preventDefault(); }, { capture: true, once: true });
      if (dx < -60) { M.haptic(10); next(); } else if (dx > 60) { M.haptic(10); prev(); }
    };
    deck.addEventListener('pointerup', end);
    deck.addEventListener('pointercancel', end);
  })();

  // =====================================================================
  // Sheet
  // =====================================================================
  const sheetWrap = $('#sheet');
  const sheet = $('.sheet', sheetWrap);
  const body = $('#sheet-body');
  let session = null;
  let returnFocus = null;
  function openSheet(html) {
    body.innerHTML = html;
    if (sheetWrap.hidden) {
      returnFocus = document.activeElement;
      sheetWrap.hidden = false;
      document.body.classList.add('no-scroll');
      requestAnimationFrame(() => requestAnimationFrame(() => sheetWrap.classList.add('in')));
    }
    sheet.scrollTop = 0;
  }
  function closeSheet() {
    if (sheetWrap.hidden) return;
    session = null;
    sheetWrap.classList.remove('in');
    document.body.classList.remove('no-scroll');
    setTimeout(() => { if (!sheetWrap.classList.contains('in')) { sheetWrap.hidden = true; body.innerHTML = ''; } }, 320);
    if (returnFocus && returnFocus.isConnected) returnFocus.focus({ preventScroll: true });
  }
  sheetWrap.addEventListener('click', (e) => { if (e.target.closest('[data-dismiss]')) closeSheet(); });
  (function sheetDrag() {
    const grab = $('#sheet-grab');
    let y0 = null, dy = 0;
    grab.addEventListener('pointerdown', (e) => { y0 = e.clientY; dy = 0; grab.setPointerCapture(e.pointerId); sheet.classList.add('dragging'); });
    grab.addEventListener('pointermove', (e) => { if (y0 == null) return; dy = Math.max(0, e.clientY - y0); sheet.style.transform = `translate3d(0, ${dy}px, 0)`; });
    const end = () => { if (y0 == null) return; y0 = null; sheet.classList.remove('dragging'); sheet.style.transform = ''; if (dy > 110) closeSheet(); };
    grab.addEventListener('pointerup', end);
    grab.addEventListener('pointercancel', end);
  })();
  const recordOut = (song, { out = true } = {}) => `<div class="record-out ${out ? 'out' : ''}" id="record-out">${vinyl(song, '100%', { px: 300, spin: isPlaying(song.id) })}${sleeve(song, 600)}${song.preview || amConnected() ? `<button class="play-fab" data-id="${esc(song.id)}" data-act="play" aria-label="Play ${esc(song.title)}">${isPlaying(song.id) ? I.pause : I.play}</button>` : ''}</div>`;
  const songTitle = (song) => `<div class="song-title"><h2>${esc(song.title)}</h2><div class="t2">${esc(song.artist)}</div><div class="t3">${esc(song.album)}${song.year ? ' · ' + song.year : ''}</div></div>`;
  function slideRecordOut() { const r = $('#record-out'); if (r) { r.classList.remove('out'); requestAnimationFrame(() => requestAnimationFrame(() => r.classList.add('out'))); } }

  // =====================================================================
  // Rating flow
  // =====================================================================
  function startRating(song) {
    remember(song);
    const placement = R.startPlacement(state.order, song.id);
    session = { song, placement, total: R.maxSteps(placement.list.length), first: placement.list.length === 0, wasRated: state.order.includes(song.id) };
    if (session.first) return finish(); // first record: straight to a 10, no questions
    step();
  }
  function step() {
    const p = session.placement;
    const oppId = R.nextOpponent(p);
    if (!oppId) return finish();
    const opp = state.songs[oppId];
    const s = session.song;
    const steps = Array.from({ length: session.total }, (_, i) => `<i class="${i < p.steps ? 'done' : ''}"></i>`).join('');
    openSheet(`<div class="step">
        <p class="label kicker">${session.wasRated ? 'Re-rate' : 'Rate'} · question ${p.steps + 1} of up to ${session.total}</p>
        <h3 class="prompt">Is <em>${esc(s.title)}</em> better or worse than <em>${esc(opp.title)}</em>?</h3>
        <div class="versus">
          <div class="duelist">${vinyl(s, 'min(30vw, 120px)', { px: 300, spin: isPlaying(s.id) })}<div class="t1">${esc(s.title)}</div><div class="t2">${esc(s.artist)}</div><button class="btn quiet sm" data-act="play" data-id="${esc(s.id)}">${I.play}Preview</button></div>
          <div class="vs">vs</div>
          <div class="duelist">${vinyl(opp, 'min(30vw, 120px)', { px: 300, spin: isPlaying(opp.id) })}<div class="t1">${esc(opp.title)}</div><div class="t2">${esc(opp.artist)}</div><span class="t3">You gave it ${fmt((scoreMapOf(state.order)[opp.id] || { score: 0 }).score)}</span></div>
        </div>
        <div class="answers">
          <button class="btn" data-ans="worse">${I.down}Worse</button>
          <button class="btn primary" data-ans="better">${I.up}Better</button>
          <button class="btn quiet same" data-ans="same">About the same</button>
        </div>
        <div class="steps" aria-hidden="true">${steps}</div>
      </div>`);
  }
  let answering = false;
  function answer(choice) {
    if (!session || session.done || answering || !R.nextOpponent(session.placement)) return;
    answering = true;
    M.haptic(choice === 'same' ? 6 : 10);
    setTimeout(() => { answering = false; if (!session || session.done) return; R.answer(session.placement, choice); step(); }, M.reduced() ? 0 : 120);
  }
  function finish() {
    const { song, first, wasRated } = session;
    const prevTop = state.order[0];
    state.order = R.commit(state.order, session.placement);
    state.ratedAt[song.id] = Date.now();
    save();
    const e = scoreMapOf(state.order)[song.id];
    const n = rated();
    session = { song, done: true };
    const note = first ? 'Your first record starts at the top, with a 10.'
      : e.rank === 1 && prevTop !== song.id ? 'New #1. Everything else shifted down, and your top song is still a 10.'
        : 'Scores re-spread across your whole list, so your #1 stays a 10.';
    openSheet(`<div class="step">
        <p class="label kicker">${first ? 'First record' : wasRated ? 'Re-rated' : 'Added to your ratings'}</p>
        ${recordOut(song, { out: false })}
        ${songTitle(song)}
        <div class="result"><div class="big-score" id="big-score">0.0</div><div class="place"><b>#${e.rank}</b> of ${n} · ${esc(note)}</div></div>
        <div class="avg-box">${avgLine(groupOf(state.order, state.songs, 'artist', song), 'artist')}${song.album ? avgLine(groupOf(state.order, state.songs, 'album', song), 'album') : ''}</div>
        <div class="btn-row center"><button class="btn" data-done="list">${I.listAdd}Add to list</button><button class="btn primary" data-done="close">Done</button></div>
      </div>`);
    slideRecordOut();
    M.countUp($('#big-score'), e.score, { duration: 1100 });
    M.haptic([12, 60, 18]);
    renderAll();
    scheduleRecs();
  }
  body.addEventListener('click', (e) => {
    const play = e.target.closest('[data-act="play"]');
    if (play && play.dataset.id) { e.stopPropagation(); const s = lookupAny(play.dataset.id); if (s) playFrom(s, [s]); return; }
    const ans = e.target.closest('[data-ans]');
    if (ans) return answer(ans.dataset.ans);
    const done = e.target.closest('[data-done]');
    if (done) { const s = session && session.song; closeSheet(); if (done.dataset.done === 'list' && s) setTimeout(() => openAddToList(s), 340); return; }
    const det = e.target.closest('[data-detail]');
    if (det) return detailAction(det.dataset.detail);
  });

  // ----- Song detail -----
  let detailSong = null;
  function openDetail(song, other) {
    if (!song) return;
    detailSong = song;
    session = null;
    const mine = scoreMapOf(state.order)[song.id];
    const theirs = other && !other.mine ? scoreMapOf(other.order)[song.id] : null;
    const artistG = mine ? groupOf(state.order, state.songs, 'artist', song) : null;
    const albumG = mine && song.album ? groupOf(state.order, state.songs, 'album', song) : null;
    const lists = state.lists.filter((l) => l.songIds.includes(song.id));
    openSheet(`<div class="step">
        ${recordOut(song)}
        ${songTitle(song)}
        ${mine ? `<div class="result" style="margin-bottom:0"><div class="big-score">${fmt(mine.score)}</div><div class="place">Your <b>#${mine.rank}</b> of ${rated()}</div></div>` : ''}
        ${theirs ? `<p class="center muted">${esc(other.user.displayName)} gave it <b>${fmt(theirs.score)}</b> (#${theirs.rank})</p>` : ''}
        ${artistG || albumG ? `<div class="avg-box">${avgLine(artistG, 'artist')}${avgLine(albumG, 'album')}</div>` : ''}
        ${lists.length ? `<p class="center t3" style="white-space:normal;margin-top:var(--s-3)">On ${lists.map((l) => esc(l.name)).join(', ')}</p>` : ''}
        <div class="btn-row center">
          <button class="btn primary" data-detail="rate">${mine ? 'Re-rate' : 'Rate'}</button>
          <button class="btn" data-detail="list">${I.listAdd}Add to list</button>
          ${song.url ? `<a class="btn" href="${esc(song.url)}" target="_blank" rel="noopener">${I.external}Apple Music</a>` : ''}
          ${mine ? `<button class="btn quiet danger" data-detail="remove">${I.trash}Remove rating</button>` : ''}
        </div>
      </div>`);
  }
  function detailAction(act) {
    const song = detailSong;
    if (!song) return;
    if (act === 'rate') startRating(song);
    else if (act === 'list') openAddToList(song);
    else if (act === 'remove') {
      const before = state.order.slice();
      state.order = R.remove(state.order, song.id);
      save(); renderAll(); closeSheet(); scheduleRecs();
      toast('Rating removed', { action: 'Undo', run: () => { state.order = before; save(); renderAll(); } });
    }
  }

  // ----- Share Top 10 -----
  async function openShare() {
    const entries = R.flatten(state.order).slice(0, 10).filter((e) => state.songs[e.id]);
    if (!entries.length) { toast('Rate a song first'); return; }
    openSheet(`<p class="label kicker">Share</p><h3 class="prompt">Your Top ${entries.length}</h3><div class="share-preview" id="share-preview"><span class="vinyl spin" style="--d:80px"><span class="lbl"></span></span></div><div class="btn-row center" id="share-actions"></div>`);
    try {
      const proxied = (u) => (sync.server && /^https:\/\/is\d+(-ssl)?\.mzstatic\.com\//.test(u) ? '/api/art?u=' + encodeURIComponent(u) : u);
      const items = entries.map((e) => { const s = state.songs[e.id]; return { title: s.title, artist: s.artist, score: e.score, art: proxied(artUrl(s, 200)) }; });
      const blob = await ShareCard.render({ heading: `My Top ${items.length}`, sub: sync.user ? `@${sync.user.username} · ${rated()} songs rated on Encore` : `${rated()} songs rated head to head`, items });
      const url = URL.createObjectURL(blob);
      if (!$('#share-preview')) return;
      $('#share-preview').innerHTML = `<img src="${url}" alt="Your top ${items.length} songs as an image" class="in" />`;
      const canShare = navigator.canShare && navigator.canShare({ files: [new File([blob], 'x.png', { type: 'image/png' })] });
      $('#share-actions').innerHTML = `${canShare ? `<button class="btn primary" data-share="share">${I.share}Share image</button>` : ''}<button class="btn ${canShare ? '' : 'primary'}" data-share="save">${I.download}Save PNG</button>`;
      $('#share-actions').onclick = async (ev) => {
        const b = ev.target.closest('[data-share]');
        if (!b) return;
        if (b.dataset.share === 'share') await ShareCard.deliver(blob, 'encore-top-10.png');
        else { const a = document.createElement('a'); a.href = url; a.download = 'encore-top-10.png'; document.body.appendChild(a); a.click(); a.remove(); toast('Image saved'); }
      };
      window.__encoreShareBlob = blob;
    } catch (_) { if ($('#share-preview')) stateBlock($('#share-preview'), { error: true, title: 'Couldn’t make the image', body: 'Try again in a moment.' }); }
  }

  // =====================================================================
  // Navigation
  // =====================================================================
  const TABS = ['home', 'charts', 'lists', 'recs', 'profile'];
  let activeView = 'home';
  const stack = [];
  let chartsLoaded = false;
  function showView(name, { mode = 'tab' } = {}) {
    if (name === activeView && mode === 'tab') { window.scrollTo({ top: 0, behavior: M.reduced() ? 'auto' : 'smooth' }); return; }
    if (mode === 'push') stack.push({ view: activeView, y: window.scrollY });
    if (mode === 'tab') stack.length = 0;
    const from = $('#view-' + activeView);
    const to = $('#view-' + name);
    from.classList.remove('active', 'enter-tab', 'enter-push', 'enter-pop');
    to.classList.remove('enter-tab', 'enter-push', 'enter-pop');
    to.classList.add('active');
    if (!M.reduced()) { void to.offsetWidth; to.classList.add('enter-' + mode); }
    activeView = name;
    const tabName = TABS.includes(name) ? name : (stack[0] && stack[0].view) || 'lists';
    $$('.tab').forEach((t) => { const on = t.dataset.view === tabName; t.classList.toggle('active', on); t.setAttribute('aria-selected', on); });
    if (mode !== 'pop') window.scrollTo(0, 0);
    if (name === 'charts' && !chartsLoaded) { chartsLoaded = true; loadCharts(); }
    if (name === 'recs' && (recsDirty || !recSongs.length)) loadRecs();
  }
  function back() {
    const prevV = stack.pop();
    if (!prevV) return showView('home');
    if (activeView === 'user') { viewing = null; try { if (new URLSearchParams(location.search).get('u')) history.replaceState(null, '', location.pathname); } catch (_) { /* ignore */ } }
    showView(prevV.view, { mode: 'pop' });
    window.scrollTo(0, prevV.y);
  }
  $$('[data-back]').forEach((b) => (b.onclick = back));
  $$('.tab').forEach((t) => (t.onclick = () => { M.haptic(4); showView(t.dataset.view); }));
  $$('[data-go]').forEach((b) => (b.onclick = () => showView(b.dataset.go)));
  $$('#lists-strip button').forEach((b) => (b.onclick = () => {
    listsUI.pane = b.dataset.pane;
    $$('#lists-strip button').forEach((x) => x.classList.toggle('active', x === b));
    $('#pane-ratings').hidden = listsUI.pane !== 'ratings';
    $('#pane-mine').hidden = listsUI.pane !== 'mine';
  }));
  $$('#ratings-seg button').forEach((b) => (b.onclick = () => {
    listsUI.seg = b.dataset.seg;
    $$('#ratings-seg button').forEach((x) => x.classList.toggle('active', x === b));
    renderRatings();
  }));
  $('#ratings-filter').addEventListener('input', renderRatings);
  $('#search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    const term = $('#search').value.trim();
    if (!term || peekCatalog('search', { term })) return runSearch();
    searchTimer = setTimeout(runSearch, 180);
  });
  $('#search').addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(searchTimer); runSearch(); e.target.blur(); } });
  let scrollRaf = 0;
  window.addEventListener('scroll', () => {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; document.body.classList.toggle('scrolled', window.scrollY > 4); });
  }, { passive: true });

  // =====================================================================
  // Toast
  // =====================================================================
  let toastTimer;
  function toast(msg, { action = null, run = null } = {}) {
    const t = $('#toast');
    t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button class="toast-act">${esc(action)}</button>` : ''}`;
    if (action) $('.toast-act', t).onclick = () => { t.classList.remove('show'); run(); };
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), action ? 4200 : 2400);
  }

  // =====================================================================
  // Gestures
  // =====================================================================
  Gestures.swipeRows($('#results'), () => ({
    right: { run: (li) => { springBack(li); const s = lastResults.find((x) => x.id === li.dataset.id); if (s) startRating(s); } },
    left: { run: (li) => skipResult(li) },
  }));
  function springBack(li) {
    const b = $('.row-body', li);
    if (!b) return;
    b.getAnimations().forEach((a) => a.cancel());
    li.classList.remove('armed');
    M.animate(b, [{ transform: `translate3d(${li.dataset.side === 'left' ? '-' : ''}${li.offsetWidth}px,0,0)` }, { transform: 'translate3d(0,0,0)' }], { duration: 480 })
      .then(() => { b.getAnimations().forEach((a) => a.cancel()); b.style.transform = ''; });
  }
  Gestures.dragReorder($('#ratings'), {
    canDrag,
    onDrop: (id, from, to) => {
      const before = state.order.slice();
      state.order = R.move(state.order, id, to);
      save(); renderAll(); scheduleRecs();
      const e = scoreMapOf(state.order)[id];
      toast(`Moved to #${e.rank} · ${fmt(e.score)}`, { action: 'Undo', run: () => { state.order = before; save(); renderAll(); } });
    },
  });
  Gestures.dragReorder($('#list-songs'), {
    canDrag: () => true,
    onDrop: (id, from, to) => {
      const l = state.lists.find((x) => x.id === openListId);
      if (!l) return;
      l.songIds.splice(to, 0, ...l.songIds.splice(from, 1));
      l.updatedAt = Date.now();
      save(); renderListDetail(); renderCrates();
    },
  });
  Gestures.pullToRefresh($('#ptr'), async () => {
    if (activeView === 'home') await Promise.all([loadTrending({ fresh: true }), loadRecent(), runSearch({ fresh: true })]);
    else if (activeView === 'charts') await loadCharts({ fresh: true });
    else if (activeView === 'recs') await loadRecs();
    else if (sync.user) {
      const r = await api('/api/me', { timeout: 20000 }).catch(() => null);
      if (r && r.ok && r.data.user && r.data.version > sync.version && !sync.dirty) adoptServer(r.data.state, r.data.version);
      toast(r && r.ok ? 'Up to date' : 'Offline. Showing what’s on this device');
    } else { renderAll(); await new Promise((res) => setTimeout(res, 300)); }
  }, () => TABS.includes(activeView) && sheetWrap.hidden);

  // =====================================================================
  // Keyboard + command palette
  // =====================================================================
  document.addEventListener('keydown', (e) => {
    if (window.Palette && Palette.isOpen) return;
    const typing = e.target.closest && e.target.closest('input, textarea, select, [contenteditable]');
    if (!sheetWrap.hidden) {
      if (e.key === 'Escape') { e.preventDefault(); closeSheet(); return; }
      if (session && !session.done && !typing) {
        if (e.key === 'ArrowUp' || e.key.toLowerCase() === 'b') { e.preventDefault(); answer('better'); }
        if (e.key === 'ArrowDown' || e.key.toLowerCase() === 'w') { e.preventDefault(); answer('worse'); }
        if (e.key.toLowerCase() === 's') { e.preventDefault(); answer('same'); }
      }
      return;
    }
    if (typing) { if (e.key === 'Escape') e.target.blur(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '/') { e.preventDefault(); showView('home'); $('#search').focus(); }
    else if (e.key === ' ' && pb.song) { e.preventDefault(); togglePlay(); }
    else if (e.key === 'Escape' && stack.length) back();
  });
  Palette.init({
    art: artUrl,
    myScore: (song) => { const e = scoreMapOf(state.order)[song.id]; return e ? e.score : null; },
    searchSongs: (q) => searchSongs(q),
    onSong: (song, how) => { remember(song); if (how === 'play') playFrom(song, [song]); else if (state.order.includes(song.id)) openDetail(song); else startRating(song); },
    commands: () => [
      { label: 'Go to Home', icon: 'home', run: () => showView('home') },
      { label: 'Go to Charts', icon: 'chart', run: () => showView('charts') },
      { label: 'Go to Lists', icon: 'stack', run: () => showView('lists') },
      { label: 'Go to Recommendations', icon: 'disc', keywords: ['for you', 'suggestions'], run: () => showView('recs') },
      { label: 'Go to Profile', icon: 'user', run: () => showView('profile') },
      { label: 'New list', icon: 'plus', run: () => openNewList() },
      ...G.GENRES.map((g) => ({ label: `${g.label} chart`, icon: 'chart', keywords: ['chart', g.key], run: () => { genre = g.key; renderGenreStrip(); chartsLoaded = true; showView('charts'); loadCharts(); } })),
      { label: 'Share my Top 10', icon: 'share', run: () => openShare() },
      { label: 'Export my data', icon: 'download', run: exportData },
      ...(amConnected() ? [] : [{ label: 'Connect Apple Music', icon: 'note', run: amConnect }]),
      ...(sync.server && !sync.user ? [{ label: 'Create account', icon: 'user', run: () => openAuth('signup') }, { label: 'Sign in', icon: 'user', run: () => openAuth('login') }] : []),
    ],
  });
  $('#palette-btn').onclick = () => Palette.open();

  // =====================================================================
  // Storefront, import / export
  // =====================================================================
  const COUNTRIES = { us: 'US', gb: 'UK', ca: 'CA', au: 'AU', ie: 'IE', nz: 'NZ', de: 'DE', fr: 'FR', es: 'ES', it: 'IT', nl: 'NL', se: 'SE', br: 'BR', mx: 'MX', jp: 'JP', kr: 'KR', in: 'IN', ng: 'NG', za: 'ZA' };
  const sel = $('#country');
  sel.innerHTML = Object.entries(COUNTRIES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  sel.onchange = () => { state.country = sel.value; save(); trending = []; loadTrending(); if (activeView === 'charts') loadCharts(); else chartsLoaded = false; runSearch(); };
  function exportData() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'encore-backup.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast('Backup exported');
  }
  $('#import-file').onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!data.songs || !(data.order || data.rankings)) throw new Error('bad file');
      state = normalize(data);
      save(); afterStateChange(); toast('Backup imported');
    } catch (_) { toast('That file isn’t an Encore backup'); }
  };

  // =====================================================================
  // Rendering
  // =====================================================================
  function renderAll() {
    renderResults();
    renderTrending();
    renderTopShelf();
    renderRecent();
    renderRatings();
    renderCrates();
    renderProfile();
    renderMeButton();
    if (activeView === 'list') renderListDetail();
    if (viewing) renderUser();
    refreshPlaying();
  }

  // =====================================================================
  // Waking-up banner (Render's free plan sleeps when idle) + connect
  // =====================================================================
  function showWake(kind) {
    const w = $('#wake');
    w.className = 'wake' + (kind === 'error' ? ' error' : '');
    w.innerHTML = kind === 'waking'
      ? '<span class="vinyl"><span class="lbl"></span></span><div><b>Waking up Encore’s server</b><span>Free hosting naps when it’s quiet. This can take up to a minute. Keep browsing.</span></div>'
      : '<div><b>Can’t reach Encore’s server</b><span>Keep rating. Everything is saved on this device and syncs when the server is back.</span></div><button class="btn sm" id="wake-retry">Retry</button>';
    if (kind !== 'waking') $('#wake-retry').onclick = () => { w.hidden = true; connect(); };
    w.hidden = false;
  }
  async function connect() {
    const wakeTimer = setTimeout(() => showWake('waking'), 1200);
    let r = null;
    try { r = await api('/api/me', { timeout: 75000 }); } catch (_) { r = null; }
    clearTimeout(wakeTimer);
    const wasWaking = !$('#wake').hidden;
    $('#wake').hidden = true;
    if (r && r.json && r.ok && 'user' in r.data) {
      sync.server = true; sync.awake = true;
      const c = await api('/api/config').catch(() => null);
      if (c && c.ok) sync.config = c.data;
      if (r.data.user) { const note = signedIn(r.data.user, r.data); if (note) toast(note); }
      else if (sync.user) signedOut();
      if (wasWaking) toast('Connected');
      renderAll();
      const u = new URLSearchParams(location.search).get('u');
      if (u) openUser(u);
      afterServices();
      return;
    }
    if (r && !r.json) { sync.server = false; afterServices(); renderAll(); return; } // static hosting: guest mode
    if (sync.user || readJSON(LAST_USER)) { sync.server = true; showWake('error'); renderAll(); }
    afterServices();
  }
  /** Finish a Spotify sign-in, reconnect Apple Music if it was linked, then load listening history. */
  let servicesReady = false;
  async function afterServices() {
    if (servicesReady) return;
    servicesReady = true;
    try {
      if (await Services.Spotify.handleRedirect()) {
        state.connections.spotify = { connectedAt: Date.now(), name: Services.Spotify.profile() };
        save(); toast('Spotify connected');
      }
    } catch (err) { toast(err.message); }
    try { if (localStorage.getItem(AM_FLAG) && amPossible()) await amInit(); } catch (_) { /* stays disconnected */ }
    renderAll();
    loadRecent();
  }

  // =====================================================================
  // Boot
  // =====================================================================
  $$('[data-icon]').forEach((el) => { el.outerHTML = I[el.dataset.icon] || ''; });
  M.initImageFade();
  Charts.init({ server: () => sync.server && sync.awake, country: () => state.country, lookup: (ids) => lookupSongs(ids), resolve: resolveTrack, config: CFG });
  bindList($('#results'), (id) => lastResults.find((s) => s.id === id) || state.songs[id]);
  bindList($('#trending'), (id) => trending.find((s) => s.id === id) || state.songs[id]);
  bindList($('#recent'), (id) => recentSongs.find((s) => s.id === id) || state.songs[id]);
  bindList($('#chart-current'), (id) => chartSongs.find((s) => s.id === id) || state.songs[id]);
  bindList($('#chart-streamed'), (id) => chartSongs.find((s) => s.id === id) || state.songs[id]);
  bindList($('#ratings'), (id) => state.songs[id]);
  bindList($('#group-list'), (id) => state.songs[id] || ($('#group-list')._data && $('#group-list')._data.songs[id]), { other: () => $('#group-list')._data });
  bindList($('#list-songs'), (id) => state.songs[id], {
    onRemove: (song, li) => {
      const l = state.lists.find((x) => x.id === openListId);
      if (!l) return;
      const at = l.songIds.indexOf(song.id);
      M.flip($('#list-songs'), ':scope > li.row', () => { l.songIds.splice(at, 1); li.remove(); });
      l.updatedAt = Date.now(); save(); renderCrates();
      toast(`Removed from “${l.name}”`, { action: 'Undo', run: () => { l.songIds.splice(at, 0, song.id); save(); renderListDetail(); renderCrates(); } });
    },
  });

  (function boot() {
    const last = readJSON(LAST_USER);
    const cache = last && readJSON(accountKey(last));
    if (last && cache) { sync.user = last; sync.version = cache.version; sync.dirty = !!cache.dirty; state = normalize(cache.state); sync.server = true; }
    else state = normalize(readJSON(GUEST_KEY));
    sel.value = COUNTRIES[state.country] ? state.country : (state.country = 'us');
    renderGenreStrip();
    renderAll();
    const h = location.hash.slice(1);
    if (TABS.includes(h)) showView(h);
    loadTrending();
    refreshSongMeta();
    if (location.protocol.startsWith('http')) connect(); else afterServices();
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
  })();
})();
