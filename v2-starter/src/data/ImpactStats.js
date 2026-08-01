/**
 * ImpactStats — the single source of DISPLAY-READY impact numbers.
 *
 * VISUAL_UPGRADE_PLAN F2: every statistic shown on the globe or in chat for a
 * climate event comes from baked data (climate.json / worldbank.json /
 * cities.json), never from the LLM. ScenarioParser keeps returning
 * location + magnitude; the render path and ChatInterface render ImpactStats
 * output. This mechanically enforces CLAUDE.md rule "never fabricate statistics".
 *
 * Every returned number carries a `source` tag (e.g. "CMIP6 SSP2-4.5",
 * "World Bank") so the UI can attribute it. Nothing here calls the network at
 * runtime beyond fetching the static baked JSON (CLAUDE.md rule 5).
 *
 * Usage:
 *   import { getImpactStats } from '../data/ImpactStats.js';
 *   const stats = await getImpactStats({ eventType, iso, year, ssp, center, magnitude });
 *
 * Returns an ImpactStatsResult (see typedef). Always resolves — on data failure
 * it returns { hasData:false } and callers fall back to their prior behavior.
 */

import { normalizeISO, isoDisplayName } from '../core/ISONormalizer.js';

const CLIMATE_URL   = '/data/climate.json';
const WORLDBANK_URL = '/data/worldbank.json';
const CITIES_URL    = '/data/cities.json';

/**
 * @typedef {Object} Stat
 * @property {string} label
 * @property {string} value    - preformatted display string
 * @property {string} basis    - short qualifier ("regional mean", "per year", …)
 * @property {string} source   - attribution tag ("CMIP6 SSP2-4.5", "World Bank")
 */

/**
 * @typedef {Object} NearbyCity
 * @property {string} name
 * @property {string} iso
 * @property {number} lon
 * @property {number} lat
 * @property {number} population
 * @property {number} distanceKm
 * @property {number|null} exposedPopulation - population × exposed fraction, if known
 * @property {number|null} meanElevM
 */

/**
 * @typedef {Object} ImpactStatsResult
 * @property {boolean} hasData
 * @property {Stat|null} headline
 * @property {Stat[]} stats
 * @property {NearbyCity[]} nearestCities
 * @property {{count:number, pct:number, source:string}|null} exposed
 * @property {string[]} caveats
 * @property {'high'|'sparse'|null} coverageTier
 */

// ── Data loading (cached module-level promise) ──────────────────────────────

let _dataPromise = null;

/** @returns {Promise<{climate:object, worldbank:object, cities:object[]}>} */
export function loadImpactData() {
  if (!_dataPromise) {
    _dataPromise = Promise.all([
      fetch(CLIMATE_URL).then((r) => { if (!r.ok) throw new Error(`load ${CLIMATE_URL}`); return r.json(); }),
      fetch(WORLDBANK_URL).then((r) => { if (!r.ok) throw new Error(`load ${WORLDBANK_URL}`); return r.json(); }),
      fetch(CITIES_URL).then((r) => { if (!r.ok) throw new Error(`load ${CITIES_URL}`); return r.json(); }),
    ]).then(([climate, worldbank, citiesDoc]) => ({
      climate,
      worldbank,
      cities: Array.isArray(citiesDoc?.cities) ? citiesDoc.cities : [],
    })).catch((err) => {
      _dataPromise = null; // allow retry
      throw err;
    });
  }
  return _dataPromise;
}

// ── Formatting helpers ──────────────────────────────────────────────────────

const nfCompact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

function fmtCount(n)  { return (n == null || Number.isNaN(n)) ? '—' : nfCompact.format(n); }
function fmtNum(n, digits = 1, suffix = '') {
  return (n == null || Number.isNaN(n)) ? '—' : `${Number(n).toFixed(digits)}${suffix}`;
}
function fmtSigned(n, digits = 1, suffix = '') {
  if (n == null || Number.isNaN(n)) return '—';
  const v = Number(n);
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)}${suffix}`;
}

// ── Geo helpers ─────────────────────────────────────────────────────────────

function haversineKm(lon1, lat1, lon2, lat2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Nearest named cities to a center point.
 * @param {object[]} cities
 * @param {{lon:number, lat:number}} center
 * @param {{ coastalOnly?:boolean, k?:number, maxKm?:number }} [opts]
 * @returns {object[]}
 */
function nearestCities(cities, center, { coastalOnly = false, k = 3, maxKm = 1200 } = {}) {
  if (!center || center.lon == null || center.lat == null) return [];
  const scored = [];
  for (const c of cities) {
    if (coastalOnly && !c.coastal) continue;
    const d = haversineKm(center.lon, center.lat, c.lon, c.lat);
    if (d <= maxKm) scored.push({ city: c, distanceKm: d });
  }
  scored.sort((a, b) => a.distanceKm - b.distanceKm);
  return scored.slice(0, k);
}

/**
 * Event types whose renders re-anchor country-level queries onto the most
 * populous city. Localized hazards only: a wildfire has to be *somewhere*, and
 * a spot 1,000 km from anyone reads as fire-on-sand. Country-scale events
 * (drought, heatwave) paint a national polygon and need no such nudge.
 */
const COUNTRY_LEVEL_ANCHOR_EVENTS = new Set(['wildfire']);

/**
 * Single source for "where does this event actually go?".
 *
 * Both `ActiveSimulation` (which draws the fire) and `ChatInterface` (which
 * renders the By-the-numbers card) must agree on the anchor, or the globe and
 * the card disagree about which city is nearest — on 2026-07-31 the globe read
 * "Sydney — 4.6M people" while the card read "Nearest: Adelaide (1166 km)",
 * because each computed its own. This function is deterministic, so both
 * callers land on the same answer without any event plumbing between them.
 *
 * Gated on the parser's `placeSpecificity`, NOT on distance to the nearest baked
 * city. Distance was tried first and cannot work: `cities.json` holds 1,000
 * cities worldwide — seven in Australia, all coastal capitals — so an invented
 * whole-country centroid (1,166 km from the nearest) and a genuinely remote
 * named town (Alice Springs, ~1,330 km from the same set) land in the same
 * range. Any threshold that catches the first relocates the second, which is
 * strictly worse: it moves a place the user explicitly named. Only the parser
 * knows which was asked for, so it now says so.
 *
 * @param {{eventType:string|null, iso:string|null|undefined,
 *          center:{lon:number,lat:number}|null,
 *          placeSpecificity:string|null|undefined}} args
 * @returns {Promise<{lon:number|null, lat:number|null, cityBiased:boolean}>}
 */
export async function resolveEventAnchor({ eventType, iso, center, placeSpecificity }) {
  const lon = center?.lon ?? null;
  const lat = center?.lat ?? null;
  if (!COUNTRY_LEVEL_ANCHOR_EVENTS.has(eventType)) {
    return { lon, lat, cityBiased: false };
  }
  // Only 'country' re-anchors. A missing value means an older parser response
  // (or the edge function not yet redeployed) — treat it as place-level and
  // leave the centre alone: failing to re-anchor is a cosmetic miss, whereas
  // relocating a named place is a correctness bug.
  const countryLevel = placeSpecificity === 'country' || (lon == null || lat == null);
  if (!countryLevel) return { lon, lat, cityBiased: false };

  const big = await largestCityForISO(iso);
  if (!big) return { lon, lat, cityBiased: false };
  return { lon: big.lon, lat: big.lat, cityBiased: true };
}

/**
 * Most populous baked city in a country. Used by renders that need a
 * population-biased anchor for country-level queries (wildfire, decision
 * 2026-07-16): the anchor comes from baked cities.json (rule #4), never the
 * LLM. Null when the ISO is unknown or the country has no baked city.
 *
 * @param {string|null|undefined} iso
 * @returns {Promise<{name:string, lon:number, lat:number, population:number}|null>}
 */
export async function largestCityForISO(iso) {
  const a3 = normalizeISO(iso);
  if (!a3) return null;
  let data;
  try { data = await loadImpactData(); } catch { return null; }
  let best = null;
  for (const c of data.cities) {
    if (normalizeISO(c.iso) !== a3) continue;
    if (!Number.isFinite(c.lon) || !Number.isFinite(c.lat)) continue;
    const pop = Number(c.population) || 0;
    if (!best || pop > best.population) {
      best = { name: c.name, lon: c.lon, lat: c.lat, population: pop };
    }
  }
  return best;
}

// ── Source tags ─────────────────────────────────────────────────────────────

const climateSource = (ssp) => `CMIP6 ${ssp || 'SSP2-4.5'}`;
const WB_SOURCE     = 'World Bank';
const CITY_SOURCE   = 'GeoNames (approx.)';

// ── Public API ──────────────────────────────────────────────────────────────

const EMPTY = Object.freeze({
  hasData: false, headline: null, stats: [], nearestCities: [],
  exposed: null, caveats: [], coverageTier: null,
});

/**
 * @param {{ eventType:string, iso?:string|null, year:number, ssp:string,
 *           center?:{lon:number,lat:number}|null, magnitude?:number|null }} args
 * @returns {Promise<ImpactStatsResult>}
 */
export async function getImpactStats({ eventType, iso, year, ssp, center = null }) {
  let data;
  try {
    data = await loadImpactData();
  } catch (err) {
    console.warn('[ImpactStats] data load failed:', err);
    return EMPTY;
  }

  const a3 = normalizeISO(iso);
  const yearKey = String(year);
  const climate = a3 ? (data.climate?.[a3]?.[yearKey]?.[ssp] ?? null) : null;
  const wb = a3 ? (data.worldbank?.[a3] ?? null) : null;
  const coverageTier = climate?.coverage_tier ?? null;

  // Nearest cities — coastal bias for water-driven events.
  //
  // Two-pass radius (2026-07-31): the default 1,200 km returns nothing at all
  // for genuinely remote places — cities.json holds 1,000 cities worldwide, so
  // "wildfire near Alice Springs" has no baked city inside that radius (Adelaide
  // is ~1,330 km). The render then lost its city line AND the card lost its
  // "Nearest:" row, leaving a fire in empty terrain with nothing saying where
  // you were looking. Falling back to a wider search is strictly better: the
  // distance is displayed alongside the name, so "Adelaide (1,330 km)" reads
  // honestly as remote rather than pretending the fire is near a city.
  const coastalEvent = eventType === 'sea_level_rise' || eventType === 'hurricane';
  const cityOpts = { coastalOnly: coastalEvent, k: 3 };
  let hits = nearestCities(data.cities, center, cityOpts);
  if (hits.length === 0) {
    hits = nearestCities(data.cities, center, { ...cityOpts, maxKm: 4000 });
  }
  const near = hits
    .map(({ city, distanceKm }) => {
      const exposedPop = (climate?.exposed_population_pct != null)
        ? Math.round(city.population * climate.exposed_population_pct)
        : null;
      return {
        name: city.name, iso: city.iso, lon: city.lon, lat: city.lat,
        population: city.population, distanceKm,
        exposedPopulation: exposedPop, meanElevM: city.mean_elev_m ?? null,
      };
    });

  // National exposed-population count (fraction × national population).
  let exposed = null;
  if (climate?.exposed_population_pct != null && wb?.population != null) {
    exposed = {
      count: Math.round(wb.population * climate.exposed_population_pct),
      pct: climate.exposed_population_pct * 100,
      source: climateSource(ssp),
    };
  }

  const stats = [];
  let headline = null;
  const caveats = [];

  const push = (label, value, basis, source) => stats.push({ label, value, basis, source });

  switch (eventType) {
    case 'sea_level_rise': {
      if (climate?.sea_level_rise_m != null) {
        headline = { label: 'Sea level rise', value: fmtSigned(climate.sea_level_rise_m, 2, ' m'),
          basis: `regional mean, ${year}`, source: climateSource(ssp) };
      }
      if (exposed) push('People exposed to climate hazards',
        `${fmtCount(exposed.count)} (${fmtNum(exposed.pct, 0, '%')})`, `${isoDisplayName(a3) ?? a3}, ${year}`, exposed.source);
      caveats.push('Inundation uses a bathtub model (ignores levees, pumps, drainage) — matches NOAA SLR Viewer caveats.');
      caveats.push('30 m DEM resolution ⇒ block-level, not beach-scale erosion. Close-ups show inundation, not measured shoreline loss.');
      break;
    }
    case 'hurricane': {
      if (climate?.sea_level_rise_m != null) {
        headline = { label: 'Baseline sea level rise', value: fmtSigned(climate.sea_level_rise_m, 2, ' m'),
          basis: `adds to storm surge, ${year}`, source: climateSource(ssp) };
      }
      if (exposed) push('People exposed to climate hazards',
        `${fmtCount(exposed.count)} (${fmtNum(exposed.pct, 0, '%')})`, `${isoDisplayName(a3) ?? a3}, ${year}`, exposed.source);
      caveats.push('Track is a historical analog under future conditions — not a forecast.');
      break;
    }
    case 'heatwave': {
      if (climate?.heat_days_gt35c != null) {
        headline = { label: 'Days over 35 °C', value: fmtNum(climate.heat_days_gt35c, 0),
          basis: `per year, ${year}`, source: climateSource(ssp) };
      }
      if (climate?.temperature_anomaly_c != null) push('Temperature anomaly',
        fmtSigned(climate.temperature_anomaly_c, 1, ' °C'), 'vs 1995–2014 baseline', climateSource(ssp));
      break;
    }
    case 'drought': {
      if (climate?.drought_index != null) {
        headline = { label: 'Drought index', value: fmtNum(climate.drought_index, 2),
          basis: '0 = none, 1 = extreme', source: climateSource(ssp) };
      }
      if (climate?.precipitation_change_pct != null) push('Precipitation change',
        fmtSigned(climate.precipitation_change_pct, 1, ' %'), `annual, ${year}`, climateSource(ssp));
      break;
    }
    case 'wildfire': {
      if (climate?.temperature_anomaly_c != null) {
        headline = { label: 'Temperature anomaly', value: fmtSigned(climate.temperature_anomaly_c, 1, ' °C'),
          basis: `vs 1995–2014 baseline, ${year}`, source: climateSource(ssp) };
      }
      if (climate?.precipitation_change_pct != null) push('Precipitation change',
        fmtSigned(climate.precipitation_change_pct, 1, ' %'),
        // "drier fuels" only when precip actually falls — a positive change is
        // wetter, so claiming drier fuels there contradicts the number (caught on
        // the Australia eyeball: +7.7% labeled "drier fuels").
        climate.precipitation_change_pct < 0 ? 'annual — drier fuels' : 'annual',
        climateSource(ssp));
      break;
    }
    case 'conflict': {
      if (wb?.population != null) {
        headline = { label: 'Population', value: fmtCount(wb.population), basis: 'national', source: WB_SOURCE };
      }
      if (climate?.temperature_anomaly_c != null) push('Climate driver — temp anomaly',
        fmtSigned(climate.temperature_anomaly_c, 1, ' °C'), 'water/crop stress link', climateSource(ssp));
      caveats.push('Displacement is a historical analog / scenario, never a prediction for a named country-pair.');
      break;
    }
    default: {
      if (climate?.temperature_anomaly_c != null) {
        headline = { label: 'Temperature anomaly', value: fmtSigned(climate.temperature_anomaly_c, 1, ' °C'),
          basis: `vs 1995–2014 baseline, ${year}`, source: climateSource(ssp) };
      }
    }
  }

  // Socioeconomic anchor — added for every event when available.
  if (wb?.population != null && eventType !== 'conflict') {
    push('Population', fmtCount(wb.population), 'national', WB_SOURCE);
  }

  if (coverageTier === 'sparse') {
    caveats.push('Sparse CMIP6 coverage for this country — projections are low-confidence.');
  }

  // Raw numeric values for programmatic use (render animation, HumanScale math).
  const raw = {
    seaLevelRiseM:   climate?.sea_level_rise_m ?? null,
    tempAnomalyC:    climate?.temperature_anomaly_c ?? null,
    heatDaysGt35c:   climate?.heat_days_gt35c ?? null,
    droughtIndex:    climate?.drought_index ?? null,
    precipChangePct: climate?.precipitation_change_pct ?? null,
    population:      wb?.population ?? null,
    exposedCount:   exposed?.count ?? null,
  };

  const hasData = headline != null || stats.length > 0 || near.length > 0;
  return { hasData, headline, stats, nearestCities: near, exposed, caveats, coverageTier, raw };
}

// Exposed for reuse by HumanScale and tests.
export { haversineKm, nearestCities, fmtCount, fmtNum, fmtSigned, CITY_SOURCE };
