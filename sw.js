/*
 * Encore service worker.
 *  - App shell: precached, served cache-first and refreshed in the background,
 *    so the app opens instantly (and offline) even while the free server sleeps.
 *  - Album art from Apple's CDN: cached as you browse (capped).
 *  - /api/*: always network (accounts, sync, catalog proxy).
 */
const VERSION = 'encore-v3';
const SHELL = `${VERSION}-shell`;
const ART = `${VERSION}-art`;
const ART_MAX = 400;
const SHELL_FILES = [
  './', 'index.html', 'styles.css', 'ranking.js', 'app.js',
  'js/icons.js', 'js/motion.js', 'js/color.js', 'js/audio.js', 'js/gestures.js', 'js/sharecard.js', 'js/palette.js',
  'fonts/unbounded-latin-wght-normal.woff2', 'fonts/manrope-latin-wght-normal.woff2',
  'icon.svg', 'icons/icon-192.png', 'icons/apple-touch-icon.png', 'manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function trim(cacheName, max) {
  const c = await caches.open(cacheName);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - max; i++) await c.delete(keys[i]);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Album art (Apple CDN or our same-origin proxy): cache-first.
  if (/\.mzstatic\.com$/.test(url.hostname) || (url.origin === location.origin && url.pathname.endsWith('/api/art'))) {
    e.respondWith(caches.open(ART).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') { c.put(req, res.clone()); trim(ART, ART_MAX); }
      return res;
    }));
    return;
  }
  if (url.origin !== location.origin || url.pathname.includes('/api/')) return;

  // App shell: stale-while-revalidate. Navigations fall back to the cached page.
  e.respondWith(caches.open(SHELL).then(async (c) => {
    const key = req.mode === 'navigate' ? new URL('./', location).href : req;
    const hit = await c.match(key, { ignoreSearch: req.mode === 'navigate' });
    const net = fetch(req).then((res) => { if (res.ok) c.put(key, res.clone()); return res; }).catch(() => null);
    if (hit) { e.waitUntil(net); return hit; }
    const res = await net;
    return res || new Response('Offline', { status: 503, statusText: 'Offline' });
  }));
});
