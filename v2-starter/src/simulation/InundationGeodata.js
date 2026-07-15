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
  // Phase 3 (2026-07-14). A metro may have only one kind of geodata —
  // houston has slr_+hurricane_, dhaka hurricane_ only (track-only analog),
  // jakarta slr_ only; the loaders resolve a missing file to null, so a
  // partial metro degrades to the generic render for the missing kind.
  { key: 'houston',     display: 'Houston–Galveston', lon: -95.36, lat: 29.76, matchRadiusDeg: 2.0 },
  { key: 'dhaka',       display: 'Dhaka',         lon: 90.41,  lat: 23.81, matchRadiusDeg: 2.0 },
  // Enable as bake_geodata.py METROS grows:
  // norfolk, lagos, shanghai, rotterdam
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
 * Fallback matcher for when the parser's event center lands off the coast.
 * The scenario parser (an LLM) often returns a center that's degrees away from
 * the metro the user named — e.g. a "Miami sea level" query whose center drifts
 * into the Gulf, missing Miami's 2° radius and falling back to the generic
 * ellipse. The nearest baked cities are far more reliable: Fort Lauderdale /
 * Hialeah sit right on the real metro, so testing each nearby city against the
 * flagship registry recovers the intended metro. Returns the first city that
 * matches a flagship metro (cities are distance-sorted), else null.
 *
 * @param {Array<{lon:number, lat:number}>} [cities] - nearestCities from ImpactStats
 * @returns {{key:string, display:string, lon:number, lat:number}|null}
 */
export function findFlagshipMetroForCities(cities) {
  if (!Array.isArray(cities)) return null;
  for (const c of cities) {
    if (c?.lon == null || c?.lat == null) continue;
    const m = findFlagshipMetro(c.lon, c.lat);
    if (m) return m;
  }
  return null;
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
