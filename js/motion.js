/*
 * Encore motion kit. Everything here animates transform / opacity only
 * (plus SVG stroke-dashoffset for score rings) and turns itself off for
 * prefers-reduced-motion.
 */
(function () {
  const mq = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  const reduced = () => mq.matches;

  // Spring curves sampled from a damped harmonic oscillator (k=170, c=22 and k=300, c=20).
  const SPRING = 'linear(0, 0.053, 0.161, 0.292, 0.424, 0.547, 0.655, 0.745, 0.817, 0.873, 0.916, 0.947, 0.969, 0.984, 0.994, 1, 1.004, 1.006, 1.006, 1.005, 1.004, 1.003, 1.002, 1.001, 1)';
  const BOUNCE = 'linear(0, 0.095, 0.284, 0.504, 0.709, 0.875, 0.993, 1.065, 1.099, 1.105, 1.093, 1.072, 1.049, 1.028, 1.011, 0.999, 0.992, 0.989, 0.991, 0.995, 1)';
  const supportsLinear = window.CSS && CSS.supports && CSS.supports('transition-timing-function', 'linear(0, 1)');
  const spring = supportsLinear ? SPRING : 'cubic-bezier(.2, .9, .25, 1.05)';
  const bounce = supportsLinear ? BOUNCE : 'cubic-bezier(.3, 1.4, .5, 1)';

  /** Light haptic tick where supported (Android Chrome; iOS Safari ignores it). */
  function haptic(pattern = 8) {
    try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (_) { /* ignore */ }
  }

  function animate(el, keyframes, opts) {
    if (!el || !el.animate) return Promise.resolve();
    if (reduced()) { opts = { ...opts, duration: 1 }; }
    const a = el.animate(keyframes, { fill: 'both', easing: spring, duration: 420, ...opts });
    return a.finished.catch(() => {});
  }

  /** Count a number up from 0 (or `from`) with easing; writes textContent. */
  /** Score label: one decimal, except a perfect 10 (keeps the ring's label narrow). */
  const fmt = (v) => (v >= 9.995 ? '10' : v.toFixed(1));
  function countUp(el, to, { from = 0, duration = 1100, format = fmt } = {}) {
    if (!el) return;
    if (reduced()) { el.textContent = format(to); return; }
    const t0 = performance.now();
    const ease = (t) => 1 - Math.pow(1 - t, 4);
    function frame(now) {
      const t = Math.min(1, (now - t0) / duration);
      el.textContent = format(t < 1 ? from + (to - from) * ease(t) : to);
      if (t < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  /**
   * Score ring markup. `value` 0–10. Rings start empty when `animate` is set,
   * then fill via fillRings().
   */
  function ring(value, { size = 44, stroke = 4, animate = false, label = true, cls = '' } = {}) {
    const r = 50 - stroke * 1.25;
    const pct = Math.max(0, Math.min(100, value * 10));
    return `<span class="ring ${cls}" style="--size:${size}px" data-value="${value}">
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle class="ring-track" cx="50" cy="50" r="${r}" stroke-width="${stroke * 2.4}"/>
        <circle class="ring-fill" cx="50" cy="50" r="${r}" stroke-width="${stroke * 2.4}" pathLength="100"
          style="stroke-dashoffset:${animate ? 100 : 100 - pct}"/>
      </svg>
      ${label ? `<b class="ring-num" ${animate ? 'data-count' : ''}>${animate ? '0.0' : fmt(value)}</b>` : ''}
    </span>`;
  }
  /** Fill any rings inside `root` that were rendered with animate:true. */
  function fillRings(root, { delay = 80 } = {}) {
    root.querySelectorAll('.ring').forEach((r, i) => {
      const v = parseFloat(r.dataset.value);
      const fill = r.querySelector('.ring-fill');
      const num = r.querySelector('[data-count]');
      const go = () => {
        if (fill) fill.style.strokeDashoffset = String(100 - v * 10);
        if (num) countUp(num, v, { duration: r.classList.contains('ring-hero') ? 1300 : 800 });
      };
      if (reduced()) go(); else setTimeout(() => requestAnimationFrame(go), delay + i * 60);
    });
  }

  /**
   * FLIP: record positions of `items`, run `mutate`, then animate each item
   * from its old position to its new one with a spring.
   */
  function flip(container, selector, mutate) {
    const before = new Map();
    container.querySelectorAll(selector).forEach((el) => before.set(el.dataset.key || el.dataset.id, el.getBoundingClientRect()));
    mutate();
    if (reduced()) return;
    container.querySelectorAll(selector).forEach((el) => {
      const b = before.get(el.dataset.key || el.dataset.id);
      if (!b) { animate(el, [{ opacity: 0, transform: 'scale(.96)' }, { opacity: 1, transform: 'none' }], { duration: 360 }); return; }
      const a = el.getBoundingClientRect();
      const dy = b.top - a.top;
      if (Math.abs(dy) > 0.5) animate(el, [{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 520 });
    });
  }

  /**
   * Shared-element transition: a copy of `fromEl` flies (translate + scale)
   * onto `toEl`'s spot, then `toEl` takes over. Both should be square covers.
   */
  function shared(fromEl, toEl, { duration = 560, radiusTo = 28 } = {}) {
    if (!fromEl || !toEl || reduced()) return Promise.resolve();
    const a = fromEl.getBoundingClientRect();
    const b = toEl.getBoundingClientRect();
    if (!a.width || !b.width) return Promise.resolve();
    const ghost = fromEl.cloneNode(true);
    const cs = getComputedStyle(fromEl);
    Object.assign(ghost.style, {
      position: 'fixed', left: b.left + 'px', top: b.top + 'px', width: b.width + 'px', height: b.height + 'px',
      margin: 0, zIndex: 80, borderRadius: radiusTo + 'px', overflow: 'hidden', pointerEvents: 'none',
      transformOrigin: '0 0', boxShadow: '0 30px 80px -20px rgba(0,0,0,.7)', opacity: 1,
    });
    ghost.classList.add('ghost');
    ghost.querySelectorAll('img').forEach((i) => { i.style.opacity = 1; i.style.width = '100%'; i.style.height = '100%'; i.style.objectFit = 'cover'; });
    document.body.appendChild(ghost);
    toEl.style.opacity = '0';
    const sx = a.width / b.width;
    const sy = a.height / b.height;
    const startRadius = parseFloat(cs.borderRadius) / sx || 8;
    return animate(ghost, [
      { transform: `translate(${a.left - b.left}px, ${a.top - b.top}px) scale(${sx}, ${sy})`, borderRadius: startRadius + 'px' },
      { transform: 'none', borderRadius: radiusTo + 'px' },
    ], { duration, fill: 'forwards' }).then(() => {
      toEl.style.opacity = '';
      ghost.remove();
    });
  }

  /** Fade images in once decoded; avoids pop-in. Call once at startup. */
  function initImageFade() {
    const done = (img) => img.classList.add('in');
    document.addEventListener('load', (e) => { if (e.target.tagName === 'IMG') done(e.target); }, true);
    // Images already complete (from cache) before the listener saw them:
    new MutationObserver((muts) => {
      for (const m of muts) m.addedNodes.forEach((n) => {
        if (n.nodeType !== 1) return;
        (n.tagName === 'IMG' ? [n] : n.querySelectorAll('img')).forEach((img) => { if (img.complete && img.naturalWidth) done(img); });
      });
    }).observe(document.body, { childList: true, subtree: true });
  }

  window.Motion = { reduced, haptic, animate, countUp, fmt, ring, fillRings, flip, shared, initImageFade, spring, bounce };
})();
