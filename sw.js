/* ==========================================================================
   TKG Service Worker — v1.0.4
   
   Changes in v1.0.4:
   1. Bumped version to force cache purge across all devices
   2. Precache array verified: /moments_hub.html (underscore, not hyphen)
   3. CORS bypass confirmed: Early return for Apps Script + Stream Proxy
   4. Cache-first strategy for static assets only
   
   ========================================================================== */

const CACHE_NAME = 'tkg-os-v-1.0.45';

const APP_SHELL = [
  '/',
  '/index.html',
  '/moments.html',
  '/moments_hub.html',
  '/dashboard.html',
  '/khichiya-runner.html',
  '/leaderboard.html',
  '/tkg-shared.js',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(APP_SHELL).then(() => {
        console.log('[SW v1.0.3] Install complete. Precache:', APP_SHELL.length, 'files');
      }).catch((err) => {
        console.error('[SW v1.0.3] Precache failed:', err.message);
        console.error('[SW v1.0.3] Failed URLs checked:', APP_SHELL);
        throw err;
      });
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      const deletePromises = keys
        .filter((key) => key !== CACHE_NAME)
        .map((key) => {
          console.log('[SW v1.0.3] Deleting old cache:', key);
          return caches.delete(key);
        });
      return Promise.all(deletePromises);
    }).then(() => {
      console.log('[SW v1.0.3] Activation complete. Active cache:', CACHE_NAME);
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // CRITICAL BYPASS: Hand control back to native browser engine
  // Google Apps Script needs native CORS + redirect handling
  // Stream proxy (/api/stream) needs HTTP 206 Partial Content support
  if (
    url.hostname.includes('script.google.com') ||
    url.hostname.includes('script.googleusercontent.com') ||
    url.hostname.includes('drive.google.com') ||
    url.pathname.startsWith('/api/stream') ||
    event.request.method !== 'GET'
  ) {
    // Early return = browser handles natively (no caching, no interception)
    return;
  }

  // Cache-first strategy for static app shell only
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) {
        return cached;
      }

      return fetch(event.request).then((response) => {
        // Only cache successful, basic responses
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, clone);
          });
        }
        return response;
      }).catch(() => {
        // Network error: return cached index.html as fallback
        return caches.match('/index.html');
      });
    })
  );
});
