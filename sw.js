/* ==========================================================================
   TKG Service Worker — Production Ready
   
   Fixes:
   1. Precache path corrected: /moments_hub.html (underscore)
   2. Explicit version string: tkg-os-v-1.0.2
   3. CORS bypass with early return for Apps Script
   4. Cache-first strategy for static assets
   ========================================================================== */

const CACHE_NAME = 'tkg-os-v-1.0.2';

const APP_SHELL = [
  '/',
  '/index.html',
  '/moments.html',
  '/moments_hub.html',
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

  // CRITICAL BYPASS: Hand control back to native browser engine for Google Apps Script CORS/redirects & stream proxy
  if (
    url.hostname.includes('script.google.com') ||
    url.hostname.includes('script.googleusercontent.com') ||
    url.pathname.startsWith('/api/stream') ||
    event.request.method !== 'GET'
  ) {
    return;
  }

  // Cache-first strategy for static app shell
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
