/**
 * Admin1Geodata — lazy loader for baked admin-1 (state/province) boundaries.
 *
 * Files live at /data/geodata/admin1_<ISO3>.json (one per country, produced by
 * pipeline/bake_admin1.py in CI from Natural Earth 1:10m — full global coverage).
 * Fetched only when a drought simulation targets a country, cached per session.
 *
 * A missing file (bake hasn't run for that country yet) resolves to null and the
 * drought render falls back to the national-boundary polygon — never throws.
 *
 * Geometry only: the choropleth colors every region by the country's NATIONAL
 * drought_index and says so on-screen. No sub-national climate value lives here
 * (rule #4).
 */

import { normalizeISO } from '../core/ISONormalizer.js';

/** @type {Map<string, Promise<Object|null>>} */
const _cache = new Map();

/**
 * Load a country's admin-1 document (cached; null on any failure / empty).
 *
 * @param {string|null|undefined} iso - any alias normalizeISO accepts
 * @returns {Promise<Object|null>} parsed admin1_<ISO>.json or null
 */
export function loadAdmin1(iso) {
  const key = normalizeISO(iso);
  if (!key) return Promise.resolve(null);
  if (!_cache.has(key)) {
    _cache.set(
      key,
      fetch(`/data/geodata/admin1_${key}.json`)
        .then((r) => (r.ok ? r.json() : null))
        .then((doc) => (doc && Array.isArray(doc.regions) && doc.regions.length ? doc : null))
        .catch(() => null),
    );
  }
  return _cache.get(key);
}

/**
 * Flatten a region's polygons into Cesium-ready ring arrays.
 * Each polygon → { outer: [lon,lat,…], holes: [[lon,lat,…],…] }.
 *
 * @param {{polygons: {outer:number[][], holes:number[][][]}[]}} region
 * @returns {{ outer: number[], holes: number[][] }[]}
 */
export function regionToPolygonRings(region) {
  const polys = region?.polygons;
  if (!Array.isArray(polys)) return [];
  return polys.map((p) => ({
    outer: (p.outer ?? []).flat(),
    holes: (p.holes ?? []).map((h) => h.flat()),
  }));
}
