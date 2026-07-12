/**
 * HumanScale — deterministic "human anchor" comparison copy (VISUAL_UPGRADE_PLAN F4).
 *
 * Turns bare numbers from ImpactStats into things a person can picture:
 *   rise in metres      → "past the first floor of buildings"
 *   a population count   → "≈ the population of Sydney"
 *   an area in km²       → "about 12 × Manhattan"
 *
 * Pure lookups — NO LLM, NO fetch, no randomness. Same input → same output,
 * so the copy is reproducible and can't drift or fabricate. Keyed off the
 * values ImpactStats already produced from baked data.
 */

// ── Sea level rise → what it reaches on a street ────────────────────────────

/**
 * @param {number} meters
 * @returns {string|null}
 */
export function riseToHeight(meters) {
  if (meters == null || Number.isNaN(meters)) return null;
  const m = Number(meters);
  if (m <= 0)    return 'no measurable rise at this horizon';
  if (m < 0.15)  return 'enough to back up storm drains and flood low curbs';
  if (m < 0.5)   return 'up to an adult’s knee in the lowest streets';
  if (m < 1.0)   return 'waist-deep water in low-lying blocks';
  if (m < 1.5)   return 'over an adult’s head — ground floors take on water';
  if (m < 3.0)   return 'past the first floor of buildings';
  return 'into the second floor of buildings';
}

// ── Population count → a city everyone knows ────────────────────────────────

/** Recognizable anchor cities (name, approx. population), ascending. */
const POP_ANCHORS = [
  ['a small town',            25_000],
  ['Green Bay, Wisconsin',    105_000],
  ['Salt Lake City',          200_000],
  ['Orlando',                 310_000],
  ['New Orleans',             384_000],
  ['Atlanta',                 499_000],
  ['Seattle',                 750_000],
  ['San Francisco',           815_000],
  ['Amsterdam',               920_000],
  ['San Jose',                1_000_000],
  ['Barcelona',               1_620_000],
  ['Paris',                   2_100_000],
  ['Chicago',                 2_750_000],
  ['Berlin',                  3_700_000],
  ['Los Angeles',             3_900_000],
  ['Sydney',                  5_300_000],
  ['Singapore',               5_900_000],
  ['New York City',           8_340_000],
  ['London',                  8_980_000],
  ['Jakarta',                 10_560_000],
  ['Mumbai',                  12_440_000],
  ['greater Cairo',           21_300_000],
  ['greater Tokyo',           37_400_000],
];

/**
 * @param {number} count
 * @returns {string|null} e.g. "≈ the population of Sydney"
 */
export function populationToComparison(count) {
  if (count == null || Number.isNaN(count) || count <= 0) return null;
  const n = Number(count);
  // Find the anchor with the closest population (log-distance so ratios matter).
  let best = POP_ANCHORS[0], bestErr = Infinity;
  for (const anchor of POP_ANCHORS) {
    const err = Math.abs(Math.log(n / anchor[1]));
    if (err < bestErr) { bestErr = err; best = anchor; }
  }
  const [name, pop] = best;
  const ratio = n / pop;
  if (ratio >= 1.6)  return `≈ ${ratio.toFixed(1)}× the population of ${name}`;
  if (ratio <= 0.62) return `under half the population of ${name}`;
  return `≈ the population of ${name}`;
}

// ── Area → familiar footprint ───────────────────────────────────────────────

const MANHATTAN_KM2   = 59.1;
const CENTRAL_PARK_KM2 = 3.41;

/**
 * @param {number} km2
 * @returns {string|null}
 */
export function areaToComparison(km2) {
  if (km2 == null || Number.isNaN(km2) || km2 <= 0) return null;
  const a = Number(km2);
  if (a < 2) {
    const parks = a / CENTRAL_PARK_KM2;
    return parks < 0.5 ? 'a few city blocks' : `about ${parks.toFixed(1)} × Central Park`;
  }
  const manh = a / MANHATTAN_KM2;
  if (manh < 0.5) return `about ${(a / CENTRAL_PARK_KM2).toFixed(0)} × Central Park`;
  return `about ${manh < 10 ? manh.toFixed(1) : Math.round(manh)} × Manhattan`;
}

const _nfCompact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

/**
 * Build the one-line human anchor for a sea-level result.
 *
 * Anchors on the physical height + the nearest named coastal city — a concrete,
 * honest picture. Deliberately does NOT convert a national "exposed to climate
 * hazards" fraction into "people displaced by sea level": that figure is
 * all-hazard and national, and implying it is sea-level displacement would be
 * exactly the kind of misleading stat this program exists to remove.
 *
 * @param {{ riseM?:number|null, anchorCity?:{name:string, population?:number}|null }} args
 * @returns {string|null}
 */
export function seaLevelHumanLine({ riseM, anchorCity = null }) {
  const height = riseToHeight(riseM);
  if (!height) return null;
  if (anchorCity?.name) {
    const pop = anchorCity.population != null
      ? ` (${_nfCompact.format(anchorCity.population)} residents)` : '';
    return `That's ${height} — in and around ${anchorCity.name}${pop}.`;
  }
  return `That's ${height}.`;
}
