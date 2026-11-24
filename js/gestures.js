/*
 * Encore gestures — pointer-event based, transform-only.
 *   Gestures.swipeRows(list, actionsFor)       swipe a row left / right to act
 *   Gestures.pullToRefresh(indicator, handler)  pull down at the top to refresh
 *   Gestures.dragReorder(list, opts)            grab the grip and drop to re-rank
 */
(function () {
  const M = () => window.Motion;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  /** Rubber-band resistance past `limit`. */
  const rubber = (x, limit) => (Math.abs(x) <= limit ? x : Math.sign(x) * (limit + (Math.abs(x) - limit) * 0.25));

  /**
   * Rows look like <li class="row"><div class="row-under">…</div><div class="row-body">…</div></li>.
   * actionsFor(li) → { right: {run}, left: {run} } (either side optional) or null.
   */
  function swipeRows(list, actionsFor) {
    let st = null;
    let suppressClick = false;

    list.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (e.target.closest('.grip, input, select')) return;
      const li = e.target.closest('li.row');
      if (!li || !list.contains(li)) return;
      const acts = actionsFor(li);
      if (!acts) return;
      st = { li, body: li.querySelector('.row-body'), acts, x0: e.clientX, y0: e.clientY, dx: 0, mode: null, armed: false, id: e.pointerId };
    });

    list.addEventListener('pointermove', (e) => {
      if (!st || e.pointerId !== st.id) return;
      const dx = e.clientX - st.x0;
      const dy = e.clientY - st.y0;
      if (!st.mode) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        st.mode = Math.abs(dx) > Math.abs(dy) * 1.2 ? 'swipe' : 'scroll';
        if (st.mode === 'scroll') { st = null; return; }
        st.li.setPointerCapture(e.pointerId);
        st.li.classList.add('swiping');
      }
      const side = dx > 0 ? 'right' : 'left';
      const allowed = !!st.acts[side];
      const w = st.li.offsetWidth;
      const limit = Math.min(140, w * 0.34);
      st.dx = allowed ? rubber(dx, w * 0.6) : rubber(dx, 0) * 0.5;
      st.body.style.transform = `translate3d(${st.dx}px,0,0)`;
      st.li.dataset.side = side;
      const armed = allowed && Math.abs(dx) > limit;
      if (armed !== st.armed) {
        st.armed = armed;
        st.li.classList.toggle('armed', armed);
        if (armed) M().haptic(10);
      }
    });

    const end = (e) => {
      if (!st || e.pointerId !== st.id) return;
      const s = st; st = null;
      if (!s.mode) return;
      suppressClick = true; setTimeout(() => { suppressClick = false; }, 0);
      s.li.classList.remove('swiping');
      const side = s.dx > 0 ? 'right' : 'left';
      if (s.armed && e.type !== 'pointercancel') {
        const w = s.li.offsetWidth;
        M().animate(s.body, [{ transform: `translate3d(${s.dx}px,0,0)` }, { transform: `translate3d(${side === 'right' ? w : -w}px,0,0)`, opacity: 0.4 }], { duration: 260, easing: 'cubic-bezier(.4,0,.6,1)' })
          .then(() => { s.acts[side].run(s.li); });
      } else {
        M().animate(s.body, [{ transform: `translate3d(${s.dx}px,0,0)` }, { transform: 'translate3d(0,0,0)' }], { duration: 480 })
          .then(() => { s.body.style.transform = ''; s.li.classList.remove('armed'); s.body.getAnimations().forEach((a) => a.cancel()); });
      }
    };
    list.addEventListener('pointerup', end);
    list.addEventListener('pointercancel', end);
    list.addEventListener('click', (e) => { if (suppressClick) { e.stopPropagation(); e.preventDefault(); } }, true);
  }

  /** Touch pull-to-refresh. `isActive()` says whether the current screen supports it. */
  function pullToRefresh(indicator, handler, isActive) {
    const TH = 72;
    let y0 = null, pull = 0, armed = false, busy = false;
    const icon = indicator.querySelector('.ptr-icon');
    const set = (p) => {
      indicator.style.transform = `translate3d(-50%, ${p - 56}px, 0)`;
      indicator.style.opacity = clamp(p / TH, 0, 1);
      if (icon) icon.style.transform = `rotate(${p * 3}deg)`;
    };
    window.addEventListener('touchstart', (e) => {
      if (busy || window.scrollY > 0 || !isActive() || document.body.classList.contains('no-scroll')) return;
      if (e.target.closest('.grip, .mini, .row.swiping')) return;
      y0 = e.touches[0].clientY; pull = 0; armed = false;
    }, { passive: true });
    window.addEventListener('touchmove', (e) => {
      if (y0 == null) return;
      const dy = e.touches[0].clientY - y0;
      if (dy <= 0 || window.scrollY > 0) { if (pull) set(0); y0 = dy < -4 ? null : y0; pull = 0; return; }
      pull = rubber(dy * 0.55, TH * 1.2);
      if (e.cancelable) e.preventDefault();
      set(pull);
      const a = pull >= TH;
      if (a !== armed) { armed = a; indicator.classList.toggle('armed', a); if (a) M().haptic(12); }
    }, { passive: false });
    window.addEventListener('touchend', async () => {
      if (y0 == null) return;
      y0 = null;
      if (!armed) { M().animate(indicator, [{ transform: indicator.style.transform, opacity: indicator.style.opacity }, { transform: 'translate3d(-50%,-56px,0)', opacity: 0 }], { duration: 300 }).then(() => { indicator.getAnimations().forEach((a) => a.cancel()); set(0); }); return; }
      busy = true;
      indicator.classList.add('spinning');
      set(TH * 0.8);
      try { await handler(); } catch (_) { /* handler shows its own errors */ }
      indicator.classList.remove('spinning', 'armed');
      busy = false; armed = false;
      M().animate(indicator, [{ transform: indicator.style.transform, opacity: 1 }, { transform: 'translate3d(-50%,-56px,0)', opacity: 0 }], { duration: 320 }).then(() => { indicator.getAnimations().forEach((a) => a.cancel()); set(0); });
    });
  }

  /**
   * Drag-to-rank. Grab `.grip` inside an li[data-id]; neighbours glide out of the
   * way; the row snaps into its slot on release. onDrop(id, from, to) commits.
   */
  function dragReorder(list, { onDrop, canDrag = () => true }) {
    let st = null;
    let raf = 0;

    function layout() {
      const rows = [...list.querySelectorAll(':scope > li[data-id]')];
      return rows.map((el) => { const r = el.getBoundingClientRect(); return { el, top: r.top + window.scrollY, h: r.height }; });
    }

    function update() {
      if (!st) return;
      const dy = st.y - st.y0 + (window.scrollY - st.scroll0);
      st.row.el.style.transform = `translate3d(0, ${dy}px, 0) scale(1.03)`;
      // Where would the dragged row's centre land?
      const center = st.row.top + st.row.h / 2 + dy;
      let to = st.from;
      st.rows.forEach((r, i) => {
        if (i === st.from) return;
        const mid = r.top + r.h / 2;
        if (i < st.from && center < mid) to = Math.min(to, i);
        if (i > st.from && center > mid) to = Math.max(to, i);
      });
      if (to !== st.to) {
        st.to = to;
        M().haptic(6);
        st.rows.forEach((r, i) => {
          if (i === st.from) return;
          let shift = 0;
          if (st.from < to && i > st.from && i <= to) shift = -st.row.h;
          if (st.from > to && i >= to && i < st.from) shift = st.row.h;
          r.el.style.transform = shift ? `translate3d(0, ${shift}px, 0)` : '';
        });
      }
    }

    function autoScroll() {
      if (!st) return;
      const edge = 90;
      const vh = window.innerHeight;
      let v = 0;
      if (st.y < edge) v = -(edge - st.y) / 6;
      else if (st.y > vh - edge - 80) v = (st.y - (vh - edge - 80)) / 6;
      if (v) { window.scrollBy(0, v); update(); }
      raf = requestAnimationFrame(autoScroll);
    }

    list.addEventListener('pointerdown', (e) => {
      const grip = e.target.closest('.grip');
      if (!grip || !canDrag()) return;
      const li = grip.closest('li[data-id]');
      if (!li) return;
      e.preventDefault();
      const rows = layout();
      const from = rows.findIndex((r) => r.el === li);
      st = { rows, from, to: from, row: rows[from], y0: e.clientY, y: e.clientY, scroll0: window.scrollY, id: e.pointerId };
      grip.setPointerCapture(e.pointerId);
      list.classList.add('reordering');
      li.classList.add('dragging');
      rows.forEach((r) => { if (r.el !== li) r.el.classList.add('shifting'); });
      M().haptic(14);
      raf = requestAnimationFrame(autoScroll);
      update();
    });
    list.addEventListener('pointermove', (e) => {
      if (!st || e.pointerId !== st.id) return;
      st.y = e.clientY;
      update();
    });
    const finish = (e) => {
      if (!st || e.pointerId !== st.id) return;
      cancelAnimationFrame(raf);
      const s = st; st = null;
      const cancelled = e.type === 'pointercancel';
      const to = cancelled ? s.from : s.to;
      // Snap the dragged row into its slot.
      let target = 0;
      if (to > s.from) for (let i = s.from + 1; i <= to; i++) target += s.rows[i].h;
      if (to < s.from) for (let i = to; i < s.from; i++) target -= s.rows[i].h;
      const fromT = s.row.el.style.transform;
      M().animate(s.row.el, [{ transform: fromT }, { transform: `translate3d(0, ${target}px, 0) scale(1)` }], { duration: 380, easing: M().bounce }).then(() => {
        s.rows.forEach((r) => { r.el.style.transform = ''; r.el.classList.remove('shifting', 'dragging'); r.el.getAnimations().forEach((a) => a.cancel()); });
        list.classList.remove('reordering');
        if (to !== s.from) { M().haptic([6, 30, 12]); onDrop(s.row.el.dataset.id, s.from, to); }
      });
    };
    list.addEventListener('pointerup', finish);
    list.addEventListener('pointercancel', finish);
  }

  window.Gestures = { swipeRows, pullToRefresh, dragReorder };
})();
