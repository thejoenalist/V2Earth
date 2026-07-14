/**
 * HurricaneGeodata — lazy loader for baked historical-analog storm tracks
 * (HURRICANE_TRACKS_PLAN Phase 1, produced by pipeline/bake_tracks.py in CI).
 *
 * Files live at /data/geodata/hurricane_<metro>.json and are fetched only when a
 * hurricane simulation lands near a flagship metro that has a curated analog —
 * mirrors InundationGeodata.js so the two share the same flagship registry and
 * the same "missing file → null → generic render" contract.
 *
 * A missing file (bake hasn't run / no analog for this coast, e.g. Jakarta)
 * resolves to null and _renderHurricane keeps its spiral-only behavior — never
 * throws. Every displayed value in the file (track coordinates, per-point
 * category, analog metadata) is baked, never LLM-derived (CLAUDE.md rule #4).
 */

import { findFlagshipMetro } from './InundationGeodata.js';

/** @type {Map<string, Promise<Object|null>>} */
const _cache = new Map();

/**
 * Load a metro's baked analog-track document (cached; null on any failure or
 * when the metro has no analog file).
 *
 * @param {string} metroKey
 * @returns {Promise<Object|null>} parsed hurricane_<metro>.json or null
 */
export function loadHurricane(metroKey) {
  if (!_cache.has(metroKey)) {
    _cache.set(
      metroKey,
      fetch(`/data/geodata/hurricane_${metroKey}.json`)
        .then((r) => (r.ok ? r.json() : null))
        .then((doc) =>
          doc && Array.isArray(doc.track) && doc.track.length ? doc : null)
        .catch(() => null),
    );
  }
  return _cache.get(metroKey);
}

// Re-exported so callers can resolve the metro and load the track from one module.
export { findFlagshipMetro };
