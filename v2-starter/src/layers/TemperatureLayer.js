import * as Cesium from 'cesium';
import { LayerContract } from '../globe/LayerContract.js';
import { normalizeISO } from '../core/ISONormalizer.js';

const CLIMATE_URL = '/data/climate.json';
const BOUNDARIES_URL = '/data/countries.geojson';

/** @param {number | null | undefined} anomaly °C relative to 1995–2014 baseline */
function anomalyToColor(anomaly) {
  if (anomaly == null || Number.isNaN(anomaly)) return null;

  const blue = Cesium.Color.fromCssColorString('hsl(220, 80%, 60%)');
  const white = Cesium.Color.WHITE.clone();
  const yellow = Cesium.Color.fromCssColorString('hsl(45, 95%, 60%)');
  const orange = Cesium.Color.fromCssColorString('hsl(25, 95%, 55%)');
  const red = Cesium.Color.fromCssColorString('hsl(0, 90%, 45%)');

  if (anomaly < 0) return blue.withAlpha(0.72);

  if (anomaly < 1.0) {
    return Cesium.Color.lerp(blue, white, anomaly, new Cesium.Color()).withAlpha(0.72);
  }
  if (anomaly < 2.0) {
    return Cesium.Color.lerp(white, yellow, anomaly - 1.0, new Cesium.Color()).withAlpha(0.75);
  }
  if (anomaly < 3.5) {
    return Cesium.Color.lerp(yellow, orange, (anomaly - 2.0) / 1.5, new Cesium.Color()).withAlpha(0.78);
  }
  const t = Math.min(1, (anomaly - 3.5) / 1.5);
  return Cesium.Color.lerp(orange, red, t, new Cesium.Color()).withAlpha(0.82);
}

/**
 * TemperatureLayer — choropleth of CMIP6 temperature anomaly by country.
 */
export class TemperatureLayer extends LayerContract {
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

    if (!climateRes.ok) throw new Error(`[TemperatureLayer] Failed to load ${CLIMATE_URL}`);
    if (!geoRes.ok) throw new Error(`[TemperatureLayer] Failed to load ${BOUNDARIES_URL}`);

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
      const anomaly = record.temperature_anomaly_c;

      if (tier === 'sparse' || anomaly == null) {
        if (tier === 'sparse' && !this._warnedSparse.has(iso)) {
          console.warn(`[TemperatureLayer] Sparse CMIP6 coverage for ${iso} — not coloring`);
          this._warnedSparse.add(iso);
        }
        this._setPolygonStyle(entity, Cesium.Color.fromCssColorString('hsl(220, 10%, 55%)'), true);
        continue;
      }

      const color = anomalyToColor(anomaly);
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
