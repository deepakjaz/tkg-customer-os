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
    // network
    submitToAppsScript,
    fetchFromAppsScript,
    // exposed for pages that need the raw endpoint (e.g. legacy code mid-migration)
    APP_SCRIPT_URL
  };

})(window);
