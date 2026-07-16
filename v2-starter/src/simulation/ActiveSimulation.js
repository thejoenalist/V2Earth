/**
 * ActiveSimulation — one executing simulation in the stack.
 *
 * Milestone 4: All 6 "ready" event renders are fully implemented.
 * Schema/noted-tier events route to _renderGenericEvent (polygon/ellipse +
 * ImpactStats + city callouts — the shared template, CLAUDE.md item #16);
 * only non-climate/unknown types fall back to _renderPlaceholder.
 *
 * Memory contract: every CesiumJS object (Entity, Primitive, ParticleSystem,
 * PostProcessStage, postRender listener) is tracked in this._owned and
 * removed in destroy(). No leaks.
 */

import { EVENT_TYPES } from '../chat/SimulationCommand.js';
import { EventBus } from '../core/EventBus.js';
import { getCentroid } from '../globe/RegionCentroids.js';
import { getImpactStats, fmtCount, largestCityForISO } from '../data/ImpactStats.js';
import { getCountryFeature, featureToPolygonRings } from '../data/CountryGeometry.js';
import { loadAdmin1, regionToPolygonRings } from './Admin1Geodata.js';
import { loadLandMask } from './LandMaskGeodata.js';
import { findFlagshipMetro, findFlagshipMetroForCities, loadInundation, pickLevel } from './InundationGeodata.js';
import { loadHurricane } from './HurricaneGeodata.js';
import * as Cesium from 'cesium';

/**
 * Natural lifetime of a simulation in milliseconds. After this, the sim emits
 * `simulation:decision_requested` — ChatInterface asks the user to keep it up or
 * clear it, with a grace window (below) before it auto-clears. The actual
 * teardown still happens in EventSimulator via `simulation:complete`, which
 * ChatInterface emits on the user's choice or when the grace window lapses.
 */
export const SIMULATION_LIFETIME_MS = 180_000; // 3 minutes on the globe

/**
 * Grace window after the keep-or-clear prompt appears. If the user doesn't
 * answer within this time, the scenario auto-clears. Owned by ChatInterface.
 */
export const SIMULATION_DECISION_GRACE_MS = 60_000; // 1 minute to decide

// ─────────────────────────────────────────────────────────────────────────────
// Canvas helpers for particle textures
// ─────────────────────────────────────────────────────────────────────────────

/** Soft radial gradient circle — basis for fire and smoke particles */
function makeCircleCanvas(innerColor, outerColor = 'transparent', size = 64) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, innerColor);
  g.addColorStop(1, outerColor);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return c;
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-level particle texture canvases — created once, reused every simulation
// ─────────────────────────────────────────────────────────────────────────────
const _FIRE_CANVAS  = makeCircleCanvas('#ff6a00', 'rgba(255,30,0,0)');
const _SMOKE_CANVAS = makeCircleCanvas('rgba(75,75,75,0.9)', 'rgba(40,40,40,0)');
const _EMBER_CANVAS = makeCircleCanvas('#ffcc00', 'rgba(255,80,0,0)', 32);

// ─────────────────────────────────────────────────────────────────────────────
// ActiveSimulation
// ─────────────────────────────────────────────────────────────────────────────

export class ActiveSimulation {
  constructor({ command, compound, viewer, year, ssp, stackIndex = 0 }) {
    this.command     = command;
    this.compound    = compound;
    this.viewer      = viewer;
    this.year        = year;
    this.ssp         = ssp;
    this._stackIndex = stackIndex;
    this.eventType   = command.params?.eventType ?? command.event ?? null;

    /** All owned CesiumJS objects — cleared in destroy() */
    this._owned = [];
    /** postRender listener removal functions — tracked separately */
    this._listeners = [];

    this._started   = false;
    this._destroyed = false;
    this._animStart = null;
    this._lifetimeTimer = null;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async start() {
    if (this._started || this._destroyed) return;
    this._started   = true;
    this._animStart = Date.now();

    const meta     = this.eventType ? EVENT_TYPES[this.eventType] : null;
    const strategy = meta?.render ?? 'placeholder';
    await this._dispatch(strategy);

    // Natural end: after the lifetime elapses, ask the user whether to keep the
    // scenario up or clear it (ChatInterface renders the prompt + runs the grace
    // countdown, then emits simulation:complete for EventSimulator to tear down).
    this._lifetimeTimer = setTimeout(() => {
      if (this._destroyed) return;
      EventBus.emit('simulation:decision_requested', {
        commandId: this.command.id,
        eventType: this.eventType,
      });
    }, SIMULATION_LIFETIME_MS);
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;

    if (this._lifetimeTimer) {
      clearTimeout(this._lifetimeTimer);
      this._lifetimeTimer = null;
    }

    // Remove postRender listeners before touching owned objects
    for (const remove of this._listeners) {
      try { remove(); } catch (_) {}
    }
    this._listeners = [];

    for (const obj of this._owned) {
      try {
        if (!obj) continue;
        if (obj instanceof Cesium.Entity) {
          this.viewer.entities.remove(obj);
        } else if (this.viewer.scene.primitives.contains(obj)) {
          this.viewer.scene.primitives.remove(obj);
        } else if (this.viewer.dataSources.contains(obj)) {
          this.viewer.dataSources.remove(obj, true);
        } else if (this.viewer.scene.postProcessStages.contains?.(obj)) {
          this.viewer.scene.postProcessStages.remove(obj);
        } else if (typeof obj.destroy === 'function' && !obj.isDestroyed?.()) {
          obj.destroy();
        }
      } catch (e) {
        console.warn('[ActiveSimulation] Cleanup error:', e);
      }
    }
    this._owned = [];
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  _track(obj) {
    this._owned.push(obj);
    return obj;
  }

  /** Register a postRender listener and track its removal.
   *  Cesium.Event.addEventListener returns void — removal is via removeEventListener. */
  _addPostRenderListener(fn) {
    this._listeners.push(() => this.viewer.scene.postRender.removeEventListener(fn));
    this.viewer.scene.postRender.addEventListener(fn);
  }

  /** Elapsed seconds since simulation started */
  _elapsed() {
    return (Date.now() - this._animStart) / 1000;
  }

  /** Resolve event center: params.center → RegionCentroids lookup → Atlantic fallback */
  _getCenter() {
    const p = this.command.params;
    if (p?.center?.lon != null && p?.center?.lat != null) {
      return { lon: p.center.lon, lat: p.center.lat };
    }
    const centroid = getCentroid(this.command.target);
    if (centroid) {
      return { lon: centroid.lon, lat: centroid.lat };
    }
    return { lon: -25, lat: 20 };
  }

  // ── Dispatch ──────────────────────────────────────────────────────────────

  async _dispatch(strategy) {
    const routes = {
      'particle-spiral':     () => this._renderHurricane(),
      'mesh-flood':          () => this._renderSeaLevelRise(),
      'particle-spread':     () => this._renderWildfire(),
      'choropleth-anim':     () => this._renderDrought(),
      'atmospheric-shimmer': () => this._renderHeatwave(),
      'flow-vectors':        () => this._renderConflict(),
    };
    let fn = routes[strategy];
    if (!fn) {
      // Schema/noted-tier events get the generic template (polygon/ellipse +
      // ImpactStats + city callouts — CLAUDE.md item #16). Non-climate events
      // (solar_storm) and unknown types keep the honest placeholder: climate
      // stats on a non-climate event would be a fabricated causal claim.
      const status = this.eventType ? EVENT_TYPES[this.eventType]?.status : null;
      fn = (status === 'schema' || status === 'noted')
        ? () => this._renderGenericEvent()
        : () => this._renderPlaceholder();
    }
    await fn();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // M4: Hurricane  (particle-spiral)
  // Multi-layer rotating cloud-band spiral with animated eye
  // ═══════════════════════════════════════════════════════════════════════════

  async _renderHurricane() {
    const { lon, lat } = this._getCenter();
    const mag    = Math.max(1, Math.min(5, this.command.params?.magnitude ?? 3));
    const stormR = 120_000 + mag * 80_000;   // 200–520 km in metres
    const eyeR   = stormR * 0.045;
    const eyeWallR = stormR * 0.09;

    // ── Eye (calm dark oval) ─────────────────────────────────────────────
    this._track(this.viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat),
      ellipse: {
        semiMajorAxis: eyeR,
        semiMinorAxis: eyeR * 0.85,
        height: 500,
        material: new Cesium.ColorMaterialProperty(
          Cesium.Color.fromCssColorString('#0a1a2e').withAlpha(0.6)),
      },
    }));

    // ── Eye wall (bright, dense) ─────────────────────────────────────────
    this._track(this.viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat),
      ellipse: {
        semiMajorAxis: eyeWallR,
        semiMinorAxis: eyeWallR * 0.85,
        height: 2000,
        material: new Cesium.ColorMaterialProperty(
          Cesium.Color.WHITE.withAlpha(0.75)),
      },
    }));

    // ── Cloud band layers at 5 altitudes ────────────────────────────────
    // 2 wide opposite bands per layer (180° apart) = S-curve cloud spiral.
    // Arms are FAT (semiMinorAxis ≈ 55% of semiMajorAxis) so they look
    // like thick cloud masses, not thin spokes.
    const LAYERS = [
      { height: 1500,  frac: 0.28, alpha: 0.62, speed: 1.80, aspect: 0.58 },
      { height: 4000,  frac: 0.46, alpha: 0.52, speed: 1.30, aspect: 0.55 },
      { height: 7000,  frac: 0.64, alpha: 0.40, speed: 0.90, aspect: 0.53 },
      { height: 10000, frac: 0.82, alpha: 0.26, speed: 0.60, aspect: 0.52 },
      { height: 12500, frac: 1.00, alpha: 0.15, speed: 0.38, aspect: 0.50 },
    ];
    const rotRefs = [];

    for (let li = 0; li < LAYERS.length; li++) {
      const layer = LAYERS[li];
      const r     = stormR * layer.frac;
      const armW  = r * layer.aspect; // wide fat band
      rotRefs[li] = [];

      // 2 bands, 180° apart — together they form a spiral S
      for (let ai = 0; ai < 2; ai++) {
        const rotRef = { val: ai * 180 };
        rotRefs[li][ai] = rotRef;

        this._track(this.viewer.entities.add({
          position: Cesium.Cartesian3.fromDegrees(lon, lat),
          ellipse: {
            semiMajorAxis: r,
            semiMinorAxis: armW,
            height: layer.height,
            rotation: new Cesium.CallbackProperty(
              () => Cesium.Math.toRadians(rotRef.val), false),
            stRotation: new Cesium.CallbackProperty(
              () => Cesium.Math.toRadians(rotRef.val), false),
            material: new Cesium.ColorMaterialProperty(
              Cesium.Color.WHITE.withAlpha(layer.alpha)),
          },
        }));
      }
    }

    // Dense inner cloud deck (near-circle covering the inner core)
    this._track(this.viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat),
      ellipse: {
        semiMajorAxis: stormR * 0.20,
        semiMinorAxis: stormR * 0.18,
        height: 2500,
        material: new Cesium.ColorMaterialProperty(
          Cesium.Color.WHITE.withAlpha(0.70)),
      },
    }));

    // Outer moisture envelope
    this._track(this.viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat),
      ellipse: {
        semiMajorAxis: stormR * 1.35,
        semiMinorAxis: stormR * 1.15,
        height: 500,
        material: new Cesium.ColorMaterialProperty(
          Cesium.Color.fromCssColorString('#c8e8ff').withAlpha(0.09)),
      },
    }));

    // Category label
    const catName = ['', 'Cat 1', 'Cat 2', 'Cat 3', 'Cat 4', 'Cat 5'][Math.round(mag)];
    this._track(this.viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat + stormR / 111_000 + 2),
      label: {
        text: `Hurricane  ${catName}`,
        font: 'bold 14px system-ui',
        fillColor: Cesium.Color.fromCssColorString('#cce8ff'),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        pixelOffset: new Cesium.Cartesian2(0, -8),
      },
    }));

    // ── Historical-analog track (HURRICANE_TRACKS_PLAN Phase 1) ──
    // Real past storm's path from a baked IBTrACS-derived file; null → no analog
    // for this coast (or bake not run) → spiral-only, unchanged. Coordinates and
    // the per-point category are baked (rule #4), framed honestly as an analog.
    const trackMetro = findFlagshipMetro(lon, lat);
    const trackDoc   = trackMetro ? await loadHurricane(trackMetro.key) : null;
    if (this._destroyed) return;
    if (trackDoc?.track?.length) this._renderHurricaneTrack(trackDoc);
    if (trackDoc?.surge?.rings?.length) this._renderHurricaneSurge(trackDoc.surge);

    // ── Baked impact overlay (VISUAL_UPGRADE_PLAN template: ImpactStats + city
    // callouts). The category above is the scenario the user is exploring; the
    // numbers here are baked (climate.json/worldbank/cities.json), never the LLM.
    // getImpactStats gives hurricane a coastal-city bias + surge-baseline SLR.
    let stats = null;
    try {
      stats = await getImpactStats({
        eventType: 'hurricane', iso: this.command.target,
        year: this.year, ssp: this.ssp, center: { lon, lat },
      });
    } catch (_) { /* overlay is best-effort; the spiral still renders */ }
    if (this._destroyed) return;

    if (stats?.raw?.seaLevelRiseM != null) {
      this._track(this.viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(lon, lat + stormR / 111_000 + 0.9),
        label: {
          text: `+${stats.raw.seaLevelRiseM.toFixed(2)} m baseline sea level by ${this.year}`
            + ` (CMIP6 ${this.ssp}) — adds to storm surge`,
          font: '12px system-ui',
          fillColor: Cesium.Color.fromCssColorString('#cce8ff'),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: Cesium.VerticalOrigin.TOP,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          pixelOffset: new Cesium.Cartesian2(0, 6),
        },
      }));
    }

    // Coastal city callouts — the human anchor (same treatment as sea level rise).
    this._addCityPins(stats?.nearestCities);

    // ── Rotation animation ───────────────────────────────────────────────
    let last = performance.now();
    this._addPostRenderListener(() => {
      if (this._destroyed) return;
      const now = performance.now();
      const dt  = Math.min((now - last) / 1000, 0.05);
      last = now;
      for (let li = 0; li < LAYERS.length; li++) {
        for (let ai = 0; ai < 2; ai++) {
          rotRefs[li][ai].val += LAYERS[li].speed * dt * 60;
        }
      }
      this.viewer.scene.requestRender();
    });

    this.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat - 3, stormR * 3.5),
      duration: 2.5,
      easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
    });
  }

  /**
   * Draw a baked historical-analog storm track (HURRICANE_TRACKS_PLAN Phase 1):
   * a glowing polyline through the real path, category-colored dots at each
   * point, an honest "analog — not a forecast" label at landfall, and a marker
   * that walks the track over the animation. All entities are _track()ed, so
   * destroy() removes them with the rest of the simulation.
   *
   * @param {Object} doc - hurricane_<metro>.json (track[], landfall, _meta.analog)
   */
  _renderHurricaneTrack(doc) {
    const pts = doc.track;
    if (!Array.isArray(pts) || pts.length < 2) return;

    const flat = [];
    for (const p of pts) flat.push(p.lon, p.lat);

    // Path polyline — warm glow along the real geodesic path.
    this._track(this.viewer.entities.add({
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArray(flat),
        width: 3,
        arcType: Cesium.ArcType.GEODESIC,
        material: new Cesium.PolylineGlowMaterialProperty({
          glowPower: 0.25,
          color: Cesium.Color.fromCssColorString('#fb923c').withAlpha(0.9),
        }),
      },
    }));

    // Category dot at each track point (Saffir–Simpson warm ramp).
    for (const p of pts) {
      this._track(this.viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat),
        point: {
          pixelSize: 6,
          color: Cesium.Color.fromCssColorString(this._categoryColor(p.category)),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      }));
    }

    // Analog label at landfall — honest framing is mandatory, not polish.
    const a  = doc._meta?.analog;
    const lf = doc.landfall ?? pts[pts.length - 1];
    if (a && lf) {
      this._track(this.viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(lf.lon, lf.lat),
        label: {
          text: `${a.name} (${a.year}) — Cat ${a.peak_category} peak\nhistorical analog — not a forecast`,
          font: '11px system-ui',
          fillColor: Cesium.Color.fromCssColorString('#fed7aa'),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: Cesium.VerticalOrigin.TOP,
          pixelOffset: new Cesium.Cartesian2(0, 10),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      }));
    }

    // Marker that walks the track over ~12 s, then holds at the final point.
    this._track(this.viewer.entities.add({
      position: new Cesium.CallbackProperty(() => {
        const s = Math.min(this._elapsed() / 12, 1) * (pts.length - 1);
        const i = Math.min(Math.floor(s), pts.length - 2);
        const f = s - i;
        return Cesium.Cartesian3.fromDegrees(
          pts[i].lon + (pts[i + 1].lon - pts[i].lon) * f,
          pts[i].lat + (pts[i + 1].lat - pts[i].lat) * f,
        );
      }, false),
      point: {
        pixelSize: 10,
        color: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.fromCssColorString('#ef4444'),
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    }));
    // No postRender listener here: the marker's CallbackProperty is re-evaluated
    // by the spiral's rotation listener in _renderHurricane, which already forces
    // a per-frame render for the whole hurricane simulation.
  }

  /**
   * Draw the baked storm-surge bathtub footprint (HURRICANE_TRACKS_PLAN Phase 2).
   * Present only after pipeline/bake_tracks.py runs the DEM step in CI; the
   * `area_km2` shown is pipeline-computed (rule #4). Teal fill fades in over ~3 s;
   * distinct from the sea-level-rise blue. All entities _track()ed. Labelled
   * "category-typical, bathtub" — it is not this storm's observed surge.
   *
   * @param {Object} surge - { height_m, area_km2, rings: [[[lon,lat],…],…] }
   */
  _renderHurricaneSurge(surge) {
    const rings = surge.rings.slice(0, 60);
    const fill = Cesium.Color.fromCssColorString('#0e6b8f');
    const line = Cesium.Color.fromCssColorString('#38bdf8');

    for (const ring of rings) {
      const flat = [];
      for (const [rlon, rlat] of ring) flat.push(rlon, rlat);
      this._track(this.viewer.entities.add({
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(
            Cesium.Cartesian3.fromDegreesArray(flat)),
          material: new Cesium.ColorMaterialProperty(new Cesium.CallbackProperty(
            () => fill.withAlpha(Math.min(this._elapsed() / 3, 1) * 0.5), false)),
          outline: true,
          outlineColor: line.withAlpha(0.7),
          outlineWidth: 1,
          height: 0,
        },
      }));
    }

    // Extent label — anchored at the first vertex of the first ring.
    const anchor = rings[0]?.[0];
    if (anchor && surge.area_km2 != null) {
      this._track(this.viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(anchor[0], anchor[1]),
        label: {
          text: `Storm surge — ~${surge.height_m} m (category-typical, bathtub)`
            + `\n${surge.area_km2} km² inundated`,
          font: '11px system-ui',
          fillColor: Cesium.Color.fromCssColorString('#bae6fd'),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: Cesium.VerticalOrigin.TOP,
          pixelOffset: new Cesium.Cartesian2(0, 8),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      }));
    }
  }

  /** Saffir–Simpson category → warm color ramp (0 = pre-hurricane). */
  _categoryColor(cat) {
    return ['#fde68a', '#ffeda0', '#feb24c', '#fd8d3c', '#f03b20', '#bd0026'][
      Math.max(0, Math.min(5, cat | 0))
    ];
  }

  /**
   * Standard multi-line baked-stat label anchored above an event. Shared by the
   * heatwave/drought/wildfire/conflict renders (identical styling — only text,
   * anchor, and colour differ). Tracked for destroy().
   */
  _addStatLabel(lon, lat, text, color) {
    this._track(this.viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat),
      label: {
        text,
        font: 'bold 14px system-ui',
        fillColor: Cesium.Color.fromCssColorString(color),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    }));
  }

  /**
   * Named-city callout pins (name + population) — the human anchor. Shared by
   * the sea-level-rise and hurricane renders. Tracked for destroy().
   */
  _addCityPins(cities) {
    for (const city of (cities ?? [])) {
      this._track(this.viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(city.lon, city.lat),
        point: {
          pixelSize: 7,
          color: Cesium.Color.fromCssColorString('#fde68a'),
          outlineColor: Cesium.Color.fromCssColorString('#78350f'),
          outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: `${city.name}\n${fmtCount(city.population)} people`,
          font: '11px system-ui',
          fillColor: Cesium.Color.fromCssColorString('#fef3c7'),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: Cesium.VerticalOrigin.TOP,
          pixelOffset: new Cesium.Cartesian2(0, 8),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      }));
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // M4: Sea Level Rise  (mesh-flood)
  // Animated blue flood fill with expanding wave rings
  // ═══════════════════════════════════════════════════════════════════════════

  async _renderSeaLevelRise() {
    const { lon, lat } = this._getCenter();
    const mag = this.command.params?.magnitude ?? 1.5; // metres (parser hint — sizes visuals only)

    // ── Real numbers FIRST (VISUAL_UPGRADE_PLAN F2) — they now drive both the
    // headline and which baked inundation level is displayed.
    let stats = null;
    try {
      stats = await getImpactStats({
        eventType: 'sea_level_rise', iso: this.command.target,
        year: this.year, ssp: this.ssp, center: { lon, lat },
      });
    } catch (_) { /* fall back to magnitude-only label */ }
    if (this._destroyed) return;

    const realRise    = stats?.raw?.seaLevelRiseM;
    const isReal      = realRise != null && realRise > 0;
    const displayRise = isReal ? realRise : mag;
    const srcTag      = isReal ? ` (CMIP6 ${this.ssp})` : '';
    const rise        = { val: 0 }; // 0→1 over 12 s — drives fills + headline count-up

    // ── Flagship metro? Load REAL coastline-inundation geometry (F3) ──
    // Baked by pipeline/bake_geodata.py from the Copernicus GLO-30 DEM.
    // Missing file (bake not run yet) → null → generic render below.
    // Primary match on the parser's center; fall back to the nearest baked
    // cities when that center drifts offshore (see findFlagshipMetroForCities).
    // Without the fallback, an imprecise "Miami" center misses the 2° radius and
    // the user gets the generic ellipse with no visible land-loss delta.
    const metro = findFlagshipMetro(lon, lat)
      ?? findFlagshipMetroForCities(stats?.nearestCities);
    const doc   = metro ? await loadInundation(metro.key) : null;
    if (this._destroyed) return;
    const level = doc ? pickLevel(doc, displayRise) : null;

    let labelLon = lon;
    let labelLat = lat;
    let title;
    let extentLine = '';

    if (level) {
      // ═══ Flagship path: the delta band — land lost, on real geography ═══
      const flagship = this._renderInundationDelta(doc, level, rise);
      labelLon = flagship.labelLon;
      labelLat = flagship.labelLat;
      title = `${doc._meta.display} — Sea Level Rise`;
      // area_km2 is pipeline-computed from the DEM (baked), safe to display.
      extentLine = `\nshowing the ${level.levelKey} m extent — `
        + `${level.areaKm2 != null ? `${level.areaKm2} km² of land newly under water` : 'newly inundated land'}`;

      // Close-up moment (F5): once the flood fill is mostly in, fly in for the
      // South Beach moment. Prefer the lowest-lying named city we have elevation
      // for; else the nearest named city (nearestCities is distance-sorted);
      // else the baked metro centre. The fallback matters: most coastal-metro
      // cities lack per-city elevation (only ~44/1006 carry mean_elev_m, and
      // Miami itself is null), so without it the flagship close-up would
      // silently never fire. Fired via the tracked postRender listener so
      // destroy() can never leak a timer.
      const closeupTarget =
        (stats?.nearestCities ?? [])
          .filter((c) => c.meanElevM != null)
          .sort((a, b) => a.meanElevM - b.meanElevM)[0]
        ?? (stats?.nearestCities ?? [])[0]
        ?? { lon: doc.center?.lon ?? lon, lat: doc.center?.lat ?? lat,
             name: doc._meta?.display ?? 'the coast' };
      {
        let fired = false;
        this._addPostRenderListener(() => {
          if (fired || this._destroyed || this._elapsed() < 7) return;
          fired = true;
          EventBus.emit('camera:closeup_requested', {
            lon: closeupTarget.lon, lat: closeupTarget.lat,
            name: closeupTarget.name,
          });
        });
      }
    } else {
      // ═══ Generic path (non-flagship coasts): animated fill + wave rings ═══
      const floodR = 400_000 + mag * 80_000;
      this._renderGenericFlood(lon, lat, floodR, rise);
      labelLat = lat + floodR / 111_000 + 1.5;
      const anchorCity = stats?.nearestCities?.[0]?.name ?? null;
      title = anchorCity ? `${anchorCity} — Sea Level Rise` : 'Sea Level Rise';
      this.viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(lon, lat - 2, floodR * 2.8),
        duration: 2.5,
      });
    }

    // Animate rise 0→1 (drives fill alpha + the headline number).
    this._addPostRenderListener(() => {
      if (this._destroyed) return;
      const t = Math.min(this._elapsed() / 12, 1);
      rise.val = t * t * (3 - 2 * t); // smoothstep
      this.viewer.scene.requestRender();
    });

    // Headline label — animates 0 → the real projected rise for this chapter/SSP.
    this._track(this.viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(labelLon, labelLat),
      label: {
        text: new Cesium.CallbackProperty(
          () => `${title}\n+${(displayRise * rise.val).toFixed(2)} m by ${this.year}${srcTag}${extentLine}`,
          false),
        font: 'bold 14px system-ui',
        fillColor: Cesium.Color.fromCssColorString('#7dd3fc'),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        pixelOffset: new Cesium.Cartesian2(0, -12),
      },
    }));

    // Named city pins from cities.json — the human anchor the feedback asked for.
    // Population only: a per-city "exposed" number would require the DEM bake
    // (deferred), and reusing the national all-hazard fraction here would mislead.
    this._addCityPins(stats?.nearestCities);
  }

  /**
   * Flagship inundation: render the baked delta band (land dry today, under
   * water at the shown rise level) as real polygons hugging the coastline.
   * Water-blue fill animating in + bright delta outline.
   *
   * @param {Object} doc   - slr_<metro>.json
   * @param {Object} level - pickLevel() result
   * @param {{val:number}} rise - shared 0→1 animation driver
   * @returns {{labelLon:number, labelLat:number}}
   */
  _renderInundationDelta(doc, level, rise) {
    // Cap ring count — a metro bake can produce many islets; the largest
    // rings carry the story and the 30fps budget matters more than islet #61.
    const MAX_RINGS = 60;
    const rings = level.rings.slice(0, MAX_RINGS);

    const fillColor = Cesium.Color.fromCssColorString('#1d7dd8');
    const lineColor = Cesium.Color.fromCssColorString('#7dd3fc');

    for (const ring of rings) {
      const flat = [];
      for (const [rlon, rlat] of ring) flat.push(rlon, rlat);
      this._track(this.viewer.entities.add({
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(
            Cesium.Cartesian3.fromDegreesArray(flat)),
          material: new Cesium.ColorMaterialProperty(
            new Cesium.CallbackProperty(
              () => fillColor.withAlpha(rise.val * 0.58), false)),
          outline: true,
          outlineColor: new Cesium.CallbackProperty(
            () => lineColor.withAlpha(0.25 + rise.val * 0.6), false),
          outlineWidth: 2,
          height: 0,
        },
      }));
    }

    // Frame the metro (bbox baked alongside the geometry)
    const [w, s, e, n] = doc.bbox;
    this.viewer.camera.flyTo({
      destination: Cesium.Rectangle.fromDegrees(w - 0.15, s - 0.1, e + 0.15, n + 0.1),
      duration: 2.8,
      easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
    });

    return {
      labelLon: doc.center.lon,
      labelLat: doc.bbox[3] + 0.06, // just north of the frame
    };
  }

  /**
   * Generic sea-level visual for coasts without baked geometry:
   * the previous ellipse fill + surge + expanding wave rings, unchanged.
   */
  _renderGenericFlood(lon, lat, floodR, rise) {
    // Main flood zone
    this._track(this.viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat),
      ellipse: {
        semiMajorAxis: floodR,
        semiMinorAxis: floodR * 0.75,
        height: 0,
        material: new Cesium.ColorMaterialProperty(
          new Cesium.CallbackProperty(
            () => Cesium.Color.fromCssColorString('#1a6eb5').withAlpha(rise.val * 0.52),
            false)),
      },
    }));

    // Inner surge (brighter)
    this._track(this.viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat),
      ellipse: {
        semiMajorAxis: floodR * 0.45,
        semiMinorAxis: floodR * 0.35,
        height: 1,
        material: new Cesium.ColorMaterialProperty(
          new Cesium.CallbackProperty(
            () => Cesium.Color.fromCssColorString('#3399ff').withAlpha(rise.val * 0.65),
            false)),
      },
    }));

    // 4 expanding wave rings
    for (let i = 0; i < 4; i++) {
      const phase = i * 0.25;
      this._track(this.viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(lon, lat),
        ellipse: {
          semiMajorAxis: new Cesium.CallbackProperty(() => {
            const t = ((this._elapsed() * 0.35 + phase) % 1);
            return floodR * (0.25 + t * 0.9);
          }, false),
          semiMinorAxis: new Cesium.CallbackProperty(() => {
            const t = ((this._elapsed() * 0.35 + phase) % 1);
            return floodR * 0.75 * (0.25 + t * 0.9);
          }, false),
          height: 10,
          outline: true,
          outlineColor: new Cesium.CallbackProperty(() => {
            const t = ((this._elapsed() * 0.35 + phase) % 1);
            return Cesium.Color.fromCssColorString('#93c5fd')
              .withAlpha(rise.val * (1 - t) * 0.55);
          }, false),
          outlineWidth: 1.5,
          material: new Cesium.ColorMaterialProperty(Cesium.Color.TRANSPARENT),
        },
      }));
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // M4: Wildfire  (particle-spread)
  // ParticleSystem fire column + smoke + embers with expanding burn scar
  // ═══════════════════════════════════════════════════════════════════════════

  async _renderWildfire() {
    const center = this._getCenter();
    const mag = Math.max(1, Math.min(10, this.command.params?.magnitude ?? 5));

    // Burnable-land mask (bake_landmask.py): nudge the fire onto burnable ground
    // when the parser centroid drifts offshore / onto ice / into a named desert,
    // and clip the burn scar to it below. Null (bake not run yet) → unclipped
    // centroid behavior. 40 rings ≈ 10° ≈ 1,100 km: with named deserts excluded
    // (2026-07-16) a country centroid can sit deep inside one (Australia →
    // Outback), so the search must escape a desert complex, not just a bay.
    // Cost is trivial (ring scan over packed bits) and the nudge is what gives
    // vegetation-biased placement: the fire moves to the nearest vegetated cell.
    const mask = await loadLandMask();
    if (this._destroyed) return;
    let { lon, lat } = center;

    // Population-biased anchor for COUNTRY-LEVEL queries (decision locked
    // 2026-07-16, from the Australia eyeball): with no explicit place from the
    // parser, the geometric centroid can sit in remote interior (the Alice
    // Springs corridor — a genuine gap between NE named deserts), reading as
    // fire-on-sand 1,100+ km from anyone. Anchoring at the most populous baked
    // city puts "wildfire in Australia" in the populated fire country people
    // mean, and the city callout becomes meaningful. Baked cities.json only
    // (rule #4); explicit-center queries keep the parser's placement.
    let cityBiased = false;
    const hasExplicitCenter =
      this.command.params?.center?.lon != null && this.command.params?.center?.lat != null;
    if (!hasExplicitCenter) {
      const big = await largestCityForISO(this.command.target);
      if (this._destroyed) return;
      if (big) { lon = big.lon; lat = big.lat; cityBiased = true; }
    }

    if (mask) {
      const b = mask.nearestBurnable(lon, lat, 40);
      if (b) { lon = b.lon; lat = b.lat; }
    }

    const fireCanvas  = _FIRE_CANVAS;
    const smokeCanvas = _SMOKE_CANVAS;
    const emberCanvas = _EMBER_CANVAS;

    const fireR      = 30_000 + mag * 12_000;
    const rate       = 6 + mag * 3;
    const burnRadius = { val: 5000 };

    // Ground burn scar — clipped to the burnable mask when available (skips
    // water/ice cells, so a coastal fire follows the shoreline instead of a
    // perfect ellipse). Falls back to the expanding ellipse without the mask.
    if (mask) {
      this._renderBurnableScar(mask, lon, lat, fireR, burnRadius);
    } else {
      this._track(this.viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(lon, lat),
        ellipse: {
          semiMajorAxis: new Cesium.CallbackProperty(() => burnRadius.val, false),
          semiMinorAxis: new Cesium.CallbackProperty(() => burnRadius.val * 0.7, false),
          height: 50,
          material: new Cesium.ColorMaterialProperty(
            new Cesium.CallbackProperty(() =>
              Cesium.Color.fromCssColorString('#cc3300')
                .withAlpha(0.32 + Math.sin(this._elapsed() * 3.5) * 0.10),
              false)),
        },
      }));
    }

    // Fire column
    const fireOrigin = Cesium.Cartesian3.fromDegrees(lon, lat, 0);
    const fire = new Cesium.ParticleSystem({
      image: fireCanvas,
      modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(fireOrigin),
      emitter: new Cesium.ConeEmitter(Cesium.Math.toRadians(22)),
      emissionRate: rate,
      minimumParticleLife: 4,
      maximumParticleLife: 9,
      minimumSpeed: 80,
      maximumSpeed: 180,
      startColor: Cesium.Color.fromCssColorString('#ff8800').withAlpha(0.9),
      endColor:   Cesium.Color.fromCssColorString('#ff2200').withAlpha(0.0),
      startScale: 1.0,
      endScale:   3.5,
      minimumImageSize: new Cesium.Cartesian2(10000, 10000),
      maximumImageSize: new Cesium.Cartesian2(24000, 24000),
    });
    this.viewer.scene.primitives.add(fire);
    this._track(fire);

    // Smoke column (higher altitude, larger), drifting on prevailing winds.
    // Direction is a latitude-band climatology (tropical/polar easterlies,
    // mid-latitude westerlies), NOT a forecast — decorative, so nothing on
    // screen claims a wind speed. The force accelerates each particle downwind.
    const smokeOrigin = Cesium.Cartesian3.fromDegrees(lon, lat, 8000);
    const windForce = this._prevailingWindForce(lon, lat);
    const smoke = new Cesium.ParticleSystem({
      image: smokeCanvas,
      modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(smokeOrigin),
      emitter: new Cesium.ConeEmitter(Cesium.Math.toRadians(14)),
      emissionRate: Math.ceil(rate * 0.55),
      minimumParticleLife: 18,
      maximumParticleLife: 32,
      minimumSpeed: 25,
      maximumSpeed: 75,
      startColor: Cesium.Color.fromCssColorString('rgba(85,85,85,0.6)'),
      endColor:   Cesium.Color.fromCssColorString('rgba(145,145,145,0.0)'),
      startScale: 1.0,
      endScale:   6.0,
      minimumImageSize: new Cesium.Cartesian2(20000, 20000),
      maximumImageSize: new Cesium.Cartesian2(65000, 65000),
      updateCallback: (p, dt) => {
        p.velocity.x += windForce.x * dt;
        p.velocity.y += windForce.y * dt;
        p.velocity.z += windForce.z * dt;
      },
    });
    this.viewer.scene.primitives.add(smoke);
    this._track(smoke);

    // Ember sparks
    const embers = new Cesium.ParticleSystem({
      image: emberCanvas,
      modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(fireOrigin),
      emitter: new Cesium.ConeEmitter(Cesium.Math.toRadians(38)),
      emissionRate: Math.ceil(rate * 1.6),
      minimumParticleLife: 2,
      maximumParticleLife: 5,
      minimumSpeed: 200,
      maximumSpeed: 550,
      startColor: Cesium.Color.fromCssColorString('#ffdd00').withAlpha(1.0),
      endColor:   Cesium.Color.fromCssColorString('#ff4400').withAlpha(0.0),
      startScale: 0.3,
      endScale:   0.8,
      minimumImageSize: new Cesium.Cartesian2(3000, 3000),
      maximumImageSize: new Cesium.Cartesian2(8000, 8000),
    });
    this.viewer.scene.primitives.add(embers);
    this._track(embers);

    // ── Label reads BAKED data — the fire's driver (temperature anomaly) and
    // fuel-dryness proxy (precip change) are in climate.json. The old
    // `Severity mag/10` label was fabricated from the parser magnitude (the
    // rule-#4 failure mode). Fire stays localized — a wildfire is not nationwide,
    // so unlike heatwave/drought the geometry is NOT polygon-bound to the country.
    let stats = null;
    try {
      stats = await getImpactStats({
        eventType: 'wildfire', iso: this.command.target,
        year: this.year, ssp: this.ssp, center: { lon, lat },
      });
    } catch (_) { /* label falls back below */ }
    if (this._destroyed) return;

    const anomaly = stats?.raw?.tempAnomalyC;
    const precip  = stats?.raw?.precipChangePct;
    const lines   = ['Wildfire'];
    if (anomaly != null) {
      lines[0] = `Wildfire  ${anomaly >= 0 ? '+' : ''}${anomaly.toFixed(1)}°C anomaly (CMIP6 ${this.ssp})`;
    }
    if (precip != null) {
      lines.push(`Precipitation ${precip >= 0 ? '+' : ''}${precip.toFixed(1)}% annual`
        + `${precip < 0 ? ' — drier fuels' : ''}`);
    }
    const anchorCity = stats?.nearestCities?.[0];
    if (anchorCity) {
      lines.push(`${anchorCity.name} — ${fmtCount(anchorCity.population)} people`);
    }
    // Honest framing when we chose the spot (country-level query): the fire's
    // location is illustrative, not a modeled ignition point.
    if (cityBiased) {
      lines.push('illustrative placement — country-level query');
    }

    this._addStatLabel(lon, lat + fireR / 111_000 + 1.5, lines.join('\n'), '#ffa040');

    this._addPostRenderListener(() => {
      if (this._destroyed) return;
      const t = Math.min(this._elapsed() / 20, 1);
      burnRadius.val = 5000 + t * (fireR - 5000);
      this.viewer.scene.requestRender();
    });

    this.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat - 1.5, fireR * 5),
      duration: 2.5,
    });
  }

  /**
   * Burn scar clipped to the burnable-land mask: draw a translucent cell for
   * each burnable grid cell within fireR of the fire, revealed outward as the
   * burn radius grows. Skips water/ice cells, so the scar hugs the coastline
   * instead of spilling into the sea. Cell count is small (fireR ≲ 150 km at
   * ~28 km cells → a handful across) and hard-capped for the 30fps budget.
   *
   * @param {import('./LandMaskGeodata.js').LandMask} mask
   * @param {number} lon @param {number} lat @param {number} fireR
   * @param {{val:number}} burnRadius - shared 5 km→fireR animation driver
   */
  _renderBurnableScar(mask, lon, lat, fireR, burnRadius) {
    const res = mask.resDeg;
    const cosLat = Math.max(0.1, Math.cos(Cesium.Math.toRadians(lat)));
    const spanCols = Math.ceil((fireR / (111_000 * cosLat)) / res) + 1;
    const spanRows = Math.ceil((fireR / 111_000) / res) + 1;
    const c0 = Math.floor((lon + 180) / res);
    const r0 = Math.floor((90 - lat) / res);
    const MAX_CELLS = 220;

    let cells = 0;
    for (let dr = -spanRows; dr <= spanRows && cells < MAX_CELLS; dr++) {
      for (let dc = -spanCols; dc <= spanCols && cells < MAX_CELLS; dc++) {
        const clon = -180 + (c0 + dc + 0.5) * res;
        const clat = 90 - (r0 + dr + 0.5) * res;
        const dxM = (clon - lon) * 111_000 * cosLat;
        const dyM = (clat - lat) * 111_000;
        const distM = Math.hypot(dxM, dyM);
        if (distM > fireR) continue;
        if (!mask.isBurnable(clon, clat)) continue;

        const w = -180 + (c0 + dc) * res;
        const s = 90 - (r0 + dr + 1) * res;
        // Skip cells crossing the antimeridian / poles → Rectangle throws on
        // west>east or lat out of range (rare: a fire within fireR of ±180°).
        if (w < -180 || w + res > 180 || s < -90 || s + res > 90) continue;
        this._track(this.viewer.entities.add({
          rectangle: {
            coordinates: Cesium.Rectangle.fromDegrees(w, s, w + res, s + res),
            height: 50,
            material: new Cesium.ColorMaterialProperty(
              new Cesium.CallbackProperty(() => {
                // Cell ignites once the growing burn radius reaches it.
                const lit = burnRadius.val >= distM;
                const a = lit ? 0.30 + Math.sin(this._elapsed() * 3.5 + distM * 1e-4) * 0.10 : 0;
                return Cesium.Color.fromCssColorString('#cc3300').withAlpha(a);
              }, false)),
          },
        }));
        cells++;
      }
    }
  }

  /**
   * Prevailing-wind drift force (world-space Cartesian3) for smoke, from a
   * coarse latitude-band climatology — tropical & polar easterlies, mid-latitude
   * westerlies, with a slight poleward lean. Decorative direction only; no wind
   * speed is claimed anywhere on screen.
   *
   * @param {number} lon @param {number} lat
   * @returns {Cesium.Cartesian3} force applied to particle velocity per second
   */
  _prevailingWindForce(lon, lat) {
    const absLat = Math.abs(lat);
    const eastSign = (absLat < 30 || absLat >= 60) ? -1 : 1; // easterlies vs westerlies
    const northSign = lat >= 0 ? 0.2 : -0.2;                 // slight poleward lean

    const originC = Cesium.Cartesian3.fromDegrees(lon, lat);
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(originC);
    const eCol = Cesium.Matrix4.getColumn(enu, 0, new Cesium.Cartesian4());
    const nCol = Cesium.Matrix4.getColumn(enu, 1, new Cesium.Cartesian4());
    const eastV  = new Cesium.Cartesian3(eCol.x, eCol.y, eCol.z);
    const northV = new Cesium.Cartesian3(nCol.x, nCol.y, nCol.z);

    const force = new Cesium.Cartesian3();
    Cesium.Cartesian3.add(
      Cesium.Cartesian3.multiplyByScalar(eastV, eastSign, new Cesium.Cartesian3()),
      Cesium.Cartesian3.multiplyByScalar(northV, northSign, new Cesium.Cartesian3()),
      force);
    Cesium.Cartesian3.normalize(force, force);
    // ~2.5 m/s² over an 18–32 s smoke life ≈ 45–80 m/s lateral, comparable to the
    // 25–75 m/s rise speed → smoke leans over as it climbs (a drift, not a blast).
    const WIND_ACCEL = 2.5;
    return Cesium.Cartesian3.multiplyByScalar(force, WIND_ACCEL, force);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // M4: Drought  (choropleth-anim)
  // Animated ground fill: green → yellow → orange → deep brown
  // ═══════════════════════════════════════════════════════════════════════════

  async _renderDrought() {
    const { lon, lat } = this._getCenter();
    const mag    = Math.max(1, Math.min(5, this.command.params?.magnitude ?? 3));
    const radius = 350_000 + mag * 80_000;

    // Real numbers FIRST — the baked drought_index drives the fill SEVERITY, not
    // only the label. (Before, the color came from the parser magnitude, so a
    // near-zero index could still shade a whole country deep brown — the rule #4
    // failure the USA eyeball caught: label "index 0.09" under a severe-orange
    // fill.) Fetched once here; the label below reuses this same `stats`.
    let stats = null;
    try {
      stats = await getImpactStats({
        eventType: 'drought', iso: this.command.target,
        year: this.year, ssp: this.ssp, center: { lon, lat },
      });
    } catch (_) { /* falls back to magnitude-only visuals + a bare label */ }
    if (this._destroyed) return;

    // 0 (none) → 1 (extreme). Baked index when present; else the parser
    // magnitude as a last-resort visual for null/unknown targets (the label
    // only ever *names* an index when one is actually baked).
    const bakedIdx = stats?.raw?.droughtIndex;
    const severityTarget = bakedIdx != null
      ? Math.max(0, Math.min(1, bakedIdx))
      : (mag / 5);

    const droughtColor = () => {
      const t = Math.min(1, this._elapsed() / 10) * severityTarget;
      if (t < 0.33) {
        return Cesium.Color.lerp(
          Cesium.Color.fromCssColorString('#4ade80'),
          Cesium.Color.fromCssColorString('#facc15'),
          t / 0.33, new Cesium.Color()).withAlpha(0.52);
      } else if (t < 0.66) {
        return Cesium.Color.lerp(
          Cesium.Color.fromCssColorString('#facc15'),
          Cesium.Color.fromCssColorString('#f97316'),
          (t - 0.33) / 0.33, new Cesium.Color()).withAlpha(0.58);
      } else {
        return Cesium.Color.lerp(
          Cesium.Color.fromCssColorString('#f97316'),
          Cesium.Color.fromCssColorString('#7c2d12'),
          (t - 0.66) / 0.34, new Cesium.Color()).withAlpha(0.64);
      }
    };

    // Main drought zone — bound to real geometry (VISUAL_UPGRADE_PLAN:
    // polygon-anchored, not a centroid ellipse), in preference order:
    //   1. admin-1 CHOROPLETH — baked state/province boundaries (bake_admin1.py),
    //      every region filled with the same color from the country's NATIONAL
    //      drought_index (rule #4: geometry is sub-national, the value is not —
    //      the label says so). Adds the state/province legibility the feedback
    //      asked for and auto-upgrades if per-region climate is ever baked.
    //   2. national boundary polygon — when the admin-1 file isn't baked yet.
    //   3. centroid ellipse — null/unknown target (sub-national / regional).
    const droughtMat = new Cesium.ColorMaterialProperty(
      new Cesium.CallbackProperty(droughtColor, false));
    const regionOutline = new Cesium.CallbackProperty(
      () => Cesium.Color.fromCssColorString('#78350f')
        .withAlpha(Math.min(1, this._elapsed() / 8) * 0.5), false);

    const addDroughtPolygon = ({ outer, holes }, outlined) => {
      this._track(this.viewer.entities.add({
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(
            Cesium.Cartesian3.fromDegreesArray(outer),
            holes.map((h) => new Cesium.PolygonHierarchy(
              Cesium.Cartesian3.fromDegreesArray(h)))),
          height: 100,
          arcType: Cesium.ArcType.GEODESIC,
          granularity: Cesium.Math.toRadians(2),
          material: droughtMat,
          outline: outlined,
          outlineColor: outlined ? regionOutline : undefined,
          outlineWidth: 1,
        },
      }));
    };

    let polygonBound = false;
    let choropleth = false;

    // 1. admin-1 choropleth (defensive polygon cap so archipelago nations can't
    //    blow the 30fps entity budget).
    try {
      const admin1 = await loadAdmin1(this.command.target);
      if (this._destroyed) return;
      if (admin1?.regions?.length) {
        let count = 0;
        for (const region of admin1.regions) {
          for (const poly of regionToPolygonRings(region)) {
            if (count >= 250) break;
            addDroughtPolygon(poly, true);
            count++;
          }
          if (count >= 250) break;
        }
        polygonBound = count > 0;
        choropleth = polygonBound;
      }
    } catch (_) { /* fall through to the national polygon */ }

    // 2. national boundary polygon (interim until the admin-1 bake lands).
    if (!polygonBound) {
      try {
        const feature = await getCountryFeature(this.command.target);
        if (this._destroyed) return;
        for (const rings of featureToPolygonRings(feature)) {
          addDroughtPolygon(rings, false);
          polygonBound = true;
        }
      } catch (_) { /* fall through to the ellipse */ }
    }

    if (!polygonBound) {
      this._track(this.viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(lon, lat),
        ellipse: {
          semiMajorAxis: radius,
          semiMinorAxis: radius * 0.72,
          height: 100,
          material: droughtMat,
        },
      }));
    }

    // Concentric ring cracks (progressive severity markers) — opacity scales
    // with the baked severity, not the parser magnitude, so a mild index doesn't
    // draw a severe-looking ring cage over a faint fill.
    for (let i = 0; i < 5; i++) {
      const r = radius * (0.18 + i * 0.16);
      this._track(this.viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(lon, lat),
        ellipse: {
          semiMajorAxis: r,
          semiMinorAxis: r * 0.72,
          height: 200,
          outline: true,
          outlineColor: new Cesium.CallbackProperty(() =>
            Cesium.Color.fromCssColorString('#92400e')
              .withAlpha(Math.min(1, this._elapsed() / 8) * 0.30 * severityTarget),
            false),
          outlineWidth: 1,
          material: new Cesium.ColorMaterialProperty(Cesium.Color.TRANSPARENT),
        },
      }));
    }

    // ── Label reads the SAME baked data that drives the fill severity above
    // (drought_index + precip from climate.json). Falls back to a bare "Drought"
    // if no baked data — never a synthesized severity.
    const idx    = stats?.raw?.droughtIndex;
    const precip = stats?.raw?.precipChangePct;
    const lines  = ['Drought'];
    if (idx != null) {
      lines[0] = `Drought  index ${idx.toFixed(2)} (0 = none, 1 = extreme) (CMIP6 ${this.ssp})`;
    }
    // Honest disclosure (rule #4): the choropleth draws real admin-1 boundaries
    // but every region carries the same NATIONAL value — say so on-screen so the
    // uniform shading is never read as measured sub-national variation.
    if (choropleth) {
      lines.push('national value shown per region (sub-national CMIP6 not yet baked)');
    }
    if (precip != null) {
      lines.push(`Precipitation ${precip >= 0 ? '+' : ''}${precip.toFixed(1)}% annual by ${this.year}`);
    }
    const anchorCity = stats?.nearestCities?.[0];
    if (anchorCity) {
      lines.push(`${anchorCity.name} — ${fmtCount(anchorCity.population)} people`);
    }

    this._addStatLabel(lon, lat + radius / 111_000 + 1.5, lines.join('\n'), '#fde68a');

    this._addPostRenderListener(() => {
      if (!this._destroyed) this.viewer.scene.requestRender();
    });

    this.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat - 2, radius * 3),
      duration: 2.5,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // M4: Heatwave  (atmospheric-shimmer)
  // PostProcessStage heat shimmer + pulsing red-orange ground overlay
  // ═══════════════════════════════════════════════════════════════════════════

  async _renderHeatwave() {
    const { lon, lat } = this._getCenter();
    const mag       = Math.max(1, Math.min(5, this.command.params?.magnitude ?? 3));
    const radius    = 300_000 + mag * 100_000;

    // Visual intensity ref — seeded from parser magnitude, then re-driven by
    // the BAKED temperature anomaly once ImpactStats loads below (the same
    // rule-#4 tightening as the drought-fill fix, 2026-07-13): shimmer/ring
    // strength reads as severity, so severity must come from baked data, not
    // the LLM. mag keeps sizing the footprint (radius) only.
    // Floor at 0.45: the shimmer's distortion coefficients only become
    // perceptible around there — a pure anomaly mapping without the floor made
    // 2025 heatwaves invisible (regression caught on the 2026-07-16 eyeball).
    const intensityRef = { val: Math.max(0.45, mag / 5) };

    // Heat shimmer PostProcessStage (global scene effect)
    const shimmer = this.viewer.scene.postProcessStages.add(
      new Cesium.PostProcessStage({
        name: `heat_shimmer_${Date.now()}`,
        fragmentShader: `
          uniform sampler2D colorTexture;
          uniform float intensity;
          in vec2 v_textureCoordinates;
          // NOTE: do NOT declare out_FragColor — Cesium injects the
          // declaration into post-process shaders; declaring it again is a
          // GLSL redefinition error that kills the whole renderer.

          void main() {
            float t = mod(czm_frameNumber * 0.025, 6.28318);
            vec2 uv = v_textureCoordinates;

            // Vertical shimmer (heat rises)
            float wave = sin(uv.x * 28.0 + t * 1.8) * 0.0018
                       + sin(uv.x * 13.0 - t * 1.2) * 0.0011;
            uv.y += wave * intensity;
            uv.x += cos(uv.y * 22.0 + t * 1.1) * 0.0007 * intensity;

            vec4 color = texture(colorTexture, clamp(uv, 0.001, 0.999));

            // Warm tint
            color.r = min(1.0, color.r + 0.042 * intensity);
            color.g = max(0.0, color.g - 0.007 * intensity);
            color.b = max(0.0, color.b - 0.016 * intensity);

            out_FragColor = color;
          }
        `,
        // Function uniform: re-reads the ref each frame, so the strength
        // switches to the baked-anomaly value as soon as stats load.
        uniforms: { intensity: () => intensityRef.val },
      })
    );
    this._track(shimmer);

    // Ground heat tint — bound to the real country polygon when the command
    // targets a country (VISUAL_UPGRADE_PLAN: polygon-anchored geometry, not
    // centroid ellipses). Falls back to the legacy ellipse for null/unknown
    // targets (e.g. sub-national or ocean-region heatwaves).
    const pulsingHeat = new Cesium.ColorMaterialProperty(
      new Cesium.CallbackProperty(() =>
        Cesium.Color.fromCssColorString('#ef4444')
          .withAlpha(0.07 + Math.sin(this._elapsed() * 2) * 0.035),
        false));

    let polygonBound = false;
    try {
      const feature = await getCountryFeature(this.command.target);
      if (this._destroyed) return;
      for (const { outer, holes } of featureToPolygonRings(feature)) {
        this._track(this.viewer.entities.add({
          polygon: {
            hierarchy: new Cesium.PolygonHierarchy(
              Cesium.Cartesian3.fromDegreesArray(outer),
              holes.map((h) => new Cesium.PolygonHierarchy(
                Cesium.Cartesian3.fromDegreesArray(h)))),
            height: 100,
            arcType: Cesium.ArcType.GEODESIC,
            // Coarse granularity — same geometry-worker guard as the
            // choropleth layers (complex coastlines crash finer settings).
            granularity: Cesium.Math.toRadians(2),
            material: pulsingHeat,
          },
        }));
        polygonBound = true;
      }
    } catch (_) { /* fall through to the ellipse */ }

    if (!polygonBound) {
      this._track(this.viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(lon, lat),
        ellipse: {
          semiMajorAxis: radius,
          semiMinorAxis: radius * 0.75,
          height: 100,
          material: pulsingHeat,
        },
      }));
    }

    // Pulsing temperature rings
    for (let i = 0; i < 3; i++) {
      const phase = i * 0.33;
      this._track(this.viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(lon, lat),
        ellipse: {
          semiMajorAxis: new Cesium.CallbackProperty(() => {
            const t = ((this._elapsed() * 0.28 + phase) % 1);
            return radius * (0.18 + t * 1.1);
          }, false),
          semiMinorAxis: new Cesium.CallbackProperty(() => {
            const t = ((this._elapsed() * 0.28 + phase) % 1);
            return radius * 0.75 * (0.18 + t * 1.1);
          }, false),
          height: 200,
          outline: true,
          outlineColor: new Cesium.CallbackProperty(() => {
            const t = ((this._elapsed() * 0.28 + phase) % 1);
            return Cesium.Color.fromCssColorString('#fca5a5')
              .withAlpha((1 - t) * 0.42 * intensityRef.val);
          }, false),
          outlineWidth: 1.5,
          material: new Cesium.ColorMaterialProperty(Cesium.Color.TRANSPARENT),
        },
      }));
    }

    // ── Label reads BAKED data (VISUAL_UPGRADE_PLAN §3.4) ──
    // heat_days_gt35c + temperature_anomaly_c are already in climate.json;
    // the old `mag × 2.5 °C` label was the exact fabricated-stat failure mode
    // CLAUDE.md warns about. Falls back to an anomaly-free label if baked data
    // is missing — never back to a synthesized number.
    let stats = null;
    try {
      stats = await getImpactStats({
        eventType: 'heatwave', iso: this.command.target,
        year: this.year, ssp: this.ssp, center: { lon, lat },
      });
    } catch (_) { /* label falls back below */ }
    if (this._destroyed) return;

    const anomaly  = stats?.raw?.tempAnomalyC;
    const heatDays = stats?.raw?.heatDaysGt35c;

    // Baked anomaly modulates the visual intensity over a PERCEPTIBLE band:
    // 0.45 (any heatwave — the effect must announce the event the user chose,
    // like the hurricane's Cat-N spiral) → 1.0 at ~+4.5 °C (late-century
    // SSP5-8.5). The severity ORDERING is baked-data-driven (rule #4); the
    // baseline is scenario framing, not a statistic. A pure anomaly/4 mapping
    // was tried first and made 2025 heatwaves invisible (2026-07-16 eyeball).
    // Missing baked data → the mag seed stays (decoration-only fallback,
    // mirroring the label's own fallback).
    if (anomaly != null) {
      intensityRef.val = 0.45 + 0.55 * Math.min(1, Math.max(0, anomaly / 4.5));
    }

    const lines = ['Heatwave'];
    if (anomaly != null) {
      lines[0] = `Heatwave  ${anomaly >= 0 ? '+' : ''}${anomaly.toFixed(1)}°C anomaly (CMIP6 ${this.ssp})`;
    }
    if (heatDays != null) {
      lines.push(`${Math.round(heatDays)} days over 35 °C per year by ${this.year}`);
    }
    const anchorCity = stats?.nearestCities?.[0];
    if (anchorCity) {
      lines.push(`${anchorCity.name} — ${fmtCount(anchorCity.population)} people`);
    }

    this._addStatLabel(lon, lat + radius / 111_000 + 1.5, lines.join('\n'), '#fca5a5');

    this._addPostRenderListener(() => {
      if (!this._destroyed) this.viewer.scene.requestRender();
    });

    this.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat - 2, radius * 3.2),
      duration: 2.5,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // M4: Conflict  (flow-vectors)
  // Pulsing epicentre + animated displacement flow lines + shockwave rings
  // ═══════════════════════════════════════════════════════════════════════════

  async _renderConflict() {
    const { lon, lat } = this._getCenter();
    const mag      = Math.max(1, Math.min(5, this.command.params?.magnitude ?? 3));
    const flowLen  = 300_000 + mag * 80_000;

    // Pulsing conflict epicentre
    this._track(this.viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat, 5000),
      point: {
        pixelSize: new Cesium.CallbackProperty(
          () => 10 + Math.sin(this._elapsed() * 5) * 4, false),
        color: Cesium.Color.fromCssColorString('#ef4444'),
        outlineColor: Cesium.Color.fromCssColorString('#fca5a5'),
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    }));

    // Shockwave rings
    for (let i = 0; i < 3; i++) {
      const phase = i * 0.33;
      this._track(this.viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(lon, lat),
        ellipse: {
          semiMajorAxis: new Cesium.CallbackProperty(() => {
            const t = ((this._elapsed() * 0.18 + phase) % 1);
            return 40_000 + t * 650_000;
          }, false),
          semiMinorAxis: new Cesium.CallbackProperty(() => {
            const t = ((this._elapsed() * 0.18 + phase) % 1);
            return 40_000 + t * 650_000;
          }, false),
          height: 2000,
          outline: true,
          outlineColor: new Cesium.CallbackProperty(() => {
            const t = ((this._elapsed() * 0.18 + phase) % 1);
            return Cesium.Color.fromCssColorString('#f87171')
              .withAlpha((1 - t) * 0.5);
          }, false),
          outlineWidth: 1.5,
          material: new Cesium.ColorMaterialProperty(
            new Cesium.CallbackProperty(() => {
              const t = ((this._elapsed() * 0.18 + phase) % 1);
              return Cesium.Color.fromCssColorString('#ef4444')
                .withAlpha((1 - t) * 0.08);
            }, false)),
        },
      }));
    }

    // 8 displacement flow spokes
    for (let d = 0; d < 8; d++) {
      const angle = (d / 8) * Math.PI * 2;
      const endLon = lon + (flowLen / 111_320) * Math.cos(angle);
      const endLat = lat + (flowLen / 111_320) * Math.sin(angle);
      const phase  = d / 8;

      this._track(this.viewer.entities.add({
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArrayHeights(
            [lon, lat, 3000, endLon, endLat, 3000]),
          width: 1.5 + mag * 0.25,
          material: new Cesium.PolylineDashMaterialProperty({
            color: new Cesium.CallbackProperty(() => {
              const pulse = (Math.sin(this._elapsed() * 3 - phase * Math.PI * 2) + 1) / 2;
              return Cesium.Color.fromCssColorString('#f87171')
                .withAlpha(0.28 + pulse * 0.52);
            }, false),
            dashLength: 24,
            dashPattern: 0xFF00,
          }),
        },
      }));

      // Endpoint dot
      this._track(this.viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(endLon, endLat, 3000),
        point: {
          pixelSize: 4,
          color: Cesium.Color.fromCssColorString('#fca5a5').withAlpha(0.7),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      }));
    }

    // ── Label reads BAKED data — national population (World Bank) + the climate
    // driver (temp anomaly) come from ImpactStats. The old `round(mag)` scale
    // name was fabricated from the parser magnitude (rule-#4 failure mode). The
    // displacement spokes above are schematic and radial ON PURPOSE — drawing
    // arcs to real named destinations would imply migration routes we can't
    // predict; the mandatory on-screen framing says so explicitly.
    let stats = null;
    try {
      stats = await getImpactStats({
        eventType: 'conflict', iso: this.command.target,
        year: this.year, ssp: this.ssp, center: { lon, lat },
      });
    } catch (_) { /* label falls back below */ }
    if (this._destroyed) return;

    const pop     = stats?.raw?.population;
    const anomaly = stats?.raw?.tempAnomalyC;
    const lines   = ['Conflict'];
    if (pop != null) {
      lines.push(`${fmtCount(pop)} people nationally`);
    }
    if (anomaly != null) {
      lines.push(`Climate driver: ${anomaly >= 0 ? '+' : ''}${anomaly.toFixed(1)}°C anomaly `
        + `(CMIP6 ${this.ssp}) — water/crop stress`);
    }
    const anchorCity = stats?.nearestCities?.[0];
    if (anchorCity) {
      lines.push(`${anchorCity.name} — ${fmtCount(anchorCity.population)} people`);
    }
    lines.push('illustrative displacement — not a prediction');

    this._addStatLabel(lon, lat + flowLen / 111_000 + 2, lines.join('\n'), '#fca5a5');

    this._addPostRenderListener(() => {
      if (!this._destroyed) this.viewer.scene.requestRender();
    });

    this.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat - 2, flowLen * 3.5),
      duration: 2.5,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Generic template — schema-tier (19) + noted-tier (10) events
  // Polygon-anchored geometry + ImpactStats + city callouts (CLAUDE.md #16).
  // The pattern, not a per-event one-off: a bespoke render replaces this by
  // adding its strategy string to the routes map in _dispatch.
  // ═══════════════════════════════════════════════════════════════════════════

  async _renderGenericEvent() {
    const { lon, lat } = this._getCenter();
    const mag    = Math.max(1, Math.min(5, this.command.params?.magnitude ?? 3));
    const meta   = EVENT_TYPES[this.eventType] ?? {};
    const label  = meta.label ?? this.eventType ?? 'Event';

    // Extent honesty (the wildfire lesson): binding a localized hazard to the
    // whole country boundary falsely implies nationwide impact, and binding an
    // ocean event to land is just wrong. Three modes:
    //   national — country-scale phenomena → real boundary polygon
    //   ocean    — marine events → ellipse at center over water
    //   local    — everything else (default; a modest ellipse never over-claims)
    const NATIONAL = new Set([
      'epidemic_outbreak', 'power_grid_failure', 'infrastructure_cascade',
      'crop_failure', 'wet_bulb_exceedance', 'permafrost_thaw', 'blizzard',
      'wildfire_smoke', 'compound_fire_weather', 'dust_storm', 'locust_swarm',
    ]);
    const OCEAN = new Set([
      'tsunami', 'coral_bleaching', 'harmful_algal_bloom', 'marine_heatwave',
      'ocean_acidification', 'amoc_slowdown',
    ]);
    const mode = OCEAN.has(this.eventType) ? 'ocean'
      : NATIONAL.has(this.eventType) ? 'national' : 'local';

    // magnitude sizes VISUALS ONLY (rule #4) — all displayed numbers are baked.
    const radius = (mode === 'local' ? 120_000 : 250_000) + mag * 60_000;
    const tint   = mode === 'ocean' ? '#38bdf8' : '#a78bfa';
    const pulsing = new Cesium.ColorMaterialProperty(
      new Cesium.CallbackProperty(() =>
        Cesium.Color.fromCssColorString(tint)
          .withAlpha(0.10 + Math.sin(this._elapsed() * 1.6) * 0.04),
        false));

    let polygonBound = false;
    if (mode === 'national') {
      try {
        const feature = await getCountryFeature(this.command.target);
        if (this._destroyed) return;
        for (const { outer, holes } of featureToPolygonRings(feature)) {
          this._track(this.viewer.entities.add({
            polygon: {
              hierarchy: new Cesium.PolygonHierarchy(
                Cesium.Cartesian3.fromDegreesArray(outer),
                holes.map((h) => new Cesium.PolygonHierarchy(
                  Cesium.Cartesian3.fromDegreesArray(h)))),
              height: 100,
              arcType: Cesium.ArcType.GEODESIC,
              // Same geometry-worker guard as heatwave/drought — complex
              // coastlines crash finer granularity settings.
              granularity: Cesium.Math.toRadians(2),
              material: pulsing,
            },
          }));
          polygonBound = true;
        }
      } catch (_) { /* fall through to the ellipse */ }
    }

    if (!polygonBound) {
      this._track(this.viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(lon, lat),
        ellipse: {
          semiMajorAxis: radius,
          semiMinorAxis: radius * 0.8,
          height: 100,
          material: pulsing,
          outline: true,
          outlineColor: Cesium.Color.fromCssColorString(tint).withAlpha(0.55),
          outlineWidth: 2,
        },
      }));
    }

    // Expanding pulse ring — visual life within the 30fps budget.
    this._track(this.viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat),
      ellipse: {
        semiMajorAxis: new Cesium.CallbackProperty(() => {
          const t = (this._elapsed() * 0.25) % 1;
          return radius * (0.2 + t * 1.2);
        }, false),
        semiMinorAxis: new Cesium.CallbackProperty(() => {
          const t = (this._elapsed() * 0.25) % 1;
          return radius * 0.8 * (0.2 + t * 1.2);
        }, false),
        height: 200,
        outline: true,
        outlineColor: new Cesium.CallbackProperty(() => {
          const t = (this._elapsed() * 0.25) % 1;
          return Cesium.Color.fromCssColorString(tint).withAlpha((1 - t) * 0.4);
        }, false),
        outlineWidth: 1.5,
        material: new Cesium.ColorMaterialProperty(Cesium.Color.TRANSPARENT),
      },
    }));

    // ── Baked stats label (ImpactStats default branch: temp anomaly + precip
    // + national population) — never the parser magnitude on-screen.
    let stats = null;
    try {
      stats = await getImpactStats({
        eventType: this.eventType, iso: this.command.target,
        year: this.year, ssp: this.ssp, center: { lon, lat },
      });
    } catch (_) { /* label falls back below */ }
    if (this._destroyed) return;

    const anomaly = stats?.raw?.tempAnomalyC;
    const precip  = stats?.raw?.precipChangePct;
    const lines = [label];
    if (anomaly != null) {
      lines.push(`${anomaly >= 0 ? '+' : ''}${anomaly.toFixed(1)}°C anomaly by ${this.year} (CMIP6 ${this.ssp})`);
    }
    if (precip != null) {
      lines.push(`Precipitation ${precip >= 0 ? '+' : ''}${precip.toFixed(1)}% annual`);
    }
    const anchorCity = stats?.nearestCities?.[0];
    if (anchorCity) {
      lines.push(`${anchorCity.name} — ${fmtCount(anchorCity.population)} people`);
    }
    // Honest framing, always on-screen: the geometry is indicative, and for
    // national mode the boundary is an extent anchor, not a modeled footprint.
    lines.push(mode === 'national'
      ? 'national extent shown — not a modeled footprint'
      : 'illustrative extent — not a modeled footprint');

    this._addStatLabel(lon, lat + radius / 111_000 + 1.5, lines.join('\n'), '#c4b5fd');
    this._addCityPins(stats?.nearestCities);

    this._addPostRenderListener(() => {
      if (!this._destroyed) this.viewer.scene.requestRender();
    });

    this.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat - 2, radius * 3.2),
      duration: 2.5,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Placeholder — non-climate events (solar_storm) + unknown types only;
  // schema/noted tiers now route to _renderGenericEvent.
  // ═══════════════════════════════════════════════════════════════════════════

  async _renderPlaceholder() {
    // Non-localized event with no resolvable anchor (e.g. solar_storm with no
    // target): _getCenter() would fall back to a mid-Atlantic point, drawing a
    // meaningless circle in open ocean and flying the camera to it (seen on the
    // 2026-07-16 eyeball pass). The chat response already carries the honest
    // scope disclosure — draw nothing rather than a fake footprint.
    const p = this.command.params;
    const hasAnchor = (p?.center?.lon != null && p?.center?.lat != null)
      || !!getCentroid(this.command.target);
    if (!hasAnchor) return;

    const { lon, lat } = this._getCenter();
    const label = EVENT_TYPES[this.eventType]?.label ?? this.eventType ?? 'Event';

    this._track(this.viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat),
      ellipse: {
        semiMajorAxis: 250_000,
        semiMinorAxis: 250_000,
        height: 0,
        material: new Cesium.ColorMaterialProperty(
          Cesium.Color.fromCssColorString('#7dd3fc').withAlpha(0.18)),
        outline: true,
        outlineColor: Cesium.Color.fromCssColorString('#38bdf8').withAlpha(0.6),
        outlineWidth: 2,
      },
    }));

    this._track(this.viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat + 2.5),
      label: {
        text: `${label}\n(render coming in later milestone)`,
        font: '13px system-ui',
        fillColor: Cesium.Color.fromCssColorString('#bae6fd'),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    }));

    this.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat - 3, 3_000_000),
      duration: 2.0,
    });
  }
}
