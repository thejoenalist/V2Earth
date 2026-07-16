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

// Consent version — privacy.html promises "if this policy changes materially,
// the consent banner will reappear and ask again". This is the mechanism
// (added 2026-07-16; before it the flag was unversioned and the promise had
// none): the stored value is the policy's last-updated date, and a stored
// consent for an older version no longer counts, so the banner re-asks.
// BUMP THIS whenever privacy.html changes materially, together with its
// "Last updated" date. Still the one approved localStorage flag (DECISIONS.md
// amendment) — same key, single value, no personal content.
const CONSENT_VERSION = '2026-07-05';
const ACCEPTED = `accepted:${CONSENT_VERSION}`;
// Pre-versioning value written between 2026-07-05 and 2026-07-16 — the policy
// text is unchanged since then, so legacy consent remains valid for this
// version (and is upgraded in place on load).
const ACCEPTED_LEGACY = 'accepted';

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
{
  const stored = _read();
  if (stored === ACCEPTED) {
    _granted = true;
  } else if (stored === ACCEPTED_LEGACY) {
    _granted = true;
    _persistAccept(); // upgrade the legacy value to the versioned form
  }
  // Any other value (older CONSENT_VERSION after a bump, or garbage) counts
  // as undecided → the banner asks again before any collection.
}

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
