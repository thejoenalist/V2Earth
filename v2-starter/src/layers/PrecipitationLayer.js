import * as Cesium from 'cesium';
import { LayerContract } from '../globe/LayerContract.js';
import { normalizeISO } from '../core/ISONormalizer.js';

const CLIMATE_URL = '/data/climate.json';
const BOUNDARIES_URL = '/data/countries.geojson';

/**
 * @param {number | null | undefined} pctChange Precipitation change in %
 * relative to baseline (FIELD_BOUNDS: -60.0 to 100.0). Diverging ramp:
 * brown (drying) → white (near-baseline) → green (wetting).
 */
function pctChangeToColor(pctChange) {
  if (pctChange == null || Number.isNaN(pctChange)) return null;

  const deepBrown = Cesium.Color.fromCssColorString('hsl(25, 70%, 35%)');  // severe drying
  const brown     = Cesium.Color.fromCssColorString('hsl(30, 60%, 55%)');  // moderate drying
  const white     = Cesium.Color.fromCssColorString('hsl(60, 30%, 92%)');  // near-baseline
  const green     = Cesium.Color.fromCssColorString('hsl(150, 50%, 50%)'); // moderate wetting
  const deepGreen = Cesium.Color.fromCssColorString('hsl(165, 70%, 30%)'); // severe wetting

  if (pctChange <= -40) return deepBrown.withAlpha(0.85);
  if (pctChange < -10) {
    return Cesium.Color.lerp(deepBrown, brown, (pctChange + 40) / 30, new Cesium.Color()).withAlpha(0.8);
  }
  if (pctChange < 10) {
    return Cesium.Color.lerp(brown, white, (pctChange + 10) / 20, new Cesium.Color()).withAlpha(0.6);
  }
  if (pctChange < 40) {
    return Cesium.Color.lerp(white, green, (pctChange - 10) / 30, new Cesium.Color()).withAlpha(0.75);
  }
  const t = Math.min(1, (pctChange - 40) / 40);
  return Cesium.Color.lerp(green, deepGreen, t, new Cesium.Color()).withAlpha(0.85);
}

/**
 * PrecipitationLayer — choropleth of CMIP6-derived precipitation change by country.
 *
 * Mirrors TemperatureLayer's structure: same GeoJsonDataSource setup
 * (GEODESIC arcType + coarse granularity to avoid the "Too many properties"
 * geometry worker crash on complex coastlines), same sparse-tier handling.
 */
export class PrecipitationLayer extends LayerContract {
  /**
   * @param {Cesium.Viewer} viewer
   */
  constructor(viewer) {
    super();
    this._viewer = viewer;
    /** @type {Cesium.GeoJsonDataSource | null} */
    this._dataSource = null;
    /** @type {Record<string, Record<string, Record<string, object>>>} */
    this._climate = {};
    this._year = 2025;
    this._ssp = 'SSP2-4.5';
    this._loaded = false;
    this._warnedSparse = new Set();
  }

  async load() {
    if (this._loaded) return;

    const [climateRes, geoRes] = await Promise.all([
      fetch(CLIMATE_URL),
      fetch(BOUNDARIES_URL),
    ]);

    if (!climateRes.ok) throw new Error(`[PrecipitationLayer] Failed to load ${CLIMATE_URL}`);
    if (!geoRes.ok) throw new Error(`[PrecipitationLayer] Failed to load ${BOUNDARIES_URL}`);

    this._climate = await climateRes.json();
    const geojson = await geoRes.json();

    this._dataSource = await Cesium.GeoJsonDataSource.load(geojson, {
      clampToGround: false,
      stroke: Cesium.Color.TRANSPARENT,
    });

    // CRITICAL: set these BEFORE adding to the viewer.
    // GeoJsonDataSource defaults to ArcType.RHUMB, which blows up on complex
    // coastlines (Russia, Canada, Indonesia) with "Too many properties" in the
    // geometry worker. Switch to GEODESIC + coarse granularity to prevent it.
    for (const entity of this._dataSource.entities.values) {
      if (!entity.polygon) continue;
      entity.polygon.arcType    = Cesium.ArcType.GEODESIC;
      entity.polygon.granularity = Cesium.Math.toRadians(10);
      entity.polygon.height      = 0;
    }

    this._viewer.dataSources.add(this._dataSource);
    this._dataSource.show = false;

    this._applyColors();
    this._loaded = true;
  }

  show() {
    if (this._dataSource) this._dataSource.show = true;
    this._visible = true;
    this._applyColors();
  }

  hide() {
    if (this._dataSource) this._dataSource.show = false;
    this._visible = false;
  }

  updateTime({ year, ssp }) {
    this._year = year;
    this._ssp = ssp;
    this._applyColors();
  }

  destroy() {
    if (this._dataSource) {
      this._viewer.dataSources.remove(this._dataSource, true);
      this._dataSource = null;
    }
    super.destroy();
  }

  _applyColors() {
    if (!this._dataSource) return;

    const yearKey = String(this._year);
    const entities = this._dataSource.entities.values;

    for (const entity of entities) {
      const rawIso = entity.properties?.iso?.getValue?.()
        ?? entity.properties?.ISO_A3?.getValue?.();
      const iso = normalizeISO(rawIso);

      if (!iso) {
        this._setPolygonStyle(entity, null, false);
        continue;
      }

      const record = this._climate[iso]?.[yearKey]?.[this._ssp];
      if (!record) {
        this._setPolygonStyle(entity, null, false);
        continue;
      }

      const tier = record.coverage_tier ?? 'high';
      const pctChange = record.precipitation_change_pct;

      if (tier === 'sparse' || pctChange == null) {
        if (tier === 'sparse' && !this._warnedSparse.has(iso)) {
          console.warn(`[PrecipitationLayer] Sparse CMIP6 coverage for ${iso} — not coloring`);
          this._warnedSparse.add(iso);
        }
        this._setPolygonStyle(entity, Cesium.Color.fromCssColorString('hsl(220, 10%, 55%)'), true);
        continue;
      }

      const color = pctChangeToColor(pctChange);
      this._setPolygonStyle(entity, color, false);
    }
  }

  /**
   * @param {Cesium.Entity} entity
   * @param {Cesium.Color | null} color
   * @param {boolean} sparse
   */
  _setPolygonStyle(entity, color, sparse) {
    if (!entity.polygon) return;

    if (!color) {
      entity.polygon.material = Cesium.Color.TRANSPARENT;
      entity.polygon.outline = false;
      return;
    }

    if (sparse) {
      entity.polygon.material = color.withAlpha(0.18);
      entity.polygon.outline = false;
      return;
    }

    entity.polygon.material = color;
    entity.polygon.outline = false;
  }
}
