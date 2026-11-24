/*
 * Encore audio engine: two decks that crossfade between 30-second previews,
 * plus an analyser for the mini player's live waveform.
 *
 * Web Audio needs CORS-readable media. If Apple's preview host ever refuses
 * that, we fall back to plain <audio> decks (still crossfading where the
 * browser lets us set volume; the waveform then shows the song's progress
 * instead of live levels).
 */
(function () {
  const FADE = 0.6; // seconds
  let ctx = null, analyser = null, master = null;
  let webAudio = true;
  const listeners = {};
  const emit = (ev, d) => (listeners[ev] || []).forEach((fn) => fn(d));

  function makeDeck(withGraph) {
    const el = new Audio();
    el.preload = 'auto';
    el.playsInline = true;
    const deck = { el, gain: null, graph: false };
    if (withGraph && ctx) {
      el.crossOrigin = 'anonymous';
      try {
        const src = ctx.createMediaElementSource(el);
        deck.gain = ctx.createGain();
        deck.gain.gain.value = 0;
        src.connect(deck.gain).connect(master);
        deck.graph = true;
      } catch (_) { /* fall back to plain */ }
    }
    el.addEventListener('ended', () => { if (deck === active) { playing = false; emit('state', 'ended'); } });
    el.addEventListener('pause', () => { if (deck === active && !switching) { playing = false; emit('state', 'paused'); } });
    el.addEventListener('playing', () => { if (deck === active) { playing = true; emit('state', 'playing'); } });
    el.addEventListener('error', () => {
      if (deck !== active || !el.getAttribute('src')) return;
      if (deck.graph) { // CORS refused: rebuild as plain decks and retry once
        webAudio = false;
        decks = [makeDeck(false), makeDeck(false)];
        active = decks[0];
        if (current) start(current, true);
      } else { playing = false; emit('state', 'error'); }
    });
    return deck;
  }

  let decks = null, active = null, current = null, playing = false, switching = false;
  // iOS ignores element.volume; detect so we don't double-play during a "fade".
  const volumeWorks = (() => { try { const a = new Audio(); a.volume = 0.5; return a.volume === 0.5; } catch (_) { return false; } })();

  function ensure() {
    if (!ctx && webAudio) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        try {
          ctx = new AC();
          master = ctx.createGain();
          analyser = ctx.createAnalyser();
          analyser.fftSize = 128;
          analyser.smoothingTimeConstant = 0.78;
          master.connect(analyser).connect(ctx.destination);
        } catch (_) { ctx = null; webAudio = false; }
      } else webAudio = false;
    }
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
    if (!decks) { decks = [makeDeck(webAudio && !!ctx), makeDeck(webAudio && !!ctx)]; active = decks[0]; }
  }

  function fadeOut(deck) {
    const el = deck.el;
    if (deck.gain) {
      const g = deck.gain.gain;
      g.cancelScheduledValues(ctx.currentTime);
      g.setValueAtTime(g.value, ctx.currentTime);
      g.linearRampToValueAtTime(0, ctx.currentTime + FADE);
      setTimeout(() => { if (deck !== active) el.pause(); }, FADE * 1000 + 40);
    } else if (volumeWorks && !el.paused) {
      const v0 = el.volume, t0 = performance.now();
      const step = (now) => {
        const t = Math.min(1, (now - t0) / (FADE * 1000));
        el.volume = v0 * (1 - t);
        if (t < 1 && deck !== active) requestAnimationFrame(step); else if (deck !== active) el.pause();
      };
      requestAnimationFrame(step);
    } else el.pause();
  }
  function fadeIn(deck) {
    if (deck.gain) {
      const g = deck.gain.gain;
      g.cancelScheduledValues(ctx.currentTime);
      g.setValueAtTime(0, ctx.currentTime);
      g.linearRampToValueAtTime(1, ctx.currentTime + FADE);
    } else if (volumeWorks) {
      deck.el.volume = 0;
      const t0 = performance.now();
      const step = (now) => { const t = Math.min(1, (now - t0) / (FADE * 1000)); deck.el.volume = t; if (t < 1) requestAnimationFrame(step); };
      requestAnimationFrame(step);
    }
  }

  function start(song, retry) {
    const prev = active;
    const next = retry ? active : (decks[0] === active ? decks[1] : decks[0]);
    switching = true;
    if (!retry && prev && !prev.el.paused) fadeOut(prev);
    active = next;
    current = song;
    next.el.src = song.preview;
    next.el.currentTime = 0;
    fadeIn(next);
    emit('track', song);
    const p = next.el.play();
    switching = false;
    return p ? p.catch((err) => { if (err && err.name !== 'AbortError') { playing = false; emit('state', 'error'); } }) : Promise.resolve();
  }

  const AudioEngine = {
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    /** Start a preview (crossfading from whatever is playing). Call from a user gesture. */
    play(song) {
      if (!song || !song.preview) return Promise.reject(new Error('no-preview'));
      ensure();
      return start(song);
    },
    pause() { if (active) active.el.pause(); },
    resume() { ensure(); if (active && active.el.src) { if (active.gain) active.gain.gain.value = 1; else if (volumeWorks) active.el.volume = 1; return active.el.play().catch(() => {}); } },
    toggle() { return playing ? this.pause() : this.resume(); },
    stop() { if (decks) decks.forEach((d) => d.el.pause()); playing = false; emit('state', 'paused'); },
    get current() { return current; },
    get playing() { return playing; },
    get live() { return !!(analyser && active && active.graph); },
    progress() {
      const el = active && active.el;
      if (!el || !el.duration || !isFinite(el.duration)) return 0;
      return el.currentTime / el.duration;
    },
    seek(frac) { const el = active && active.el; if (el && el.duration) el.currentTime = frac * el.duration; },

    /**
     * Draw a waveform into `canvas` every frame while visible. getRGB() returns
     * the current song's color. Live levels when Web Audio is available;
     * otherwise a song-shaped static wave with a progress fill.
     */
    attachWave(canvas, getRGB) {
      const c2 = canvas.getContext('2d');
      const bins = new Uint8Array(64);
      const BARS = 28;
      let shape = [];
      let shapeFor = null;
      const seeded = (str) => {
        let h = 2166136261;
        for (const ch of String(str)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
        return Array.from({ length: BARS }, (_, i) => { h = Math.imul(h ^ (h >>> 13), 1274126177); return 0.25 + 0.75 * (((h >>> 0) % 1000) / 1000) * (0.55 + 0.45 * Math.sin(i / 3)); });
      };
      const levels = new Array(BARS).fill(0.08);
      function frame() {
        requestAnimationFrame(frame);
        if (!canvas.isConnected || canvas.offsetParent === null) return;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const w = canvas.clientWidth, h = canvas.clientHeight;
        if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
        c2.setTransform(dpr, 0, 0, dpr, 0, 0);
        c2.clearRect(0, 0, w, h);
        const [r, g, b] = getRGB();
        const prog = AudioEngine.progress();
        const isLive = AudioEngine.live && playing;
        if (isLive) {
          analyser.getByteFrequencyData(bins);
          for (let i = 0; i < BARS; i++) {
            const v = bins[Math.floor(2 + i * 1.6)] / 255;
            levels[i] += (Math.max(0.06, v) - levels[i]) * 0.35;
          }
        } else {
          if (shapeFor !== (current && current.id)) { shapeFor = current && current.id; shape = seeded(shapeFor || 'x'); }
          for (let i = 0; i < BARS; i++) levels[i] += ((playing ? shape[i] * (0.7 + 0.3 * Math.sin(performance.now() / 260 + i)) : shape[i] * 0.5) - levels[i]) * 0.12;
        }
        const gap = 2.5;
        const bw = (w - gap * (BARS - 1)) / BARS;
        for (let i = 0; i < BARS; i++) {
          const bh = Math.max(3, levels[i] * h);
          const x = i * (bw + gap);
          const done = (i + 0.5) / BARS <= prog;
          c2.fillStyle = done ? `rgba(${r},${g},${b},0.95)` : `rgba(255,255,255,${isLive ? 0.55 : 0.22})`;
          const y = (h - bh) / 2;
          if (c2.roundRect) { c2.beginPath(); c2.roundRect(x, y, bw, bh, bw / 2); c2.fill(); } else c2.fillRect(x, y, bw, bh);
        }
      }
      requestAnimationFrame(frame);
    },
  };
  window.AudioEngine = AudioEngine;
})();
