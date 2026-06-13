/**
 * ActiveSimulation — one executing simulation in the stack.
 *
 * Owns every CesiumJS object (Entity, Primitive, DataSource, ParticleSystem)
 * created for this event. destroy() removes them all cleanly — no leaks.
 *
 * The render strategy is determined by the eventType's `render` field from
 * EVENT_TYPES in SimulationCommand.js. Milestone 4 implements each strategy
 * as a full particle/mesh/shader render. Until then, all strategies render
 * a labeled placeholder ellipse so the full flow is testable end-to-end.
 *
 * ── CESIUM PRIMITIVES REFERENCE (Sandcastle examples) ─────────────────────
 *
 * ParticleSystem — hurricane spiral, wildfire spread, ash cloud, blizzard, locust swarm
 *   https://sandcastle.cesium.com/?src=Particle%20System.html
 *   https://sandcastle.cesium.com/?src=Particle%20System%20Fireworks.html
 *
 * GroundPrimitive — flood mesh, drought choropleth, burn scar, surge zone
 *   https://sandcastle.cesium.com/?src=Ground%20Primitives.html
 *
 * PostProcessStage — heat shimmer, wildfire smoke haze, desaturation
 *   https://sandcastle.cesium.com/?src=Post%20Processing.html
 *
 * CZML (time-dynamic animation) — storm tracks, seismic wave rings, contagion spread
 *   https://sandcastle.cesium.com/?src=CZML.html
 *
 * ImageryLayer — choropleth overlays, temperature anomaly maps, ocean color shift
 *   https://sandcastle.cesium.com/?src=Imagery%20Layers%20Manipulation.html
 *
 * Custom Shaders — sea level mesh morph, lava flow, glacial recession
 *   https://sandcastle.cesium.com/?src=Custom%20Shaders%20Models.html
 *
 * Entities (Polyline, Polygon, Point, Cylinder) — migration flow vectors,
 *   city markers, tornado column, infrastructure network graph
 *   https://sandcastle.cesium.com/?src=Polyline.html
 *   https://sandcastle.cesium.com/?src=Polygon.html
 *
 * ── RENDER STRATEGY → CESIUM PRIMITIVE MAPPING ────────────────────────────
 *
 * 'particle-spiral'        hurricane       → ParticleSystem, rotating inward, wind speed = particle velocity
 * 'mesh-flood'             sea_level_rise  → GroundPrimitive polygon, animated alpha rising over time
 * 'particle-spread'        wildfire        → ParticleSystem emitting from fire perimeter, drifts downwind
 * 'choropleth-anim'        drought         → ImageryLayer, green→yellow→red animated color ramp over region
 * 'atmospheric-shimmer'    heatwave        → PostProcessStage heat distortion, opacity = temperature anomaly
 * 'flow-vectors'           conflict        → Polyline entities showing migration routes, arrow density = volume
 * 'seismic-wave-rings'     earthquake      → CZML expanding ellipses (P-wave and S-wave at different speeds)
 * 'ash-cloud-expand'       volcanic        → ParticleSystem from vent + GroundPrimitive lava polygon on terrain
 * 'coastal-surge-fast'     storm_surge     → GroundPrimitive flood fill from coast, faster than mesh-flood
 * 'contagion-spread'       epidemic        → CZML point cluster expanding by R-number, color = transmission stage
 * 'swarm-advance'          locust          → ParticleSystem dense cloud advancing with prevailing wind
 * 'ocean-color-spread'     algal_bloom     → ImageryLayer ocean surface tint (blue→green/red)
 * 'blackout-spread'        grid_failure    → ImageryLayer swap (night lights on→off across affected region)
 * 'atmospheric-haze'       wildfire_smoke  → PostProcessStage brownish-orange overlay, opacity = AQI
 * 'network-failure-spread' infra_cascade   → Polyline network graph, nodes turn red in cascade sequence
 * 'wave-propagation'       tsunami         → CZML expanding wave front rings from origin point
 * 'vortex-column'          tornado         → Cylinder entity spinning with particle debris field
 * 'mesh-flood-river'       flood           → GroundPrimitive following river corridor + floodplain polygon
 * 'terrain-deform'         landslide       → Custom shader morphing terrain slope, debris GroundPrimitive
 * 'particle-whiteout'      blizzard        → ParticleSystem white particles + PostProcessStage desaturation
 * 'volumetric-wall'        dust_storm      → ParticleSystem dense brown wall advancing with wind
 * 'color-shift-ocean'      coral_bleaching → ImageryLayer ocean color shift (reef polygon)
 * 'mesh-shrink-timeline'   glacial_reces.  → GroundPrimitive polygon shrinking on chapter timeline
 * 'moisture-band'          atmos_river     → ImageryLayer animated band of high precipitable water
 */

import { EVENT_TYPES } from '../chat/SimulationCommand.js';
import * as Cesium from 'cesium';

export class ActiveSimulation {
  /**
   * @param {{
   *   command:  import('../chat/SimulationCommand.js').SimulationCommand,
   *   compound: import('./CompoundEffectsResolver.js').CompoundEffect | null,
   *   viewer:   Cesium.Viewer,
   *   year:     number,
   *   ssp:      string,
   * }} opts
   */
  constructor({ command, compound, viewer, year, ssp }) {
    this.command   = command;
    this.compound  = compound;
    this.viewer    = viewer;
    this.year      = year;
    this.ssp       = ssp;

    /** @type {string | null} */
    this.eventType = command.params?.eventType ?? null;

    /**
     * Every CesiumJS object created by this simulation.
     * destroy() removes all of them — this is the memory safety guarantee.
     * @type {Array<Cesium.Entity | Cesium.Primitive | Cesium.DataSource | object>}
     */
    this._owned = [];

    this._started   = false;
    this._destroyed = false;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async start() {
    if (this._started || this._destroyed) return;
    this._started = true;

    const meta     = this.eventType ? EVENT_TYPES[this.eventType] : null;
    const strategy = meta?.render ?? 'placeholder';

    await this._dispatch(strategy);
  }

  /**
   * Removes ALL owned CesiumJS objects from the viewer. Safe to call multiple times.
   */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;

    for (const obj of this._owned) {
      try {
        if (!obj) continue;

        // Entity
        if (obj instanceof Cesium.Entity) {
          this.viewer.entities.remove(obj);
          continue;
        }
        // Primitive (GroundPrimitive, etc.)
        if (this.viewer.scene.primitives.contains(obj)) {
          this.viewer.scene.primitives.remove(obj);
          continue;
        }
        // DataSource
        if (this.viewer.dataSources.contains(obj)) {
          this.viewer.dataSources.remove(obj, true);
          continue;
        }
        // PostProcessStage
        if (this.viewer.scene.postProcessStages.contains?.(obj)) {
          this.viewer.scene.postProcessStages.remove(obj);
          continue;
        }
        // Fallback: try generic destroy
        if (typeof obj.destroy === 'function' && !obj.isDestroyed?.()) {
          obj.destroy();
        }
      } catch (e) {
        console.warn('[ActiveSimulation] Cleanup error for object:', e);
      }
    }

    this._owned = [];
  }

  // ── Dispatch ──────────────────────────────────────────────────────────────

  async _dispatch(strategy) {
    const routes = {
      'particle-spiral':         () => this._renderParticleSpiral(),
      'mesh-flood':              () => this._renderMeshFlood(),
      'particle-spread':         () => this._renderParticleSpread(),
      'choropleth-anim':         () => this._renderChoroplethAnim(),
      'atmospheric-shimmer':     () => this._renderAtmosphericShimmer(),
      'flow-vectors':            () => this._renderFlowVectors(),
      'seismic-wave-rings':      () => this._renderSeismicWaveRings(),
      'ash-cloud-expand':        () => this._renderAshCloudExpand(),
      'coastal-surge-fast':      () => this._renderCoastalSurgeFast(),
      'contagion-spread':        () => this._renderContagionSpread(),
      'swarm-advance':           () => this._renderSwarmAdvance(),
      'ocean-color-spread':      () => this._renderOceanColorSpread(),
      'blackout-spread':         () => this._renderBlackoutSpread(),
      'atmospheric-haze':        () => this._renderAtmosphericHaze(),
      'network-failure-spread':  () => this._renderNetworkFailureSpread(),
      'wave-propagation':        () => this._renderWavePropagation(),
      'vortex-column':           () => this._renderVortexColumn(),
      'mesh-flood-river':        () => this._renderMeshFloodRiver(),
      'terrain-deform':          () => this._renderTerrainDeform(),
      'particle-whiteout':       () => this._renderParticleWhiteout(),
      'volumetric-wall':         () => this._renderVolumetricWall(),
      'color-shift-ocean':       () => this._renderColorShiftOcean(),
      'mesh-shrink-timeline':    () => this._renderMeshShrinkTimeline(),
      'moisture-band':           () => this._renderMoistureBand(),
      'placeholder':             () => this._renderPlaceholder(),
    };

    const fn = routes[strategy] ?? routes['placeholder'];
    await fn();
  }

  // ── Render stubs (Milestone 4) ────────────────────────────────────────────
  // Each method populates this._owned. All currently render a labeled placeholder
  // ellipse so the full simulation flow is testable before Milestone 4 rendering.

  async _renderParticleSpiral()       { this._placeholder('Hurricane / Cyclone',         Cesium.Color.STEELBLUE); }
  async _renderMeshFlood()            { this._placeholder('Sea Level Rise',               Cesium.Color.AQUA); }
  async _renderParticleSpread()       { this._placeholder('Wildfire',                     Cesium.Color.ORANGERED); }
  async _renderChoroplethAnim()       { this._placeholder('Drought',                      Cesium.Color.SANDYBROWN); }
  async _renderAtmosphericShimmer()   { this._placeholder('Heatwave',                     Cesium.Color.GOLD); }
  async _renderFlowVectors()          { this._placeholder('Conflict / Displacement',      Cesium.Color.CRIMSON); }
  async _renderSeismicWaveRings()     { this._placeholder('Earthquake',                   Cesium.Color.MEDIUMPURPLE); }
  async _renderAshCloudExpand()       { this._placeholder('Volcanic Eruption',            Cesium.Color.DIMGRAY); }
  async _renderCoastalSurgeFast()     { this._placeholder('Storm Surge',                  Cesium.Color.DEEPSKYBLUE); }
  async _renderContagionSpread()      { this._placeholder('Epidemic Outbreak',            Cesium.Color.LIMEGREEN); }
  async _renderSwarmAdvance()         { this._placeholder('Locust Swarm',                 Cesium.Color.YELLOWGREEN); }
  async _renderOceanColorSpread()     { this._placeholder('Harmful Algal Bloom',          Cesium.Color.DARKGREEN); }
  async _renderBlackoutSpread()       { this._placeholder('Power Grid Failure',           Cesium.Color.LIGHTGRAY); }
  async _renderAtmosphericHaze()      { this._placeholder('Wildfire Smoke',               Cesium.Color.PERU); }
  async _renderNetworkFailureSpread() { this._placeholder('Infrastructure Cascade',       Cesium.Color.TOMATO); }
  async _renderWavePropagation()      { this._placeholder('Tsunami',                      Cesium.Color.CYAN); }
  async _renderVortexColumn()         { this._placeholder('Tornado',                      Cesium.Color.LAVENDER); }
  async _renderMeshFloodRiver()       { this._placeholder('Flash Flood',                  Cesium.Color.DODGERBLUE); }
  async _renderTerrainDeform()        { this._placeholder('Landslide',                    Cesium.Color.SADDLEBROWN); }
  async _renderParticleWhiteout()     { this._placeholder('Blizzard',                     Cesium.Color.WHITE); }
  async _renderVolumetricWall()       { this._placeholder('Dust Storm',                   Cesium.Color.BURLYWOOD); }
  async _renderColorShiftOcean()      { this._placeholder('Coral Bleaching',              Cesium.Color.PALEVIOLETRED); }
  async _renderMeshShrinkTimeline()   { this._placeholder('Glacial Recession',            Cesium.Color.LIGHTBLUE); }
  async _renderMoistureBand()         { this._placeholder('Atmospheric River',            Cesium.Color.CORNFLOWERBLUE); }

  async _renderPlaceholder()          { this._placeholder(this.eventType ?? 'Simulation', Cesium.Color.CYAN); }

  // ── Utility ───────────────────────────────────────────────────────────────

  /**
   * @param {string} label
   * @param {Cesium.Color} color
   */
  _placeholder(label, color) {
    const center = this.command.params?.center;
    if (!center || !this.viewer) return;

    const entity = this.viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(center.lon ?? 0, center.lat ?? 0),
      label: {
        text: `[ ${label} ]`,
        font: '13px sans-serif',
        fillColor: color,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        pixelOffset: new Cesium.Cartesian2(0, -16),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      ellipse: {
        semiMajorAxis: 600_000,
        semiMinorAxis: 600_000,
        material: color.withAlpha(0.12),
        outline: true,
        outlineColor: color.withAlpha(0.6),
        outlineWidth: 2,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      },
    });

    this._track(entity);
  }

  /**
   * Register any CesiumJS object for cleanup on destroy().
   * @param {object} obj
   * @returns {object} the same object (for chaining)
   */
  _track(obj) {
    this._owned.push(obj);
    return obj;
  }
}
