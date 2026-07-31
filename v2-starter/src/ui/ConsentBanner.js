/**
 * ConsentBanner — first-visit telemetry consent notice (launch blocker #1).
 *
 * Owns the #consent-banner element in index.html. Shows only while consent is
 * undecided (ConsentState.getConsent() === null):
 *   - Accept  → setConsent(true): persisted, banner never reappears.
 *   - Decline → setConsent(false): session-only; the app works normally,
 *     telemetry stays off, and the banner reappears next visit.
 *
 * Deliberately deferred until after the onboarding overlay is dismissed
 * (see revealIfNeeded). The banner's z-index sits above onboarding, so
 * showing it early covered the "Explore the Earth" button and trapped users.
 *
 * The choice is recorded through ConsentState, which emits consent:changed on
 * the EventBus — TelemetryService reacts there; this module never touches
 * telemetry directly.
 */

import { getConsent, setConsent } from '../core/ConsentState.js';

export class ConsentBanner {
  constructor() {
    this._banner = document.getElementById('consent-banner');
    if (!this._banner) return;

    this._acceptBtn = document.getElementById('consent-accept');
    this._declineBtn = document.getElementById('consent-decline');

    this._onAccept = () => this._choose(true);
    this._onDecline = () => this._choose(false);
    this._acceptBtn?.addEventListener('click', this._onAccept);
    this._declineBtn?.addEventListener('click', this._onDecline);
    // Do not auto-show here — wait for revealIfNeeded() after onboarding.
  }

  /** Show the banner once onboarding is gone, if consent is still undecided. */
  revealIfNeeded() {
    if (!this._banner) return;
    if (getConsent() === null) {
      this._banner.classList.add('visible');
    }
  }

  _choose(granted) {
    setConsent(granted);
    this._banner.classList.remove('visible');
  }

  destroy() {
    this._acceptBtn?.removeEventListener('click', this._onAccept);
    this._declineBtn?.removeEventListener('click', this._onDecline);
  }
}
