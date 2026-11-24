/*
 * ⌘K / Ctrl+K command palette: jump anywhere, run actions, and search the
 * Apple Music catalog without leaving the keyboard.
 */
(function () {
  let cfg = null, root, input, listEl, items = [], sel = 0, open = false, seq = 0, timer = 0, lastFocus = null;

  /** Subsequence fuzzy score (higher is better, -1 = no match). */
  function score(q, text) {
    q = q.toLowerCase(); text = text.toLowerCase();
    if (!q) return 0;
    if (text.startsWith(q)) return 100 - text.length * 0.01;
    const i = text.indexOf(q);
    if (i >= 0) return 80 - i;
    let ti = 0, s = 0, run = 0;
    for (const ch of q) {
      const j = text.indexOf(ch, ti);
      if (j < 0) return -1;
      run = j === ti ? run + 1 : 0;
      s += 1 + run * 2;
      ti = j + 1;
    }
    return s;
  }
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function build() {
    root = document.createElement('div');
    root.className = 'palette';
    root.hidden = true;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Command palette');
    root.innerHTML = `
      <div class="palette-box">
        <div class="palette-input">${Icons.search}<input id="palette-q" type="text" placeholder="Search songs or type a command…" autocomplete="off" spellcheck="false" aria-controls="palette-list" /><kbd>esc</kbd></div>
        <ul class="palette-list" id="palette-list" role="listbox"></ul>
        <div class="palette-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> rank / run</span><span><kbd>⇧</kbd><kbd>↵</kbd> play</span></div>
      </div>`;
    document.body.appendChild(root);
    input = root.querySelector('input');
    listEl = root.querySelector('.palette-list');
    root.addEventListener('pointerdown', (e) => { if (e.target === root) close(); });
    input.addEventListener('input', refresh);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); run(items[sel], e.shiftKey ? 'play' : 'primary'); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    listEl.addEventListener('click', (e) => {
      const li = e.target.closest('li[data-i]');
      if (li) run(items[+li.dataset.i], e.target.closest('[data-play]') ? 'play' : 'primary');
    });
    listEl.addEventListener('pointermove', (e) => {
      const li = e.target.closest('li[data-i]');
      if (li && +li.dataset.i !== sel) { sel = +li.dataset.i; paint(); }
    });
  }

  function move(d) { if (!items.length) return; sel = (sel + d + items.length) % items.length; paint(); }
  function paint() {
    listEl.querySelectorAll('li[data-i]').forEach((li) => {
      const on = +li.dataset.i === sel;
      li.classList.toggle('sel', on);
      li.setAttribute('aria-selected', on);
      if (on) li.scrollIntoView({ block: 'nearest' });
    });
  }
  function render(songs, loading) {
    let html = '';
    const cmds = items.filter((x) => x.type === 'cmd');
    if (cmds.length) html += '<li class="palette-head">Actions</li>' + cmds.map((c) => `<li data-i="${items.indexOf(c)}" role="option">${Icons[c.icon] || ''}<span class="pl">${esc(c.label)}</span>${c.hint ? `<kbd>${esc(c.hint)}</kbd>` : ''}</li>`).join('');
    if (songs.length || loading) html += '<li class="palette-head">Songs on Apple Music</li>';
    if (loading && !songs.length) html += '<li class="palette-skel"><i></i><i></i></li><li class="palette-skel"><i></i><i></i></li>';
    html += items.filter((x) => x.type === 'song').map((s) => {
      const song = s.song;
      return `<li data-i="${items.indexOf(s)}" role="option" class="song-opt">
        <img src="${esc(cfg.art(song, 80))}" alt="" />
        <span class="pl"><b>${esc(song.title)}</b><small>${esc(song.artist)}${song.album ? ' · ' + esc(song.album) : ''}</small></span>
        ${s.score != null ? `<span class="pl-score">${s.score.toFixed(1)}</span>` : ''}
        <button class="pl-play" data-play aria-label="Play preview">${Icons.play}</button></li>`;
    }).join('');
    if (!html) html = '<li class="palette-empty">No matches. Try an artist or song name.</li>';
    listEl.innerHTML = html;
    if (sel >= items.length) sel = 0;
    paint();
  }
  function refresh() {
    const q = input.value.trim();
    const cmds = cfg.commands()
      .map((c) => ({ ...c, type: 'cmd', s: q ? Math.max(score(q, c.label), ...(c.keywords || []).map((k) => score(q, k) - 5)) : 0 }))
      .filter((c) => c.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, q ? 5 : 8);
    items = cmds;
    sel = 0;
    render([], q.length >= 2);
    clearTimeout(timer);
    if (q.length < 2) return;
    const my = ++seq;
    timer = setTimeout(async () => {
      let songs = [];
      try { songs = await cfg.searchSongs(q); } catch (_) { /* offline */ }
      if (my !== seq || !open) return;
      items = cmds.concat(songs.slice(0, 8).map((song) => ({ type: 'song', song, score: cfg.myScore(song) })));
      render(songs, false);
    }, 160);
  }
  function run(item, how) {
    if (!item) return;
    close();
    if (item.type === 'cmd') item.run();
    else cfg.onSong(item.song, how);
  }

  function show() {
    if (open) return;
    if (!root) build();
    lastFocus = document.activeElement;
    open = true;
    root.hidden = false;
    document.body.classList.add('palette-open');
    input.value = '';
    refresh();
    requestAnimationFrame(() => { root.classList.add('in'); input.focus(); });
  }
  function close() {
    if (!open) return;
    open = false;
    root.classList.remove('in');
    document.body.classList.remove('palette-open');
    setTimeout(() => { if (!open) root.hidden = true; }, 180);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  window.Palette = {
    init(config) {
      cfg = config;
      document.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); open ? close() : show(); }
      });
    },
    open: show,
    close,
    get isOpen() { return open; },
  };
})();
