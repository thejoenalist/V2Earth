/**
 * ConsentState — single source of truth for the telemetry consent flag.
 *
 * This is the ONE approved localStorage use in the project (see DECISIONS.md,
 * amendment 2026-07-05). It stores a single boolean preference — never chat
 * text or any personal content, which must not persist client-side.
 *
 * Semantics:
 *   - Accept  → persisted in localStorage; banner never reappears.
 *   - Decline → session-only (in memory); telemetry stays off for this
 *     session, nothing is stored, and the banner reappears on next visit.
 *
 * EventBus contract:
 *   Emits: consent:changed { granted: boolean }
 *
 * Consumers must import getConsent()/setConsent() from here — do not read
 * localStorage directly anywhere else (single-source rule).
 */

import { EventBus } from './EventBus.js';

const STORAGE_KEY = 'earthsim.telemetryConsent';
const ACCEPTED = 'accepted';

/** @type {boolean | null} null = undecided, true = accepted, false = declined (session-only) */
let _granted = null;

// localStorage can throw (private browsing, storage disabled) — telemetry
// consent must never break the app, so all storage access is guarded.
function _read() {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function _persistAccept() {
  try {
    window.localStorage.setItem(STORAGE_KEY, ACCEPTED);
  } catch { /* non-fatal — consent just won't persist across visits */ }
}

// Initialize from storage at module load so early consumers see the right state.
if (_read() === ACCEPTED) _granted = true;

/** @returns {boolean | null} true = accepted, false = declined, null = undecided */
export function getConsent() {
  return _granted;
}

/**
 * Record the user's consent choice and notify subscribers.
 * @param {boolean} granted
 */
export function setConsent(granted) {
  _granted = Boolean(granted);
  if (_granted) _persistAccept();
  EventBus.emit('consent:changed', { granted: _granted });
}
