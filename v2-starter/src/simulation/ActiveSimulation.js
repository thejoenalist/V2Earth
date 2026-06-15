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
import * as Cesium from 'cesium';

// ─────────────────────────────────────────────────────────────────────────────
// Country centroid lookup  [lon, lat] decimal degrees
// Used as fallback when command.params.center is absent.
// ─────────────────────────────────────────────────────────────────────────────
const CENTROIDS = {
  AFG: [67.71, 33.93],  AGO: [17.87, -11.20], ARG: [-63.62, -38.42],
  AUS: [133.78, -25.27], AUT: [14.55, 47.52],  BGD: [90.36, 23.68],
  BEL: [4.47, 50.50],   BRA: [-51.93, -14.24], CAN: [-96.82, 56.13],
  CHE: [8.23, 46.82],   CHL: [-71.54, -35.68], CHN: [104.20, 35.86],
  COD: [23.65, -2.88],  COL: [-74.30, 4.57],   DEU: [10.45, 51.17],
  DZA: [1.66, 28.03],   EGY: [30.80, 26.82],   ESP: [-3.75, 40.46],
  ETH: [40.49, 9.15],   FRA: [2.21, 46.23],    GBR: [-3.44, 55.38],
  GHA: [-1.02, 7.95],   GTM: [-90.23, 15.78],  IDN: [113.92, -0.79],
  IND: [78.96, 20.59],  IRN: [53.69, 32.43],   IRQ: [43.68, 33.22],
  ITA: [12.57, 41.87],  JPN: [138.25, 36.20],  KAZ: [66.92, 48.02],
  KEN: [37.91, 0.02],   KOR: [127.77, 35.91],  LBY: [17.23, 26.34],
  MAR: [-7.09, 31.79],  MEX: [-102.55, 23.95], MOZ: [35.00, -18.67],
  MYS: [109.70, 4.21],  NGA: [8.68, 9.08],     NOR: [8.47, 60.47],
  NPL: [84.12, 28.39],  NZL: [174.89, -40.90], PAK: [69.35, 30.38],
  PER: [-75.02, -9.19], PHL: [121.77, 12.88],  POL: [19.15, 51.92],
  PRK: [127.51, 40.34], PRT: [-8.22, 39.40],   ROU: [24.97, 45.94],
  RUS: [105.32, 61.52], SAU: [45.08, 23.89],   SDN: [29.94, 12.86],
  SEN: [-14.45, 14.50], SOM: [45.34, 6.00],    SWE: [18.64, 60.13],
  SYR: [38.30, 34.80],  THA: [100.99, 15.87],  TUR: [35.24, 38.96],
  TZA: [34.89, -6.37],  UKR: [31.17, 48.38],   URY: [-55.77, -32.52],
  USA: [-98.58, 39.83], UZB: [63.95, 41.38],   VEN: [-66.59, 6.42],
  VNM: [108.28, 14.06], YEM: [48.52, 15.55],   ZAF: [25.08, -29.00],
  ZMB: [27.85, -13.13], ZWE: [29.15, -19.02],
};

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
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async start() {
    if (this._started || this._destroyed) return;
    this._started   = true;
    this._animStart = Date.now();

    const meta     = this.eventType ? EVENT_TYPES[this.eventType] : null;
    const strategy = meta?.render ?? 'placeholder';
    await this._dispatch(strategy);
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;

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

  /** Resolve event center: params.center → centroid lookup → Atlantic fallback */
  _getCenter() {
    const p = this.command.params;
    if (p?.center?.lon != null && p?.center?.lat != null) {
      return { lon: p.center.lon, lat: p.center.lat };
    }
    const iso = this.command.target;
    if (iso && CENTROIDS[iso]) {
      return { lon: CENTROIDS[iso][0], lat: CENTROIDS[iso][1] };
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
    const mag    = this.command.params?.magnitude ?? 1.5; // metres
    const floodR = 400_000 + mag * 80_000;
    const rise   = { val: 0 }; // 0→1 over 12 s

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

    // Dynamic label showing current rise
    this._track(this.viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat + floodR / 111_000 + 1.5),
      label: {
        text: new Cesium.CallbackProperty(
          () => `Sea Level Rise\n+${(mag * rise.val).toFixed(1)} m`, false),
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

    this._addPostRenderListener(() => {
      if (this._destroyed) return;
      const t = Math.min(this._elapsed() / 12, 1);
      rise.val = t * t * (3 - 2 * t); // smoothstep
      this.viewer.scene.requestRender();
    });

    this.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat - 2, floodR * 2.8),
      duration: 2.5,
    });
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

    const tempLabel = `+${(mag * 2.5).toFixed(1)}°C anomaly`;
    this._track(this.viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat + radius / 111_000 + 1.5),
      label: {
        text: `Heatwave  ${tempLabel}`,
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
