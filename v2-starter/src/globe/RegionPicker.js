/**
 * RegionPicker — click/hover country picking on the globe.
 *
 * Loads countries.geojson as a near-invisible (but pickable) polygon layer,
 * so picking works regardless of which data layer is visible. Emits:
 *
 *   region:selected  { iso, name, coords: { lat, lon } | null }
 *   region:hovered   { iso: string | null }
 *
 * Listens:
 *   region:cleared   (from CountryPanel close) — removes the selection highlight
 *
 * The selected country gets a subtle accent fill + outline until the panel
 * is closed or another country is selected.
 *
 * Memory contract: destroy() removes the ScreenSpaceEventHandler, the
 * datasource, and all EventBus subscriptions.
 */

import * as Cesium from 'cesium';
import { EventBus } from '../core/EventBus.js';
import { normalizeISO } from '../core/ISONormalizer.js';

const BOUNDARIES_URL = '/data/countries.geojson';
const HOVER_THROTTLE_MS = 80;

// Near-zero alpha keeps polygons pickable without visibly tinting the globe.
const IDLE_FILL = Cesium.Color.WHITE.withAlpha(0.004);
const SELECTED_FILL = Cesium.Color.fromCssColorString('#4aa8e8').withAlpha(0.14);
const SELECTED_OUTLINE = Cesium.Color.fromCssColorString('#4aa8e8').withAlpha(0.85);

export class RegionPicker {
  /**
   * @param {Cesium.Viewer} viewer
   */
  constructor(viewer) {
    this._viewer = viewer;
    /** @type {Cesium.GeoJsonDataSource | null} */
    this._dataSource = null;
    /** @type {Cesium.ScreenSpaceEventHandler | null} */
    this._handler = null;
    /** @type {Cesium.Entity | null} */
    this._selectedEntity = null;
    /** @type {Map<string, Cesium.Entity>} iso → own boundary entity (highlight target) */
    this._byIso = new Map();
    this._lastHoverAt = 0;
    this._lastHoverIso = null;
    this._loaded = false;

    this._onCleared = () => this._clearHighlight();
    EventBus.on('region:cleared', this._onCleared);
  }

  /** Load boundaries and attach input handlers. Idempotent. */
  async load() {
    if (this._loaded) return;

    this._dataSource = await Cesium.GeoJsonDataSource.load(BOUNDARIES_URL, {
      clampToGround: false,
      stroke: Cesium.Color.TRANSPARENT,
      fill: IDLE_FILL,
    });

    // Same geometry-worker guard as the data layers (see TemperatureLayer):
    // GEODESIC + coarse granularity prevents "Too many properties" crashes
    // on complex coastlines.
    for (const entity of this._dataSource.entities.values) {
      if (!entity.polygon) continue;
      entity.polygon.arcType = Cesium.ArcType.GEODESIC;
      entity.polygon.granularity = Cesium.Math.toRadians(10);
      entity.polygon.height = 0;
      entity.polygon.material = IDLE_FILL;
      entity.polygon.outline = false;

      const iso = normalizeISO(entity.properties?.iso?.getValue?.()
        ?? entity.properties?.ISO_A3?.getValue?.());
      if (iso && !this._byIso.has(iso)) this._byIso.set(iso, entity);
    }

    await this._viewer.dataSources.add(this._dataSource);

    this._handler = new Cesium.ScreenSpaceEventHandler(this._viewer.scene.canvas);
    this._handler.setInputAction(
      (e) => this._onClick(e.position),
      Cesium.ScreenSpaceEventType.LEFT_CLICK,
    );
    this._handler.setInputAction(
      (e) => this._onMove(e.endPosition),
      Cesium.ScreenSpaceEventType.MOUSE_MOVE,
    );

    this._loaded = true;
  }

  destroy() {
    EventBus.off('region:cleared', this._onCleared);
    this._handler?.destroy();
    this._handler = null;
    if (this._dataSource) {
      this._viewer.dataSources.remove(this._dataSource, true);
      this._dataSource = null;
    }
  }

  // ── Input handling ────────────────────────────────────────────────────────

  _onClick(position) {
    const hit = this._pickCountry(position);
    if (!hit) return;

    // Only ever highlight our OWN boundary entity — a drillPick hit may
    // belong to a choropleth layer, and restyling that would corrupt it.
    this._highlight(this._byIso.get(hit.iso) ?? null);

    // Geographic coords of the actual click point (null over empty space)
    let coords = null;
    const cartesian = this._viewer.camera.pickEllipsoid(
      position, this._viewer.scene.globe.ellipsoid);
    if (cartesian) {
      const carto = Cesium.Cartographic.fromCartesian(cartesian);
      coords = {
        lat: Cesium.Math.toDegrees(carto.latitude),
        lon: Cesium.Math.toDegrees(carto.longitude),
      };
    }

    EventBus.emit('region:selected', { iso: hit.iso, name: hit.name, coords });
  }

  _onMove(position) {
    const now = Date.now();
    if (now - this._lastHoverAt < HOVER_THROTTLE_MS) return;
    this._lastHoverAt = now;

    const hit = this._pickCountry(position);
    const iso = hit?.iso ?? null;
    if (iso === this._lastHoverIso) return;
    this._lastHoverIso = iso;

    this._viewer.scene.canvas.style.cursor = iso ? 'pointer' : '';
    EventBus.emit('region:hovered', { iso });
  }

  /**
   * @param {Cesium.Cartesian2} position
   * @returns {{ iso: string, name: string | null, entity: Cesium.Entity } | null}
   */
  _pickCountry(position) {
    // drillPick so simulation entities / choropleth layers stacked on top
    // don't mask the boundary polygons underneath.
    const picked = this._viewer.scene.drillPick(position, 6);
    for (const p of picked) {
      const entity = p?.id;
      if (!(entity instanceof Cesium.Entity) || !entity.properties) continue;
      const rawIso = entity.properties.iso?.getValue?.()
        ?? entity.properties.ISO_A3?.getValue?.();
      const iso = normalizeISO(rawIso);
      if (!iso) continue;
      const name = entity.properties.NAME?.getValue?.() ?? null;
      return { iso, name, entity };
    }
    return null;
  }

  // ── Selection highlight ───────────────────────────────────────────────────

  _highlight(entity) {
    this._clearHighlight();
    if (!entity?.polygon) return;
    entity.polygon.material = new Cesium.ColorMaterialProperty(SELECTED_FILL);
    entity.polygon.outline = true;
    entity.polygon.outlineColor = SELECTED_OUTLINE;
    this._selectedEntity = entity;
    this._viewer.scene.requestRender();
  }

  _clearHighlight() {
    if (this._selectedEntity?.polygon) {
      this._selectedEntity.polygon.material = new Cesium.ColorMaterialProperty(IDLE_FILL);
      this._selectedEntity.polygon.outline = false;
    }
    this._selectedEntity = null;
    this._viewer.scene.requestRender();
  }
}
