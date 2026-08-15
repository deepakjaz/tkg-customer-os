/**
 * tkg-shared.js
 * ─────────────────────────────────────────────────────────────
 * TKG Customer OS — Shared Identity & Apps Script Utility Module
 *
 * Single canonical source for:
 *   1. Customer identity (name + mobile) persisted in localStorage
 *   2. Mobile number validation/normalization
 *   3. A uniform fetch dispatcher for Apps Script requests
 *
 * Used by: index.html, moments.html, moments_hub.html, khichiya-runner.html
 *
 * Design decisions this file encodes (locked 2026-08-07):
 *   - Identity is PERSISTENT across browser closes (not session-based)
 *   - Primary key is the normalized mobile number
 *   - Every Apps Script request includes { name, mobile, ...moduleData }
 *   - Apps Script responses are read as { status: 'ok' | 'error', message? }
 *   - Phase 2: mobile is trusted, unverified. Phase 3 will add
 *     locationVerified server-side — this file does NOT gate on it.
 *
 * No build step. Include via:
 *   <script src="./tkg-shared.js"></script>
 * Exposes everything under the global `TKGShared` namespace to avoid
 * polluting the page's own globals.
 * ─────────────────────────────────────────────────────────────
 */

(function (global) {
  'use strict';

  // ========================================================
  // CONFIG — update this in ONE place if the deployment URL changes
  // ========================================================
  const APP_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxyftcQEeDkU1sf2MJy4Zwj12C9J8z4UVWTY1-ny5HM9HhJ0azlkMt5Gvp-nJXDgtLnLA/exec';

  const STORAGE_KEY = 'tkg_customer';

  // ========================================================
  // MOBILE VALIDATION
  // Mirrors isPlausibleMobile_() already fixed server-side:
  // real Indian mobile numbers start 6-9, reject all-same-digit,
  // must be exactly 10 digits after stripping non-digits.
  // ========================================================
  function normalizeMobile(raw) {
    if (!raw) return '';
    return String(raw).replace(/\D/g, '').slice(-10);
  }

  function isPlausibleMobile(raw) {
    const mobile = normalizeMobile(raw);
    if (mobile.length !== 10) return false;
    if (!/^[6-9]/.test(mobile)) return false;
    if (/^(\d)\1{9}$/.test(mobile)) return false; // all same digit
    return true;
  }

  // ========================================================
  // IDENTITY: GET
  // Returns { name, mobile, updated_at } or null if none stored
  // or the stored value is corrupt.
  // ========================================================
  function getCustomerIdentity() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.mobile) return null;
      return parsed;
    } catch (e) {
      console.warn('[tkg-shared] Corrupt identity in localStorage, clearing.', e);
      try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
      return null;
    }
  }

  // ========================================================
  // IDENTITY: SET
  // Validates + normalizes mobile, writes { name, mobile, updated_at }.
  // Returns { success: true, identity } or { success: false, error }.
  // Overwrites whatever was there before — last submission wins,
  // per the "persistent, overwritten on new submission" rule.
  // ========================================================
  function setCustomerIdentity(name, mobile) {
    const cleanName = (name || '').trim();
    const cleanMobile = normalizeMobile(mobile);

    if (!cleanName) {
      return { success: false, error: { code: 'MISSING_NAME', message: 'Name is required.' } };
    }
    if (!isPlausibleMobile(cleanMobile)) {
      return { success: false, error: { code: 'INVALID_MOBILE', message: 'Enter a valid 10-digit mobile number.' } };
    }

    const identity = {
      name: cleanName,
      mobile: cleanMobile,
      updated_at: new Date().toISOString()
    };

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
      return { success: true, identity: identity };
    } catch (e) {
      console.error('[tkg-shared] Failed to write identity to localStorage.', e);
      return { success: false, error: { code: 'STORAGE_FAILED', message: 'Could not save on this device.' } };
    }
  }

  // ========================================================
  // IDENTITY: CLEAR (manual sign-out / reset, not used by default flows)
  // ========================================================
  function clearCustomerIdentity() {
    try {
      localStorage.removeItem(STORAGE_KEY);
      return true;
    } catch (e) {
      console.warn('[tkg-shared] Failed to clear identity.', e);
      return false;
    }
  }

  // ========================================================
  // HAS IDENTITY — convenience check for auto-fill / gating UI
  // ========================================================
  function hasCustomerIdentity() {
    const identity = getCustomerIdentity();
    return !!(identity && identity.mobile);
  }

  // ========================================================
  // SHARED JOURNEY CONTEXT — Step 1 (2026-08-13)
  // Unified, cross-surface read/write for the visitor's Journey state
  // (atTKG / planning / exploring), stored under its own key,
  // tkg_journey_context — separate from index.html's tkg_journey /
  // tkg_journey_ts, which are left completely untouched and keep
  // governing index.html's own screens exactly as before.
  //
  // Mirrors, without altering, the freshness windows already locked in
  // index.html (Journey Friction Fixes, item A): atTKG expires after 4h,
  // planning after 24h, exploring never expires. This does not change
  // how atTKG/planning/exploring function — it's an additive shared
  // copy so moments.html, moments_hub.html, khichiya-runner.html, and
  // leaderboard.html can learn the same state index.html already knows,
  // without reading index.html's own storage keys directly.
  //
  // getJourneyContext() — returns { state, locality, ts } or null if
  // nothing stored, invalid, or expired per the same windows above.
  //
  // setJourneyContext(state, locality) — validates state, writes
  // { state, locality, ts: Date.now() }. Passing a falsy/invalid state
  // clears the stored context (covers both "select" and "clear").
  // Anonymous by design: no identity, no registration involved.
  // ========================================================
  const JOURNEY_CONTEXT_KEY = 'tkg_journey_context';
  const JOURNEY_VALUES = ['atTKG', 'planning', 'exploring'];
  const JOURNEY_RESET_MS = {
    atTKG: 4 * 60 * 60 * 1000,      // 4 hours
    planning: 24 * 60 * 60 * 1000,  // 24 hours
    exploring: null                  // never resets
  };

  function getJourneyContext() {
    try {
      const raw = localStorage.getItem(JOURNEY_CONTEXT_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !JOURNEY_VALUES.includes(parsed.state)) return null;

      const windowMs = JOURNEY_RESET_MS[parsed.state];
      if (windowMs != null) {
        const ts = parsed.ts;
        if (!ts || (Date.now() - ts) > windowMs) {
          try { localStorage.removeItem(JOURNEY_CONTEXT_KEY); } catch (_) {}
          return null;
        }
      }
      return { state: parsed.state, locality: parsed.locality || null, ts: parsed.ts };
    } catch (e) {
      return null;
    }
  }

  function setJourneyContext(state, locality) {
    if (!JOURNEY_VALUES.includes(state)) {
      // Falsy or invalid state = clear, so callers can use the same
      // function for both "select" and "clear" as required.
      try { localStorage.removeItem(JOURNEY_CONTEXT_KEY); } catch (_) {}
      return null;
    }
    const context = { state: state, locality: locality || null, ts: Date.now() };
    try {
      localStorage.setItem(JOURNEY_CONTEXT_KEY, JSON.stringify(context));
    } catch (e) {
      console.warn('[tkg-shared] Failed to write journey context.', e);
    }
    return context;
  }

  // ========================================================
  // JOURNEY ORIGIN — write-once, per-device (2026-08-14)
  // Captures which SURFACE a visitor FIRST selected a Journey from —
  // 'Menu' | 'Hub' | 'Moments' | 'Runner'. Separate from the Journey
  // Context above (which is the CURRENT/latest Journey state, not where
  // it began) and separate from the Customers-sheet Journey_Origin field
  // (which is populated from this value only once, at registration).
  // Stored as a plain string under its own key. Once set, never
  // overwritten by any later selection on any surface — moving between
  // Hub → Moments → Runner → Menu after the first pick never changes it.
  // ========================================================
  const JOURNEY_ORIGIN_KEY = 'tkg_journey_origin';
  // 'Leaderboard' added Sprint B (2026-08-15) — Leaderboard gains its own
  // Journey selection UI for the first time this sprint (see below), so
  // it must be a valid origin surface like the other 4.
  const JOURNEY_ORIGIN_SURFACES = ['Menu', 'Hub', 'Moments', 'Runner', 'Leaderboard'];

  function getJourneyOrigin() {
    try {
      const v = localStorage.getItem(JOURNEY_ORIGIN_KEY);
      return JOURNEY_ORIGIN_SURFACES.includes(v) ? v : null;
    } catch (e) {
      return null;
    }
  }

  function setJourneyOriginIfUnset(surface) {
    if (!JOURNEY_ORIGIN_SURFACES.includes(surface)) return;
    try {
      if (!localStorage.getItem(JOURNEY_ORIGIN_KEY)) {
        localStorage.setItem(JOURNEY_ORIGIN_KEY, surface);
      }
    } catch (e) {
      console.warn('[tkg-shared] Failed to write journey origin.', e);
    }
  }

  // ========================================================
  // SHARED JOURNEY ANALYTICS + LOCATION ENGINE (2026-08-14)
  // Ported from index.html's Journey Analytics system so Hub, Moments,
  // and Runner trigger the EXACT SAME thing Menu already does: the same
  // local event log (tkg_journey_events — the SAME key index.html
  // already writes to, not a second log), the same 'journeyEvent' Apps
  // Script action (via submitToAppsScript() below), the same geocoding/
  // landmark resolution, and the same permission-toast flow. index.html's
  // own implementation is left completely untouched and keeps writing to
  // the same array — this is additive, not a parallel/second system.
  // Requires a `#geoHintToast` element and its CSS to exist on the page
  // (same markup index.html already has) for the permission toast to
  // render; degrades silently (no toast, location still requested) if
  // the element isn't present.
  // ========================================================
  const JOURNEY_EVENTS_KEY = 'tkg_journey_events';

  function loadJourneyEvents() {
    try {
      const raw = localStorage.getItem(JOURNEY_EVENTS_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function saveJourneyEvents(list) {
    try {
      localStorage.setItem(JOURNEY_EVENTS_KEY, JSON.stringify(list));
    } catch (e) {
      console.warn('[tkg-shared] Failed to save journey events.', e);
    }
  }

  const GEO_PERMISSION_GRANTED_KEY = 'tkg_geo_permission_granted';
  let geoHintTimer = null;

  function markGeoPermissionGranted() {
    try { localStorage.setItem(GEO_PERMISSION_GRANTED_KEY, '1'); } catch (e) {}
  }

  function showGeoHint() {
    const toast = document.getElementById('geoHintToast');
    if (!toast) return;
    clearTimeout(geoHintTimer);
    toast.classList.add('show');
    geoHintTimer = setTimeout(hideGeoHint, 2800);
  }

  function hideGeoHint() {
    const toast = document.getElementById('geoHintToast');
    clearTimeout(geoHintTimer);
    geoHintTimer = null;
    if (toast) toast.classList.remove('show');
  }

  function requestJourneyLocation(callback) {
    if (!navigator.geolocation) { hideGeoHint(); callback(null, 'unavailable'); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        hideGeoHint();
        markGeoPermissionGranted();
        callback({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy
        }, 'granted');
      },
      (err) => {
        hideGeoHint();
        const reason = err && err.code === 1 ? 'denied' : (err && err.code === 3 ? 'timeout' : 'unavailable');
        callback(null, reason);
      },
      { timeout: 12000, maximumAge: 60000 }
    );
  }

  function showGeoConsent(callback, surface) {
    showGeoHint();
    logEvent(surface, 'location_prompt_shown');
    requestJourneyLocation(callback);
  }

  // Same rule as Menu: once permission is confirmed granted (on this
  // device, any surface — the flag is shared), never show the
  // explanation toast again anywhere.
  function ensureLocationConsent(callback, surface) {
    if ('permissions' in navigator && navigator.permissions && navigator.permissions.query) {
      navigator.permissions.query({ name: 'geolocation' }).then(status => {
        if (status.state === 'granted') {
          requestJourneyLocation(callback);
        } else {
          showGeoConsent(callback, surface);
        }
      }).catch(() => {
        let confirmedGranted = false;
        try { confirmedGranted = localStorage.getItem(GEO_PERMISSION_GRANTED_KEY) === '1'; } catch (e) {}
        confirmedGranted ? requestJourneyLocation(callback) : showGeoConsent(callback, surface);
      });
    } else {
      let confirmedGranted = false;
      try { confirmedGranted = localStorage.getItem(GEO_PERMISSION_GRANTED_KEY) === '1'; } catch (e) {}
      confirmedGranted ? requestJourneyLocation(callback) : showGeoConsent(callback, surface);
    }
  }

  const SURAT_COHORTS = [
    { name: 'Vesu',   lat: 21.1447, lon: 72.7718, radiusMeters: 1800 },
    { name: 'Piplod', lat: 21.1575, lon: 72.7755, radiusMeters: 1500 },
    { name: 'Adajan', lat: 21.1940, lon: 72.7980, radiusMeters: 2000 },
    { name: 'Pal',    lat: 21.1850, lon: 72.7761, radiusMeters: 1500 }
  ];
  const SURAT_COHORT_MAX_MATCH_METERS = 4500;

  function haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = (d) => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function resolveSuratCohortLocality(lat, lon) {
    let best = null, bestDist = Infinity;
    for (const cohort of SURAT_COHORTS) {
      const dist = haversineMeters(lat, lon, cohort.lat, cohort.lon);
      if (dist < bestDist) { bestDist = dist; best = cohort; }
    }
    if (best && bestDist <= SURAT_COHORT_MAX_MATCH_METERS) return best.name;
    return '';
  }

  function resolveBusinessLocality(address) {
    const addr = address || {};
    return addr.suburb || addr.neighbourhood || addr.city_district || addr.residential
      || addr.borough || addr.quarter || addr.hamlet || addr.village || addr.town || '';
  }

  function reverseGeocode(lat, lon) {
    return new Promise((resolve) => {
      if (!('fetch' in window)) { resolve(null); return; }
      const controller = ('AbortController' in window) ? new AbortController() : null;
      const timeoutId = setTimeout(() => { if (controller) controller.abort(); resolve(null); }, 4000);
      fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=14&addressdetails=1`,
        { signal: controller ? controller.signal : undefined, headers: { 'Accept-Language': 'en' } })
        .then(res => res.ok ? res.json() : null)
        .then(data => {
          clearTimeout(timeoutId);
          const addr = (data && data.address) || {};
          const locality = resolveBusinessLocality(addr);
          const city = addr.city || addr.town || addr.village || addr.state_district || '';
          resolve((locality || city) ? { locality: locality, city: city } : null);
        })
        .catch(() => { clearTimeout(timeoutId); resolve(null); });
    });
  }

  function resolveNearbyLandmarkFallback(lat, lon) {
    return new Promise((resolve) => {
      if (!('fetch' in window)) { resolve(''); return; }
      const controller = ('AbortController' in window) ? new AbortController() : null;
      const timeoutId = setTimeout(() => { if (controller) controller.abort(); resolve(''); }, 4000);
      fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`,
        { signal: controller ? controller.signal : undefined, headers: { 'Accept-Language': 'en' } })
        .then(res => res.ok ? res.json() : null)
        .then(data => {
          clearTimeout(timeoutId);
          const addr = (data && data.address) || {};
          const landmark = addr.attraction || addr.tourism || addr.leisure || addr.amenity
            || addr.shop || addr.office || addr.historic || addr.building || (data && data.name) || '';
          resolve(landmark);
        })
        .catch(() => { clearTimeout(timeoutId); resolve(''); });
    });
  }

  function resolveOverpassLandmark(lat, lon) {
    return new Promise((resolve) => {
      if (!('fetch' in window)) { resolve(''); return; }
      const controller = ('AbortController' in window) ? new AbortController() : null;
      const timeoutId = setTimeout(() => { if (controller) controller.abort(); resolve(''); }, 4000);
      const query = '[out:json][timeout:4];(' +
        `node(around:750,${lat},${lon})["shop"="mall"];` +
        `way(around:750,${lat},${lon})["shop"="mall"];` +
        `node(around:750,${lat},${lon})["amenity"="university"];` +
        `way(around:750,${lat},${lon})["amenity"="university"];` +
        `node(around:750,${lat},${lon})["amenity"="college"];` +
        `way(around:750,${lat},${lon})["amenity"="college"];` +
        `node(around:750,${lat},${lon})["amenity"="school"];` +
        `way(around:750,${lat},${lon})["amenity"="school"];` +
        `node(around:750,${lat},${lon})["tourism"="attraction"];` +
        `node(around:750,${lat},${lon})["tourism"="aquarium"];` +
        `node(around:750,${lat},${lon})["amenity"="hospital"];` +
        `way(around:750,${lat},${lon})["amenity"="hospital"];` +
        `node(around:750,${lat},${lon})["amenity"="place_of_worship"];` +
        `way(around:750,${lat},${lon})["amenity"="place_of_worship"];` +
        `node(around:750,${lat},${lon})["tourism"="hotel"];` +
        `way(around:750,${lat},${lon})["tourism"="hotel"];` +
        `node(around:750,${lat},${lon})["amenity"="cinema"];` +
        `node(around:750,${lat},${lon})["railway"="station"];` +
        `node(around:750,${lat},${lon})["amenity"="bus_station"];` +
        `node(around:750,${lat},${lon})["amenity"="marketplace"];` +
        `node(around:750,${lat},${lon})["shop"]["name"];` +
        `way(around:750,${lat},${lon})["shop"]["name"];` +
        `node(around:750,${lat},${lon})["office"]["name"];` +
        `way(around:750,${lat},${lon})["office"]["name"];` +
        `way(around:750,${lat},${lon})["building"]["name"];` +
        `node(around:750,${lat},${lon})["building"]["name"];` +
      ');out tags center 30;';
      fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        signal: controller ? controller.signal : undefined
      })
        .then(res => res.ok ? res.json() : null)
        .then(data => {
          clearTimeout(timeoutId);
          const elements = (data && Array.isArray(data.elements)) ? data.elements : [];
          const isCuratedTag = (tags) => !!(
            tags.shop || tags.office ||
            ['university', 'college', 'school', 'hospital', 'place_of_worship', 'cinema', 'bus_station', 'marketplace']
              .includes(tags.amenity) ||
            ['attraction', 'aquarium', 'hotel'].includes(tags.tourism) ||
            tags.railway === 'station'
          );
          const curated = elements.find(el => el && el.tags && el.tags.name && isCuratedTag(el.tags));
          if (curated) { resolve(curated.tags.name); return; }
          const namedBuildings = elements.filter(el => el && el.tags && el.tags.name && el.tags.building);
          if (namedBuildings.length === 0) { resolve(''); return; }
          let nearest = null, nearestDist = Infinity;
          for (const el of namedBuildings) {
            const elLat = el.lat != null ? el.lat : (el.center && el.center.lat);
            const elLon = el.lon != null ? el.lon : (el.center && el.center.lon);
            if (elLat == null || elLon == null) continue;
            const dist = haversineMeters(lat, lon, elLat, elLon);
            if (dist < nearestDist) { nearestDist = dist; nearest = el; }
          }
          resolve(nearest ? nearest.tags.name : '');
        })
        .catch(() => { clearTimeout(timeoutId); resolve(''); });
    });
  }

  async function resolveLandmark(lat, lon) {
    const overpassResult = await resolveOverpassLandmark(lat, lon);
    if (overpassResult) return overpassResult;
    return resolveNearbyLandmarkFallback(lat, lon);
  }

  let journeyEventSyncInFlight = false;

  async function attemptJourneyEventSync() {
    if (journeyEventSyncInFlight) return;
    if (!navigator.onLine) return;

    const events = loadJourneyEvents();
    const pending = events.filter(e => e.pendingSync);
    if (pending.length === 0) return;

    journeyEventSyncInFlight = true;

    try {
      const result = await submitToAppsScript('journeyEvent', {
        events: pending.map(e => ({ journey: e.journey, origin: e.origin || '', ts: e.ts, latitude: e.latitude, longitude: e.longitude, accuracy: e.accuracy, locality: e.locality, city: e.city, landmark: e.landmark }))
      }, { requireIdentity: false });

      // Same guard as Menu: only trust a response that actually carries a
      // numeric `recorded` count — a stale/not-yet-redeployed Apps Script
      // still returns status 'ok' via its generic fallback without this.
      if (!result.success || typeof result.data.recorded !== 'number') {
        throw new Error('Journey event sync: unexpected response');
      }

      const freshEvents = loadJourneyEvents();
      const sentTimestamps = new Set(pending.map(e => e.ts));
      freshEvents.forEach(e => {
        if (e.pendingSync && sentTimestamps.has(e.ts)) e.pendingSync = false;
      });
      saveJourneyEvents(freshEvents);

    } catch (err) {
      console.warn('[tkg-shared] Journey event sync failed, will retry later:', err);
    } finally {
      journeyEventSyncInFlight = false;
    }
  }

  // recordJourneyEvent(journey, surface) — the single entry point Hub,
  // Moments, and Runner call on Journey selection. Mirrors index.html's
  // recordJourneyEvent exactly: atTKG skips location entirely; planning/
  // exploring go through the same consent → GPS → geocode → cohort-match
  // → save → sync chain, writing into the SAME tkg_journey_events array
  // index.html already uses and syncs via the SAME 'journeyEvent' action.
  function recordJourneyEvent(journey, surface) {
    if (journey === 'atTKG') {
      const events = loadJourneyEvents();
      events.push({
        journey: journey,
        origin: surface || '',
        ts: new Date().toISOString(),
        pendingSync: true,
        locality: 'Not Applicable — At TKG',
        landmark: 'Not Applicable — At TKG'
      });
      saveJourneyEvents(events);
      attemptJourneyEventSync();
      return;
    }
    ensureLocationConsent(async (loc) => {
      logEvent(surface, 'location_response', { shared: !!loc });
      const events = loadJourneyEvents();
      const event = { journey: journey, origin: surface || '', ts: new Date().toISOString(), pendingSync: true };
      if (loc) {
        event.latitude = loc.latitude;
        event.longitude = loc.longitude;
        event.accuracy = loc.accuracy;
        if (loc.accuracy != null && loc.accuracy > 150) {
          event.locality = 'Low GPS Confidence';
          event.landmark = 'Low GPS Confidence';
        } else {
          const [place, landmark, cohortLocality] = await Promise.all([
            reverseGeocode(loc.latitude, loc.longitude),
            resolveLandmark(loc.latitude, loc.longitude),
            Promise.resolve(resolveSuratCohortLocality(loc.latitude, loc.longitude))
          ]);
          if (place) {
            event.locality = place.locality;
            event.city = place.city;
          }
          if (cohortLocality) event.locality = cohortLocality;
          event.landmark = landmark || '';
        }
      } else {
        event.locality = 'Location Not Shared';
        event.landmark = 'Location Not Shared';
      }
      events.push(event);
      saveJourneyEvents(events);
      attemptJourneyEventSync();
    }, surface);
  }

  // ========================================================
  // PROXIMITY NUDGE — 200m Radius / "I'm at TKG" (Sprint B, 2026-08-15)
  // Purely a soft, non-blocking notification-style nudge inviting a
  // visitor to (re)pick their Journey when they're actually near TKG —
  // NEVER auto-selects a Journey on their behalf. Two independent gates
  // must both pass before anything shows:
  //   1. Day gate — only Friday/Saturday/Sunday (TKG's operating days),
  //      so this can never pop up on a day TKG isn't even open.
  //   2. Proximity gate — device geolocation, ONLY read if location
  //      permission is already granted from an earlier flow (Journey
  //      selection, etc.). This feature NEVER triggers its own
  //      permission prompt, by design — so it can't feel like tracking.
  // Fires at most once per calendar day per device (shared across all
  // 5 surfaces via one localStorage key), and is skipped entirely if the
  // visitor already has a fresh 'atTKG' Journey (no need to nudge
  // someone already checked in).
  // TKG's own location is fixed, decoded once from the Plus Code
  // 4QV8+XJ, Surat, Gujarat (standard Open Location Code algorithm) —
  // this is TKG's location, never a visitor's, and never changes.
  // ========================================================
  const TKG_LOCATION = { lat: 21.144937499999997, lon: 72.76656249999999 }; // Plus Code 4QV8+XJ, Surat, Gujarat
  const PROXIMITY_RADIUS_METERS = 200;
  const PROXIMITY_NUDGE_DAYS = [0, 5, 6]; // Date.getDay(): 0=Sun, 5=Fri, 6=Sat
  const PROXIMITY_NUDGE_LAST_SHOWN_KEY = 'tkg_proximity_nudge_last_shown';
  const PROXIMITY_ACCURACY_MAX_METERS = 150; // same "Low GPS Confidence" cutoff Journey Analytics already uses

  function todayLocalDateStr() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function isProximityNudgeDay() {
    return PROXIMITY_NUDGE_DAYS.includes(new Date().getDay());
  }

  function hasShownProximityNudgeToday() {
    try {
      return localStorage.getItem(PROXIMITY_NUDGE_LAST_SHOWN_KEY) === todayLocalDateStr();
    } catch (e) {
      return false;
    }
  }

  function markProximityNudgeShown() {
    try { localStorage.setItem(PROXIMITY_NUDGE_LAST_SHOWN_KEY, todayLocalDateStr()); } catch (e) {}
  }

  // Never prompts. Only reports whether permission is already granted
  // from an earlier flow (e.g. a prior Journey location request).
  function geoPermissionAlreadyGranted() {
    return new Promise((resolve) => {
      if ('permissions' in navigator && navigator.permissions && navigator.permissions.query) {
        navigator.permissions.query({ name: 'geolocation' }).then((status) => {
          resolve(status.state === 'granted');
        }).catch(() => {
          let flag = false;
          try { flag = localStorage.getItem(GEO_PERMISSION_GRANTED_KEY) === '1'; } catch (e) {}
          resolve(flag);
        });
      } else {
        let flag = false;
        try { flag = localStorage.getItem(GEO_PERMISSION_GRANTED_KEY) === '1'; } catch (e) {}
        resolve(flag);
      }
    });
  }

  // Self-contained styling, injected once — deliberately uses fixed
  // hex values rather than each page's own CSS variables, since the 5
  // surfaces use two completely different theming systems (stone/ink/
  // ember vs page-bg/text-primary). Keeps this component identical and
  // isolated everywhere instead of requiring 5 separate variable maps.
  let proximityStylesInjected = false;
  function injectProximityNudgeStyles() {
    if (proximityStylesInjected || document.getElementById('tkgProximityNudgeStyles')) return;
    proximityStylesInjected = true;
    const style = document.createElement('style');
    style.id = 'tkgProximityNudgeStyles';
    style.textContent =
      '.tkg-proximity-nudge{position:fixed;left:50%;bottom:18px;transform:translateX(-50%) translateY(120%);' +
      'width:calc(100% - 32px);max-width:380px;background:#1C1815;color:#F2EFEA;border-radius:16px;' +
      'padding:14px 16px;box-shadow:0 12px 30px rgba(0,0,0,0.35);z-index:9999;display:flex;align-items:center;' +
      'gap:12px;transition:transform 0.3s ease;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;}' +
      '.tkg-proximity-nudge.show{transform:translateX(-50%) translateY(0);}' +
      '.tkg-proximity-nudge .tkg-pn-text{flex:1;min-width:0;}' +
      '.tkg-proximity-nudge .tkg-pn-title{font-size:0.875rem;font-weight:700;margin:0 0 2px;}' +
      '.tkg-proximity-nudge .tkg-pn-sub{font-size:0.75rem;opacity:0.72;margin:0;}' +
      '.tkg-proximity-nudge .tkg-pn-cta{flex-shrink:0;background:#E85D2C;color:#fff;border:none;border-radius:10px;' +
      'padding:9px 13px;font-size:0.75rem;font-weight:700;cursor:pointer;white-space:nowrap;}' +
      '.tkg-proximity-nudge .tkg-pn-close{flex-shrink:0;background:transparent;border:none;color:#F2EFEA;' +
      'opacity:0.5;font-size:1.1rem;cursor:pointer;padding:0 2px;line-height:1;}';
    document.head.appendChild(style);
  }

  function showProximityNudgeBanner(surface, onOpenJourney) {
    injectProximityNudgeStyles();
    const el = document.createElement('div');
    el.className = 'tkg-proximity-nudge';
    el.innerHTML =
      '<div class="tkg-pn-text">' +
        '<p class="tkg-pn-title">Seems like you\'re planning to visit today \uD83D\uDC4B</p>' +
        '<p class="tkg-pn-sub">Let us know how we can help</p>' +
      '</div>' +
      '<button type="button" class="tkg-pn-cta">Choose Journey</button>' +
      '<button type="button" class="tkg-pn-close" aria-label="Dismiss">\u00D7</button>';
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));

    function remove() {
      el.classList.remove('show');
      setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 320);
    }

    el.querySelector('.tkg-pn-close').addEventListener('click', () => {
      logEvent(surface, 'proximity_nudge_dismissed');
      remove();
    });
    el.querySelector('.tkg-pn-cta').addEventListener('click', () => {
      logEvent(surface, 'proximity_nudge_tapped');
      remove();
      if (typeof onOpenJourney === 'function') onOpenJourney();
    });

    // Auto-dismiss if left untouched — never lingers like a sticky
    // tracking indicator, matches the "normal notification" feel.
    setTimeout(() => { if (el.parentNode) remove(); }, 10000);
  }

  // checkProximityNudge(surface, onOpenJourney) — call once per page load
  // from each of the 5 surfaces. onOpenJourney is that page's OWN
  // function for opening its Journey selection UI (e.g. showScreen(
  // 'screen-journey') on Menu, openJourneyPrompt() elsewhere) — this
  // module never assumes a specific UI, it only decides WHETHER to nudge.
  function checkProximityNudge(surface, onOpenJourney) {
    if (!isProximityNudgeDay()) return;
    if (hasShownProximityNudgeToday()) return;

    const activeJourney = getJourneyContext();
    if (activeJourney && activeJourney.state === 'atTKG') return; // already checked in, no need to nudge

    geoPermissionAlreadyGranted().then((granted) => {
      if (!granted) return; // never prompt just for this — silent no-op
      if (!navigator.geolocation) return;

      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const accuracy = pos.coords.accuracy;
          if (accuracy != null && accuracy > PROXIMITY_ACCURACY_MAX_METERS) return; // unreliable fix, skip silently

          const distance = haversineMeters(pos.coords.latitude, pos.coords.longitude, TKG_LOCATION.lat, TKG_LOCATION.lon);
          if (distance <= PROXIMITY_RADIUS_METERS) {
            markProximityNudgeShown();
            logEvent(surface, 'proximity_nudge_shown', { distance: Math.round(distance) });
            showProximityNudgeBanner(surface, onOpenJourney);
          }
        },
        () => { /* denied/unavailable/timeout — silent no-op, no error UI */ },
        { timeout: 8000, maximumAge: 600000 }
      );
    });
  }

  // ========================================================
  // SESSION MOVEMENT TRAIL — Phase 1 (locked 2026-08-13)
  // Anonymous, per-tab movement log. Completely separate from customer
  // identity: never reads/writes tkg_customer, tkg_my_identity, or
  // tkg_customers, and nothing in the identity/visit functions above
  // reads this. sessionStorage (not localStorage) is used deliberately —
  // it clears itself when the tab closes, which is the natural boundary
  // for "one visit" without inventing a custom expiry rule.
  //
  // logEvent(surface, event, extra) — appends one entry and returns the
  // updated trail array. Capped at 50 entries (oldest dropped first) so
  // a long browsing session can't grow this unbounded.
  //
  // getSessionTrail() — read-only accessor, returns the current array
  // (empty array if nothing logged yet or storage is unavailable).
  // ========================================================
  const SESSION_TRAIL_KEY = 'tkg_session_trail';
  const SESSION_TRAIL_MAX = 50;

  function getSessionTrail() {
    try {
      const raw = sessionStorage.getItem(SESSION_TRAIL_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function logEvent(surface, event, extra) {
    const entry = Object.assign(
      { ts: new Date().toISOString(), surface: surface, event: event },
      extra || {}
    );
    // Step 1 (2026-08-13): attach the active Journey state, when one
    // exists, so the movement trail understands Journey context without
    // becoming a second Journey system — this only reads
    // tkg_journey_context via getJourneyContext(), never writes it.
    const journey = getJourneyContext();
    if (journey && journey.state) {
      entry.journey = journey.state;
    }
    const trail = getSessionTrail();
    trail.push(entry);
    while (trail.length > SESSION_TRAIL_MAX) trail.shift();
    try {
      sessionStorage.setItem(SESSION_TRAIL_KEY, JSON.stringify(trail));
    } catch (e) {
      console.warn('[tkg-shared] Failed to write session trail.', e);
    }
    return trail;
  }

  // ========================================================
  // APPS SCRIPT DISPATCH
  //
  // submitToAppsScript(action, moduleData, options)
  //   - action:      string, e.g. 'uploadMoment', 'submitMomentLink'
  //   - moduleData:  plain object with the module's own fields
  //   - options:
  //       method:        'POST' (default) | 'GET'
  //       requireIdentity: true (default) — if true and no identity is
  //                        stored, rejects before sending (caller should
  //                        prompt for name/mobile first)
  //       contentType:   default 'text/plain;charset=utf-8' — matches
  //                      the existing workaround for Apps Script's
  //                      missing doOptions() CORS-preflight handling.
  //                      Do NOT change to 'application/json' — that
  //                      was the confirmed root cause of earlier
  //                      "Failed to fetch" errors.
  //
  // Returns: { success: true, data } or { success: false, error }
  // Reads Apps Script's { status: 'ok' | 'error', message? } contract.
  // ========================================================
  async function submitToAppsScript(action, moduleData, options) {
    const opts = Object.assign(
      { method: 'POST', requireIdentity: true, contentType: 'text/plain;charset=utf-8' },
      options || {}
    );

    let identity = null;
    if (opts.requireIdentity) {
      identity = getCustomerIdentity();
      if (!identity) {
        return {
          success: false,
          error: { code: 'NO_IDENTITY', message: 'Name and mobile number are required before this action.' }
        };
      }
    }

    const payload = Object.assign(
      { action: action },
      identity ? { name: identity.name, mobile: identity.mobile } : {},
      moduleData || {}
    );

    try {
      let response;
      if (opts.method === 'GET') {
        const params = new URLSearchParams(payload).toString();
        response = await fetch(`${APP_SCRIPT_URL}?${params}`);
      } else {
        response = await fetch(APP_SCRIPT_URL, {
          method: 'POST',
          headers: { 'Content-Type': opts.contentType },
          body: JSON.stringify(payload)
        });
      }

      const result = await response.json();

      if (!result || result.status !== 'ok') {
        return {
          success: false,
          error: {
            code: 'SERVER_ERROR',
            message: (result && result.message) || 'Something went wrong. Please try again.'
          }
        };
      }

      return { success: true, data: result };
    } catch (err) {
      console.error(`[tkg-shared] submitToAppsScript(${action}) failed:`, err);
      return {
        success: false,
        error: { code: 'NETWORK_ERROR', message: 'Could not reach the server. Check your connection.' }
      };
    }
  }

  // ========================================================
  // FETCH (read-only GET, e.g. ?action=moments / getFeaturedReviews)
  // Does not require or attach identity — for public read endpoints.
  // Returns { success: true, data } or { success: false, error }.
  // ========================================================
  async function fetchFromAppsScript(action, params) {
    try {
      const query = new URLSearchParams(Object.assign({ action: action }, params || {})).toString();
      const response = await fetch(`${APP_SCRIPT_URL}?${query}`);
      const result = await response.json();
      return { success: true, data: result };
    } catch (err) {
      console.error(`[tkg-shared] fetchFromAppsScript(${action}) failed:`, err);
      return {
        success: false,
        error: { code: 'NETWORK_ERROR', message: 'Could not reach the server. Check your connection.' }
      };
    }
  }

  // ========================================================
  // PUBLIC API
  // ========================================================
  global.TKGShared = {
    // identity
    getCustomerIdentity,
    setCustomerIdentity,
    clearCustomerIdentity,
    hasCustomerIdentity,
    // validation
    normalizeMobile,
    isPlausibleMobile,
    // session movement trail (Phase 1, 2026-08-13 — isolated from identity)
    logEvent,
    getSessionTrail,
    // shared journey context (Step 1, 2026-08-13 — mirrors index.html's
    // own tkg_journey/tkg_journey_ts, does not replace or alter them)
    getJourneyContext,
    setJourneyContext,
    // journey origin — write-once first-surface capture (2026-08-14)
    getJourneyOrigin,
    setJourneyOriginIfUnset,
    // journey analytics + location engine — same mechanism Menu uses,
    // shared so Hub/Moments/Runner don't duplicate it (2026-08-14)
    recordJourneyEvent,
    // 200m proximity nudge — Sprint B (2026-08-15)
    checkProximityNudge,
    // network
    submitToAppsScript,
    fetchFromAppsScript,
    // exposed for pages that need the raw endpoint (e.g. legacy code mid-migration)
    APP_SCRIPT_URL
  };

})(window);
