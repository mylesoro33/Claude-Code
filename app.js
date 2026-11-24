/* Encore — Beli-style song ranking on top of the Apple Music catalog. */
(() => {
  'use strict';
  const R = window.Ranking;
  const M = window.Motion;
  const AC = window.AlbumColor;
  const I = window.Icons;
  const GUEST_KEY = 'encore.v1';
  const LAST_USER = 'encore.lastUser';
  const AM_FLAG = 'encore.am';
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const round1 = (x) => Math.round(x * 10) / 10;
  const BUCKET_LABEL = { liked: 'Loved it', fine: 'It was fine', disliked: "Didn't like it" };
  const BUCKET_SHORT = { liked: 'Loved', fine: 'Fine', disliked: "Didn't like" };
  const bucketForScore = (s) => (s >= 6.7 ? 'liked' : s >= 3.4 ? 'fine' : 'disliked');
  const rgbVar = (rgb) => rgb.join(',');

  // =====================================================================
  // State + persistence (guest = this browser; account = synced to server)
  // =====================================================================
  const defaultState = () => ({
    songs: {}, rankings: R.emptyRankings(), later: [], rankedAt: {}, country: guessCountry(),
  });
  const sync = { server: false, awake: false, user: null, version: 0, dirty: false, timer: null, status: '' };
  let state = defaultState();

  function guessCountry() {
    const m = (navigator.language || 'en-US').match(/-([A-Z]{2})$/i);
    return m ? m[1].toLowerCase() : 'us';
  }
  const accountKey = (u) => 'encore.user.' + u.username.toLowerCase();
  function readJSON(key) { try { return JSON.parse(localStorage.getItem(key)); } catch (_) { return null; } }
  function writeJSON(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (_) { /* full / private mode */ } }
  function removeKey(key) { try { localStorage.removeItem(key); } catch (_) { /* ignore */ } }
  const normalize = (s) => Object.assign(defaultState(), s || {});
  const rankedCount = (s) => s.rankings.liked.length + s.rankings.fine.length + s.rankings.disliked.length;

  function save() {
    if (sync.user) {
      sync.dirty = true;
      writeJSON(accountKey(sync.user), { state, version: sync.version, dirty: true });
      clearTimeout(sync.timer);
      sync.timer = setTimeout(push, 800);
      setSyncStatus('Saving…');
    } else {
      writeJSON(GUEST_KEY, state);
    }
  }

  async function api(path, opts = {}) {
    const ctrl = new AbortController();
    const timer = opts.timeout ? setTimeout(() => ctrl.abort(), opts.timeout) : 0;
    try {
      const res = await fetch(path, {
        method: opts.method || 'GET',
        credentials: 'same-origin',
        headers: opts.body ? { 'Content-Type': 'application/json' } : {},
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: ctrl.signal,
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
      } else if (r.status === 409) {
        adoptServer(r.data.state, r.data.version);
        toast('Updated with changes from another device');
      } else if (r.status === 401) {
        signedOut(); toast('You were signed out');
      } else setSyncStatus('Sync failed. Retrying soon');
    } catch (_) {
      setSyncStatus('Offline. Will sync when you reconnect');
    }
  }
  function adoptServer(serverState, version) {
    state = normalize(serverState);
    sync.version = version; sync.dirty = false;
    writeJSON(accountKey(sync.user), { state, version, dirty: false });
    setSyncStatus('Synced');
    afterStateChange();
  }
  function setSyncStatus(s) { sync.status = s; const el = $('#sync-status'); if (el) el.textContent = s; }

  /** Pick the right data once we know who is signed in. Returns a note for the welcome toast. */
  function signedIn(user, server) {
    let note = '';
    sync.user = user;
    writeJSON(LAST_USER, user);
    const cache = readJSON(accountKey(user));
    const guest = normalize(readJSON(GUEST_KEY));
    if (cache && cache.dirty && cache.version === server.version) {
      state = normalize(cache.state); sync.version = server.version; save();
    } else if (!server.state && rankedCount(guest) > 0) {
      state = guest; sync.version = server.version; save();
      note = `Moved your ${rankedCount(guest)} ranked songs into your account`;
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
    ambientDefault();
  }

  // =====================================================================
  // Apple Music public catalog (iTunes Search API), with an instant cache
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
  /** Through our server when it's awake (no CORS issues), else straight to Apple. */
  async function catalog(kind, params, { fresh = false } = {}) {
    const key = memoKey(kind, params);
    if (!fresh) { const hit = peekCatalog(kind, params); if (hit) return hit; }
    const data = await fetchCatalog(kind, params);
    memo.set(key, { t: Date.now(), data });
    if (memo.size > 80) memo.delete(memo.keys().next().value);
    return data;
  }
  async function fetchCatalog(kind, params) {
    const qs = new URLSearchParams({ ...params, country: state.country }).toString();
    if (sync.server) {
      // While the free server is still waking up, don't wait on it for long.
      try { return await getJson(`/api/catalog/${kind}?${qs}`, sync.awake ? 15000 : 3500); } catch (_) { /* fall through */ }
    }
    if (kind === 'charts') {
      try {
        return await getJson(`https://rss.marketingtools.apple.com/api/v2/${state.country}/music/most-played/50/songs.json`, 8000);
      } catch (_) {
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
      id: String(r.trackId),
      title: r.trackName, artist: r.artistName, album: r.collectionName || '',
      art: r.artworkUrl100 || r.artworkUrl60 || '',
      preview: r.previewUrl || '', url: r.trackViewUrl || '', genre: r.primaryGenreName || '',
      year: r.releaseDate ? r.releaseDate.slice(0, 4) : '', explicit: r.trackExplicitness === 'explicit',
      artistId: r.artistId ? String(r.artistId) : '', albumId: r.collectionId ? String(r.collectionId) : '',
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
    try { songs = await lookupSongs(feed.map((r) => r.id), opts); } catch (_) { /* use feed below */ }
    if (songs.length) return songs;
    return feed.map((r) => ({ id: String(r.id), title: r.name, artist: r.artistName, album: '', art: r.artworkUrl100 || '', preview: '', url: r.url || '', genre: (r.genres?.[0]?.name) || '', year: (r.releaseDate || '').slice(0, 4), explicit: false }));
  }
  function peekTopSongs() {
    const d = peekCatalog('charts', {});
    if (!d) return null;
    const ids = ((d.feed && d.feed.results) || []).map((r) => r.id);
    const l = peekCatalog('lookup', { id: ids.slice(0, 100).join(',') });
    return l ? songsFrom({ results: (l.results || []).map((r) => ({ ...r, kind: 'song' })) }) : null;
  }

  /** Fill in cover art / ids for saved songs that are missing them. */
  let refreshing = false;
  async function refreshSongMeta() {
    if (refreshing) return;
    const ids = Object.values(state.songs).filter((s) => /^\d+$/.test(s.id) && (!s.art || !s.albumId)).map((s) => s.id);
    if (!ids.length) return;
    refreshing = true;
    try {
      const fresh = await lookupSongs(ids);
      let changed = false;
      fresh.forEach((s) => { if (state.songs[s.id]) { state.songs[s.id] = { ...state.songs[s.id], ...s }; changed = true; } });
      if (changed) { save(); renderAll(); }
    } catch (_) { /* offline; try again next load */ }
    refreshing = false;
  }

  // =====================================================================
  // Cover art + album color
  // =====================================================================
  function artUrl(song, px) {
    const a = song && song.art;
    if (!a) return placeholderArt(song);
    return a.replace('{w}', px).replace('{h}', px).replace(/\/\d+x\d+(bb|cc|sr)?(\.\w+)(\?.*)?$/, `/${px}x${px}bb$2`);
  }
  function placeholderArt(song) {
    const [r, g, b] = AC.hashColor((song && (song.album || song.title)) || 'x');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="rgb(${r},${g},${b})"/><stop offset="1" stop-color="rgb(${r >> 2},${g >> 2},${b >> 2})"/></linearGradient></defs><rect width="100" height="100" fill="url(#g)"/><path d="M42 66V36l24-6v30" fill="none" stroke="rgba(255,255,255,.75)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="36" cy="66" r="7" fill="rgba(255,255,255,.75)"/><circle cx="60" cy="60" r="7" fill="rgba(255,255,255,.75)"/></svg>`;
    return 'data:image/svg+xml,' + encodeURIComponent(svg);
  }
  function artImg(song, px, { eager = false } = {}) {
    return `<img src="${esc(artUrl(song, px))}" data-ph="${esc(placeholderArt(song))}" alt="" ${eager ? '' : 'loading="lazy"'} decoding="async" width="${px}" height="${px}" />`;
  }
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (img.tagName === 'IMG' && img.dataset.ph && img.src !== img.dataset.ph) img.src = img.dataset.ph;
  }, true);
  const colorOf = (song) => AC.peek(song) || AC.hashColor((song && (song.album || song.title)) || 'x');

  /** The stage glow follows whatever you're focused on (crossfading two layers). */
  let glowFlip = false;
  let glowFor = null;
  function setAmbient(song) {
    if (!song || glowFor === song.id) return;
    glowFor = song.id;
    AC.forSong(song).then((rgb) => {
      if (glowFor !== song.id) return;
      const [a, b] = glowFlip ? [$('#glow-a'), $('#glow-b')] : [$('#glow-b'), $('#glow-a')];
      glowFlip = !glowFlip;
      a.style.setProperty('--c', rgbVar(rgb));
      a.classList.add('on'); b.classList.remove('on');
      document.documentElement.style.setProperty('--c', rgbVar(rgb));
      const meta = document.querySelector('meta[name=theme-color]');
      if (meta) meta.content = '#060609';
    });
  }
  function ambientDefault() {
    if (pb.song) return setAmbient(pb.song);
    const top = R.flatten(state.rankings)[0];
    if (top && state.songs[top.id]) return setAmbient(state.songs[top.id]);
    if (lastResults[0]) setAmbient(lastResults[0]);
  }

  // =====================================================================
  // Artist / album averages
  // =====================================================================
  const norm = (s) => String(s || '').toLowerCase().replace(/\s*[-–]\s*(single|ep)$/i, '').replace(/\s+/g, ' ').trim();
  function scoreMapOf(rankings) {
    const m = {};
    R.flatten(rankings).forEach((e) => { m[e.id] = e; });
    return m;
  }
  function groupStats(rankings, songs, kind) {
    const groups = new Map();
    for (const e of R.flatten(rankings)) {
      const s = songs[e.id];
      if (!s) continue;
      if (kind === 'album' && !s.album) continue;
      const key = kind === 'artist' ? norm(s.artist) : norm(s.album) + '|' + norm(s.artist);
      let g = groups.get(key);
      if (!g) { g = { key, kind, name: kind === 'artist' ? s.artist : s.album, artist: s.artist, entries: [], sum: 0, top: s }; groups.set(key, g); }
      g.entries.push(e); g.sum += e.score;
    }
    return [...groups.values()].map((g) => ({ ...g, count: g.entries.length, avg: round1(g.sum / g.entries.length) }));
  }
  function groupOf(rankings, songs, kind, song) {
    const key = kind === 'artist' ? norm(song.artist) : norm(song.album) + '|' + norm(song.artist);
    return groupStats(rankings, songs, kind).find((g) => g.key === key) || null;
  }
  function sortGroups(list, by) {
    return list.sort((a, b) => (by === 'count' ? b.count - a.count || b.avg - a.avg : b.avg - a.avg || b.count - a.count) || a.name.localeCompare(b.name));
  }
  function avgLine(g, label) {
    if (!g) return '';
    return `<div class="avg-line" style="--c:${rgbVar(colorOf(g.top))}">${M.ring(g.avg, { size: 40, stroke: 4, animate: true })}<span><b>${esc(g.name)}</b> ${label} average · ${g.count} song${g.count > 1 ? 's' : ''} ranked</span></div>`;
  }

  // =====================================================================
  // Rows
  // =====================================================================
  const UNDER = {
    discover: { right: [I.bookmark, 'Later'], left: ['Skip', I.skip] },
    later: { right: [I.plus, 'Rank it'], left: ['Remove', I.trash] },
  };
  function songRow(song, { entry = null, mine = null, readOnly = false, chartRank = null, grip = false, under = null } = {}) {
    const li = document.createElement('li');
    li.className = 'row';
    li.dataset.id = song.id;
    const saved = state.later.includes(song.id);
    const now = pb.song && pb.song.id === song.id;
    if (now) li.classList.add('now');
    if (now && !isPlaying(song.id)) li.classList.add('paused');
    const rank = entry ? entry.rank : chartRank;
    const sub = entry && !readOnly
      ? `<span class="verdict v-${entry.bucket}">${BUCKET_SHORT[entry.bucket]}</span> · ${esc(song.album)}`
      : `${esc(song.album)}${song.year ? ' · ' + song.year : ''}`;
    let right = '';
    if (readOnly && entry) right = M.ring(entry.score, { size: 42 });
    else if (mine) right = `<button class="icon-btn" data-act="open" aria-label="Your score ${mine.score.toFixed(1)}">${M.ring(mine.score, { size: 42 })}</button>`;
    else right = `<button class="add-btn" data-act="rank" aria-label="Rank ${esc(song.title)}">${I.plus}</button>`;
    li.innerHTML = `
      ${under ? `<div class="row-under" aria-hidden="true"><span class="u-left">${under.right[0]}${under.right[1]}</span><span class="u-right">${under.left[0]}${under.left[1]}</span></div>` : ''}
      <div class="row-body">
        ${rank != null ? `<div class="rank">${rank}</div>` : ''}
        <button class="cover" data-act="play" aria-label="Play ${esc(song.title)}">
          ${artImg(song, 120)}
          <span class="cover-play">${now && isPlaying(song.id) ? '<span class="eq"><i></i><i></i><i></i></span>' : I.play}</span>
        </button>
        <div class="meta" data-act="open">
          <div class="t1">${esc(song.title)}${song.explicit ? '<span class="e" aria-label="Explicit">E</span>' : ''}</div>
          <div class="t2">${esc(song.artist)}</div>
          <div class="t3">${sub}</div>
        </div>
        <div class="actions">
          ${right}
          ${!readOnly && !grip ? `<button class="icon-btn ${saved ? 'on' : ''}" data-act="later" aria-pressed="${saved}" aria-label="${saved ? 'Remove from Later' : 'Save for later'}">${saved ? I.bookmarkOn : I.bookmark}</button>` : ''}
          ${grip ? `<span class="grip" aria-label="Drag to re-rank" role="button">${I.grip}</span>` : ''}
        </div>
      </div>`;
    AC.paint(li, song);
    return li;
  }
  function groupRow(g, i) {
    const li = document.createElement('li');
    li.className = 'row group';
    li.dataset.key = g.key;
    li.innerHTML = `
      <div class="row-body">
        ${i != null ? `<div class="rank">${i + 1}</div>` : ''}
        <div class="cover ${g.kind === 'artist' ? 'round' : ''}" data-act="group">${artImg(g.top, 120)}</div>
        <div class="meta" data-act="group">
          <div class="t1">${esc(g.name)}</div>
          <div class="t2">${g.kind === 'album' ? esc(g.artist) + ' · ' : ''}${g.count} song${g.count > 1 ? 's' : ''} ranked</div>
          <div class="bar"><i style="--p:${g.avg / 10}"></i></div>
        </div>
        <div class="actions"><button class="icon-btn" data-act="group" aria-label="Average ${g.avg.toFixed(1)}">${M.ring(g.avg, { size: 42 })}</button></div>
      </div>`;
    AC.paint(li, g.top);
    return li;
  }
  function skeleton(ul, n = 6) {
    ul.innerHTML = Array.from({ length: n }, () => '<li class="skel" aria-hidden="true"><i class="s-cover"></i><i class="s-lines"><b></b><b></b></i><i class="s-dot"></i></li>').join('');
  }
  function stateBlock(el, { icon = 'note', title, body = '', action = null, error = false } = {}) {
    if (!title) { el.innerHTML = ''; return; }
    el.innerHTML = `<div class="state ${error ? 'error' : ''}"><div class="state-art">${I[icon] || ''}</div><h3>${esc(title)}</h3>${body ? `<p>${body}</p>` : ''}${action ? `<button class="btn primary" data-state-action>${esc(action.label)}</button>` : ''}</div>`;
    if (action) $('[data-state-action]', el).onclick = action.run;
  }

  /** Render a ranked collection (mine or someone else's) as songs, artists or albums. */
  function renderCollection(ol, data, { seg = 'songs', filter = '', bucket = 'all', sort = 'avg', readOnly = false, grip = false }) {
    ol.innerHTML = '';
    const q = filter.trim().toLowerCase();
    const match = (s) => !q || `${s.title} ${s.artist} ${s.album} ${s.genre}`.toLowerCase().includes(q);
    if (seg === 'songs') {
      const mineMap = scoreMapOf(state.rankings);
      const frag = document.createDocumentFragment();
      let n = 0;
      R.flatten(data.rankings).forEach((e) => {
        const s = data.songs[e.id];
        if (!s || (bucket !== 'all' && e.bucket !== bucket) || !match(s)) return;
        frag.appendChild(songRow(s, { entry: e, mine: readOnly ? mineMap[e.id] : e, readOnly, grip }));
        n++;
      });
      ol.appendChild(frag);
      return n;
    }
    const kind = seg === 'artists' ? 'artist' : 'album';
    const groups = sortGroups(groupStats(data.rankings, data.songs, kind).filter((g) => !q || `${g.name} ${g.artist}`.toLowerCase().includes(q)), sort);
    groups.forEach((g, i) => ol.appendChild(groupRow(g, i)));
    ol._groups = groups;
    ol._data = data;
    return groups.length;
  }

  /** Songs in the order a list shows them (the play queue for that list). */
  const listSongs = (ul, lookup) => $$(':scope > li.row[data-id]', ul).map((li) => lookup(li.dataset.id)).filter(Boolean);

  function bindList(ul, lookup, getData) {
    ul.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const li = e.target.closest('li.row');
      if (!li) return;
      if (btn.dataset.act === 'group') {
        const g = (ul._groups || []).find((x) => x.key === li.dataset.key);
        if (g) openGroup(g, ul._data || mineData(), $('.cover', li));
        return;
      }
      const song = lookup(li.dataset.id);
      if (!song) return;
      const act = btn.dataset.act;
      if (act === 'play') playFrom(song, listSongs(ul, lookup));
      else if (act === 'rank') startRanking(song);
      else if (act === 'later') toggleLater(song, btn);
      else if (act === 'open') openDetail(song, getData ? getData() : null);
    });
  }
  const mineData = () => ({ rankings: state.rankings, songs: state.songs, mine: true });

  // =====================================================================
  // Discover
  // =====================================================================
  let lastResults = [];
  let searchTimer = null;
  let searchSeq = 0;
  let source = 'charts';
  const skipped = new Set();

  function resultsTitle(term) {
    return term ? `Results for “${term}”` : { charts: 'Top songs right now', recent: 'Recently played on Apple Music', library: 'Your Apple Music library' }[source];
  }
  async function loadResults({ fresh = false } = {}) {
    const term = $('#search').value.trim();
    const seq = ++searchSeq;
    const stateEl = $('#results-state');
    $('#results-title').textContent = resultsTitle(term);
    // Instant path: a repeat search renders synchronously from cache.
    const cached = fresh ? null : term ? (peekCatalog('search', { term }) && songsFrom(peekCatalog('search', { term }))) : source === 'charts' ? peekTopSongs() : null;
    if (cached && cached.length) { showResults(cached, term); return; }
    stateBlock(stateEl, {});
    skeleton($('#results'));
    let songs = [];
    try {
      if (term) songs = await searchSongs(term, { fresh });
      else if (source === 'recent') songs = await amRecent();
      else if (source === 'library') songs = await amLibrary();
      else songs = await topSongs({ fresh });
    } catch (err) {
      if (seq !== searchSeq) return;
      $('#results').innerHTML = '';
      lastResults = [];
      stateBlock(stateEl, {
        icon: 'signal', error: true,
        title: source !== 'charts' && !term ? 'Apple Music didn’t answer' : 'Can’t reach Apple Music',
        body: source !== 'charts' && !term ? 'Try reconnecting Apple Music in Profile.' : 'Check your connection, then try again.',
        action: { label: 'Try again', run: () => loadResults({ fresh: true }) },
      });
      return;
    }
    if (seq !== searchSeq) return;
    showResults(songs, term);
  }
  function showResults(songs, term) {
    lastResults = songs.filter((s) => !skipped.has(s.id));
    songs.forEach((s) => { if (state.songs[s.id]) state.songs[s.id] = { ...state.songs[s.id], ...s }; });
    renderResults();
    if (!pb.song && !R.flatten(state.rankings).length && lastResults[0]) setAmbient(lastResults[0]);
    stateBlock($('#results-state'), lastResults.length ? {} : term
      ? { icon: 'search', title: 'No songs found', body: `Nothing on Apple Music matches “${esc(term)}”. Check the spelling or try the artist’s name.` }
      : { icon: 'note', title: 'Nothing here yet', body: 'Search for any song on Apple Music to start ranking.' });
  }
  function renderResults() {
    const ul = $('#results');
    ul.innerHTML = '';
    const mine = scoreMapOf(state.rankings);
    const charts = !$('#search').value.trim() && source === 'charts';
    const frag = document.createDocumentFragment();
    lastResults.forEach((s, i) => frag.appendChild(songRow(s, { mine: mine[s.id], chartRank: charts ? i + 1 : null, under: UNDER.discover })));
    ul.appendChild(frag);
    M.fillRings(ul);
  }
  const remember = (song) => { state.songs[song.id] = { ...(state.songs[song.id] || {}), ...song }; };

  function skipResult(li) {
    const id = li.dataset.id;
    skipped.add(id);
    const ul = $('#results');
    M.flip(ul, ':scope > li.row', () => { lastResults = lastResults.filter((s) => s.id !== id); li.remove(); });
    toast('Skipped', { action: 'Undo', run: () => { skipped.delete(id); loadResults(); } });
  }

  // =====================================================================
  // My List / Later / Profile
  // =====================================================================
  const listUI = { seg: 'songs', bucket: 'all', sort: 'avg' };
  const canDrag = () => listUI.seg === 'songs' && listUI.bucket === 'all' && !$('#list-filter').value.trim() && rankedCount(state) > 1;
  function renderRanked() {
    const n = rankedCount(state);
    $('#list-count').textContent = n ? String(n) : '';
    $('#bucket-chips').hidden = listUI.seg !== 'songs' || !n;
    $('#group-sort').hidden = listUI.seg === 'songs' || !n;
    $('#list-filter').hidden = !n;
    $('#list-seg').hidden = !n;
    $('#drag-hint').hidden = !canDrag();
    const shown = renderCollection($('#ranked'), mineData(), { ...listUI, filter: $('#list-filter').value, grip: canDrag() });
    const st = $('#ranked-state');
    if (!n) stateBlock(st, { icon: 'podium', title: 'Your list starts with one song', body: 'Find a song in Discover and tap <b>+</b>. A few quick “which do you like more?” picks place it, and every song gets a score.', action: { label: 'Find a song', run: () => { showView('discover'); $('#search').focus(); } } });
    else if (!shown) stateBlock(st, { icon: 'search', title: 'No matches', body: 'Nothing in your rankings matches that filter.' });
    else stateBlock(st, {});
    if (activeView === 'list') M.fillRings($('#ranked'));
  }

  function toggleLater(song, btn) {
    remember(song);
    const i = state.later.indexOf(song.id);
    const adding = i < 0;
    if (adding) state.later.unshift(song.id); else state.later.splice(i, 1);
    save();
    // Optimistic: flip the button in place, then refresh other lists quietly.
    if (btn) {
      btn.classList.toggle('on', adding);
      btn.innerHTML = adding ? I.bookmarkOn : I.bookmark;
      btn.setAttribute('aria-pressed', adding);
      btn.classList.remove('pop'); void btn.offsetWidth; btn.classList.add('pop');
    }
    M.haptic(adding ? [8, 30, 8] : 6);
    toast(adding ? 'Saved to Later' : 'Removed from Later', { action: 'Undo', run: () => toggleLater(song) });
    renderLater(); renderProfile();
    if (!btn) renderResults();
  }
  function renderLater() {
    const ul = $('#later');
    ul.innerHTML = '';
    const mine = scoreMapOf(state.rankings);
    state.later.forEach((id) => { const s = state.songs[id]; if (s) ul.appendChild(songRow(s, { mine: mine[id], under: UNDER.later })); });
    $('#later-count').textContent = state.later.length ? String(state.later.length) : '';
    $('#later-hint').hidden = !state.later.length;
    stateBlock($('#later-state'), state.later.length ? {} : { icon: 'bookmark', title: 'Nothing saved yet', body: 'Swipe a song right in Discover, or tap its bookmark, to save it here for later.' });
  }
  function removeLater(li) {
    const id = li.dataset.id;
    const at = state.later.indexOf(id);
    M.flip($('#later'), ':scope > li.row', () => { state.later = state.later.filter((x) => x !== id); li.remove(); });
    save();
    $('#later-count').textContent = state.later.length ? String(state.later.length) : '';
    if (!state.later.length) renderLater();
    toast('Removed from Later', { action: 'Undo', run: () => { state.later.splice(at, 0, id); save(); renderLater(); } });
  }

  // ---------- Taste Profile ----------
  function renderTaste() {
    const el = $('#taste');
    const entries = R.flatten(state.rankings);
    const n = entries.length;
    const top = entries[0] && state.songs[entries[0].id];
    if (top) AC.paint(el, top);
    const head = `<div class="card-head"><h3>${I.sparkle}Taste Profile</h3>${n ? `<button class="btn" id="share-btn">${I.share}Share Top ${Math.min(10, n)}</button>` : ''}</div>`;
    if (!n) { el.innerHTML = head + '<p class="taste-empty">Rank a few songs and your score spread, favorite genres and artist averages show up here.</p>'; return; }
    const avg = entries.reduce((a, e) => a + e.score, 0) / n;
    const loved = state.rankings.liked.length;
    const artists = groupStats(state.rankings, state.songs, 'artist');
    const albums = groupStats(state.rankings, state.songs, 'album');
    // Score distribution: 10 one-point bins.
    const bins = new Array(10).fill(0);
    entries.forEach((e) => { bins[Math.min(9, Math.floor(e.score))]++; });
    const maxBin = Math.max(...bins, 1);
    // Genres by count.
    const gm = new Map();
    entries.forEach((e) => { const g = state.songs[e.id]?.genre; if (!g) return; const x = gm.get(g) || { n: 0, sum: 0 }; x.n++; x.sum += e.score; gm.set(g, x); });
    const genres = [...gm.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 5);
    const maxG = genres.length ? genres[0][1].n : 1;
    const byArtist = sortGroups(artists.slice(), 'avg').sort((a, b) => Math.min(b.count, 3) - Math.min(a.count, 3) || b.avg - a.avg).slice(0, 6);
    el.innerHTML = `${head}
      <div class="stat-row">
        <div class="stat"><b>${n}</b><span>Ranked</span></div>
        <div class="stat"><b>${avg.toFixed(1)}</b><span>Avg score</span></div>
        <div class="stat"><b>${Math.round((loved / n) * 100)}%</b><span>Loved</span></div>
        <div class="stat desk-only"><b>${artists.length}</b><span>Artists</span></div>
        <div class="stat desk-only"><b>${albums.length}</b><span>Albums</span></div>
      </div>
      <div class="taste-grid">
        <div>
          <h4><span>Score distribution</span><span>${n} songs</span></h4>
          <div class="dist" role="img" aria-label="Songs per score: ${bins.map((c, i) => `${i} to ${i + 1}: ${c}`).join(', ')}">
            ${bins.map((c, i) => `<div class="col"><i class="${bucketForScore(i + 0.5)}" data-p="${c / maxBin}"></i>${c ? `<b data-p="${c / maxBin}">${c}</b>` : ''}</div>`).join('')}
          </div>
          <div class="dist-axis">${bins.map((_, i) => `<span>${i}</span>`).join('')}</div>
          <h4><span>Top genres</span><span>songs · avg</span></h4>
          <div class="hbars">${genres.map(([name, x]) => `<div class="hbar"><span class="name">${esc(name)}</span><span class="val">${x.n}<small>${(x.sum / x.n).toFixed(1)}</small></span><span class="track"><i data-p="${x.n / maxG}"></i></span></div>`).join('') || '<p class="taste-empty">No genre info yet.</p>'}</div>
        </div>
        <div>
          <h4><span>Average by artist</span><span>score</span></h4>
          <div class="hbars">${byArtist.map((g) => `<div class="hbar" data-group-key="${esc(g.key)}" style="--c:${rgbVar(colorOf(g.top))};cursor:pointer"><span class="name">${esc(g.name)} <small class="muted">· ${g.count}</small></span><span class="val">${g.avg.toFixed(1)}</span><span class="track"><i data-p="${g.avg / 10}"></i></span></div>`).join('')}</div>
        </div>
      </div>`;
    el._artists = byArtist;
    if (activeView === 'profile') growBars(el);
  }
  /** Bars render empty, then grow (transform: scale) once visible. */
  function growBars(root) {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      $$('[data-p]', root).forEach((b) => b.style.setProperty('--p', b.dataset.p));
    }));
  }

  function renderProfile() {
    renderAccountCard();
    renderTaste();
    renderAmCard();
  }

  function renderAll() {
    renderResults();
    renderRanked();
    renderLater();
    renderProfile();
    renderAccountButton();
    if (viewing) renderUser();
  }

  // =====================================================================
  // Accounts UI
  // =====================================================================
  function initials(name) { return esc((name || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase()); }
  function renderAccountButton() {
    const b = $('#account-btn');
    b.hidden = !sync.server;
    b.classList.toggle('has-avatar', !!sync.user);
    if (sync.user) { b.innerHTML = `<span class="avatar">${initials(sync.user.displayName)}</span>`; b.title = '@' + sync.user.username; b.setAttribute('aria-label', 'Your profile'); }
    else { b.textContent = 'Sign in'; b.title = ''; b.removeAttribute('aria-label'); }
  }
  function renderAccountCard() {
    const el = $('#account-card');
    $('#people-box').hidden = !sync.server;
    if (!sync.server) {
      el.innerHTML = `<h3>${I.user}Your list lives on this device</h3><p>Accounts, syncing across devices and shareable profiles need the Encore server. Run <code>npm start</code> to turn them on.</p>`;
      return;
    }
    if (!sync.user) {
      el.innerHTML = `<h3>${I.user}Save your list everywhere</h3><p>You’re ranking as a guest, so your list only lives in this browser. Create an account to sync it across devices and share your rankings.</p>
        <div class="row-buttons"><button class="btn primary" data-auth="signup">Create account</button><button class="btn" data-auth="login">Sign in</button></div>`;
      return;
    }
    const link = `${location.origin}${location.pathname}?u=${encodeURIComponent(sync.user.username)}`;
    el.innerHTML = `
      <div class="user-head"><div class="avatar big">${initials(sync.user.displayName)}</div>
        <div style="min-width:0"><h3 style="overflow-wrap:anywhere">${esc(sync.user.displayName)}</h3><div class="muted small">@${esc(sync.user.username)} · <span id="sync-status">${esc(sync.status || 'Synced')}</span></div></div></div>
      <label class="toggle"><span>Public profile<br /><small class="muted">Anyone with your link can see your rankings</small></span><span class="switch"><input type="checkbox" id="public-toggle" ${sync.user.isPublic ? 'checked' : ''} /><i></i></span></label>
      <div class="row-buttons" style="margin-top:var(--s-2)">
        ${sync.user.isPublic ? `<button class="btn" data-copy="${esc(link)}">${I.share}Copy profile link</button>` : ''}
        <button class="btn" data-auth="rename">Edit name</button>
        <button class="btn ghost" data-auth="logout">Sign out</button>
      </div>`;
  }
  $('#account-card').addEventListener('click', async (e) => {
    const a = e.target.closest('[data-auth]');
    const c = e.target.closest('[data-copy]');
    if (c) {
      try { await navigator.clipboard.writeText(c.dataset.copy); toast('Link copied'); }
      catch (_) { openSheet(`<p class="kicker">Your profile link</p><h3 class="prompt">Copy this link</h3><input class="input" readonly value="${esc(c.dataset.copy)}" onclick="this.select()" />`); }
      return;
    }
    if (!a) return;
    const act = a.dataset.auth;
    if (act === 'login' || act === 'signup') openAuth(act);
    if (act === 'logout') { await api('/api/logout', { method: 'POST', body: {} }).catch(() => {}); signedOut(); toast('Signed out'); }
    if (act === 'rename') openRename();
  });
  $('#account-card').addEventListener('change', async (e) => {
    if (e.target.id !== 'public-toggle') return;
    const want = e.target.checked;
    sync.user = { ...sync.user, isPublic: want }; // optimistic
    renderAccountCard();
    const r = await api('/api/me', { method: 'PATCH', body: { isPublic: want } }).catch(() => ({ ok: false }));
    if (r.ok) { sync.user = r.data.user; toast(want ? 'Your profile is public' : 'Your profile is private'); }
    else { sync.user = { ...sync.user, isPublic: !want }; toast('Couldn’t change that. Try again'); }
    writeJSON(LAST_USER, sync.user);
    renderAccountCard();
  });
  $('#account-btn').onclick = () => (sync.user ? showView('profile') : openAuth('login'));

  function openRename() {
    openSheet(`<p class="kicker">Profile</p><h3 class="prompt">Edit your name</h3>
      <form class="auth-form" id="rename-form"><label>Display name<input class="input" name="displayName" maxlength="40" value="${esc(sync.user.displayName)}" required /></label>
      <button class="btn primary wide" type="submit">Save</button></form>`);
    $('#rename-form').onsubmit = async (e) => {
      e.preventDefault();
      const name = new FormData(e.target).get('displayName');
      closeSheet();
      const r = await api('/api/me', { method: 'PATCH', body: { displayName: name } }).catch(() => ({ ok: false }));
      if (r.ok) { sync.user = r.data.user; writeJSON(LAST_USER, sync.user); renderAll(); toast('Name updated'); } else toast('Couldn’t save your name');
    };
  }

  function openAuth(mode) {
    const signup = mode === 'signup';
    openSheet(`
      <p class="kicker">${signup ? 'Create your account' : 'Welcome back'}</p>
      <h3 class="prompt">${signup ? 'Keep your list everywhere' : 'Sign in to Encore'}</h3>
      <form class="auth-form" id="auth-form">
        ${signup ? '<label>Name<input class="input" name="displayName" autocomplete="name" maxlength="40" placeholder="What friends call you" /></label>' : ''}
        <label>Username<input class="input" name="username" autocomplete="username" autocapitalize="none" required minlength="3" maxlength="24" pattern="[A-Za-z0-9_.]+" /></label>
        <label>Password<input class="input" name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" required minlength="${signup ? 8 : 1}" /></label>
        <p class="form-error" id="auth-error" hidden></p>
        <button class="btn primary wide" type="submit">${signup ? 'Create account' : 'Sign in'}</button>
      </form>
      <p class="center small muted">${signup ? 'Already have an account?' : 'New to Encore?'} <a href="#" data-switch="${signup ? 'login' : 'signup'}">${signup ? 'Sign in' : 'Create one'}</a></p>`);
    setTimeout(() => $('#sheet-body input')?.focus(), 350);
    $('[data-switch]').onclick = (e) => { e.preventDefault(); openAuth(e.target.dataset.switch); };
    $('#auth-form').onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      const btn = e.target.querySelector('button');
      btn.disabled = true;
      btn.textContent = signup ? 'Creating…' : 'Signing in…';
      const r = await api(signup ? '/api/signup' : '/api/login', { method: 'POST', body: f, timeout: 70000 }).catch(() => ({ ok: false, data: { error: 'Can’t reach the server. Check your connection.' } }));
      btn.disabled = false;
      btn.textContent = signup ? 'Create account' : 'Sign in';
      if (!r.ok) { const er = $('#auth-error'); er.textContent = r.data.error || 'Something went wrong. Try again.'; er.hidden = false; M.haptic([10, 40, 10]); return; }
      closeSheet();
      const note = signedIn(r.data.user, r.data);
      toast((signup ? `Welcome, ${r.data.user.displayName}!` : `Signed in as @${r.data.user.username}`) + (note ? ' ' + note + '.' : ''));
    };
  }

  // ----- Other people's profiles -----
  let viewing = null;
  const userUI = { seg: 'songs' };
  async function openUser(username) {
    const r = await api('/api/users/' + encodeURIComponent(username)).catch(() => ({ ok: false }));
    if (!r.ok) { toast('That profile is private or doesn’t exist'); return; }
    viewing = { ...r.data, mine: false };
    userUI.seg = 'songs';
    setSeg($('#user-seg'), 'songs');
    renderUser();
    showView('user', { mode: 'push' });
  }
  function renderUser() {
    const u = viewing.user;
    $('#user-avatar').innerHTML = initials(u.displayName);
    $('#user-name').textContent = u.displayName;
    const n = rankedCount(viewing);
    const mine = scoreMapOf(state.rankings);
    const common = R.flatten(viewing.rankings).filter((e) => mine[e.id]);
    $('#user-sub').textContent = `@${u.username} · ${n} songs ranked${common.length ? ` · ${common.length} in common` : ''}`;
    let match = '';
    if (common.length >= 3) {
      const diff = common.reduce((a, e) => a + Math.abs(e.score - mine[e.id].score), 0) / common.length;
      match = `<span class="match">${I.sparkle}${Math.max(0, Math.round(100 - diff * 10))}% taste match</span>`;
    }
    $('#user-match').innerHTML = match;
    const shown = renderCollection($('#user-list'), viewing, { seg: userUI.seg, readOnly: true });
    stateBlock($('#user-state'), shown ? {} : { icon: 'podium', title: `${u.displayName} hasn’t ranked anything yet` });
    M.fillRings($('#user-list'));
  }
  let peopleTimer;
  $('#people-search').addEventListener('input', (e) => {
    clearTimeout(peopleTimer);
    peopleTimer = setTimeout(async () => {
      const q = e.target.value.trim();
      const ul = $('#people-results');
      if (!q) { ul.innerHTML = ''; return; }
      const r = await api('/api/users?q=' + encodeURIComponent(q)).catch(() => ({ ok: false }));
      const users = (r.ok && r.data.users) || [];
      ul.innerHTML = users.length
        ? users.map((u) => `<li data-user="${esc(u.username)}" tabindex="0"><span class="avatar">${initials(u.displayName)}</span><div><b>${esc(u.displayName)}</b><div class="muted small">@${esc(u.username)} · ${u.ranked} ranked</div></div><span class="chev">${I.chevron}</span></li>`).join('')
        : '<li class="muted small" style="cursor:default">No public profiles match.</li>';
    }, 220);
  });
  $('#people-results').addEventListener('click', (e) => { const li = e.target.closest('[data-user]'); if (li) openUser(li.dataset.user); });
  $('#people-results').addEventListener('keydown', (e) => { const li = e.target.closest('[data-user]'); if (li && e.key === 'Enter') openUser(li.dataset.user); });

  // =====================================================================
  // Apple Music account linking (MusicKit JS)
  // =====================================================================
  const am = { music: null, devToken: null, loading: null, error: '' };
  const amConnected = () => !!(am.music && am.music.isAuthorized);

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.async = true; s.onload = resolve; s.onerror = () => reject(new Error('Could not load MusicKit'));
      document.head.appendChild(s);
    });
  }
  function amInit() {
    if (am.loading) return am.loading;
    am.loading = (async () => {
      if (!sync.server) throw new Error('Connecting Apple Music needs the Encore server.');
      const r = await api('/api/apple/developer-token');
      if (!r.ok) throw new Error(r.data.error || 'Apple Music is not configured on this server.');
      am.devToken = r.data.token;
      if (!window.MusicKit) {
        const ready = new Promise((res) => document.addEventListener('musickitloaded', res, { once: true }));
        await loadScript('https://js-cdn.music.apple.com/musickit/v3/musickit.js');
        if (!window.MusicKit) await ready;
      }
      am.music = await MusicKit.configure({ developerToken: am.devToken, app: { name: 'Encore', build: '3.0' } });
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
      if (music.storefrontId && music.storefrontId !== state.country) { state.country = music.storefrontId; $('#country').value = state.country; save(); }
      am.error = '';
      toast('Apple Music connected');
    } catch (err) {
      am.error = err && err.message ? err.message : 'Could not connect Apple Music';
      toast(am.error);
    }
    renderAmUI();
  }
  async function amDisconnect() {
    try { await am.music?.unauthorize(); } catch (_) { /* ignore */ }
    removeKey(AM_FLAG);
    if (source !== 'charts') setSource('charts');
    renderAmUI();
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
      id: String(r.id), title: a.name, artist: a.artistName, album: a.albumName || '',
      art: a.artwork && a.artwork.url ? a.artwork.url : '',
      preview: (a.previews && a.previews[0] && a.previews[0].url) || '', url: a.url || '',
      genre: (a.genreNames || []).find((g) => g !== 'Music') || '', year: (a.releaseDate || '').slice(0, 4),
      explicit: a.contentRating === 'explicit', artistId: '', albumId: '',
    };
  }
  async function amRecent() {
    const d = await amFetch('/v1/me/recent/played/tracks?types=songs&limit=30');
    const seen = new Set();
    return (d.data || []).filter((r) => r.type === 'songs' && !seen.has(r.id) && seen.add(r.id)).map(amToSong);
  }
  async function amLibrary() {
    const out = [];
    let nextPage = '/v1/me/library/songs?limit=100&include=catalog';
    for (let page = 0; nextPage && page < 3; page++) {
      const d = await amFetch(nextPage);
      (d.data || []).forEach((r) => { const c = r.relationships?.catalog?.data?.[0]; if (c && c.attributes) out.push(amToSong(c)); });
      nextPage = d.next ? d.next + (d.next.includes('include=') ? '' : '&include=catalog') : null;
    }
    return out;
  }
  async function amExportPlaylist(n = 25) {
    const ids = R.flatten(state.rankings).slice(0, n).map((e) => e.id).filter((id) => /^\d+$/.test(id));
    if (!ids.length) { toast('Rank some songs first'); return; }
    try {
      await amFetch('/v1/me/library/playlists', { method: 'POST', body: {
        attributes: { name: `Encore Top ${ids.length}`, description: 'My highest-ranked songs on Encore' },
        relationships: { tracks: { data: ids.map((id) => ({ id, type: 'songs' })) } },
      } });
      toast(`“Encore Top ${ids.length}” is in your Apple Music library`);
    } catch (_) { toast('Couldn’t create the playlist. Try again'); }
  }
  function renderAmUI() {
    $$('.am-only').forEach((el) => { el.hidden = !amConnected(); });
    renderAmCard();
  }
  function renderAmCard() {
    const el = $('#am-card');
    if (amConnected()) {
      el.innerHTML = `<div class="card-head"><h3><span class="badge-am">${I.note}</span>Apple Music</h3><span class="match">${I.check}Connected</span></div>
        <p>Rank from your recently played songs and library in Discover, hear full songs with your subscription, and save your top songs as a playlist.</p>
        <div class="row-buttons"><button class="btn primary" data-am="playlist">Save Top 25 as playlist</button><button class="btn ghost" data-am="disconnect">Disconnect</button></div>`;
    } else {
      el.innerHTML = `<h3><span class="badge-am">${I.note}</span>Apple Music</h3>
        <p>Link your account to rank from your library and recently played songs, hear full songs instead of previews, and export your list as a playlist.</p>
        ${am.error ? `<p class="form-error" style="margin-top:var(--s-3)">${esc(am.error)}</p>` : ''}
        <div class="row-buttons"><button class="btn primary" data-am="connect" style="--c:250,45,85">Connect Apple Music</button></div>`;
    }
  }
  $('#am-card').addEventListener('click', (e) => {
    const b = e.target.closest('[data-am]');
    if (!b) return;
    if (b.dataset.am === 'connect') amConnect();
    if (b.dataset.am === 'disconnect') amDisconnect();
    if (b.dataset.am === 'playlist') amExportPlaylist();
  });

  // =====================================================================
  // Playback: queue + crossfading previews (or full songs via Apple Music)
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
    setAmbient(song);
    renderMini(dir);
    if (amConnected() && /^\d+$/.test(song.id)) {
      try {
        AE.stop();
        pb.full = true;
        await am.music.setQueue({ song: song.id, startPlaying: true });
        refreshPlaying();
        return;
      } catch (_) { pb.full = false; /* not a subscriber → preview */ }
    }
    if (am.music) { try { am.music.stop(); } catch (_) { /* ignore */ } }
    pb.full = false;
    if (!song.preview) { toast('No preview for this song'); refreshPlaying(); return; }
    AE.play(song).catch(() => toast('Couldn’t play this preview'));
    refreshPlaying();
  }
  function togglePlay() {
    if (!pb.song) return;
    if (pb.full) { musicPlaying() ? am.music.pause() : am.music.play(); }
    else AE.toggle();
    M.haptic(6);
  }
  function next() { if (pb.index < pb.queue.length - 1) { pb.index++; startSong(pb.queue[pb.index], 1); } else if (pb.full) refreshPlaying(); }
  function prev() { if (pb.index > 0) { pb.index--; startSong(pb.queue[pb.index], -1); } }
  AE.on('state', (s) => { refreshPlaying(); if (s === 'ended') next(); if (s === 'error') toast('This preview couldn’t load'); });

  function refreshPlaying() {
    const id = pb.song && pb.song.id;
    $$('li.row[data-id]').forEach((li) => {
      const now = li.dataset.id === id;
      const playing = now && isPlaying(id);
      li.classList.toggle('now', now);
      li.classList.toggle('paused', now && !playing);
      const cp = $('.cover-play', li);
      if (cp) {
        const want = playing ? 'eq' : 'play';
        if (cp.dataset.s !== want) { cp.dataset.s = want; cp.innerHTML = playing ? '<span class="eq"><i></i><i></i><i></i></span>' : I.play; }
      }
    });
    $$('#sheet-body .art-play').forEach((b) => { b.innerHTML = isPlaying(b.dataset.id) ? I.pause : I.play; });
    const t = $('#mini-toggle');
    const playing = id && isPlaying(id);
    t.innerHTML = playing ? I.pause : I.play;
    t.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    $('#mini-next').disabled = !(pb.index < pb.queue.length - 1);
  }
  function renderMini(dir) {
    const mini = $('#mini');
    const s = pb.song;
    if (!s) { mini.hidden = true; document.body.classList.remove('has-mini'); return; }
    mini.hidden = false;
    document.body.classList.add('has-mini');
    AC.paint(mini, s);
    $('#mini-art').innerHTML = artImg(s, 120, { eager: true });
    const meta = $('#mini-meta');
    meta.innerHTML = `<div class="t1">${esc(s.title)}</div><div class="t3">${esc(s.artist)} · ${pb.full ? 'Apple Music' : 'Preview'}</div>`;
    meta.classList.remove('slide-l', 'slide-r');
    if (dir) { void meta.offsetWidth; meta.classList.add(dir > 0 ? 'slide-l' : 'slide-r'); }
  }
  $('#mini-toggle').onclick = togglePlay;
  $('#mini-next').onclick = () => { next(); M.haptic(6); };
  $('#mini-art').onclick = () => pb.song && openDetail(pb.song);
  $('#mini-meta').onclick = () => pb.song && openDetail(pb.song);
  AE.attachWave($('#mini-wave'), () => (pb.song ? colorOf(pb.song) : [255, 92, 138]));
  // Swipe the mini player to skip.
  (function miniSwipe() {
    const mini = $('#mini');
    let x0 = null, dx = 0, id = null, moved = false;
    mini.addEventListener('pointerdown', (e) => { if (e.target.closest('#mini-toggle, #mini-next')) return; x0 = e.clientX; dx = 0; id = e.pointerId; moved = false; });
    mini.addEventListener('pointermove', (e) => {
      if (x0 == null || e.pointerId !== id) return;
      dx = e.clientX - x0;
      if (!moved && Math.abs(dx) > 10) { moved = true; mini.setPointerCapture(id); }
      if (moved) $('#mini-meta').style.transform = `translateX(${dx * 0.6}px)`;
      if (moved) $('#mini-meta').style.opacity = String(1 - Math.min(0.6, Math.abs(dx) / 200));
    });
    const end = () => {
      if (x0 == null) return;
      x0 = null;
      const meta = $('#mini-meta');
      meta.style.transform = ''; meta.style.opacity = '';
      if (!moved) return;
      mini.addEventListener('click', (ev) => { ev.stopPropagation(); ev.preventDefault(); }, { capture: true, once: true });
      if (dx < -60 && pb.index < pb.queue.length - 1) { M.haptic(10); next(); }
      else if (dx > 60 && pb.index > 0) { M.haptic(10); prev(); }
    };
    mini.addEventListener('pointerup', end);
    mini.addEventListener('pointercancel', end);
  })();

  // =====================================================================
  // Sheet
  // =====================================================================
  const sheetWrap = $('#sheet');
  const sheet = $('.sheet', sheetWrap);
  const body = $('#sheet-body');
  let session = null;
  let sheetReturnFocus = null;
  function openSheet(html, { song = null } = {}) {
    body.innerHTML = html;
    if (song) AC.paint(sheet, song); else sheet.style.removeProperty('--c');
    if (sheetWrap.hidden) {
      sheetReturnFocus = document.activeElement;
      sheetWrap.hidden = false;
      document.body.classList.add('no-scroll');
      requestAnimationFrame(() => requestAnimationFrame(() => sheetWrap.classList.add('in')));
    }
    sheet.scrollTop = 0;
    M.fillRings(body, { delay: 220 });
    setTimeout(() => { if (!sheet.contains(document.activeElement)) $('button, input, a', body)?.focus({ preventScroll: true }); }, 60);
  }
  function closeSheet() {
    if (sheetWrap.hidden) return;
    session = null;
    sheetWrap.classList.remove('in');
    document.body.classList.remove('no-scroll');
    setTimeout(() => { if (!sheetWrap.classList.contains('in')) { sheetWrap.hidden = true; body.innerHTML = ''; } }, 320);
    if (sheetReturnFocus && sheetReturnFocus.isConnected) sheetReturnFocus.focus({ preventScroll: true });
  }
  sheetWrap.addEventListener('click', (e) => { if (e.target.closest('[data-dismiss]')) closeSheet(); });
  // Drag the grab handle down to dismiss.
  (function sheetDrag() {
    const grab = $('#sheet-grab');
    let y0 = null, dy = 0;
    grab.addEventListener('pointerdown', (e) => { y0 = e.clientY; dy = 0; grab.setPointerCapture(e.pointerId); sheet.classList.add('dragging'); });
    grab.addEventListener('pointermove', (e) => { if (y0 == null) return; dy = Math.max(0, e.clientY - y0); sheet.style.transform = `translate3d(0, ${dy}px, 0)`; });
    const end = () => {
      if (y0 == null) return;
      y0 = null; sheet.classList.remove('dragging'); sheet.style.transform = '';
      if (dy > 110) closeSheet();
    };
    grab.addEventListener('pointerup', end);
    grab.addEventListener('pointercancel', end);
  })();

  function featureArt(song) {
    return `<div class="feature-art">${artImg(song, 600, { eager: true })}${song.preview || amConnected() ? `<button class="art-play" data-act="play" data-id="${esc(song.id)}" aria-label="Play ${esc(song.title)}">${isPlaying(song.id) ? I.pause : I.play}</button>` : ''}</div>`;
  }
  function sheetBg(song) { return `<div class="sheet-bg" aria-hidden="true">${artImg(song, 120, { eager: true })}</div>`; }

  // =====================================================================
  // Ranking flow (the Beli part)
  // =====================================================================
  function startRanking(song) {
    remember(song);
    session = { song, stage: 'react' };
    const current = R.bucketOf(state.rankings, song.id);
    openSheet(`${sheetBg(song)}
      <div class="sheet-step">
        <p class="kicker">${current ? 'Re-rank' : 'Rank a song'}</p>
        <div class="feature" style="margin-top:var(--s-4)">${featureArt(song)}<h2 class="display">${esc(song.title)}</h2><div class="t2">${esc(song.artist)}</div></div>
        <h3 class="prompt" style="margin-top:var(--s-6)">How did it land?</h3>
        <div class="reactions">
          <button class="react liked" data-bucket="liked">${I.heart}I loved it</button>
          <button class="react fine" data-bucket="fine">${I.meh}It was fine</button>
          <button class="react disliked" data-bucket="disliked">${I.thumbDown}Not for me</button>
        </div>
      </div>`, { song });
    setAmbient(song);
  }
  function pickBucket(bucket) {
    M.haptic(8);
    const s = R.startPlacement(state.rankings, bucket, session.song.id);
    Object.assign(session, { stage: 'compare', placement: s, total: R.maxSteps(s.list.length) });
    step();
  }
  function duelCard(song, act) {
    return `<div class="duel" data-choose="${act}" data-id="${esc(song.id)}" role="button" tabindex="0" style="--c:${rgbVar(colorOf(song))}" aria-label="I like ${esc(song.title)} more">
      ${featureArt(song)}<div class="t1">${esc(song.title)}</div><div class="t2">${esc(song.artist)}</div></div>`;
  }
  function step() {
    const p = session.placement;
    const oppId = R.nextOpponent(p);
    if (!oppId) return finish();
    const opp = state.songs[oppId];
    const bars = Array.from({ length: session.total }, (_, i) => `<i class="${i < p.steps ? 'done' : ''}"></i>`).join('');
    body.innerHTML = `${sheetBg(session.song)}
      <div class="sheet-step">
        <p class="kicker">${BUCKET_LABEL[p.bucket]} · pick ${p.steps + 1} of up to ${session.total}</p>
        <h3 class="prompt">Which do you like more?</h3>
        <div class="versus">${duelCard(session.song, 'new')}<div class="vs">VS</div>${duelCard(opp, 'old')}</div>
        <div class="progress" aria-hidden="true">${bars}</div>
        <div class="row-buttons center" style="margin-top:var(--s-2)"><button class="btn ghost" data-choose="tie">Too close to call</button></div>
        <p class="center small muted desk-only" style="margin:var(--s-2) 0 0">Keys: <kbd>←</kbd> left · <kbd>→</kbd> right · <kbd>0</kbd> too close</p>
      </div>`;
    [AC.forSong(session.song), AC.forSong(opp)].forEach((p2, i) => p2.then((rgb) => { const d = $$('.duel', body)[i]; if (d) d.style.setProperty('--c', rgbVar(rgb)); }));
  }
  let choosing = false;
  function choose(choice) {
    if (!session || session.stage !== 'compare' || choosing) return;
    choosing = true;
    M.haptic(10);
    const duels = $$('.duel', body);
    if (choice !== 'tie') duels.forEach((d) => d.classList.add(d.dataset.choose === choice ? 'chosen' : 'lost'));
    setTimeout(() => { choosing = false; if (!session) return; R.answer(session.placement, choice); step(); }, M.reduced() ? 0 : 230);
  }
  function finish() {
    const song = session.song;
    const isNew = !R.bucketOf(state.rankings, song.id);
    state.rankings = R.commit(state.rankings, session.placement);
    state.rankedAt[song.id] = Date.now();
    state.later = state.later.filter((id) => id !== song.id);
    save();
    const e = scoreMapOf(state.rankings)[song.id];
    session.stage = 'done';
    body.innerHTML = `${sheetBg(song)}
      <div class="sheet-step">
        <p class="kicker">${isNew ? 'Added to your list' : 'Re-ranked'}</p>
        <div class="feature" style="margin-top:var(--s-3)"><h2 class="display" style="margin:0">${esc(song.title)}</h2><div class="t2">${esc(song.artist)}</div></div>
        <div class="result">
          ${M.ring(e.score, { size: 176, stroke: 5, animate: true, cls: 'ring-hero' })}
          <div class="place"><b>#${e.rank}</b> of ${rankedCount(state)}&ensp;<span class="verdict v-${e.bucket}">${BUCKET_SHORT[e.bucket]}</span></div>
        </div>
        <div class="avg-box">
          ${avgLine(groupOf(state.rankings, state.songs, 'artist', song), 'artist')}
          ${avgLine(groupOf(state.rankings, state.songs, 'album', song), 'album')}
        </div>
        <div class="row-buttons center">
          <button class="btn" data-done="list">See my list</button>
          <button class="btn primary" data-done="close">Done</button>
        </div>
      </div>`;
    M.fillRings(body, { delay: 160 });
    M.haptic([12, 60, 18]);
    renderAll();
  }

  body.addEventListener('click', (e) => {
    const play = e.target.closest('[data-act="play"]');
    if (play) {
      e.stopPropagation();
      const id = play.dataset.id;
      const song = state.songs[id] || (viewing && viewing.songs[id]) || lastResults.find((s) => s.id === id);
      if (song) playFrom(song, [song]);
      return;
    }
    const react = e.target.closest('[data-bucket]');
    if (react && session?.stage === 'react') return pickBucket(react.dataset.bucket);
    const ch = e.target.closest('[data-choose]');
    if (ch) return choose(ch.dataset.choose);
    const done = e.target.closest('[data-done]');
    if (done) { closeSheet(); if (done.dataset.done === 'list') showView('list'); return; }
    const det = e.target.closest('[data-detail]');
    if (det) return detailAction(det.dataset.detail);
  });
  body.addEventListener('keydown', (e) => {
    const d = e.target.closest('.duel');
    if (d && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); choose(d.dataset.choose); }
  });

  // ----- Song detail -----
  let detailSong = null;
  function openDetail(song, other) {
    detailSong = song;
    session = null;
    const mine = scoreMapOf(state.rankings)[song.id];
    const theirs = other && !other.mine ? scoreMapOf(other.rankings)[song.id] : null;
    const artistG = groupOf(state.rankings, state.songs, 'artist', song);
    const albumG = song.album ? groupOf(state.rankings, state.songs, 'album', song) : null;
    const saved = state.later.includes(song.id);
    openSheet(`${sheetBg(song)}
      <div class="sheet-step">
        <div class="feature" style="margin-top:var(--s-4)">${featureArt(song)}
          <h2 class="display">${esc(song.title)}</h2>
          <div class="t2">${esc(song.artist)}</div>
          <div class="t3" style="white-space:normal">${esc(song.album)}${song.year ? ' · ' + song.year : ''}${song.genre ? ' · ' + esc(song.genre) : ''}</div>
        </div>
        ${mine ? `<div class="result">${M.ring(mine.score, { size: 120, stroke: 5, animate: true, cls: 'ring-hero' })}<div class="place">Your <b>#${mine.rank}</b>&ensp;<span class="verdict v-${mine.bucket}">${BUCKET_SHORT[mine.bucket]}</span></div></div>` : ''}
        ${theirs ? `<p class="center muted" style="margin:var(--s-3) 0 0">${esc(other.user.displayName)} gave it <b>${theirs.score.toFixed(1)}</b> (#${theirs.rank})</p>` : ''}
        ${artistG || albumG ? `<div class="avg-box">${avgLine(artistG, 'artist')}${avgLine(albumG, 'album')}</div>` : ''}
        <div class="row-buttons center">
          <button class="btn primary" data-detail="rank">${mine ? 'Re-rank' : 'Rank it'}</button>
          <button class="btn" data-detail="later">${saved ? I.bookmarkOn + 'Saved' : I.bookmark + 'Later'}</button>
          ${song.url ? `<a class="btn" href="${esc(song.url)}" target="_blank" rel="noopener">${I.external}Apple Music</a>` : ''}
          ${mine ? `<button class="btn ghost danger" data-detail="remove">${I.trash}Remove</button>` : ''}
        </div>
      </div>`, { song });
    setAmbient(song);
  }
  function detailAction(act) {
    const song = detailSong;
    if (!song) return;
    if (act === 'rank') startRanking(song);
    else if (act === 'later') { toggleLater(song); openDetail(song); }
    else if (act === 'remove') {
      const before = state.rankings;
      state.rankings = R.remove(state.rankings, song.id);
      save(); renderAll(); closeSheet();
      toast('Removed from your rankings', { action: 'Undo', run: () => { state.rankings = before; save(); renderAll(); } });
    }
  }

  // ----- Artist / album page (full screen, cover expands into it) -----
  function openGroup(g, data, fromEl) {
    const whose = data.mine ? 'Your' : esc(data.user.displayName) + '’s';
    const hero = $('#group-hero');
    AC.paint($('#view-group'), g.top);
    hero.innerHTML = `
      <div class="hero-glow" aria-hidden="true"></div>
      <div class="hero-art ${g.kind === 'artist' ? 'round' : ''}">${artImg(g.top, 600, { eager: true })}</div>
      <p class="eyebrow" style="margin:var(--s-3) 0 0">${g.kind === 'artist' ? 'Artist' : 'Album · ' + esc(g.artist)}</p>
      <h1 class="display" id="group-name">${esc(g.name)}</h1>
      <div class="sub">${whose} average across ${g.count} ranked song${g.count > 1 ? 's' : ''}</div>
      ${M.ring(g.avg, { size: 112, stroke: 5, animate: true, cls: 'ring-hero' })}`;
    const ol = $('#group-list');
    ol.innerHTML = '';
    const mineMap = scoreMapOf(state.rankings);
    g.entries.forEach((e) => { const s = data.songs[e.id]; if (s) ol.appendChild(songRow(s, { entry: e, mine: data.mine ? e : mineMap[e.id], readOnly: !data.mine })); });
    ol._data = data;
    showView('group', { mode: 'push' });
    setAmbient(g.top);
    const heroArt = $('.hero-art', hero);
    M.shared(fromEl, heroArt, { radiusTo: g.kind === 'artist' ? heroArt.offsetWidth / 2 : 30 });
    M.fillRings($('#view-group'), { delay: 260 });
  }

  // ----- Share card -----
  async function openShare() {
    const entries = R.flatten(state.rankings).slice(0, 10).filter((e) => state.songs[e.id]);
    if (!entries.length) { toast('Rank a song first'); return; }
    openSheet(`<p class="kicker">Share</p><h3 class="prompt">Your Top ${entries.length}</h3>
      <div class="share-preview" id="share-preview"><div class="skel" style="height:auto"><i class="s-cover"></i></div></div>
      <div class="row-buttons center" id="share-actions"></div>`, { song: state.songs[entries[0].id] });
    try {
      const items = await Promise.all(entries.map(async (e) => {
        const s = state.songs[e.id];
        return { title: s.title, artist: s.artist, score: e.score, rgb: await AC.forSong(s), art: AC.proxied(artUrl(s, 200)) };
      }));
      const blob = await ShareCard.render({
        heading: `My Top ${items.length}`,
        sub: sync.user ? `${sync.user.displayName} · @${sync.user.username} · ${rankedCount(state)} songs ranked` : `${rankedCount(state)} songs ranked head to head`,
        items,
      });
      const url = URL.createObjectURL(blob);
      const prevEl = $('#share-preview');
      if (!prevEl) return;
      prevEl.innerHTML = `<img src="${url}" alt="Your top ${items.length} songs as a shareable image" />`;
      const canShare = navigator.canShare && navigator.canShare({ files: [new File([blob], 'x.png', { type: 'image/png' })] });
      $('#share-actions').innerHTML = `${canShare ? `<button class="btn primary" data-share="share">${I.share}Share image</button>` : ''}<button class="btn ${canShare ? '' : 'primary'}" data-share="save">${I.download}Save PNG</button>`;
      $('#share-actions').onclick = async (e) => {
        const b = e.target.closest('[data-share]');
        if (!b) return;
        if (b.dataset.share === 'share') await ShareCard.deliver(blob, 'encore-top-10.png');
        else {
          const a = document.createElement('a'); a.href = url; a.download = 'encore-top-10.png';
          document.body.appendChild(a); a.click(); a.remove(); toast('Image saved');
        }
      };
      window.__encoreShareBlob = blob; // for tests
    } catch (err) {
      const prevEl = $('#share-preview');
      if (prevEl) stateBlock(prevEl, { icon: 'share', error: true, title: 'Couldn’t make the image', body: 'Try again in a moment.' });
    }
  }
  $('#taste').addEventListener('click', (e) => {
    if (e.target.closest('#share-btn')) return openShare();
    const h = e.target.closest('[data-group-key]');
    if (h) {
      const g = ($('#taste')._artists || []).find((x) => x.key === h.dataset.groupKey);
      if (g) openGroup(g, mineData(), null);
    }
  });

  // =====================================================================
  // Navigation
  // =====================================================================
  const TABS = ['discover', 'list', 'later', 'profile'];
  let activeView = 'discover';
  const stack = [];
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
    const tabName = TABS.includes(name) ? name : (stack[0] && stack[0].view) || 'profile';
    const i = TABS.indexOf(tabName);
    $('.tabs').style.setProperty('--i', i);
    $$('.tab').forEach((t) => { const on = t.dataset.view === tabName; t.classList.toggle('active', on); t.setAttribute('aria-selected', on); });
    if (mode !== 'pop') window.scrollTo(0, 0);
    if (name === 'profile') growBars($('#taste'));
    if (name === 'list') M.fillRings($('#ranked'));
    if (name === 'later') M.fillRings($('#later'));
  }
  function back() {
    const prevV = stack.pop();
    if (!prevV) return showView('discover');
    showView(prevV.view, { mode: 'pop' });
    window.scrollTo(0, prevV.y);
    if (prevV.view !== 'user') { viewing = viewing && prevV.view === 'user' ? viewing : null; }
    if (!stack.some((s) => s.view === 'user') && activeView !== 'user') {
      try { if (new URLSearchParams(location.search).get('u')) history.replaceState(null, '', location.pathname); } catch (_) { /* ignore */ }
    }
  }
  $$('[data-back]').forEach((b) => (b.onclick = back));
  $$('.tab').forEach((t) => (t.onclick = () => { M.haptic(4); showView(t.dataset.view); }));

  function setSeg(seg, value) {
    const btns = $$('button', seg);
    const i = btns.findIndex((b) => b.dataset.seg === value);
    seg.style.setProperty('--i', Math.max(0, i));
    btns.forEach((b) => { const on = b.dataset.seg === value; b.classList.toggle('active', on); b.setAttribute('aria-selected', on); });
  }
  function chipsBind(sel, key, onPick) {
    $$(sel + ' .chip').forEach((b) => (b.onclick = () => {
      $$(sel + ' .chip').forEach((x) => x.classList.toggle('active', x === b));
      onPick(b.dataset[key]);
    }));
  }
  $$('#list-seg button').forEach((b) => (b.onclick = () => { setSeg($('#list-seg'), b.dataset.seg); listUI.seg = b.dataset.seg; M.haptic(4); renderRanked(); }));
  $$('#user-seg button').forEach((b) => (b.onclick = () => { setSeg($('#user-seg'), b.dataset.seg); userUI.seg = b.dataset.seg; renderUser(); }));
  chipsBind('#bucket-chips', 'bucket', (v) => { listUI.bucket = v; renderRanked(); });
  chipsBind('#group-sort', 'sort', (v) => { listUI.sort = v; renderRanked(); });
  function setSource(s) {
    source = s;
    $$('#source-chips .chip').forEach((x) => x.classList.toggle('active', x.dataset.source === s));
    $('#search').value = '';
    loadResults();
  }
  $$('#source-chips .chip').forEach((c) => (c.onclick = () => setSource(c.dataset.source)));
  $('#list-filter').addEventListener('input', renderRanked);
  $('#search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    const term = $('#search').value.trim();
    if (term && peekCatalog('search', { term })) return loadResults(); // cached → instant
    searchTimer = setTimeout(loadResults, 180);
  });
  $('#search').addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(searchTimer); loadResults(); e.target.blur(); } });

  // Scroll edge on the top bar.
  let scrollRaf = 0;
  window.addEventListener('scroll', () => {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; document.body.classList.toggle('scrolled', window.scrollY > 4); });
  }, { passive: true });

  // =====================================================================
  // Toast (with optional action, e.g. Undo)
  // =====================================================================
  let toastTimer;
  function toast(msg, { action = null, run = null } = {}) {
    const t = $('#toast');
    t.innerHTML = `<span>${esc(msg)}</span>${action ? ` <button class="toast-act" style="pointer-events:auto;margin-left:10px;font-weight:800;text-decoration:underline;color:inherit">${esc(action)}</button>` : ''}`;
    t.style.pointerEvents = action ? 'auto' : 'none';
    if (action) $('.toast-act', t).onclick = () => { t.classList.remove('show'); run(); };
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.classList.remove('show'); t.style.pointerEvents = 'none'; }, action ? 4200 : 2400);
  }

  // =====================================================================
  // Gestures
  // =====================================================================
  Gestures.swipeRows($('#results'), () => ({
    right: { run: (li) => { const s = lastResults.find((x) => x.id === li.dataset.id); if (s && !state.later.includes(s.id)) toggleLater(s); else toast('Already in Later'); springBack(li); } },
    left: { run: (li) => skipResult(li) },
  }));
  Gestures.swipeRows($('#later'), () => ({
    right: { run: (li) => { const s = state.songs[li.dataset.id]; springBack(li); if (s) startRanking(s); } },
    left: { run: (li) => removeLater(li) },
  }));
  function springBack(li) {
    const b = $('.row-body', li);
    if (!b) return;
    b.getAnimations().forEach((a) => a.cancel());
    li.classList.remove('armed');
    M.animate(b, [{ transform: `translate3d(${li.dataset.side === 'left' ? '-' : ''}${li.offsetWidth}px,0,0)`, opacity: 0.4 }, { transform: 'translate3d(0,0,0)', opacity: 1 }], { duration: 520 })
      .then(() => { b.getAnimations().forEach((a) => a.cancel()); b.style.transform = ''; });
  }
  Gestures.dragReorder($('#ranked'), {
    canDrag,
    onDrop: (id, from, to) => {
      const before = state.rankings;
      const { rankings, bucket } = R.move(state.rankings, id, to);
      const oldBucket = R.bucketOf(before, id);
      state.rankings = rankings;
      save();
      renderRanked(); renderResults(); renderProfile();
      const e = scoreMapOf(state.rankings)[id];
      toast(`Moved to #${e.rank} · ${e.score.toFixed(1)}${bucket !== oldBucket ? ' · now ' + BUCKET_SHORT[bucket] : ''}`, { action: 'Undo', run: () => { state.rankings = before; save(); renderAll(); } });
    },
  });
  Gestures.pullToRefresh($('#ptr'), async () => {
    if (activeView === 'discover') await loadResults({ fresh: true });
    else if (sync.user) {
      const r = await api('/api/me', { timeout: 20000 }).catch(() => null);
      if (r && r.ok && r.data.user && r.data.version > sync.version && !sync.dirty) adoptServer(r.data.state, r.data.version);
      toast(r && r.ok ? 'Up to date' : 'Offline. Showing what’s on this device');
    } else { renderAll(); await new Promise((res) => setTimeout(res, 400)); }
  }, () => TABS.includes(activeView) && !sheetWrap.classList.contains('in'));

  // =====================================================================
  // Keyboard shortcuts + command palette
  // =====================================================================
  function openShortcuts() {
    openSheet(`<p class="kicker">Keyboard</p><h3 class="prompt">Shortcuts</h3>
      <div class="shortcuts">
        <span><kbd>⌘</kbd><kbd>K</kbd></span><span>Command palette: search, jump, act</span>
        <span><kbd>/</kbd></span><span>Search Apple Music</span>
        <span><kbd>1</kbd>–<kbd>4</kbd></span><span>Discover · My List · Later · Profile</span>
        <span><kbd>Space</kbd></span><span>Play / pause</span>
        <span><kbd>N</kbd> <kbd>B</kbd></span><span>Next / previous song</span>
        <span><kbd>←</kbd> <kbd>→</kbd></span><span>Pick a side while ranking</span>
        <span><kbd>0</kbd></span><span>Too close to call</span>
        <span><kbd>Esc</kbd></span><span>Close / go back</span>
      </div>`);
  }
  document.addEventListener('keydown', (e) => {
    if (window.Palette && Palette.isOpen) return;
    const typing = e.target.closest && e.target.closest('input, textarea, select, [contenteditable]');
    if (!sheetWrap.hidden) {
      if (e.key === 'Escape') { e.preventDefault(); closeSheet(); return; }
      if (session && session.stage === 'compare' && !typing) {
        if (e.key === 'ArrowLeft' || e.key === '1') { e.preventDefault(); choose('new'); }
        if (e.key === 'ArrowRight' || e.key === '2') { e.preventDefault(); choose('old'); }
        if (e.key === '0') { e.preventDefault(); choose('tie'); }
      }
      return;
    }
    if (typing) { if (e.key === 'Escape') e.target.blur(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '/') { e.preventDefault(); showView('discover'); $('#search').focus(); }
    else if (['1', '2', '3', '4'].includes(e.key)) showView(TABS[+e.key - 1]);
    else if (e.key === ' ' && pb.song) { e.preventDefault(); togglePlay(); }
    else if (e.key.toLowerCase() === 'n') next();
    else if (e.key.toLowerCase() === 'b') prev();
    else if (e.key === '?') openShortcuts();
    else if (e.key === 'Escape' && stack.length) back();
  });
  Palette.init({
    art: artUrl,
    myScore: (song) => { const e = scoreMapOf(state.rankings)[song.id]; return e ? e.score : null; },
    searchSongs: (q) => searchSongs(q),
    onSong: (song, how) => {
      remember(song);
      if (how === 'play') playFrom(song, [song]);
      else if (scoreMapOf(state.rankings)[song.id]) openDetail(song);
      else startRanking(song);
    },
    commands: () => [
      { label: 'Go to Discover', icon: 'search', hint: '1', keywords: ['home', 'charts'], run: () => showView('discover') },
      { label: 'Go to My List', icon: 'podium', hint: '2', keywords: ['rankings', 'songs'], run: () => showView('list') },
      { label: 'Go to Later', icon: 'bookmark', hint: '3', keywords: ['saved', 'bookmarks'], run: () => showView('later') },
      { label: 'Go to Profile', icon: 'user', hint: '4', keywords: ['account', 'taste'], run: () => showView('profile') },
      { label: 'Show artist averages', icon: 'podium', keywords: ['artists'], run: () => { showView('list'); $('#list-seg [data-seg="artists"]').click(); } },
      { label: 'Show album averages', icon: 'podium', keywords: ['albums'], run: () => { showView('list'); $('#list-seg [data-seg="albums"]').click(); } },
      ...(pb.song ? [{ label: isPlaying(pb.song.id) ? 'Pause' : 'Play', icon: isPlaying(pb.song.id) ? 'pause' : 'play', hint: 'Space', run: togglePlay }, { label: 'Next song', icon: 'next', hint: 'N', run: next }] : []),
      { label: 'Share my Top 10', icon: 'share', keywords: ['image', 'png', 'card'], run: () => { showView('profile'); openShare(); } },
      { label: 'Export my list', icon: 'download', keywords: ['backup', 'json'], run: () => $('#export').click() },
      ...(sync.server ? (amConnected() ? [{ label: 'Disconnect Apple Music', icon: 'note', run: amDisconnect }] : [{ label: 'Connect Apple Music', icon: 'note', run: amConnect }]) : []),
      ...(sync.server ? (sync.user ? [{ label: 'Sign out', icon: 'user', run: () => $('[data-auth="logout"]')?.click() }] : [{ label: 'Sign in', icon: 'user', run: () => openAuth('login') }, { label: 'Create account', icon: 'user', run: () => openAuth('signup') }]) : []),
      { label: 'Keyboard shortcuts', icon: 'keyboard', hint: '?', run: openShortcuts },
    ],
  });
  $('#palette-btn').onclick = () => Palette.open();
  $('#shortcuts-btn').onclick = openShortcuts;

  // =====================================================================
  // Storefront, import / export
  // =====================================================================
  const COUNTRIES = { us: 'US', gb: 'UK', ca: 'CA', au: 'AU', ie: 'IE', nz: 'NZ', de: 'DE', fr: 'FR', es: 'ES', it: 'IT', nl: 'NL', se: 'SE', br: 'BR', mx: 'MX', jp: 'JP', kr: 'KR', in: 'IN', ng: 'NG', za: 'ZA' };
  const sel = $('#country');
  sel.innerHTML = Object.entries(COUNTRIES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  sel.onchange = () => { state.country = sel.value; save(); loadResults(); };

  $('#export').onclick = () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'encore-rankings.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast('List exported');
  };
  $('#import').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!data.rankings || !data.songs) throw new Error('bad file');
      state = normalize(data);
      save(); afterStateChange(); toast('List imported');
    } catch (_) { toast('That file isn’t an Encore export'); }
    e.target.value = '';
  };
  $('#import').closest('label').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#import').click(); } });
  $('#reset').onclick = () => {
    openSheet(`<p class="kicker">Reset</p><h3 class="prompt">Delete your rankings?</h3>
      <p class="center muted">This removes every ranked and saved song${sync.user ? ' from your account on every device' : ' from this browser'}. You can’t undo it.</p>
      <div class="row-buttons center"><button class="btn" data-dismiss>Keep my list</button><button class="btn primary" id="confirm-reset" style="--c:255,138,122">Delete everything</button></div>`);
    $('#confirm-reset').onclick = () => { state = defaultState(); save(); closeSheet(); renderAll(); toast('Everything reset'); };
  };

  // =====================================================================
  // Waking-up banner (Render's free plan sleeps when idle)
  // =====================================================================
  function showWake(kind) {
    const w = $('#wake');
    if (kind === 'waking') {
      w.className = 'wake glass';
      w.innerHTML = `<span class="eq" aria-hidden="true"><i></i><i></i><i></i></span><div><b>Waking up Encore’s server</b><span>Free hosting naps when it’s quiet. This can take up to a minute. Browse and rank while it wakes.</span></div>`;
    } else {
      w.className = 'wake glass error';
      w.innerHTML = `<div><b>Can’t reach Encore’s server</b><span>You can keep ranking. Your list is saved on this device and syncs when the server is back.</span></div><button class="btn" id="wake-retry">Retry</button>`;
      $('#wake-retry').onclick = () => { hideWake(); connect(); };
    }
    w.hidden = false;
  }
  function hideWake() { $('#wake').hidden = true; }

  async function connect() {
    const wakeTimer = setTimeout(() => showWake('waking'), 1200);
    let r = null;
    try { r = await api('/api/me', { timeout: 75000 }); } catch (_) { r = null; }
    clearTimeout(wakeTimer);
    const wasWaking = !$('#wake').hidden;
    hideWake();
    if (r && r.json && r.ok && 'user' in r.data) {
      sync.server = true; sync.awake = true;
      AC.setProxy(true);
      if (r.data.user) {
        const note = signedIn(r.data.user, r.data);
        if (note) toast(note);
      } else if (sync.user) signedOut();
      if (wasWaking) toast('Connected');
      renderAll();
      const u = new URLSearchParams(location.search).get('u');
      if (u) openUser(u);
      try { if (localStorage.getItem(AM_FLAG)) amInit().then(renderAmUI).catch(() => {}); } catch (_) { /* ignore */ }
      if (!lastResults.length) loadResults();
      return;
    }
    if (r && !r.json) { renderAll(); return; } // static hosting: no server, guest mode
    // Server exists but is unreachable right now.
    if (sync.user || readJSON(LAST_USER)) { sync.server = true; showWake('error'); renderAll(); }
  }

  // =====================================================================
  // Boot
  // =====================================================================
  $$('[data-icon]').forEach((el) => { el.outerHTML = I[el.dataset.icon] || ''; });
  $$('[data-logo]').forEach((svg, i) => {
    svg.innerHTML = `<defs><linearGradient id="lg${i}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff5c8a"/><stop offset=".55" stop-color="#ffb35c"/><stop offset="1" stop-color="#8b6cff"/></linearGradient></defs>
      <circle cx="16" cy="16" r="12" fill="none" stroke="rgba(255,255,255,.14)" stroke-width="4"/>
      <circle cx="16" cy="16" r="12" fill="none" stroke="url(#lg${i})" stroke-width="4" stroke-linecap="round" stroke-dasharray="62 100" transform="rotate(-90 16 16)"/>
      <circle cx="16" cy="16" r="4" fill="#fff"/>`;
  });
  M.initImageFade();
  bindList($('#results'), (id) => lastResults.find((s) => s.id === id) || state.songs[id]);
  bindList($('#ranked'), (id) => state.songs[id]);
  bindList($('#later'), (id) => state.songs[id]);
  bindList($('#group-list'), (id) => state.songs[id] || ($('#group-list')._data && $('#group-list')._data.songs[id]), () => $('#group-list')._data);
  bindList($('#user-list'), (id) => viewing && viewing.songs[id], () => viewing);

  (function boot() {
    // Show something useful immediately: the last signed-in user's cached
    // list (so a sleeping server never blocks you), else the guest list.
    const last = readJSON(LAST_USER);
    const cache = last && readJSON(accountKey(last));
    if (last && cache) { sync.user = last; sync.version = cache.version; sync.dirty = !!cache.dirty; state = normalize(cache.state); sync.server = true; }
    else state = normalize(readJSON(GUEST_KEY));
    sel.value = COUNTRIES[state.country] ? state.country : (state.country = 'us');
    renderAll();
    const h = location.hash.slice(1);
    if (TABS.includes(h)) showView(h);
    ambientDefault();
    loadResults();
    refreshSongMeta();
    if (location.protocol.startsWith('http')) connect();
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
  })();
})();
