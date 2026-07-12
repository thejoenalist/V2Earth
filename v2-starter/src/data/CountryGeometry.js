/**
 * CountryGeometry — single source for per-country boundary geometry.
 *
 * The choropleth layers (Temperature/SeaLevel/Precipitation) and RegionPicker
 * each load countries.geojson for WHOLE-WORLD rendering; this module is the
 * lookup path for ONE country's polygons, used by simulation renders that
 * anchor visuals to real boundaries instead of centroid ellipses
 * (VISUAL_UPGRADE_PLAN: polygon-anchored geometry is the template).
 *
 * The geojson fetch is cached module-wide — at most one network request per
 * session, shared across all simulations.
 */

import { normalizeISO } from '../core/ISONormalizer.js';

const BOUNDARIES_URL = '/data/countries.geojson';

/** @type {Promise<object> | null} */
let _geojsonPromise = null;

function loadBoundaries() {
  if (!_geojsonPromise) {
    _geojsonPromise = fetch(BOUNDARIES_URL)
      .then((r) => {
        if (!r.ok) throw new Error(`[CountryGeometry] Failed to load ${BOUNDARIES_URL}`);
        return r.json();
      })
      .catch((err) => {
        _geojsonPromise = null; // allow retry on the next call
        throw err;
      });
  }
  return _geojsonPromise;
}

/**
 * The GeoJSON feature for an ISO country code (any alias normalizeISO accepts),
 * or null when the code is unknown / not in the baked boundaries.
 *
 * @param {string | null | undefined} iso
 * @returns {Promise<object | null>}
 */
export async function getCountryFeature(iso) {
  const want = normalizeISO(iso);
  if (!want) return null;
  const geojson = await loadBoundaries();
  return (
    geojson.features.find(
      (f) => normalizeISO(f.properties?.iso ?? f.properties?.ISO_A3) === want,
    ) ?? null
  );
}

/**
 * Flatten a feature's (Multi)Polygon into Cesium-ready ring arrays,
 * largest polygons first, capped so archipelago nations (thousands of
 * islets) can't blow the entity budget of a single render.
 *
 * @param {object | null} feature GeoJSON feature
 * @param {{ maxPolygons?: number }} [opts]
 * @returns {{ outer: number[], holes: number[][] }[]}
 *   outer/holes are flat [lon, lat, lon, lat, …] arrays.
 */
export function featureToPolygonRings(feature, { maxPolygons = 12 } = {}) {
  const g = feature?.geometry;
  if (!g) return [];
  const polys =
    g.type === 'Polygon' ? [g.coordinates]
    : g.type === 'MultiPolygon' ? g.coordinates
    : [];
  return polys
    .map((rings) => ({
      outer: rings[0].flat(),
      holes: rings.slice(1).map((r) => r.flat()),
      size: rings[0].length,
    }))
    .sort((a, b) => b.size - a.size)
    .slice(0, maxPolygons)
    .map(({ outer, holes }) => ({ outer, holes }));
}
