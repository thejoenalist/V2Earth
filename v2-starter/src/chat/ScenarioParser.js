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

const VALID_TYPES = Object.freeze([
  'climate_event',
  'scenario_compare',
  'region_inspect',
  'timeline_jump',
  'local_action',
  'research_query',
  'resilience_plan',
  'explain',
  'empowerment_quiz',
]);

const SAHEL_ISOS = new Set(['NER', 'MLI', 'BFA', 'TCD', 'MRT', 'SEN', 'SDN', 'ETH', 'GMB', 'GIN', 'CMR']);

export class ScenarioParser {
  constructor() {
    this._history = [];
  }

  async parse(userText, currentContext) {
    // History is only committed after a successful parse (see below).
    // Committing the user turn up-front left a dangling user message on
    // failure, producing consecutive user roles on the next request —
    // which the Anthropic API rejects, bricking chat for the session.
    const historyForRequest = this._history.slice(-10);

    const payload = {
      query: userText,
      year: currentContext.year,
      ssp: currentContext.ssp,
      history: historyForRequest,
    };

    let command;
    let lastError = null;

    if (import.meta.env.DEV) {
      try {
        command = await this._requestParse(LOCAL_PARSE_URL, payload);
      } catch (err) {
        lastError = err;
      }
    }

    if (!command && SUPABASE_URL) {
      try {
        command = await this._requestParse(
          `${SUPABASE_URL}/functions/v1/parse-scenario`,
          payload,
          {
            Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          },
        );
      } catch (err) {
        lastError = err;
      }
    }

    if (!command) {
      if (!SUPABASE_URL && !import.meta.env.DEV) {
        return this._devStub();
      }
      throw lastError ?? new Error('No scenario parser available');
    }

    if (command.target) {
      command.target = normalizeISO(command.target) ?? command.target;
    }

    this._history.push({ role: 'user', content: userText });
    this._history.push({ role: 'assistant', content: JSON.stringify(command) });
    if (this._history.length > 10) {
      this._history = this._history.slice(-10);
    }

    return createCommand(command);
  }

  async _requestParse(url, payload, extraHeaders = {}) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...extraHeaders,
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error ?? `[ScenarioParser] Parser error: ${response.status}`);
    }

    if (data.error) {
      throw new Error(data.error);
    }

    return this._validate(data);
  }

  _validate(cmd) {
    if (!cmd || typeof cmd !== 'object') {
      throw new Error('[ScenarioParser] Invalid command: not an object');
    }

    const raw = cmd;

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

  _devStub() {
    return createCommand({
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
    });
  }
}
