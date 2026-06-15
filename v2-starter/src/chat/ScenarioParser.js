/**
 * ScenarioParser — converts user natural language to SimulationCommand.
 *
 * Calls the Supabase Edge Function proxy (never the Anthropic API directly).
 */

import { createCommand, EVENT_TYPES } from './SimulationCommand.js';
import { normalizeISO } from '../core/ISONormalizer.js';
import { getCentroid, SAHEL_CENTROID } from '../globe/RegionCentroids.js';
import { getSupabaseOrigin } from '../core/supabaseClient.js';

const SUPABASE_URL = getSupabaseOrigin(import.meta.env.VITE_SUPABASE_URL ?? '');
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';

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
    if (!SUPABASE_URL) {
      return this._devStub();
    }

    const historyForRequest = this._history.slice(-10);
    this._history.push({ role: 'user', content: userText });
    if (this._history.length > 10) {
      this._history = this._history.slice(-10);
    }

    const response = await fetch(`${SUPABASE_URL}/functions/v1/parse-scenario`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({
        query: userText,
        year: currentContext.year,
        ssp: currentContext.ssp,
        history: historyForRequest,
      }),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error ?? `[ScenarioParser] Edge function error: ${response.status}`);
    }

    if (data.error) {
      throw new Error(data.error);
    }

    const command = this._validate(data);

    if (command.target) {
      command.target = normalizeISO(command.target) ?? command.target;
    }

    this._history.push({ role: 'assistant', content: JSON.stringify(command) });
    if (this._history.length > 10) {
      this._history = this._history.slice(-10);
    }

    return createCommand(command);
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
    if (eventType && typeof eventType === 'string' && eventType in EVENT_TYPES) {
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
