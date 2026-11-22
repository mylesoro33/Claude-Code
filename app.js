/* Encore — Beli-style song ranking on top of the Apple Music catalog. */
(() => {
  'use strict';
  const R = window.Ranking;
  const STORE_KEY = 'encore.v1';
  const $ = (sel) => document.querySelector(sel);

  // ---------- State ----------
  const defaultState = () => ({
    songs: {},              // id -> song metadata (cached from Apple)
    rankings: R.emptyRankings(),
    later: [],              // want-to-listen song ids
    rankedAt: {},           // id -> timestamp
    country: guessCountry(),
  });
  let state = load();

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) return Object.assign(defaultState(), JSON.parse(raw));
    } catch (_) { /* ignore */ }
    return defaultState();
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (_) { /* ignore */ }
  }
  function guessCountry() {
    const m = (navigator.language || 'en-US').match(/-([A-Z]{2})$/i);
    return m ? m[1].toLowerCase() : 'us';
  }

  // ---------- Apple Music catalog (iTunes Search API) ----------
  // Public, keyless, and covers the full Apple Music song catalog.
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
  async function itunes(path, params) {
    const qs = new URLSearchParams(params).toString();
    const url = `https://itunes.apple.com/${path}?${qs}`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(res.status);
      return await res.json();
    } catch (_) {
      return jsonp(url); // CORS fallback
    }
  }
  function toSong(r) {
    return {
      id: String(r.trackId),
      title: r.trackName,
      artist: r.artistName,
      album: r.collectionName || '',
      art: (r.artworkUrl100 || '').replace('100x100bb', '400x400bb'),
      preview: r.previewUrl || '',
      url: r.trackViewUrl || '',
      genre: r.primaryGenreName || '',
      year: r.releaseDate ? r.releaseDate.slice(0, 4) : '',
      explicit: r.trackExplicitness === 'explicit',
    };
  }
  async function searchSongs(term) {
    const data = await itunes('search', { term, media: 'music', entity: 'song', limit: 40, country: state.country });
    return (data.results || []).filter((r) => r.kind === 'song' || r.wrapperType === 'track').map(toSong);
  }
  async function lookupSongs(ids) {
    if (!ids.length) return [];
    const data = await itunes('lookup', { id: ids.join(','), country: state.country, entity: 'song' });
    const byId = {};
    (data.results || []).filter((r) => r.trackId).forEach((r) => { byId[r.trackId] = toSong(r); });
    return ids.map((id) => byId[id]).filter(Boolean);
  }
  async function topSongs() {
    // Apple's public charts feed → then look up full song data (previews, art).
    let ids = [];
    try {
      const res = await fetch(`https://rss.marketingtools.apple.com/api/v2/${state.country}/music/most-played/50/songs.json`);
      const data = await res.json();
      ids = data.feed.results.map((r) => r.id);
    } catch (_) {
      try {
        const data = await jsonp(`https://itunes.apple.com/${state.country}/rss/topsongs/limit=50/json`);
        ids = data.feed.entry.map((e) => e.id.attributes['im:id']);
      } catch (_) { /* charts unavailable */ }
    }
    return lookupSongs(ids.slice(0, 50));
  }

  // ---------- Rendering helpers ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const BUCKET_LABEL = { liked: 'Loved it', fine: 'It was fine', disliked: "Didn't like it" };

  function scoreMap() {
    const m = {};
    R.flatten(state.rankings).forEach((e) => { m[e.id] = e; });
    return m;
  }

  function songRow(song, { rankEntry, showActions = true } = {}) {
    const li = document.createElement('li');
    li.className = 'song';
    li.dataset.id = song.id;
    const ranked = rankEntry || scoreMap()[song.id];
    const saved = state.later.includes(song.id);
    li.innerHTML = `
      ${rankEntry ? `<div class="rank">${rankEntry.rank}</div>` : ''}
      <button class="art" data-act="play" aria-label="Play preview">
        <img src="${esc(song.art)}" alt="" loading="lazy" />
        <span class="play-icon">${playingId === song.id ? '❚❚' : '▶'}</span>
      </button>
      <div class="meta" data-act="open">
        <div class="title">${esc(song.title)}${song.explicit ? ' <span class="e">E</span>' : ''}</div>
        <div class="artist">${esc(song.artist)}</div>
        <div class="album">${esc(song.album)}${song.year ? ' · ' + song.year : ''}</div>
      </div>
      ${showActions ? `
      <div class="actions">
        ${ranked
          ? `<button class="score ${ranked.bucket}" data-act="open" title="Your score">${ranked.score.toFixed(1)}</button>`
          : `<button class="icon-btn add" data-act="rank" aria-label="Rank song">+</button>`}
        <button class="icon-btn ${saved ? 'on' : ''}" data-act="later" aria-label="Want to listen">🔖</button>
      </div>` : ''}`;
    return li;
  }

  function bindList(ul, lookup) {
    ul.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      const li = e.target.closest('li.song');
      if (!btn || !li) return;
      const song = lookup(li.dataset.id);
      if (!song) return;
      const act = btn.dataset.act;
      if (act === 'play') togglePlay(song);
      else if (act === 'rank') startRanking(song);
      else if (act === 'later') toggleLater(song);
      else if (act === 'open') openDetail(song);
    });
  }

  // ---------- Discover ----------
  let lastResults = [];
  let searchTimer = null;
  let searchSeq = 0;

  async function runSearch(term) {
    const seq = ++searchSeq;
    const title = $('#results-title');
    const empty = $('#results-empty');
    empty.classList.add('hidden');
    title.textContent = term ? `Results for “${term}”` : 'Top songs right now';
    $('#results').innerHTML = '<li class="loading">Loading…</li>';
    let songs = [];
    try {
      songs = term ? await searchSongs(term) : await topSongs();
    } catch (err) {
      if (seq !== searchSeq) return;
      $('#results').innerHTML = '';
      empty.textContent = 'Could not reach Apple Music. Check your connection and try again.';
      empty.classList.remove('hidden');
      return;
    }
    if (seq !== searchSeq) return;
    lastResults = songs;
    songs.forEach(cacheSong);
    renderResults();
    if (!songs.length) {
      empty.textContent = term ? 'No songs found. Try another search.' : 'Search for any song on Apple Music to start ranking.';
      empty.classList.remove('hidden');
      if (!term) title.textContent = 'Discover';
    }
  }
  function renderResults() {
    const ul = $('#results');
    ul.innerHTML = '';
    const scores = scoreMap();
    lastResults.forEach((s) => ul.appendChild(songRow(s, { rankEntry: null, showActions: true, _s: scores })));
  }
  function cacheSong(song) {
    // Keep metadata fresh for songs we already track.
    if (state.songs[song.id]) state.songs[song.id] = song;
  }
  function remember(song) {
    state.songs[song.id] = song;
  }

  // ---------- My list ----------
  let bucketFilter = 'all';
  function renderRanked() {
    const ol = $('#ranked');
    ol.innerHTML = '';
    const q = $('#list-filter').value.trim().toLowerCase();
    const entries = R.flatten(state.rankings);
    $('#list-count').textContent = entries.length ? entries.length : '';
    let shown = 0;
    entries.forEach((e) => {
      const s = state.songs[e.id];
      if (!s) return;
      if (bucketFilter !== 'all' && e.bucket !== bucketFilter) return;
      if (q && !`${s.title} ${s.artist} ${s.album} ${s.genre}`.toLowerCase().includes(q)) return;
      ol.appendChild(songRow(s, { rankEntry: e }));
      shown++;
    });
    const empty = $('#ranked-empty');
    if (!entries.length) {
      empty.innerHTML = 'No songs ranked yet. Search for a song in <b>Discover</b> and tap <b>+</b> to rank it.';
      empty.classList.remove('hidden');
    } else if (!shown) {
      empty.textContent = 'No songs match that filter.';
      empty.classList.remove('hidden');
    } else empty.classList.add('hidden');
  }

  // ---------- Want to listen ----------
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
    state.later.forEach((id) => { const s = state.songs[id]; if (s) ul.appendChild(songRow(s)); });
    $('#later-count').textContent = state.later.length || '';
    $('#later-empty').classList.toggle('hidden', state.later.length > 0);
  }

  // ---------- Profile ----------
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
    const tally = (key) => {
      const m = {};
      entries.forEach((e) => {
        const s = state.songs[e.id]; if (!s || !s[key]) return;
        (m[s[key]] = m[s[key]] || { n: 0, sum: 0 });
        m[s[key]].n++; m[s[key]].sum += e.score;
      });
      return Object.entries(m).sort((a, b) => b[1].n - a[1].n || b[1].sum / b[1].n - a[1].sum / a[1].n).slice(0, 5);
    };
    const fill = (sel, rows) => {
      $(sel).innerHTML = rows.length
        ? rows.map(([k, v]) => `<li><span>${esc(k)}</span><span class="muted">${v.n} song${v.n > 1 ? 's' : ''} · avg ${(v.sum / v.n).toFixed(1)}</span></li>`).join('')
        : '<li class="muted">Rank some songs to see this.</li>';
    };
    fill('#top-artists', tally('artist'));
    fill('#top-genres', tally('genre'));
  }

  function renderAll() {
    renderResults();
    renderRanked();
    renderLater();
    renderProfile();
  }

  // ---------- Audio previews ----------
  const player = $('#player');
  let playingId = null;
  function togglePlay(song) {
    if (!song.preview) { toast('No preview available for this song'); return; }
    if (playingId === song.id && !player.paused) {
      player.pause();
    } else {
      player.src = song.preview;
      player.play().catch(() => toast('Could not play preview'));
      playingId = song.id;
    }
    refreshPlayIcons();
  }
  player.addEventListener('ended', () => { playingId = null; refreshPlayIcons(); });
  player.addEventListener('pause', refreshPlayIcons);
  function refreshPlayIcons() {
    document.querySelectorAll('[data-act="play"]').forEach((b) => {
      const id = b.closest('[data-id]')?.dataset.id;
      const icon = b.querySelector('.play-icon');
      if (icon) icon.textContent = id === playingId && !player.paused ? '❚❚' : '▶';
    });
  }

  // ---------- Ranking flow (the Beli part) ----------
  const modal = $('#modal');
  const body = $('#modal-body');
  let session = null;

  function openModal() { modal.classList.remove('hidden'); document.body.classList.add('no-scroll'); }
  function closeModal() { modal.classList.add('hidden'); document.body.classList.remove('no-scroll'); session = null; }
  $('#modal-close').onclick = closeModal;
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  document.addEventListener('keydown', (e) => {
    if (modal.classList.contains('hidden')) return;
    if (e.key === 'Escape') closeModal();
    if (session && session.stage === 'compare') {
      if (e.key === 'ArrowLeft' || e.key === '1') choose('new');
      if (e.key === 'ArrowRight' || e.key === '2') choose('old');
      if (e.key === ' ' || e.key === '0') { e.preventDefault(); choose('tie'); }
    }
  });

  function bigCard(song, act) {
    return `
      <div class="card" ${act ? `data-choose="${act}"` : ''} data-id="${esc(song.id)}">
        <div class="card-art">
          <img src="${esc(song.art)}" alt="" />
          <button class="card-play" data-act="play" aria-label="Play preview"><span class="play-icon">${playingId === song.id && !player.paused ? '❚❚' : '▶'}</span></button>
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
      <div class="row-buttons center">
        <button class="btn ghost" data-choose="tie">Too tough — they're about even</button>
      </div>`;
  }

  function choose(choice) {
    if (!session || session.stage !== 'compare') return;
    R.answer(session.placement, choice);
    step();
  }

  function finish() {
    const isNew = !R.bucketOf(state.rankings, session.song.id);
    state.rankings = R.commit(state.rankings, session.placement);
    state.rankedAt[session.song.id] = Date.now();
    state.later = state.later.filter((id) => id !== session.song.id);
    save();
    const e = scoreMap()[session.song.id];
    session.stage = 'done';
    body.innerHTML = `
      <p class="kicker">${isNew ? 'Added to your list' : 'Re-ranked'}</p>
      ${bigCard(session.song)}
      <div class="result">
        <div class="score big ${e.bucket}">${e.score.toFixed(1)}</div>
        <div>#${e.rank} of ${R.flatten(state.rankings).length} in your rankings</div>
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
      togglePlay(state.songs[id]);
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
  });

  // ---------- Song detail ----------
  let detailSong = null;
  function openDetail(song) {
    detailSong = song;
    const e = scoreMap()[song.id];
    session = null;
    body.innerHTML = `
      ${bigCard(song)}
      <div class="detail-meta">${esc(song.album)}${song.year ? ' · ' + song.year : ''}${song.genre ? ' · ' + esc(song.genre) : ''}</div>
      ${e ? `<div class="result"><div class="score big ${e.bucket}">${e.score.toFixed(1)}</div><div>#${e.rank} · ${BUCKET_LABEL[e.bucket]}</div></div>` : ''}
      <div class="row-buttons center">
        ${song.url ? `<a class="btn" href="${esc(song.url)}" target="_blank" rel="noopener">Open in Apple Music</a>` : ''}
        <button class="btn primary" data-detail="rank">${e ? 'Re-rank' : 'Rank it'}</button>
        <button class="btn" data-detail="later">${state.later.includes(song.id) ? 'Unsave' : 'Want to listen'}</button>
        ${e ? '<button class="btn danger" data-detail="remove">Remove</button>' : ''}
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

  // ---------- Navigation ----------
  function showView(name) {
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
    window.scrollTo(0, 0);
  }
  document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => showView(t.dataset.view)));
  document.querySelectorAll('#bucket-chips .chip').forEach((c) => (c.onclick = () => {
    bucketFilter = c.dataset.bucket;
    document.querySelectorAll('#bucket-chips .chip').forEach((x) => x.classList.toggle('active', x === c));
    renderRanked();
  }));
  $('#list-filter').addEventListener('input', renderRanked);
  $('#search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const term = e.target.value.trim();
    searchTimer = setTimeout(() => runSearch(term), 300);
  });

  // ---------- Toast ----------
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 1800);
  }

  // ---------- Country / storefront ----------
  const COUNTRIES = { us: 'US', gb: 'UK', ca: 'Canada', au: 'Australia', ie: 'Ireland', nz: 'New Zealand', de: 'Germany', fr: 'France', es: 'Spain', it: 'Italy', nl: 'Netherlands', se: 'Sweden', br: 'Brazil', mx: 'Mexico', jp: 'Japan', kr: 'Korea', in: 'India', ng: 'Nigeria', za: 'South Africa' };
  const sel = $('#country');
  if (!COUNTRIES[state.country]) state.country = 'us';
  sel.innerHTML = Object.entries(COUNTRIES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  sel.value = state.country;
  sel.onchange = () => { state.country = sel.value; save(); runSearch($('#search').value.trim()); };

  // ---------- Import / export ----------
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
      state = Object.assign(defaultState(), data);
      save(); renderAll(); toast('List imported');
    } catch (_) { toast('That file is not an Encore export'); }
    e.target.value = '';
  };
  $('#reset').onclick = () => {
    if (!confirm('Delete all your rankings and saved songs?')) return;
    state = defaultState(); save(); renderAll(); toast('Everything reset');
  };

  // ---------- Boot ----------
  bindList($('#results'), (id) => lastResults.find((s) => s.id === id) || state.songs[id]);
  bindList($('#ranked'), (id) => state.songs[id]);
  bindList($('#later'), (id) => state.songs[id]);
  renderAll();
  runSearch('');
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
