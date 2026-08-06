/* ==========================================================================
   TKG Service Worker — PWA Cache & Auto-Reload v2
   
   Dynamic cache purging + explicit video stream bypass + auto-reload support.
   Handles offline caching of the app shell so registration + menu work
   with zero network connection. Data sync is handled separately in app.js
   via the "online" event and a background retry loop — the service worker
   itself does not talk to Google Sheets.
   ========================================================================== */

// ---------------------------------------------------------------------------
// CACHE VERSION — Dynamic Timestamp
// Every deploy gets a new cache key based on current timestamp, so old
// caches are automatically purged during activate. This ensures all assets
// (HTML, CSS, JS, images, manifest) are always fresh after deployment.
// ---------------------------------------------------------------------------
const CACHE_NAME = 'tkg-os-v-' + Date.now();

// Full precache list: all core static assets for the app shell
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

// =========================================================================
// INSTALL: Pre-cache the full app shell
// =========================================================================
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

// =========================================================================
// ACTIVATE: Clean up old cache versions + claim all clients
// =========================================================================
// This fires when a new Service Worker takes over. Delete all old caches
// (identified by their versioned names), then claim all clients so
// they start using this new worker immediately.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => {
        return Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        );
      })
      .then(() => {
        // Claim all clients immediately so they use the new service worker
        return self.clients.claim();
      })
  );
});

// =========================================================================
// FETCH: Cache-first for app shell, network-first for everything else
// =========================================================================
// Strategy:
// 1. BYPASS: Google Apps Script (never cache sync calls)
// 2. BYPASS: /api/stream (video streams, never cache)
// 3. BYPASS: Non-GET requests (POST, PUT, DELETE, etc.)
// 4. SERVE: GET requests from cache if available, then network
// 5. FALLBACK: If offline and no cache, return index.html

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const method = event.request.method;
  const hostname = url.hostname;

  // -----------------------------------------------------------------------
  // BYPASS #1: Never intercept Google Apps Script calls
  // These are data sync calls that must always hit the network.
  // Explicitly pass through both script.google.com and script.googleusercontent.com
  // (the latter is used after redirect from the former).
  // -----------------------------------------------------------------------
  if (
    hostname === 'script.google.com' ||
    hostname === 'script.googleusercontent.com' ||
    hostname.endsWith('.script.google.com') ||
    hostname.endsWith('.script.googleusercontent.com')
  ) {
    // Explicitly pass through to network without caching
    event.respondWith(fetch(event.request));
    return;
  }

  // -----------------------------------------------------------------------
  // BYPASS #2: Never cache video streams (/api/stream)
  // These should always stream fresh from Google Drive to prevent
  // device storage bloat and ensure up-to-date content.
  // -----------------------------------------------------------------------
  if (url.pathname.startsWith('/api/stream')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // -----------------------------------------------------------------------
  // BYPASS #3: Never cache non-GET requests (POST, PUT, DELETE, etc.)
  // These are mutations that must go to the network.
  // -----------------------------------------------------------------------
  if (method !== 'GET') {
    event.respondWith(fetch(event.request));
    return;
  }

  // -----------------------------------------------------------------------
  // CACHE-FIRST for GET requests
  // Serve from cache if available, fall back to network.
  // On success, store the response in cache for next time.
  // -----------------------------------------------------------------------
  event.respondWith(
    caches.match(event.request)
      .then((cached) => {
        if (cached) {
          return cached; // Serve from cache
        }

        // Not in cache — fetch from network
        return fetch(event.request)
          .then((response) => {
            // Only cache successful (200), non-opaque responses
            if (response && response.status === 200 && response.type === 'basic') {
              const clone = response.clone();
              caches.open(CACHE_NAME)
                .then((cache) => cache.put(event.request, clone));
            }
            return response;
          })
          .catch(() => {
            // Network failed and nothing in cache — serve fallback
            return caches.match('./index.html');
          });
      })
  );
});
