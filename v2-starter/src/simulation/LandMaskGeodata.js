/**
 * LandMaskGeodata — lazy loader + sampler for the global burnable-land mask.
 *
 * File: /data/geodata/landmask.json (produced by pipeline/bake_landmask.py in CI
 * from Natural Earth 1:50m land minus glaciated areas). One bit per grid cell,
 * base64-packed MSB-first, row-major from the north. The wildfire render samples
 * it so fire never lands on open ocean or ice.
 *
 * Missing file (bake not run yet) → loadLandMask() resolves to null and the
 * render keeps its unclipped centroid behavior — never throws.
 *
 * Honest scope: land vs water + ice, minus major NAMED deserts (NE 1:10m
 * geography regions — added 2026-07-16; a pre-desert bake degrades gracefully,
 * see _meta.desert_excluded). Unnamed barren/urban land is still burnable —
 * MODIS / ESA WorldCover remains the fuller follow-up. Coarse grid →
 * block-level, not parcel-level.
 */

/** @type {Promise<LandMask|null>|null} */
let _promise = null;

/**
 * @typedef {Object} LandMask
 * @property {number} width @property {number} height @property {number} resDeg
 * @property {Uint8Array} bits   packed bits, MSB-first row-major
 * @property {(lon:number, lat:number) => boolean} isBurnable
 * @property {(lon:number, lat:number, maxRings?:number) =>
 *            {lon:number, lat:number}|null} nearestBurnable
 */

function _build(doc) {
  const { width, height, res_deg: resDeg } = doc;
  const bytes = atob(doc.packed);
  const bits = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) bits[i] = bytes.charCodeAt(i);

  const cellAt = (row, col) => {
    if (row < 0 || row >= height || col < 0 || col >= width) return false;
    const idx = row * width + col;
    return (bits[idx >> 3] >> (7 - (idx & 7))) & 1;
  };
  const rowOf = (lat) => Math.floor((90 - lat) / resDeg);
  const colOf = (lon) => Math.floor((((lon + 180) % 360 + 360) % 360) / resDeg);

  const isBurnable = (lon, lat) => !!cellAt(rowOf(lat), colOf(lon));

  /** Spiral outward in grid rings until a burnable cell is found. */
  const nearestBurnable = (lon, lat, maxRings = 8) => {
    const r0 = rowOf(lat), c0 = colOf(lon);
    if (cellAt(r0, c0)) return { lon, lat };
    for (let ring = 1; ring <= maxRings; ring++) {
      for (let dr = -ring; dr <= ring; dr++) {
        for (let dc = -ring; dc <= ring; dc++) {
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== ring) continue; // ring edge only
          if (cellAt(r0 + dr, c0 + dc)) {
            return {
              lon: -180 + (c0 + dc + 0.5) * resDeg,
              lat: 90 - (r0 + dr + 0.5) * resDeg,
            };
          }
        }
      }
    }
    return null;
  };

  return { width, height, resDeg, bits, isBurnable, nearestBurnable };
}

/**
 * Load + decode the burnable-land mask (cached; null on any failure).
 * @returns {Promise<LandMask|null>}
 */
export function loadLandMask() {
  if (!_promise) {
    _promise = fetch('/data/geodata/landmask.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((doc) => (doc && doc.packed && doc.width && doc.height ? _build(doc) : null))
      .catch(() => {
        _promise = null; // allow retry next call
        return null;
      });
  }
  return _promise;
}
