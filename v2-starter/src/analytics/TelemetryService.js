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
import { getSupabaseOrigin } from '../core/supabaseClient.js';

const SUPABASE_URL = getSupabaseOrigin(import.meta.env.VITE_SUPABASE_URL ?? '');
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';

/** @returns {string} */
function generateSessionId() {
  return `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export class TelemetryService {
  /**
   * @param {{ sessionId?: string }} [opts] - Pass the app-wide session ID so
   *   telemetry rows correlate with chat:query payloads. Falls back to a
   *   generated ID if not provided.
   */
  constructor({ sessionId } = {}) {
    this._sessionId = sessionId ?? generateSessionId();
    this._sessionStartMs = Date.now();
    this._events = [];
    this._activeRegion = null;
    this._regionEnteredAt = null;
    this._enabled = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

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
    EventBus.on('report:export_requested', ({ type, context }) => this._log('report_export', { type, target: context?.target ?? null }));
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

  // ── Remote flush (Supabase REST) ─────────────────────────────────────────
  //
  // Raw fetch with keepalive:true instead of supabase-js — keepalive lets the
  // browser finish the request after the page unloads, so session_end events
  // (fired in beforeunload) actually persist. supabase-js inserts were being
  // dropped on unload.

  _flush(entry) {
    if (!this._enabled) return;
    try {
      fetch(`${SUPABASE_URL}/rest/v1/telemetry_events`, {
        method: 'POST',
        keepalive: true,
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          Prefer: 'return=minimal',
        },
        body: JSON.stringify(entry),
      }).catch(() => { /* silent — telemetry must never affect UX */ });
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
