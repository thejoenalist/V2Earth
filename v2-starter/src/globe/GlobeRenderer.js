import * as Cesium from 'cesium';

/**
 * GlobeRenderer — wraps CesiumJS into a clean interface.
 *
 * Handles: viewer setup, stylized globe appearance (no photorealistic
 * textures — custom NASA GIBS imagery + atmospheric glow), and
 * chapter-driven aesthetic shifts (the globe desaturates as time advances).
 *
 * Does NOT handle layers or interaction — those live in LayerOrchestrator
 * and InputHandler respectively.
 */
export class GlobeRenderer {
  /**
   * @param {HTMLElement} container - The DOM element to mount the Cesium viewer into
   */
  constructor(container) {
    if (!container) throw new Error('[GlobeRenderer] container element required');

    Cesium.Ion.defaultAccessToken = ''; // Not using Cesium ion — no token needed

    this._viewer = new Cesium.Viewer(container, {
      // Disable all default UI chrome — we have our own
      animation: false,
      baseLayerPicker: false,
      fullscreenButton: false,
      geocoder: false,
      homeButton: false,
      infoBox: false,
      navigationHelpButton: false,
      sceneModePicker: false,
      selectionIndicator: false,
      timeline: false,
      creditContainer: document.createElement('div'), // Hides Cesium credit

      // Use our own imagery provider
      baseLayer: Cesium.ImageryLayer.fromProviderAsync(
        Cesium.WebMapTileServiceImageryProvider.fromUrl(
          'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/' +
          'BlueMarble_NextGeneration/default/GoogleMapsCompatible_Level8' +
          '/{TileMatrix}/{TileRow}/{TileCol}.jpg',
          {
            tilingScheme: new Cesium.GeographicTilingScheme(),
            tileWidth: 256,
            tileHeight: 256,
            minimumLevel: 0,
            maximumLevel: 8,
          }
        )
      ),

      // Terrain: no elevation for now — flat globe
      // Swap this for CesiumTerrainProvider when terrain is needed
      terrainProvider: new Cesium.EllipsoidTerrainProvider(),
    });

    this._scene = this._viewer.scene;
    this._globe = this._scene.globe;

    this._applyStylizedDefaults();
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /** @returns {Cesium.Viewer} */
  get viewer() { return this._viewer; }

  /** @returns {Cesium.Scene} */
  get scene() { return this._scene; }

  /** @returns {Cesium.Camera} */
  get camera() { return this._viewer.camera; }

  /**
   * Apply chapter-driven aesthetic: globe desaturates and glows more
   * intensely as the year advances toward speculative territory.
   *
   * @param {number} year - Chapter year (2025–2500)
   */
  applyChapterAesthetic(year) {
    const t = Math.max(0, Math.min(1, (year - 2025) / (2500 - 2025)));

    // Atmosphere glow intensifies over time
    this._scene.skyAtmosphere.hueShift = t * 0.05;
    this._scene.skyAtmosphere.saturationShift = -t * 0.3;
    this._scene.skyAtmosphere.brightnessShift = t * 0.1;

    // Globe surface gets slightly more washed / abstract
    this._globe.atmosphereLightIntensity = 10.0 + t * 6.0;
  }

  /** Handle container resize — call from window resize event. */
  resize() {
    this._viewer.canvas.width = this._viewer.container.clientWidth;
    this._viewer.canvas.height = this._viewer.container.clientHeight;
  }

  /** Fly the camera to a country's rough center. */
  flyToISO(iso) {
    // TODO: Milestone 2 — load ISO → centroid lookup from baked data
    console.log('[GlobeRenderer] flyToISO not yet implemented for', iso);
  }

  destroy() {
    this._viewer.destroy();
  }

  // ── Private ─────────────────────────────────────────────────────────────

  _applyStylizedDefaults() {
    const scene = this._scene;

    // Atmosphere
    scene.skyAtmosphere.show = true;
    scene.skyAtmosphere.atmosphereLightIntensity = 10.0;

    // No fog (cleaner data visualization)
    scene.fog.enabled = false;

    // Enable lighting for day/night terminator effect
    this._globe.enableLighting = true;
    this._globe.nightFadeInDistance = 1e7;
    this._globe.nightFadeOutDistance = 5e6;

    // Slightly reduce globe shininess for matte data-viz feel
    this._globe.material = Cesium.Material.fromType('Color', {
      color: new Cesium.Color(1.0, 1.0, 1.0, 1.0),
    });

    // Show stars
    scene.skyBox.show = true;

    // Smooth camera
    this._viewer.scene.screenSpaceCameraController.minimumZoomDistance = 1e6; // 1000 km min
    this._viewer.scene.screenSpaceCameraController.maximumZoomDistance = 2e7; // 20,000 km max

    // Initial camera position — view of Earth from space
    this._viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(10, 20, 2e7),
      duration: 0,
    });
  }
}
