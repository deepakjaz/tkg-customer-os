/* ==========================================================================
   TKG Service Worker
   Handles offline caching of the app shell so registration + menu work
   with zero network connection. Data sync is handled separately in app.js
   via the "online" event and a background retry loop — the service worker
   itself does not talk to Google Sheets.
   ========================================================================== */

// ---------------------------------------------------------------------------
// CACHE VERSION
// Active development: bump BUILD_VERSION on every deploy that changes
// index.html, manifest.json, or this file, so the browser always detects
// the service worker as "new" and the old cache is purged automatically
// (see the activate handler below). Use a timestamp — date + time is
// enough resolution for one deploy at a time and needs no build tooling.
//
// Once V1 stabilizes, switch this back to a deliberate version tied to a
// release tag (e.g. 'tkg-cache-v3') instead of bumping on every save.
// ---------------------------------------------------------------------------
const BUILD_VERSION = '2026-06-27.2'; // <-- update this on every deploy
const CACHE_NAME = `tkg-cache-${BUILD_VERSION}`;
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// Install: pre-cache the app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

// Activate: clean up old cache versions
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch: cache-first for app shell, network-first fallback for everything else.
// Google Sheets / Apps Script requests are never cached — they always hit
// the network (and fail gracefully in app.js if offline).
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never intercept calls to Google Apps Script — let app.js handle
  // success/failure of those directly so sync logic stays accurate.
  if (url.hostname.includes('script.google.com') || url.hostname.includes('script.googleusercontent.com')) {
    return;
  }

  if (event.request.method !== 'GET') {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) {
        return cached;
      }
      return fetch(event.request)
        .then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match('./index.html'));
    })
  );
});
