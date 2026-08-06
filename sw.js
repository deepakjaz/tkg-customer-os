/* ==========================================================================
   TKG Service Worker — CORS & Mobile Update Fix
   
   CRITICAL: Early return (no event.respondWith) for third-party APIs
   allows browser's native network engine to handle CORS/redirects naturally.
   ========================================================================== */

const CACHE_NAME = 'tkg-os-v-' + Date.now();

const APP_SHELL = [
  '/',
  '/index.html',
  '/moments.html',
  '/moments-hub.html',
  '/dashboard.html',
  '/khichiya-runner.html',
  '/leaderboard.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // =========================================================================
  // CRITICAL BYPASS: Return early without event.respondWith()
  // =========================================================================
  // This hands control back to the standard browser network engine, which
  // naturally handles CORS headers and 302 redirects (script.google.com
  // -> script.googleusercontent.com). Using event.respondWith(fetch())
  // intercepts redirects and causes CORS failures.
  if (
    url.hostname.includes('script.google.com') ||
    url.hostname.includes('script.googleusercontent.com') ||
    url.pathname.startsWith('/api/stream') ||
    event.request.method !== 'GET'
  ) {
    return;
  }

  // =========================================================================
  // Cache-first strategy for static app shell
  // =========================================================================
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;

      return fetch(event.request).then((response) => {
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => caches.match('/index.html'));
    })
  );
});
