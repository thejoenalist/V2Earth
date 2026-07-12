/**
 * InundationGeodata — lazy loader for baked coastal inundation polygons
 * (VISUAL_UPGRADE_PLAN F3, produced by pipeline/bake_geodata.py in CI).
 *
 * Files live at /data/geodata/slr_<metro>.json and are fetched only when a
 * sea-level simulation lands near a flagship metro (Netlify bandwidth: the
 * global bake is never shipped to users who never ask about a coast).
 *
 * Missing file (bake hasn't run yet / metro not baked) resolves to null and
 * the render falls back to its generic behavior — never throws.
 *
 * Geometry is baked from the Copernicus GLO-30 DEM; every displayed number in
 * the file (area_km2) is pipeline-computed, never LLM-derived.
 */

/**
 * Flagship metro registry — mirror of METROS in pipeline/bake_geodata.py.
 * matchRadiusDeg: how close (Σ|Δlon|+|Δlat|) an event center must land to use
 * this metro's geometry.
 */
const FLAGSHIP_METROS = [
  { key: 'miami',       display: 'Miami',         lon: -80.19, lat: 25.78, matchRadiusDeg: 2.0 },
  { key: 'nyc',         display: 'New York City', lon: -74.00, lat: 40.71, matchRadiusDeg: 2.0 },
  { key: 'new_orleans', display: 'New Orleans',   lon: -90.07, lat: 29.95, matchRadiusDeg: 2.0 },
  { key: 'jakarta',     display: 'Jakarta',       lon: 106.83, lat: -6.17, matchRadiusDeg: 2.0 },
  // Enable as bake_geodata.py METROS grows:
  // norfolk, houston_galveston, dhaka, lagos, shanghai, rotterdam
];

/** @type {Map<string, Promise<Object|null>>} */
const _cache = new Map();

/**
 * Find the flagship metro nearest an event center, if within match radius.
 *
 * @param {number} lon @param {number} lat
 * @returns {{key:string, display:string, lon:number, lat:number}|null}
 */
export function findFlagshipMetro(lon, lat) {
  let best = null;
  let bestD = Infinity;
  for (const m of FLAGSHIP_METROS) {
    const d = Math.abs(m.lon - lon) + Math.abs(m.lat - lat);
    if (d <= m.matchRadiusDeg && d < bestD) {
      best = m;
      bestD = d;
    }
  }
  return best;
}

/**
 * Load a metro's baked inundation document (cached; null on any failure).
 *
 * @param {string} metroKey
 * @returns {Promise<Object|null>} parsed slr_<metro>.json or null
 */
export function loadInundation(metroKey) {
  if (!_cache.has(metroKey)) {
    _cache.set(
      metroKey,
      fetch(`/data/geodata/slr_${metroKey}.json`)
        .then((r) => (r.ok ? r.json() : null))
        .then((doc) => (doc && doc.levels ? doc : null))
        .catch(() => null),
    );
  }
  return _cache.get(metroKey);
}

/**
 * Choose which baked rise step to display for a projected rise.
 * Returns the smallest baked level ≥ the projection (so the visual never
 * understates uncertainty by showing less water than projected), clamped to
 * the largest available. Callers must label the shown level honestly.
 *
 * @param {Object} doc  - slr_<metro>.json
 * @param {number} riseM - projected rise (m)
 * @returns {{levelKey:string, levelM:number, areaKm2:number, rings:Array}|null}
 */
export function pickLevel(doc, riseM) {
  const keys = Object.keys(doc.levels)
    .map((k) => ({ key: k, m: parseFloat(k) }))
    .sort((a, b) => a.m - b.m);
  if (!keys.length) return null;
  const chosen = keys.find((k) => k.m >= riseM) ?? keys[keys.length - 1];
  const lvl = doc.levels[chosen.key];
  if (!lvl || !Array.isArray(lvl.rings) || lvl.rings.length === 0) return null;
  return {
    levelKey: chosen.key,
    levelM: chosen.m,
    areaKm2: lvl.area_km2 ?? null,
    rings: lvl.rings,
  };
}
