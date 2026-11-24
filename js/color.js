/*
 * Album-art color: pulls a vivid dominant color from each cover so glows,
 * gradients and score rings take on the music's own palette.
 *
 * Covers are read from a tiny 40px copy through the server's /api/art proxy
 * (same-origin, so the canvas stays readable). Without the server we try
 * Apple's CDN directly with CORS, and fall back to a stable hash color.
 */
(function () {
  const KEY = 'encore.colors';
  const cache = new Map();
  const pending = new Map();
  let useProxy = false;
  try { Object.entries(JSON.parse(localStorage.getItem(KEY) || '{}')).forEach(([k, v]) => cache.set(k, v)); } catch (_) { /* ignore */ }
  let saveTimer;
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        const entries = [...cache.entries()].slice(-600);
        localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(entries)));
      } catch (_) { /* full */ }
    }, 1000);
  }

  function hashColor(str) {
    let h = 0;
    for (const c of String(str || 'x')) h = (h * 31 + c.charCodeAt(0)) % 360;
    return hslToRgb(h / 360, 0.65, 0.62);
  }
  function hslToRgb(h, s, l) {
    const f = (n) => { const k = (n + h * 12) % 12; return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
    return [f(0), f(8), f(4)].map((x) => Math.round(x * 255));
  }
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0; const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h /= 6;
    }
    return [h, s, l];
  }

  /** Dominant vivid color from pixel data: hue buckets weighted by saturation. */
  function dominant(data) {
    const buckets = new Array(36).fill(null).map(() => ({ w: 0, r: 0, g: 0, b: 0 }));
    let grey = { w: 0, r: 0, g: 0, b: 0 };
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
      if (a < 128) continue;
      const [h, s, l] = rgbToHsl(r, g, b);
      if (l < 0.08 || l > 0.95) continue;
      if (s < 0.18) { grey.w++; grey.r += r; grey.g += g; grey.b += b; continue; }
      const w = s * s * (1 - Math.abs(l - 0.55));
      const bk = buckets[Math.floor(h * 36) % 36];
      bk.w += w; bk.r += r * w; bk.g += g * w; bk.b += b * w;
    }
    // Merge each bucket with its neighbours so a gradient isn't split in two.
    let best = null, bestW = 0;
    for (let i = 0; i < 36; i++) {
      const w = buckets[i].w + 0.5 * (buckets[(i + 35) % 36].w + buckets[(i + 1) % 36].w);
      if (w > bestW) { bestW = w; best = buckets[i]; }
    }
    let rgb;
    if (best && best.w > 0.4) rgb = [best.r / best.w, best.g / best.w, best.b / best.w];
    else if (grey.w) return [168, 160, 196]; // monochrome cover: a soft lilac-grey
    else return null;
    // Lift into a range that glows on a near-black stage.
    const [h, s, l] = rgbToHsl(...rgb);
    return hslToRgb(h, Math.min(0.9, Math.max(0.5, s)), Math.min(0.72, Math.max(0.56, l)));
  }

  function smallArt(url) {
    return String(url).replace('{w}', 40).replace('{h}', 40).replace(/\/\d+x\d+(bb|cc|sr)?(\.\w+)(\?.*)?$/, '/40x40bb$2');
  }

  function read(src) {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = c.height = 24;
          const ctx = c.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, 0, 0, 24, 24);
          resolve(dominant(ctx.getImageData(0, 0, 24, 24).data));
        } catch (_) { resolve(null); } // tainted canvas
      };
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  /** Same-origin URL for a cover (proxy when the server is around). */
  function proxied(url) {
    if (!url || url.startsWith('data:')) return url;
    return useProxy && /^https:\/\/is\d+(-ssl)?\.mzstatic\.com\//.test(url) ? '/api/art?u=' + encodeURIComponent(url) : url;
  }

  const keyOf = (url) => String(url).replace(/\/\d+x\d+(bb|cc|sr)?(\.\w+)(\?.*)?$/, '').slice(-90);
  const failed = new Map(); // in-memory only: a failure may just mean the server was asleep

  /** Resolve to [r,g,b] for a song (never rejects). */
  function forSong(song) {
    const fallback = hashColor((song && (song.album || song.title)) || 'x');
    const url = song && song.art;
    if (!url) return Promise.resolve(fallback);
    const key = keyOf(url);
    if (cache.has(key)) return Promise.resolve(cache.get(key));
    if (failed.has(key)) return Promise.resolve(failed.get(key));
    if (pending.has(key)) return pending.get(key);
    const p = read(proxied(smallArt(url))).then((rgb) => {
      pending.delete(key);
      if (rgb) { cache.set(key, rgb); persist(); return rgb; }
      failed.set(key, fallback);
      return fallback;
    });
    pending.set(key, p);
    return p;
  }
  /** Synchronous peek: the cached color, or null if not known yet. */
  function peek(song) {
    if (!song) return null;
    if (!song.art) return hashColor(song.album || song.title);
    const key = keyOf(song.art);
    return cache.get(key) || failed.get(key) || null;
  }
  /** Set --c on `el` from the song's cover (synchronously when already known). */
  function paint(el, song) {
    const known = peek(song);
    if (known) { el.style.setProperty('--c', known.join(',')); return; }
    forSong(song).then((rgb) => el.style.setProperty('--c', rgb.join(',')));
  }

  window.AlbumColor = { forSong, peek, paint, proxied, hashColor, setProxy: (v) => { useProxy = !!v; } };
})();
