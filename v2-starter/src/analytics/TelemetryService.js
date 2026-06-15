/**
 * TelemetryService — captures user behavior as a readable "train of thought."
 *
 * Design goal: each session should be reconstructable as a prose timeline
 * that shows what the user was thinking and what questions they had.
 *
 * Storage: Supabase (remote, Joe-accessible) in production.
 *          localStorage export for local dev / pre-launch.
 *
 * All events are non-blocking. Failures are silently swallowed —
 * telemetry must never affect the user experience.
 */

import { EventBus } from '../core/EventBus.js';
import { supabase } from '../core/supabaseClient.js';

/** @returns {string} */
function generateSessionId() {
  return `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export class TelemetryService {
  constructor() {
    this._sessionId = generateSessionId();
    this._events = [];
    this._activeRegion = null;
    this._regionEnteredAt = null;
    this._supabase = supabase;

    this._wireEventBus();
    this._log('session_start', { referrer: document.referrer || null, viewport: `${window.innerWidth}x${window.innerHeight}` });
    window.addEventListener('beforeunload', () => this._onSessionEnd());
  }

  // ── EventBus wiring ──────────────────────────────────────────────────────

  _wireEventBus() {
    EventBus.on('time:changed',      ({ year, ssp }) => this._log('chapter_change', { year, ssp }));
    EventBus.on('ssp:changed',       ({ ssp })       => this._log('ssp_change', { ssp }));
    EventBus.on('layer:changed',     ({ layerId })   => this._log('layer_change', { layerId }));
    EventBus.on('chat:query',        ({ text })      => this._log('chat_query', { text }));
    EventBus.on('simulation:requested', (cmd)        => this._log('simulation_trigger', { type: cmd.type, iso: cmd.target, event: cmd.event, year: cmd.params?.year }));
    EventBus.on('region:selected',   ({ iso })       => this._onRegionSelected(iso));
  }

  // ── Region dwell tracking ────────────────────────────────────────────────

  _onRegionSelected(iso) {
    if (this._activeRegion && this._regionEnteredAt) {
      const dwell = Date.now() - this._regionEnteredAt;
      this._log('region_dwell', { iso: this._activeRegion, durationMs: dwell });
    }
    this._activeRegion = iso;
    this._regionEnteredAt = Date.now();
    this._log('region_click', { iso });
  }

  // ── Core logging ─────────────────────────────────────────────────────────

  /**
   * @param {string} event
   * @param {Record<string, *>} payload
   */
  _log(event, payload = {}) {
    const entry = {
      sessionId: this._sessionId,
      timestamp: new Date().toISOString(),
      event,
      payload,
    };
    this._events.push(entry);
    this._flush(entry);
  }

  _onSessionEnd() {
    if (this._activeRegion && this._regionEnteredAt) {
      const dwell = Date.now() - this._regionEnteredAt;
      this._log('region_dwell', { iso: this._activeRegion, durationMs: dwell });
    }
    this._log('session_end', {
      totalEvents: this._events.length,
      durationMs: Date.now() - this._sessionStartMs,
    });
  }

  // ── Remote flush (Supabase) ───────────────────────────────────────────────

  async _flush(entry) {
    if (!this._supabase) return;
    try {
      await this._supabase.from('telemetry_events').insert(entry);
    } catch { /* silent */ }
  }

  // ── Dev export ───────────────────────────────────────────────────────────

  /** Download session log as JSON (dev only). */
  exportSession() {
    const blob = new Blob([JSON.stringify(this._events, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `session_${this._sessionId}.json`;
    a.click();
  }

  get sessionId() { return this._sessionId; }
}
