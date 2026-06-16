import * as Cesium from 'cesium';
import { LayerContract } from '../globe/LayerContract.js';
import { normalizeISO } from '../core/ISONormalizer.js';

const CLIMATE_URL = '/data/climate.json';
const BOUNDARIES_URL = '/data/countries.geojson';

/**
 * @param {number | null | undefined} riseM Sea level rise in meters
 * relative to baseline (FIELD_BOUNDS: -0.05 to 1.5)
 */
function riseToColor(riseM) {
  if (riseM == null || Number.isNaN(riseM)) return null;

  const pale   = Cesium.Color.fromCssColorString('hsl(190, 60%, 88%)'); // near-zero / negligible
  const teal   = Cesium.Color.fromCssColorString('hsl(190, 70%, 65%)'); // low
  const blue   = Cesium.Color.fromCssColorString('hsl(215, 80%, 55%)'); // moderate
  const indigo = Cesium.Color.fromCssColorString('hsl(255, 65%, 45%)'); // high
  const red    = Cesium.Color.fromCssColorString('hsl(345, 85%, 50%)'); // critical inundation risk

  if (riseM <= 0) return pale.withAlpha(0.55);

  if (riseM < 0.15) {
    return Cesium.Color.lerp(pale, teal, riseM / 0.15, new Cesium.Color()).withAlpha(0.7);
  }
  if (riseM < 0.4) {
    return Cesium.Color.lerp(teal, blue, (riseM - 0.15) / 0.25, new Cesium.Color()).withAlpha(0.75);
  }
  if (riseM < 0.8) {
    return Cesium.Color.lerp(blue, indigo, (riseM - 0.4) / 0.4, new Cesium.Color()).withAlpha(0.8);
  }
  const t = Math.min(1, (riseM - 0.8) / 0.7);
  return Cesium.Color.lerp(indigo, red, t, new Cesium.Color()).withAlpha(0.85);
}

/**
 * SeaLevelLayer — choropleth of CMIP6-derived sea level rise by country.
 *
 * Mirrors TemperatureLayer's structure: same GeoJsonDataSource setup
 * (GEODESIC arcType + coarse granularity to avoid the "Too many properties"
 * geometry worker crash on complex coastlines), same sparse-tier handling.
 */
export class SeaLevelLayer extends LayerContract {
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

    if (!climateRes.ok) throw new Error(`[SeaLevelLayer] Failed to load ${CLIMATE_URL}`);
    if (!geoRes.ok) throw new Error(`[SeaLevelLayer] Failed to load ${BOUNDARIES_URL}`);

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
      const riseM = record.sea_level_rise_m;

      if (tier === 'sparse' || riseM == null) {
        if (tier === 'sparse' && !this._warnedSparse.has(iso)) {
          console.warn(`[SeaLevelLayer] Sparse CMIP6 coverage for ${iso} — not coloring`);
          this._warnedSparse.add(iso);
        }
        this._setPolygonStyle(entity, Cesium.Color.fromCssColorString('hsl(220, 10%, 55%)'), true);
        continue;
      }

      const color = riseToColor(riseM);
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
