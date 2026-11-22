/* Encore — Beli-style song ranking on top of the Apple Music catalog. */
(() => {
  'use strict';
  const R = window.Ranking;
  const GUEST_KEY = 'encore.v1';
  const AM_FLAG = 'encore.am';
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const round1 = (x) => Math.round(x * 10) / 10;
  const BUCKET_LABEL = { liked: 'Loved it', fine: 'It was fine', disliked: "Didn't like it" };
  const bucketForScore = (s) => (s >= 6.7 ? 'liked' : s >= 3.4 ? 'fine' : 'disliked');

  // =====================================================================
  // State + persistence (guest = this browser; account = synced to server)
  // =====================================================================
  const defaultState = () => ({
    songs: {}, rankings: R.emptyRankings(), later: [], rankedAt: {}, country: guessCountry(),
  });
  const sync = { server: false, user: null, version: 0, dirty: false, timer: null, status: '' };
  let state = defaultState();

  function guessCountry() {
    const m = (navigator.language || 'en-US').match(/-([A-Z]{2})$/i);
    return m ? m[1].toLowerCase() : 'us';
  }
  const accountKey = (u) => 'encore.user.' + u.username.toLowerCase();
  function readJSON(key) { try { return JSON.parse(localStorage.getItem(key)); } catch (_) { return null; } }
  function writeJSON(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (_) { /* full / private mode */ } }
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
    const res = await fetch(path, {
      method: opts.method || 'GET',
      credentials: 'same-origin',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (_) { /* non-JSON */ }
    return { ok: res.ok, status: res.status, data: data || {} };
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
        // Another device saved first: take the newest copy from the server.
        adoptServer(r.data.state, r.data.version);
        toast('Updated with changes from another device');
      } else if (r.status === 401) {
        signedOut(); toast('You were signed out');
      } else setSyncStatus('Sync failed — will retry');
    } catch (_) {
      setSyncStatus('Offline — will sync later');
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

  /** Pick the right data after we learn who is signed in. */
  function signedIn(user, server) {
    sync.user = user;
    const cache = readJSON(accountKey(user));
    const guest = normalize(readJSON(GUEST_KEY));
    if (cache && cache.dirty && cache.version === server.version) {
      // Offline edits on this device that the server hasn't seen yet.
      state = normalize(cache.state); sync.version = server.version; save();
    } else if (!server.state && rankedCount(guest) > 0) {
      // Brand-new account: bring this browser's guest list along.
      state = guest; sync.version = server.version; save();
      afterStateChange();
      return `Moved your ${rankedCount(guest)} ranked songs into your account`;
    } else {
      state = normalize(server.state); sync.version = server.version;
      writeJSON(accountKey(user), { state, version: sync.version, dirty: false });
      setSyncStatus('Synced');
    }
    afterStateChange();
  }
  function signedOut() {
    sync.user = null; sync.version = 0; clearTimeout(sync.timer);
    state = normalize(readJSON(GUEST_KEY));
    afterStateChange();
  }
  function afterStateChange() {
    $('#country').value = state.country;
    renderAll();
    refreshSongMeta();
  }

  // =====================================================================
  // Apple Music public catalog (iTunes Search API) — every song on Apple Music
  // =====================================================================
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
  async function getJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(String(res.status));
    return res.json();
  }
  /** Through our server when there is one (no CORS issues), else straight to Apple. */
  async function catalog(kind, params) {
    const qs = new URLSearchParams({ ...params, country: state.country }).toString();
    if (sync.server) {
      try { return await getJson(`/api/catalog/${kind}?${qs}`); } catch (_) { /* fall through */ }
    }
    if (kind === 'charts') {
      try {
        return await getJson(`https://rss.marketingtools.apple.com/api/v2/${state.country}/music/most-played/50/songs.json`);
      } catch (_) {
        const d = await jsonp(`https://itunes.apple.com/${state.country}/rss/topsongs/limit=50/json`);
        return { feed: { results: d.feed.entry.map((e) => ({ id: e.id.attributes['im:id'] })) } };
      }
    }
    const extra = kind === 'search' ? '&media=music&entity=song&limit=40' : '&entity=song';
    const url = `https://itunes.apple.com/${kind}?${qs}${extra}`;
    try { return await getJson(url); } catch (_) { return jsonp(url); }
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
  async function searchSongs(term) {
    const d = await catalog('search', { term });
    return (d.results || []).filter((r) => r.trackId && (r.kind === 'song' || r.wrapperType === 'track')).map(toSong);
  }
  async function lookupSongs(ids) {
    const out = {};
    for (let i = 0; i < ids.length; i += 100) {
      const d = await catalog('lookup', { id: ids.slice(i, i + 100).join(',') });
      (d.results || []).filter((r) => r.trackId).forEach((r) => { out[r.trackId] = toSong(r); });
    }
    return ids.map((id) => out[id]).filter(Boolean);
  }
  async function topSongs() {
    const d = await catalog('charts', {});
    const feed = (d.feed && d.feed.results) || [];
    const ids = feed.map((r) => r.id);
    let songs = [];
    try { songs = await lookupSongs(ids); } catch (_) { /* fall back to feed data below */ }
    if (songs.length) return songs;
    // Lookup failed: the chart feed itself still has title/artist/art.
    return feed.map((r) => ({ id: String(r.id), title: r.name, artist: r.artistName, album: '', art: r.artworkUrl100 || '', preview: '', url: r.url || '', genre: (r.genres?.[0]?.name) || '', year: (r.releaseDate || '').slice(0, 4), explicit: r.contentAdvisoryRating === 'Explict' }));
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
  // Cover art
  // =====================================================================
  /** Apple artwork URLs encode their size ("…/100x100bb.jpg" or "{w}x{h}") — ask for a sharp one. */
  function artUrl(song, px) {
    const a = song && song.art;
    if (!a) return placeholderArt(song);
    return a.replace('{w}', px).replace('{h}', px).replace(/\/\d+x\d+(bb|cc|sr)?(\.\w+)(\?.*)?$/, `/${px}x${px}bb$2`);
  }
  function hue(str) { let h = 0; for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
  function placeholderArt(song) {
    const h = hue((song && (song.album || song.title)) || 'x');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h},70%,55%)"/><stop offset="1" stop-color="hsl(${(h + 60) % 360},70%,35%)"/></linearGradient></defs><rect width="100" height="100" fill="url(#g)"/><text x="50" y="66" font-size="44" text-anchor="middle" fill="rgba(255,255,255,.85)" font-family="sans-serif">♪</text></svg>`;
    return 'data:image/svg+xml,' + encodeURIComponent(svg);
  }
  function artImg(song, px, cls = '') {
    return `<img class="${cls}" src="${esc(artUrl(song, px))}" data-ph="${esc(placeholderArt(song))}" alt="${esc(song ? song.album || song.title : '')} cover art" loading="lazy" />`;
  }
  // Any cover that fails to load gets the generated placeholder instead of a broken image.
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (img.tagName === 'IMG' && img.dataset.ph && img.src !== img.dataset.ph) img.src = img.dataset.ph;
  }, true);

  // =====================================================================
  // Artist / album averages
  // =====================================================================
  const norm = (s) => String(s || '').toLowerCase().replace(/\s*[-–]\s*(single|ep)$/i, '').replace(/\s+/g, ' ').trim();
  function scoreMapOf(rankings) {
    const m = {};
    R.flatten(rankings).forEach((e) => { m[e.id] = e; });
    return m;
  }
  /** Groups ranked songs by artist or album with their average score. */
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
    return `<div class="avg-line"><span class="score sm ${bucketForScore(g.avg)}">${g.avg.toFixed(1)}</span><span><b>${esc(g.name)}</b> ${label} average · ${g.count} song${g.count > 1 ? 's' : ''} ranked</span></div>`;
  }

  // =====================================================================
  // Row rendering
  // =====================================================================
  function songRow(song, { rankEntry = null, mine = null, readOnly = false } = {}) {
    const li = document.createElement('li');
    li.className = 'song';
    li.dataset.id = song.id;
    const saved = state.later.includes(song.id);
    li.innerHTML = `
      ${rankEntry ? `<div class="rank">${rankEntry.rank}</div>` : ''}
      <button class="art" data-act="play" aria-label="Play ${esc(song.title)}">
        ${artImg(song, 200)}
        <span class="play-icon">${isPlaying(song.id) ? '❚❚' : '▶'}</span>
      </button>
      <div class="meta" data-act="open">
        <div class="title">${esc(song.title)}${song.explicit ? ' <span class="e">E</span>' : ''}</div>
        <div class="artist">${esc(song.artist)}</div>
        <div class="album">${esc(song.album)}${song.year ? ' · ' + song.year : ''}</div>
      </div>
      <div class="actions">
        ${readOnly && rankEntry ? `<span class="score ${rankEntry.bucket}" title="Their score">${rankEntry.score.toFixed(1)}</span>` : ''}
        ${!readOnly && mine ? `<button class="score ${mine.bucket}" data-act="open" title="Your score">${mine.score.toFixed(1)}</button>` : ''}
        ${!mine && !(readOnly && rankEntry) ? `<button class="icon-btn add" data-act="rank" aria-label="Rank song">+</button>` : ''}
        ${!readOnly ? `<button class="icon-btn ${saved ? 'on' : ''}" data-act="later" aria-label="Want to listen">🔖</button>` : ''}
      </div>`;
    return li;
  }
  function groupRow(g, i) {
    const li = document.createElement('li');
    li.className = 'song group';
    li.dataset.group = g.key;
    li.innerHTML = `
      ${i != null ? `<div class="rank">${i + 1}</div>` : ''}
      <div class="art ${g.kind === 'artist' ? 'round' : ''}">${artImg(g.top, 200)}</div>
      <div class="meta">
        <div class="title">${esc(g.name)}</div>
        <div class="artist">${g.kind === 'album' ? esc(g.artist) + ' · ' : ''}${g.count} song${g.count > 1 ? 's' : ''} ranked</div>
        <div class="bar"><i style="width:${g.avg * 10}%"></i></div>
      </div>
      <div class="actions"><span class="score ${bucketForScore(g.avg)}" title="Average score">${g.avg.toFixed(1)}</span></div>`;
    return li;
  }

  /** Render a ranked collection (mine or someone else's) as songs, artists or albums. */
  function renderCollection(ol, data, { seg = 'songs', filter = '', bucket = 'all', sort = 'avg', readOnly = false }) {
    ol.innerHTML = '';
    const q = filter.trim().toLowerCase();
    const match = (s) => !q || `${s.title} ${s.artist} ${s.album} ${s.genre}`.toLowerCase().includes(q);
    if (seg === 'songs') {
      const mineMap = scoreMapOf(state.rankings);
      let n = 0;
      R.flatten(data.rankings).forEach((e) => {
        const s = data.songs[e.id];
        if (!s || (bucket !== 'all' && e.bucket !== bucket) || !match(s)) return;
        ol.appendChild(songRow(s, { rankEntry: e, mine: readOnly ? mineMap[e.id] : e, readOnly }));
        n++;
      });
      return n;
    }
    const kind = seg === 'artists' ? 'artist' : 'album';
    const groups = sortGroups(groupStats(data.rankings, data.songs, kind).filter((g) => !q || `${g.name} ${g.artist}`.toLowerCase().includes(q)), sort);
    groups.forEach((g, i) => ol.appendChild(groupRow(g, i)));
    ol._groups = groups;
    return groups.length;
  }

  function bindList(ul, lookup, getData) {
    ul.addEventListener('click', (e) => {
      const gli = e.target.closest('li.group');
      if (gli) {
        const g = (ul._groups || []).find((x) => x.key === gli.dataset.group);
        if (g) openGroup(g, getData ? getData() : mineData());
        return;
      }
      const btn = e.target.closest('[data-act]');
      const li = e.target.closest('li.song');
      if (!btn || !li) return;
      const song = lookup(li.dataset.id);
      if (!song) return;
      const act = btn.dataset.act;
      if (act === 'play') togglePlay(song);
      else if (act === 'rank') startRanking(song);
      else if (act === 'later') toggleLater(song);
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

  async function loadResults() {
    const term = $('#search').value.trim();
    const seq = ++searchSeq;
    const title = $('#results-title');
    const empty = $('#results-empty');
    empty.classList.add('hidden');
    title.textContent = term ? `Results for “${term}”` : { charts: 'Top songs right now', recent: 'Recently played on Apple Music', library: 'Your Apple Music library' }[source];
    $('#results').innerHTML = '<li class="loading">Loading…</li>';
    let songs = [];
    try {
      if (term) songs = await searchSongs(term);
      else if (source === 'recent') songs = await amRecent();
      else if (source === 'library') songs = await amLibrary();
      else songs = await topSongs();
    } catch (err) {
      if (seq !== searchSeq) return;
      $('#results').innerHTML = '';
      empty.textContent = source !== 'charts' && !term ? 'Could not load from Apple Music. Try reconnecting in Profile.' : 'Could not reach Apple Music. Check your connection and try again.';
      empty.classList.remove('hidden');
      return;
    }
    if (seq !== searchSeq) return;
    lastResults = songs;
    songs.forEach((s) => { if (state.songs[s.id]) state.songs[s.id] = { ...state.songs[s.id], ...s }; });
    renderResults();
    if (!songs.length) {
      empty.textContent = term ? 'No songs found. Try another search.' : 'Nothing here yet — search for any song on Apple Music to start ranking.';
      empty.classList.remove('hidden');
    }
  }
  function renderResults() {
    const ul = $('#results');
    ul.innerHTML = '';
    const mine = scoreMapOf(state.rankings);
    lastResults.forEach((s) => ul.appendChild(songRow(s, { mine: mine[s.id] })));
  }
  const remember = (song) => { state.songs[song.id] = { ...(state.songs[song.id] || {}), ...song }; };

  // =====================================================================
  // My list / Later / Profile
  // =====================================================================
  const listUI = { seg: 'songs', bucket: 'all', sort: 'avg' };
  function renderRanked() {
    const n = rankedCount(state);
    $('#list-count').textContent = n || '';
    $('#bucket-chips').classList.toggle('hidden', listUI.seg !== 'songs');
    $('#group-sort').classList.toggle('hidden', listUI.seg === 'songs');
    const shown = renderCollection($('#ranked'), mineData(), { ...listUI, filter: $('#list-filter').value });
    const empty = $('#ranked-empty');
    if (!n) {
      empty.innerHTML = 'No songs ranked yet. Search for a song in <b>Discover</b> and tap <b>+</b> to rank it.';
      empty.classList.remove('hidden');
    } else if (!shown) {
      empty.textContent = 'Nothing matches that filter.';
      empty.classList.remove('hidden');
    } else empty.classList.add('hidden');
  }

  function toggleLater(song) {
    remember(song);
    const i = state.later.indexOf(song.id);
    if (i >= 0) { state.later.splice(i, 1); toast('Removed from Want to Listen'); }
    else { state.later.unshift(song.id); toast('Saved to Want to Listen'); }
    save();
    renderAll();
  }
  function renderLater() {
    const ul = $('#later');
    ul.innerHTML = '';
    const mine = scoreMapOf(state.rankings);
    state.later.forEach((id) => { const s = state.songs[id]; if (s) ul.appendChild(songRow(s, { mine: mine[id] })); });
    $('#later-count').textContent = state.later.length || '';
    $('#later-empty').classList.toggle('hidden', state.later.length > 0);
  }

  function renderProfile() {
    const entries = R.flatten(state.rankings);
    const n = entries.length;
    const avg = n ? entries.reduce((a, e) => a + e.score, 0) / n : 0;
    const count = (b) => state.rankings[b].length;
    $('#stats').innerHTML = `
      <div class="stat"><b>${n}</b><span>ranked</span></div>
      <div class="stat"><b>${n ? avg.toFixed(1) : '–'}</b><span>avg score</span></div>
      <div class="stat liked"><b>${count('liked')}</b><span>loved</span></div>
      <div class="stat fine"><b>${count('fine')}</b><span>fine</span></div>
      <div class="stat disliked"><b>${count('disliked')}</b><span>didn't like</span></div>`;
    for (const [sel, kind] of [['#top-artists', 'artist'], ['#top-albums', 'album']]) {
      const ol = $(sel);
      ol.innerHTML = '';
      // Top = highest average among those with the most songs ranked.
      const groups = sortGroups(groupStats(state.rankings, state.songs, kind), 'avg')
        .sort((a, b) => Math.min(b.count, 3) - Math.min(a.count, 3) || b.avg - a.avg).slice(0, 5);
      groups.forEach((g, i) => ol.appendChild(groupRow(g, i)));
      ol._groups = groups;
      if (!groups.length) ol.innerHTML = '<li class="muted small">Rank some songs to see this.</li>';
    }
    renderAccountCard();
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
    b.classList.toggle('hidden', !sync.server);
    if (sync.user) { b.innerHTML = `<span class="avatar">${initials(sync.user.displayName)}</span>`; b.title = '@' + sync.user.username; }
    else { b.textContent = 'Sign in'; b.title = ''; }
  }
  function renderAccountCard() {
    const el = $('#account-card');
    $('#people-box').classList.toggle('hidden', !sync.server);
    if (!sync.server) {
      el.innerHTML = `<h3>Account</h3><p class="muted small">Your list is saved in this browser. Run the Encore server (<code>npm start</code>) to enable accounts, sync across devices and shareable profiles.</p>`;
      return;
    }
    if (!sync.user) {
      el.innerHTML = `<h3>Account</h3><p class="muted small">You're using Encore as a guest — your list lives only in this browser. Create an account to sync it across devices and share your rankings.</p>
        <div class="row-buttons"><button class="btn primary" data-auth="signup">Create account</button><button class="btn" data-auth="login">Sign in</button></div>`;
      return;
    }
    const link = `${location.origin}${location.pathname}?u=${encodeURIComponent(sync.user.username)}`;
    el.innerHTML = `
      <div class="user-head"><div class="avatar big">${initials(sync.user.displayName)}</div>
        <div><h3 class="tight">${esc(sync.user.displayName)}</h3><div class="muted small">@${esc(sync.user.username)} · <span id="sync-status">${esc(sync.status || 'Synced')}</span></div></div></div>
      <label class="toggle"><input type="checkbox" id="public-toggle" ${sync.user.isPublic ? 'checked' : ''}/> Public profile — anyone with the link can see your rankings</label>
      <div class="row-buttons">
        ${sync.user.isPublic ? `<button class="btn" data-copy="${esc(link)}">Copy profile link</button>` : ''}
        <button class="btn" data-auth="rename">Edit name</button>
        <button class="btn danger" data-auth="logout">Sign out</button>
      </div>`;
  }
  $('#account-card').addEventListener('click', async (e) => {
    const a = e.target.closest('[data-auth]');
    const c = e.target.closest('[data-copy]');
    if (c) { navigator.clipboard?.writeText(c.dataset.copy).then(() => toast('Link copied'), () => prompt('Copy your link', c.dataset.copy)); return; }
    if (!a) return;
    const act = a.dataset.auth;
    if (act === 'login' || act === 'signup') openAuth(act);
    if (act === 'logout') { await api('/api/logout', { method: 'POST', body: {} }); signedOut(); toast('Signed out'); }
    if (act === 'rename') {
      const name = prompt('Display name', sync.user.displayName);
      if (name && name.trim()) { const r = await api('/api/me', { method: 'PATCH', body: { displayName: name } }); if (r.ok) { sync.user = r.data.user; renderAll(); } }
    }
  });
  $('#account-card').addEventListener('change', async (e) => {
    if (e.target.id !== 'public-toggle') return;
    const r = await api('/api/me', { method: 'PATCH', body: { isPublic: e.target.checked } });
    if (r.ok) { sync.user = r.data.user; renderAccountCard(); toast(sync.user.isPublic ? 'Profile is public' : 'Profile is private'); }
  });
  $('#account-btn').onclick = () => (sync.user ? showView('profile') : openAuth('login'));

  function openAuth(mode) {
    const signup = mode === 'signup';
    session = null;
    body.innerHTML = `
      <p class="kicker">${signup ? 'Create your Encore account' : 'Welcome back'}</p>
      <h3 class="prompt">${signup ? 'Sign up' : 'Sign in'}</h3>
      <form class="auth-form" id="auth-form">
        ${signup ? '<label>Name<input name="displayName" autocomplete="name" maxlength="40" placeholder="What friends call you" /></label>' : ''}
        <label>Username<input name="username" autocomplete="username" required minlength="3" maxlength="24" pattern="[A-Za-z0-9_.]+" /></label>
        <label>Password<input name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" required minlength="${signup ? 8 : 1}" /></label>
        <p class="form-error hidden" id="auth-error"></p>
        <button class="btn primary wide" type="submit">${signup ? 'Create account' : 'Sign in'}</button>
      </form>
      <p class="center small muted">${signup ? 'Already have an account?' : 'New to Encore?'} <a href="#" data-switch="${signup ? 'login' : 'signup'}">${signup ? 'Sign in' : 'Create one'}</a></p>`;
    openModal();
    body.querySelector('input').focus();
    body.querySelector('[data-switch]').onclick = (e) => { e.preventDefault(); openAuth(e.target.dataset.switch); };
    $('#auth-form').onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      const btn = e.target.querySelector('button');
      btn.disabled = true;
      const r = await api(signup ? '/api/signup' : '/api/login', { method: 'POST', body: f }).catch(() => ({ ok: false, data: { error: 'Network error' } }));
      btn.disabled = false;
      if (!r.ok) { const er = $('#auth-error'); er.textContent = r.data.error || 'Something went wrong'; er.classList.remove('hidden'); return; }
      closeModal();
      const note = signedIn(r.data.user, r.data);
      toast((signup ? `Welcome, ${r.data.user.displayName}!` : `Signed in as @${r.data.user.username}`) + (note ? ' ' + note + '.' : ''));
    };
  }

  // ----- Other people's profiles -----
  let viewing = null;
  const userUI = { seg: 'songs' };
  async function openUser(username) {
    const r = await api('/api/users/' + encodeURIComponent(username)).catch(() => ({ ok: false }));
    if (!r.ok) { toast('That profile is private or does not exist'); return; }
    viewing = { ...r.data, mine: false };
    userUI.seg = 'songs';
    document.querySelectorAll('#user-seg button').forEach((b) => b.classList.toggle('active', b.dataset.seg === 'songs'));
    renderUser();
    showView('user');
  }
  function renderUser() {
    const u = viewing.user;
    $('#user-avatar').innerHTML = initials(u.displayName);
    $('#user-name').textContent = u.displayName;
    const n = rankedCount(viewing);
    const mine = scoreMapOf(state.rankings);
    const common = R.flatten(viewing.rankings).filter((e) => mine[e.id]);
    let match = '';
    if (common.length >= 3) {
      const diff = common.reduce((a, e) => a + Math.abs(e.score - mine[e.id].score), 0) / common.length;
      match = ` · ${Math.max(0, Math.round(100 - diff * 10))}% taste match`;
    }
    $('#user-sub').textContent = `@${u.username} · ${n} songs ranked${common.length ? ` · ${common.length} in common` : ''}${match}`;
    const shown = renderCollection($('#user-list'), viewing, { seg: userUI.seg, readOnly: true });
    const empty = $('#user-empty');
    empty.textContent = `${u.displayName} hasn't ranked any songs yet.`;
    empty.classList.toggle('hidden', shown > 0);
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
        ? users.map((u) => `<li data-user="${esc(u.username)}"><span class="avatar">${initials(u.displayName)}</span><div><b>${esc(u.displayName)}</b><div class="muted small">@${esc(u.username)} · ${u.ranked} ranked</div></div><span class="chev">›</span></li>`).join('')
        : '<li class="muted small">No public profiles match.</li>';
    }, 250);
  });
  $('#people-results').addEventListener('click', (e) => { const li = e.target.closest('[data-user]'); if (li) openUser(li.dataset.user); });
  $('#user-back').onclick = () => { viewing = null; history.replaceState(null, '', location.pathname); showView('profile'); };

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
  /** Configure MusicKit with a developer token minted by our server. */
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
      am.music = await MusicKit.configure({ developerToken: am.devToken, app: { name: 'Encore', build: '2.0' } });
      am.music.addEventListener('playbackStateDidChange', refreshPlayIcons);
      return am.music;
    })();
    am.loading.catch(() => { am.loading = null; });
    return am.loading;
  }
  async function amConnect() {
    try {
      const music = await amInit();
      await music.authorize();
      localStorage.setItem(AM_FLAG, '1');
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
    localStorage.removeItem(AM_FLAG);
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
    let next = '/v1/me/library/songs?limit=100&include=catalog';
    for (let page = 0; next && page < 3; page++) {
      const d = await amFetch(next);
      (d.data || []).forEach((r) => { const c = r.relationships?.catalog?.data?.[0]; if (c && c.attributes) out.push(amToSong(c)); });
      next = d.next ? d.next + (d.next.includes('include=') ? '' : '&include=catalog') : null;
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
      toast(`Playlist “Encore Top ${ids.length}” added to your Apple Music library`);
    } catch (_) { toast('Could not create the playlist'); }
  }
  function renderAmUI() {
    document.querySelectorAll('.am-only').forEach((el) => el.classList.toggle('hidden', !amConnected()));
    renderAmCard();
  }
  function renderAmCard() {
    const el = $('#am-card');
    if (amConnected()) {
      el.innerHTML = `<h3><span class="am-badge"></span> Apple Music connected</h3>
        <p class="muted small">Rank songs straight from your recently played and library (in Discover), play full songs with your subscription, and save your rankings as a playlist.</p>
        <div class="row-buttons"><button class="btn primary" data-am="playlist">Save Top 25 as playlist</button><button class="btn" data-am="disconnect">Disconnect</button></div>`;
    } else {
      el.innerHTML = `<h3><span class="am-badge"></span> Apple Music</h3>
        <p class="muted small">Link your Apple Music account to rank from your library and recently played, hear full songs instead of previews, and export your list as a playlist.</p>
        ${am.error ? `<p class="form-error small">${esc(am.error)}</p>` : ''}
        <div class="row-buttons"><button class="btn primary" data-am="connect">Connect Apple Music</button></div>`;
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
  // Playback: full songs through Apple Music when linked, else 30s previews
  // =====================================================================
  const player = $('#player');
  let playingId = null;
  let playingFull = false;
  function isPlaying(id) {
    if (playingId !== id) return false;
    if (playingFull) return am.music && am.music.playbackState === MusicKit.PlaybackStates.playing;
    return !player.paused;
  }
  async function togglePlay(song) {
    if (isPlaying(song.id)) {
      if (playingFull) am.music.pause(); else player.pause();
      refreshPlayIcons();
      return;
    }
    player.pause();
    if (amConnected() && /^\d+$/.test(song.id)) {
      try {
        playingId = song.id; playingFull = true;
        await am.music.setQueue({ song: song.id, startPlaying: true });
        refreshPlayIcons();
        return;
      } catch (_) { playingFull = false; /* not a subscriber, etc. → preview */ }
    }
    if (am.music) { try { am.music.stop(); } catch (_) { /* ignore */ } }
    if (!song.preview) { toast('No preview available for this song'); return; }
    playingFull = false;
    player.src = song.preview;
    playingId = song.id;
    player.play().catch(() => toast('Could not play preview'));
    refreshPlayIcons();
  }
  player.addEventListener('ended', () => { playingId = null; refreshPlayIcons(); });
  player.addEventListener('pause', refreshPlayIcons);
  player.addEventListener('play', refreshPlayIcons);
  function refreshPlayIcons() {
    document.querySelectorAll('[data-act="play"]').forEach((b) => {
      const id = b.closest('[data-id]')?.dataset.id;
      const icon = b.querySelector('.play-icon');
      if (icon) icon.textContent = isPlaying(id) ? '❚❚' : '▶';
    });
  }

  // =====================================================================
  // Ranking flow (the Beli part)
  // =====================================================================
  const modal = $('#modal');
  const body = $('#modal-body');
  let session = null;

  function openModal() { modal.classList.remove('hidden'); document.body.classList.add('no-scroll'); body.parentElement.scrollTop = 0; }
  function closeModal() { modal.classList.add('hidden'); document.body.classList.remove('no-scroll'); session = null; }
  $('#modal-close').onclick = closeModal;
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  document.addEventListener('keydown', (e) => {
    if (modal.classList.contains('hidden')) return;
    if (e.key === 'Escape') closeModal();
    if (session && session.stage === 'compare') {
      if (e.key === 'ArrowLeft' || e.key === '1') choose('new');
      if (e.key === 'ArrowRight' || e.key === '2') choose('old');
      if (e.key === '0') choose('tie');
    }
  });

  function bigCard(song, act) {
    return `
      <div class="card" ${act ? `data-choose="${act}"` : ''} data-id="${esc(song.id)}">
        <div class="card-art">
          ${artImg(song, 600)}
          <button class="card-play" data-act="play" aria-label="Play"><span class="play-icon">${isPlaying(song.id) ? '❚❚' : '▶'}</span></button>
        </div>
        <div class="card-title">${esc(song.title)}</div>
        <div class="card-artist">${esc(song.artist)}</div>
      </div>`;
  }

  function startRanking(song) {
    remember(song);
    session = { song, stage: 'react' };
    const current = R.bucketOf(state.rankings, song.id);
    body.innerHTML = `
      <p class="kicker">${current ? 'Re-rank' : 'Rank a song'}</p>
      ${bigCard(song)}
      <h3 class="prompt">How did you feel about it?</h3>
      <div class="reactions">
        <button class="react liked" data-bucket="liked"><span>😍</span>I loved it</button>
        <button class="react fine" data-bucket="fine"><span>🙂</span>It was fine</button>
        <button class="react disliked" data-bucket="disliked"><span>😕</span>Didn't like it</button>
      </div>`;
    openModal();
  }
  function pickBucket(bucket) {
    const s = R.startPlacement(state.rankings, bucket, session.song.id);
    Object.assign(session, { stage: 'compare', placement: s, total: R.maxSteps(s.list.length) });
    step();
  }
  function step() {
    const p = session.placement;
    const oppId = R.nextOpponent(p);
    if (!oppId) return finish();
    const opp = state.songs[oppId];
    const dots = Array.from({ length: session.total }, (_, i) => `<i class="${i < p.steps ? 'done' : ''}"></i>`).join('');
    body.innerHTML = `
      <p class="kicker">${BUCKET_LABEL[p.bucket]} · question ${p.steps + 1}</p>
      <h3 class="prompt">Which do you like more?</h3>
      <div class="versus">
        ${bigCard(session.song, 'new')}
        <div class="or">or</div>
        ${bigCard(opp, 'old')}
      </div>
      <div class="dots">${dots}</div>
      <div class="row-buttons center"><button class="btn ghost" data-choose="tie">Too tough — they're about even</button></div>`;
  }
  function choose(choice) {
    if (!session || session.stage !== 'compare') return;
    R.answer(session.placement, choice);
    step();
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
    body.innerHTML = `
      <p class="kicker">${isNew ? 'Added to your list' : 'Re-ranked'}</p>
      ${bigCard(song)}
      <div class="result">
        <div class="score big ${e.bucket}">${e.score.toFixed(1)}</div>
        <div>#${e.rank} of ${rankedCount(state)} in your rankings</div>
      </div>
      <div class="avg-box">
        ${avgLine(groupOf(state.rankings, state.songs, 'artist', song), 'artist')}
        ${avgLine(groupOf(state.rankings, state.songs, 'album', song), 'album')}
      </div>
      <div class="row-buttons center">
        <button class="btn" data-done="list">View my list</button>
        <button class="btn primary" data-done="close">Done</button>
      </div>`;
    renderAll();
  }

  body.addEventListener('click', (e) => {
    const play = e.target.closest('[data-act="play"]');
    if (play) {
      e.stopPropagation();
      const id = play.closest('[data-id]').dataset.id;
      const song = state.songs[id] || (viewing && viewing.songs[id]) || lastResults.find((s) => s.id === id);
      if (song) togglePlay(song);
      return;
    }
    const react = e.target.closest('[data-bucket]');
    if (react && session?.stage === 'react') return pickBucket(react.dataset.bucket);
    const ch = e.target.closest('[data-choose]');
    if (ch) return choose(ch.dataset.choose);
    const done = e.target.closest('[data-done]');
    if (done) { closeModal(); if (done.dataset.done === 'list') showView('list'); return; }
    const det = e.target.closest('[data-detail]');
    if (det) return detailAction(det.dataset.detail);
    const gs = e.target.closest('[data-group-song]');
    if (gs && groupCtx) { const s = groupCtx.data.songs[gs.dataset.groupSong]; if (s) openDetail(s, groupCtx.data.mine ? null : groupCtx.data); }
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
    body.innerHTML = `
      ${bigCard(song)}
      <div class="detail-meta">${esc(song.album)}${song.year ? ' · ' + song.year : ''}${song.genre ? ' · ' + esc(song.genre) : ''}</div>
      ${mine ? `<div class="result"><div class="score big ${mine.bucket}">${mine.score.toFixed(1)}</div><div>Your #${mine.rank} · ${BUCKET_LABEL[mine.bucket]}</div></div>` : ''}
      ${theirs ? `<p class="center muted">${esc(other.user.displayName)} gave it <b class="${theirs.bucket}-text">${theirs.score.toFixed(1)}</b> (#${theirs.rank})</p>` : ''}
      ${artistG || albumG ? `<div class="avg-box"><p class="small muted">Your averages</p>${avgLine(artistG, 'artist')}${avgLine(albumG, 'album')}</div>` : ''}
      <div class="row-buttons center">
        ${song.url ? `<a class="btn" href="${esc(song.url)}" target="_blank" rel="noopener">Open in Apple Music</a>` : ''}
        <button class="btn primary" data-detail="rank">${mine ? 'Re-rank' : 'Rank it'}</button>
        <button class="btn" data-detail="later">${state.later.includes(song.id) ? 'Unsave' : 'Want to listen'}</button>
        ${mine ? '<button class="btn danger" data-detail="remove">Remove</button>' : ''}
      </div>`;
    openModal();
  }
  function detailAction(act) {
    const song = detailSong;
    if (!song) return;
    if (act === 'rank') startRanking(song);
    else if (act === 'later') { toggleLater(song); openDetail(song); }
    else if (act === 'remove') {
      state.rankings = R.remove(state.rankings, song.id);
      save(); renderAll(); closeModal(); toast('Removed from your rankings');
    }
  }

  // ----- Artist / album detail -----
  let groupCtx = null;
  function openGroup(g, data) {
    groupCtx = { g, data };
    session = null;
    const whose = data.mine ? 'Your' : esc(data.user.displayName) + '’s';
    body.innerHTML = `
      <div class="group-head">
        <div class="card-art ${g.kind === 'artist' ? 'round' : ''}">${artImg(g.top, 600)}</div>
        <p class="kicker">${g.kind === 'artist' ? 'Artist' : 'Album · ' + esc(g.artist)}</p>
        <h3 class="prompt tight">${esc(g.name)}</h3>
        <div class="result"><div class="score big ${bucketForScore(g.avg)}">${g.avg.toFixed(1)}</div>
        <div>${whose} average across ${g.count} ranked song${g.count > 1 ? 's' : ''}</div></div>
      </div>
      <ol class="song-list mini">
        ${g.entries.map((e) => { const s = data.songs[e.id]; return `<li class="song" data-group-song="${esc(e.id)}">
          <div class="rank">${e.rank}</div><div class="art sm">${artImg(s, 120)}</div>
          <div class="meta"><div class="title">${esc(s.title)}</div><div class="artist">${esc(g.kind === 'artist' ? s.album : s.artist)}</div></div>
          <span class="score ${e.bucket}">${e.score.toFixed(1)}</span></li>`; }).join('')}
      </ol>`;
    openModal();
  }

  // =====================================================================
  // Navigation + misc UI
  // =====================================================================
  function showView(name) {
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === (name === 'user' ? 'profile' : name)));
    window.scrollTo(0, 0);
  }
  document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => showView(t.dataset.view)));
  function segBind(sel, onPick) {
    document.querySelectorAll(sel + ' button').forEach((b) => (b.onclick = () => {
      document.querySelectorAll(sel + ' button').forEach((x) => x.classList.toggle('active', x === b));
      onPick(b);
    }));
  }
  segBind('#list-seg', (b) => { listUI.seg = b.dataset.seg; renderRanked(); });
  segBind('#bucket-chips', (b) => { listUI.bucket = b.dataset.bucket; renderRanked(); });
  segBind('#group-sort', (b) => { listUI.sort = b.dataset.sort; renderRanked(); });
  segBind('#user-seg', (b) => { userUI.seg = b.dataset.seg; renderUser(); });
  function setSource(s) {
    source = s;
    document.querySelectorAll('#source-chips .chip').forEach((x) => x.classList.toggle('active', x.dataset.source === s));
    $('#search').value = '';
    loadResults();
  }
  document.querySelectorAll('#source-chips .chip').forEach((c) => (c.onclick = () => setSource(c.dataset.source)));
  $('#list-filter').addEventListener('input', renderRanked);
  $('#search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadResults, 300); });

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 2200);
  }

  const COUNTRIES = { us: 'US', gb: 'UK', ca: 'Canada', au: 'Australia', ie: 'Ireland', nz: 'New Zealand', de: 'Germany', fr: 'France', es: 'Spain', it: 'Italy', nl: 'Netherlands', se: 'Sweden', br: 'Brazil', mx: 'Mexico', jp: 'Japan', kr: 'Korea', in: 'India', ng: 'Nigeria', za: 'South Africa' };
  const sel = $('#country');
  sel.innerHTML = Object.entries(COUNTRIES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  sel.onchange = () => { state.country = sel.value; save(); loadResults(); };

  $('#export').onclick = () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'encore-rankings.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };
  $('#import').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!data.rankings || !data.songs) throw new Error('bad file');
      state = normalize(data);
      save(); afterStateChange(); toast('List imported');
    } catch (_) { toast('That file is not an Encore export'); }
    e.target.value = '';
  };
  $('#reset').onclick = () => {
    if (!confirm('Delete all your rankings and saved songs?')) return;
    state = defaultState(); save(); renderAll(); toast('Everything reset');
  };

  // =====================================================================
  // Boot
  // =====================================================================
  bindList($('#results'), (id) => lastResults.find((s) => s.id === id) || state.songs[id]);
  bindList($('#ranked'), (id) => state.songs[id]);
  bindList($('#later'), (id) => state.songs[id]);
  bindList($('#top-artists'), (id) => state.songs[id]);
  bindList($('#top-albums'), (id) => state.songs[id]);
  bindList($('#user-list'), (id) => viewing && viewing.songs[id], () => viewing);

  (async function boot() {
    state = normalize(readJSON(GUEST_KEY));
    sel.value = COUNTRIES[state.country] ? state.country : (state.country = 'us');
    renderAll();
    // Is the Encore server here (accounts available)?
    if (location.protocol.startsWith('http')) {
      try {
        const r = await api('/api/me');
        if (r.ok && 'user' in r.data) {
          sync.server = true;
          if (r.data.user) signedIn(r.data.user, r.data);
        }
      } catch (_) { /* static hosting: guest mode only */ }
    }
    renderAll();
    refreshSongMeta();
    loadResults();
    const u = new URLSearchParams(location.search).get('u');
    if (u && sync.server) openUser(u);
    if (localStorage.getItem(AM_FLAG) && sync.server) amInit().then(renderAmUI).catch(() => {});
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
  })();
})();
