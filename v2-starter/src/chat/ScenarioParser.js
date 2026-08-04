/**
 * ScenarioParser — converts user natural language to SimulationCommand.
 *
 * Production: Supabase Edge Function proxy (never the Anthropic API directly).
 * Development: tries local Vite proxy (/api/parse-scenario) first when available.
 */

import { createCommand, EVENT_TYPES } from './SimulationCommand.js';
import { normalizeISO } from '../core/ISONormalizer.js';
import { getCentroid, SAHEL_CENTROID } from '../globe/RegionCentroids.js';
import { getSupabaseOrigin } from '../core/supabaseClient.js';

const SUPABASE_URL = getSupabaseOrigin(import.meta.env.VITE_SUPABASE_URL ?? '');
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';
const LOCAL_PARSE_URL = '/api/parse-scenario';

/** Canonical command types accepted by _validate. Exported for verify-all. */
export const VALID_TYPES = Object.freeze([
  'climate_event',
  'scenario_compare',
  'region_inspect',
  'timeline_jump',
  'local_action',
  'research_query',
  'resilience_plan',
  'explain',
  'empowerment_quiz',
  'support',
]);

const SAHEL_ISOS = new Set(['NER', 'MLI', 'BFA', 'TCD', 'MRT', 'SEN', 'SDN', 'ETH', 'GMB', 'GIN', 'CMR']);

/** Minimal support command — narrative is empty by design; UI uses hardcoded HTML. */
export function canonicalSupportCommand() {
  return {
    type: 'support',
    target: null,
    event: null,
    eject: false,
    offerSupport: false,
    params: {},
    narrative: { learned: '', action: '', emotion: '', sources: [] },
  };
}

export class ScenarioParser {
  constructor() {
    this._history = [];
  }

  /**
   * Fetch + validate (legacy single-shot). Prefer fetchRaw + validate in UI so
   * crisis/support can short-circuit before schema validation.
   */
  async parse(userText, currentContext) {
    const raw = await this.fetchRaw(userText, currentContext);
    return this.validateAndCommit(userText, raw);
  }

  /**
   * HTTP fetch only — returns the raw JSON body with no schema validation.
   * Throws on network / non-OK / error-payload responses.
   */
  async fetchRaw(userText, currentContext) {
    const historyForRequest = this._history.slice(-10);
    const payload = {
      query: userText,
      year: currentContext.year,
      ssp: currentContext.ssp,
      history: historyForRequest,
    };

    let raw = null;
    let lastError = null;

    if (import.meta.env.DEV) {
      try {
        raw = await this._requestRaw(LOCAL_PARSE_URL, payload);
      } catch (err) {
        lastError = err;
      }
    }

    if (!raw && SUPABASE_URL) {
      try {
        raw = await this._requestRaw(
          `${SUPABASE_URL}/functions/v1/parse-scenario`,
          payload,
          { Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
        );
      } catch (err) {
        lastError = err;
      }
    }

    if (!raw) {
      if (!SUPABASE_URL && !import.meta.env.DEV) {
        return this._devStubRaw();
      }
      throw lastError ?? new Error('No scenario parser available');
    }

    return raw;
  }

  /**
   * Schema-validate a raw body, normalize, commit chat history, return command.
   */
  validateAndCommit(userText, raw) {
    const command = this._validate(raw);

    if (command.target) {
      command.target = normalizeISO(command.target) ?? command.target;
    }

    this._commitHistory(userText, command);
    return createCommand(command);
  }

  /** Record a turn without validation (used for the support short-circuit). */
  commitSupport(userText) {
    this._commitHistory(userText, canonicalSupportCommand());
  }

  _commitHistory(userText, command) {
    this._history.push({ role: 'user', content: userText });
    this._history.push({ role: 'assistant', content: JSON.stringify(command) });
    if (this._history.length > 10) {
      this._history = this._history.slice(-10);
    }
  }

  async _requestRaw(url, payload, extraHeaders = {}) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...extraHeaders,
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok || data.error) {
      const err = new Error(
        typeof data.error === 'string' && data.error
          ? data.error
          : `[ScenarioParser] Parser error: ${response.status}`,
      );
      // Propagate machine-readable code for ChatInterface (credits / rate / upstream).
      if (typeof data.code === 'string') err.code = data.code;
      throw err;
    }

    return data;
  }

  _validate(cmd) {
    if (!cmd || typeof cmd !== 'object') {
      throw new Error('[ScenarioParser] Invalid command: not an object');
    }

    const raw = cmd;

    // Support: ignore malformed extras — UI never reads narrative for this type.
    if (raw.type === 'support') {
      return canonicalSupportCommand();
    }

    if (!VALID_TYPES.includes(raw.type)) {
      throw new Error(`[ScenarioParser] Invalid command type: ${raw.type}`);
    }

    raw.params = raw.params && typeof raw.params === 'object'
      ? { ...raw.params }
      : {};

    const eventType = raw.params.eventType ?? raw.event ?? null;
    if (eventType && typeof eventType === 'string' && Object.hasOwn(EVENT_TYPES, eventType)) {
      raw.event = eventType;
      raw.params.eventType = eventType;
    } else {
      raw.event = null;
      raw.params.eventType = null;
    }

    if (typeof raw.params.year === 'number') {
      raw.params.year = Math.max(2025, Math.min(2100, raw.params.year));
    }

    // offerSupport: climate-hopelessness footer flag. Never true on type "support".
    raw.offerSupport = raw.offerSupport === true && raw.type !== 'support';

    if (!raw.narrative || typeof raw.narrative !== 'object') {
      raw.narrative = {};
    }

    const narrative = raw.narrative;
    narrative.learned = typeof narrative.learned === 'string' ? narrative.learned : '';
    narrative.action = typeof narrative.action === 'string' ? narrative.action : '';
    narrative.emotion = typeof narrative.emotion === 'string' ? narrative.emotion : '';
    narrative.sources = Array.isArray(narrative.sources) ? narrative.sources : [];

    if (raw.type === 'climate_event' && raw.params.eventType) {
      this._attachCenter(raw);
    }

    return raw;
  }

  _attachCenter(cmd) {
    const params = cmd.params;
    if (params.center && typeof params.center === 'object') return;

    const target = typeof cmd.target === 'string' ? cmd.target : null;
    let centroid = target ? getCentroid(target) : null;

    if (!centroid && target && SAHEL_ISOS.has(target)) {
      centroid = SAHEL_CENTROID;
    }

    if (!centroid && !target && cmd.params?.eventType === 'drought') {
      centroid = SAHEL_CENTROID;
    }

    if (centroid) {
      params.center = { lat: centroid.lat, lon: centroid.lon };
    }
  }

  _devStubRaw() {
    return {
      type: 'explain',
      target: null,
      event: null,
      params: {},
      narrative: {
        learned: '[Dev stub — no Supabase URL configured]',
        action: '',
        emotion: '',
        sources: [],
      },
    };
  }
}
