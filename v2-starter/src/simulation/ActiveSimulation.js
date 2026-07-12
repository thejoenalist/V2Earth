/**
 * ActiveSimulation — one executing simulation in the stack.
 *
 * Milestone 4: All 6 "ready" event renders are fully implemented.
 * Remaining events fall back to _renderPlaceholder until their milestone.
 *
 * Memory contract: every CesiumJS object (Entity, Primitive, ParticleSystem,
 * PostProcessStage, postRender listener) is tracked in this._owned and
 * removed in destroy(). No leaks.
 */

import { EVENT_TYPES } from '../chat/SimulationCommand.js';
import { EventBus } from '../core/EventBus.js';
import { getCentroid } from '../globe/RegionCentroids.js';
import { getImpactStats, fmtCount } from '../data/ImpactStats.js';
import { findFlagshipMetro, loadInundation, pickLevel } from './InundationGeodata.js';
import * as Cesium from 'cesium';

/**
 * Natural lifetime of a simulation in milliseconds. After this, the sim
 * emits `simulation:complete` and EventSimulator winds it down — keeps the
 * globe clean and lets requestRenderMode re-idle the GPU.
 */
export const SIMULATION_LIFETIME_MS = 60_000;

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

    // Natural end: after the lifetime elapses, announce completion.
    // EventSimulator owns the stack, so it (not this class) performs the
    // actual teardown in response to this event.
    this._lifetimeTimer = setTimeout(() => {
      if (this._destroyed) return;
      EventBus.emit('simulation:complete', {
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
    const fn = routes[strategy] ?? (() => this._renderPlaceholder());
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
    const metro = findFlagshipMetro(lon, lat);
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

      // Close-up moment (F5): once the flood fill is mostly in, fly to the
      // lowest-lying named city we know about (South Beach moment). Fired via
      // the tracked postRender listener so destroy() can never leak a timer.
      const closeupCity = (stats?.nearestCities ?? [])
        .filter((c) => c.meanElevM != null)
        .sort((a, b) => a.meanElevM - b.meanElevM)[0] ?? null;
      if (closeupCity) {
        let fired = false;
        this._addPostRenderListener(() => {
          if (fired || this._destroyed || this._elapsed() < 7) return;
          fired = true;
          EventBus.emit('camera:closeup_requested', {
            lon: closeupCity.lon, lat: closeupCity.lat,
            name: closeupCity.name,
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
    for (const city of (stats?.nearestCities ?? [])) {
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
    const { lon, lat } = this._getCenter();
    const mag = Math.max(1, Math.min(10, this.command.params?.magnitude ?? 5));

    const fireCanvas  = _FIRE_CANVAS;
    const smokeCanvas = _SMOKE_CANVAS;
    const emberCanvas = _EMBER_CANVAS;

    const fireR      = 30_000 + mag * 12_000;
    const rate       = 6 + mag * 3;
    const burnRadius = { val: 5000 };

    // Ground burn scar glow
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

    // Smoke column (higher altitude, larger)
    const smokeOrigin = Cesium.Cartesian3.fromDegrees(lon, lat, 8000);
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

    this._track(this.viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat + fireR / 111_000 + 1.5),
      label: {
        text: `Wildfire  Severity ${mag.toFixed(0)}/10`,
        font: 'bold 14px system-ui',
        fillColor: Cesium.Color.fromCssColorString('#ffa040'),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    }));

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

  // ═══════════════════════════════════════════════════════════════════════════
  // M4: Drought  (choropleth-anim)
  // Animated ground fill: green → yellow → orange → deep brown
  // ═══════════════════════════════════════════════════════════════════════════

  async _renderDrought() {
    const { lon, lat } = this._getCenter();
    const mag    = Math.max(1, Math.min(5, this.command.params?.magnitude ?? 3));
    const radius = 350_000 + mag * 80_000;

    const droughtColor = () => {
      const t = Math.min(1, this._elapsed() / 10) * (mag / 5);
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

    // Main drought zone
    this._track(this.viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat),
      ellipse: {
        semiMajorAxis: radius,
        semiMinorAxis: radius * 0.72,
        height: 100,
        material: new Cesium.ColorMaterialProperty(
          new Cesium.CallbackProperty(droughtColor, false)),
      },
    }));

    // Concentric ring cracks (progressive severity markers)
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
              .withAlpha(Math.min(1, this._elapsed() / 8) * 0.30 * (mag / 5)),
            false),
          outlineWidth: 1,
          material: new Cesium.ColorMaterialProperty(Cesium.Color.TRANSPARENT),
        },
      }));
    }

    const sevLabel = ['', 'Abnormal', 'Moderate', 'Severe', 'Extreme', 'Exceptional'][Math.round(mag)];
    this._track(this.viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat + radius / 111_000 + 1.5),
      label: {
        text: `Drought  ${sevLabel}`,
        font: 'bold 14px system-ui',
        fillColor: Cesium.Color.fromCssColorString('#fde68a'),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    }));

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
    const intensity = mag / 5;
    const radius    = 300_000 + mag * 100_000;

    // Heat shimmer PostProcessStage (global scene effect)
    const shimmer = this.viewer.scene.postProcessStages.add(
      new Cesium.PostProcessStage({
        name: `heat_shimmer_${Date.now()}`,
        fragmentShader: `
          uniform sampler2D colorTexture;
          uniform float intensity;
          in vec2 v_textureCoordinates;
          out vec4 out_FragColor;

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
        uniforms: { intensity },
      })
    );
    this._track(shimmer);

    // Ground heat overlay
    this._track(this.viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat),
      ellipse: {
        semiMajorAxis: radius,
        semiMinorAxis: radius * 0.75,
        height: 100,
        material: new Cesium.ColorMaterialProperty(
          new Cesium.CallbackProperty(() =>
            Cesium.Color.fromCssColorString('#ef4444')
              .withAlpha(0.07 + Math.sin(this._elapsed() * 2) * 0.035),
            false)),
      },
    }));

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
              .withAlpha((1 - t) * 0.42 * intensity);
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

    this._track(this.viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat + radius / 111_000 + 1.5),
      label: {
        text: lines.join('\n'),
        font: 'bold 14px system-ui',
        fillColor: Cesium.Color.fromCssColorString('#fca5a5'),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    }));

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

    const scaleLabel = ['', 'Local', 'Regional', 'National', 'Multi-national', 'Global'][Math.round(mag)];
    this._track(this.viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat + flowLen / 111_000 + 2),
      label: {
        text: `Conflict  ${scaleLabel} scale`,
        font: 'bold 14px system-ui',
        fillColor: Cesium.Color.fromCssColorString('#fca5a5'),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    }));

    this._addPostRenderListener(() => {
      if (!this._destroyed) this.viewer.scene.requestRender();
    });

    this.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat - 2, flowLen * 3.5),
      duration: 2.5,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Placeholder — events not yet implemented beyond M4
  // ═══════════════════════════════════════════════════════════════════════════

  async _renderPlaceholder() {
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
