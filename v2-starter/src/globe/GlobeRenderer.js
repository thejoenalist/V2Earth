import * as Cesium from 'cesium';
import { getCentroid } from './RegionCentroids.js';

// ─────────────────────────────────────────────────────────────────────────────
// Imagery providers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * NASA GIBS Blue Marble — global base layer (zoom 0-8).
 * Shaded relief + bathymetry: the classic lit-from-space look.
 * Remains the foundation at global zoom; higher-res layers composite on top.
 */
function createBlueMarbleProvider() {
  return new Cesium.WebMapTileServiceImageryProvider({
    url:
      'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/' +
      'BlueMarble_ShadedRelief_Bathymetry/default/2004-08/' +
      'GoogleMapsCompatible_Level8/{TileMatrix}/{TileRow}/{TileCol}.jpg',
    layer: 'BlueMarble_ShadedRelief_Bathymetry',
    style: 'default',
    tileMatrixSetID: 'GoogleMapsCompatible_Level8',
    format: 'image/jpeg',
    tileWidth: 512,
    tileHeight: 512,
    maximumLevel: 8,
    credit: new Cesium.Credit('NASA GIBS Blue Marble'),
  });
}

/**
 * NASA GIBS Black Marble — city lights on the night side.
 * Composited over Blue Marble with night-blend mode so it only shows where
 * the globe is in shadow. The day/night terminator makes this visible
 * automatically when enableLighting = true.
 *
 * Layer is kept at low alpha so it doesn't wash out dayside imagery.
 * Alpha controlled by _nightLayer.alpha (set in _applyStylizedDefaults).
 */
function createBlackMarbleProvider() {
  return new Cesium.WebMapTileServiceImageryProvider({
    url:
      'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/' +
      'VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8' +
      '/{TileMatrix}/{TileRow}/{TileCol}.jpg',
    layer: 'VIIRS_Black_Marble',
    style: 'default',
    tileMatrixSetID: 'GoogleMapsCompatible_Level8',
    format: 'image/jpeg',
    tileWidth: 256,
    tileHeight: 256,
    maximumLevel: 8,
    credit: new Cesium.Credit('NASA GIBS Black Marble / VIIRS'),
  });
}

/**
 * ESRI World Imagery — sub-30m satellite, levels 0–19.
 * Primary detail layer; Blue Marble fades out when the camera moves in.
 */
async function createEsriProvider() {
  return Cesium.ArcGisMapServerImageryProvider.fromUrl(
    'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer',
    {
      enablePickFeatures: false,
      maximumLevel: 19,
      credit: new Cesium.Credit('Esri, Maxar, Earthstar Geographics, GIS Community'),
    },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Terrain
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Try to load Cesium World Terrain (requires ion token).
 * Falls back silently to the smooth ellipsoid if no token is set.
 * World Terrain adds real elevation — mountains, coastlines, ocean floors —
 * which dramatically changes how the globe reads at mid-zoom.
 *
 * @returns {Promise<Cesium.TerrainProvider>}
 */
async function createTerrainProvider() {
  const token = import.meta.env.VITE_CESIUM_ION_TOKEN;
  if (!token) {
    console.info(
      '[GlobeRenderer] No VITE_CESIUM_ION_TOKEN — using flat ellipsoid terrain.\n' +
      'Get a free token at https://ion.cesium.com and add it to .env.local to enable 3D terrain.'
    );
    return new Cesium.EllipsoidTerrainProvider();
  }

  try {
    Cesium.Ion.defaultAccessToken = token;
    // Asset ID 1 = Cesium World Terrain (global, free tier)
    return await Cesium.CesiumTerrainProvider.fromIonAssetId(1, {
      requestVertexNormals: true,  // enables terrain lighting (shaded slopes)
      requestWaterMask: true,      // ocean animated water surface
    });
  } catch (e) {
    console.warn('[GlobeRenderer] World Terrain failed, falling back to ellipsoid:', e.message);
    return new Cesium.EllipsoidTerrainProvider();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GlobeRenderer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GlobeRenderer — wraps CesiumJS into a clean interface.
 *
 * Quality upgrades in this version:
 *  - Cesium World Terrain via ion (real elevation; free tier)
 *  - NASA Black Marble city lights layer (visible on night side)
 *  - Tuned atmosphere: vivid blue limb glow, realistic haze
 *  - Stronger sun lighting contrast — globe reads as a sphere in space
 *  - Bloom: atmospheric limb + city lights get cinematic glow
 *  - requestRenderMode managed dynamically: idle=true, animations=false
 *  - High-DPI rendering at native pixel ratio
 *  - ESRI satellite at close zoom (zoom 9+)
 *
 * SETUP: add VITE_CESIUM_ION_TOKEN=<your_token> to .env.local
 * Free token: https://ion.cesium.com (no credit card required)
 */
export class GlobeRenderer {
  /**
   * @param {string} containerId - DOM id of the mount element
   */
  constructor(containerId) {
    this._container = document.getElementById(containerId);
    if (!this._container) throw new Error(`[GlobeRenderer] #${containerId} not found`);

    // Track how many animations are running — drives requestRenderMode toggling
    this._activeAnimationCount = 0;

    // Viewer created async after terrain loads — see init()
    this.viewer = null;
    this._scene = null;
    this._globe = null;
    this._bloom = null;
    this._baseLayer = null;
    this._nightLayer = null;
    this._esriLayer = null;
    this._updateImageryDetail = null;
    this._chapterNightAlpha = 1.0;
  }

  /**
   * Async init — must be awaited before any other method is called.
   * Separated from constructor because terrain loading is async.
   *
   * @returns {Promise<void>}
   */
  async init() {
    const [terrain, esriProvider] = await Promise.all([
      createTerrainProvider(),
      createEsriProvider(),
    ]);

    this.viewer = new Cesium.Viewer(this._container, {
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
      vrButton: false,
      creditContainer: document.createElement('div'),
      baseLayer: false,
      terrainProvider: terrain,
      // Start in requestRenderMode to save GPU when idle.
      // Switched off automatically during active simulations.
      requestRenderMode: true,
      maximumRenderTimeChange: Infinity,
      // 4x MSAA — sharper edges on all geometry
      msaaSamples: 4,
    });

    // HIGH-DPI: render at native pixel ratio (capped to avoid 4K GPU overload)
    this.viewer.resolutionScale = Math.min(window.devicePixelRatio || 1, 2.5);

    // Fix clock to June solstice noon (23.5°N sub-solar point).
    // The camera faces Africa/Europe which is well-lit at this time.
    // Night side + terminator remain visible when rotating.
    this.viewer.clock.currentTime = Cesium.JulianDate.fromDate(
      new Date('2024-06-21T12:00:00Z')
    );

    this._scene = this.viewer.scene;
    this._globe = this._scene.globe;

    // ── Imagery stack (bottom → top) ──────────────────────────────────────
    // Layer 0: ESRI — sharp satellite at all zoom levels (0–19)
    this._esriLayer = this.viewer.imageryLayers.addImageryProvider(esriProvider);

    // Layer 1: Blue Marble — stylized global view; fades out when zooming in
    this._baseLayer = this.viewer.imageryLayers.addImageryProvider(createBlueMarbleProvider());

    // Layer 1: Black Marble (city lights).
    // colorToAlpha makes near-black pixels transparent so only city lights show.
    // Wrapped in try/catch — GIBS tile 400s are non-fatal; the app works fine
    // with ESRI + Blue Marble if this layer is unavailable.
    try {
      this._nightLayer = this.viewer.imageryLayers.addImageryProvider(createBlackMarbleProvider());
      this._nightLayer.alpha                  = 1.0;
      this._nightLayer.brightness             = 3.0;
      this._nightLayer.contrast               = 2.0;
      this._nightLayer.colorToAlpha           = new Cesium.Color(0, 0, 0, 1);
      this._nightLayer.colorToAlphaThreshold  = 0.1;
    } catch (e) {
      console.warn('[GlobeRenderer] Black Marble layer unavailable, skipping:', e.message);
      this._nightLayer = null;
    }

    // Fade Blue Marble / night lights as the camera moves in so ESRI detail shows through
    this._chapterNightAlpha = 1.0;
    this._updateImageryDetail = () => this._applyImageryDetailForCamera();
    this.viewer.camera.changed.addEventListener(this._updateImageryDetail);
    this._applyImageryDetailForCamera();

    // ── Visual setup ──────────────────────────────────────────────────────
    this._applyStylizedDefaults();
    this._addBloom();
    this._addGlobalClouds();
    this.applyChapterAesthetic(2025);

    this.viewer.resize();
  }

  // ── Bloom ──────────────────────────────────────────────────────────────────

  /**
   * Bloom post-process: atmospheric limb, city lights, and bright ocean
   * get a cinematic soft glow. Kept subtle so it doesn't over-saturate.
   */
  _addBloom() {
    try {
      const bloom = this._scene.postProcessStages.add(
        Cesium.PostProcessStageLibrary.createBloomStage()
      );
      // High contrast = bloom only fires on very bright pixels (limb, city lights).
      // Negative brightness = raises the threshold further — no muddy global glow.
      bloom.uniforms.contrast   = 150;
      bloom.uniforms.brightness = -0.2;
      bloom.uniforms.glowOnly   = false;
      bloom.uniforms.delta      = 1.0;
      bloom.uniforms.sigma      = 2.5;  // slightly wider spread vs before
      bloom.uniforms.stepSize   = 1.0;
      bloom.enabled = true;
      this._bloom = bloom;
    } catch (e) {
      console.warn('[GlobeRenderer] Bloom unavailable:', e.message);
      this._bloom = null;
    }
  }

  // ── Global cloud layer ─────────────────────────────────────────────────────

  /**
   * Scatter ~30 cumulus cloud puffs at realistic tropospheric altitudes
   * using CesiumJS CloudCollection. Clouds are positioned pseudo-randomly
   * along real weather-belt latitudes (ITCZ, mid-lat cyclones, polar fronts).
   * They rotate imperceptibly slowly — enough to feel alive, not cartoon.
   *
   * CloudCollection is supported from CesiumJS 1.83+.
   */
  _addGlobalClouds() {
    try {
      /** @type {Cesium.CloudCollection} */
      const clouds = new Cesium.CloudCollection();

      // [lon, lat, altKm, scaleKm, brightness]
      const CLOUD_DEF = [
        // ITCZ band (±10°)
        [-30,  8, 9, 500, 0.82],  [-65,  5, 8, 420, 0.78],
        [ 15, -4, 9, 480, 0.80],  [ 60,  6, 8, 390, 0.75],
        [100,  3, 9, 450, 0.79],  [145, -7, 8, 410, 0.77],
        [-120, 9, 9, 370, 0.80],  [-80, -5, 8, 430, 0.76],
        // N hemisphere mid-latitudes (35–60°)
        [-40, 48, 7, 350, 0.72],  [-10, 52, 7, 320, 0.70],
        [ 20, 45, 7, 380, 0.74],  [ 75, 55, 7, 310, 0.69],
        [130, 42, 7, 360, 0.73],  [-90, 38, 7, 340, 0.71],
        [-160,50, 7, 290, 0.68],  [ 50, 58, 7, 330, 0.70],
        // S hemisphere mid-latitudes (35–55°S)
        [-50,-42, 7, 380, 0.72],  [-100,-48, 7, 410, 0.74],
        [ 10,-44, 7, 350, 0.70],  [ 90,-50, 7, 365, 0.71],
        [165,-40, 7, 320, 0.69],  [-170,-45, 7, 345, 0.72],
        // Subtropical ridges — thinner, brighter
        [-25, 25, 6, 220, 0.88],  [ 35, 28, 6, 200, 0.86],
        [ 80, 22, 6, 210, 0.87],  [160, 20, 6, 190, 0.85],
        [-70,-18, 6, 215, 0.87],  [-140,  17, 6, 205, 0.86],
        // Polar fronts
        [-20, 68, 6, 280, 0.66],  [ 95, 72, 6, 260, 0.65],
        [-60,-62, 6, 270, 0.65],
      ];

      for (const [lon, lat, altKm, scaleKm, bright] of CLOUD_DEF) {
        clouds.add({
          position: Cesium.Cartesian3.fromDegrees(lon, lat, altKm * 1000),
          scale: new Cesium.Cartesian2(scaleKm * 1000, scaleKm * 350),
          maximumSize: new Cesium.Cartesian3(
            scaleKm * 1000, scaleKm * 350, scaleKm * 250),
          slice: 0.36,
          brightness: bright,
        });
      }

      this._scene.primitives.add(clouds);
      this._clouds = clouds;
    } catch (e) {
      console.warn('[GlobeRenderer] CloudCollection unavailable:', e.message);
      this._clouds = null;
    }
  }

  // ── Chapter aesthetic ──────────────────────────────────────────────────────

  /**
   * Desaturate + dim imagery as year advances toward 2100.
   * Full color at 2025, near-monochrome at 2100.
   * Dims night lights proportionally — a dark future shouldn't glow.
   *
   * @param {number} year - Chapter year (2025–2100)
   */
  applyChapterAesthetic(year) {
    const t = Math.max(0, Math.min(1, (year - 2025) / (2100 - 2025)));
    const saturation = 1.0 - t * 0.92;
    const brightness  = 1.0 - t * 0.08;

    for (const layer of [this._baseLayer, this._esriLayer]) {
      if (!layer) continue;
      layer.saturation = saturation;
      layer.brightness  = brightness;
    }

    // Night lights fade as the world becomes a darker future
    if (this._nightLayer) {
      this._chapterNightAlpha = 1.0 - t * 0.6;
      this._nightLayer.brightness = 3.0  - t * 1.5;
      this._applyImageryDetailForCamera();
    }

    this._scene.skyAtmosphere.saturationShift = -t * 0.25;
    this._scene.skyAtmosphere.brightnessShift  =  t * 0.05;

    if (this._bloom) {
      this._bloom.uniforms.brightness = -0.2 + t * 0.15;
    }

    this._scene.requestRender();
  }

  // ── Imagery LOD (camera distance) ───────────────────────────────────────

  /**
   * Blue Marble maxes at zoom 8 — upscaled tiles look blocky when zoomed in.
   * Fade it (and night lights) out as altitude drops so ESRI satellite stays sharp.
   */
  _applyImageryDetailForCamera() {
    if (!this.viewer) return;

    const height = this.viewer.camera.positionCartographic.height;
    // 1 = global view, 0 = close zoom (~100 km floor)
    const farBlend = Cesium.Math.clamp((height - 8e5) / (1.2e7 - 8e5), 0, 1);

    if (this._baseLayer) {
      this._baseLayer.alpha = farBlend * 0.92;
      this._baseLayer.show = farBlend > 0.02;
    }

    if (this._nightLayer) {
      this._nightLayer.alpha = farBlend * this._chapterNightAlpha;
      this._nightLayer.show = farBlend > 0.02;
    }

    this._scene.requestRender();
  }

  // ── Render mode management ─────────────────────────────────────────────────

  /**
   * Call when a simulation animation starts.
   * Disables requestRenderMode so particles/shaders update every frame.
   */
  beginAnimation() {
    this._activeAnimationCount++;
    if (this._scene) this._scene.requestRenderMode = false;
  }

  /**
   * Call when a simulation animation ends.
   * Re-enables requestRenderMode once all animations are done (saves GPU).
   */
  endAnimation() {
    this._activeAnimationCount = Math.max(0, this._activeAnimationCount - 1);
    if (this._activeAnimationCount === 0 && this._scene) {
      this._scene.requestRenderMode = true;
      this._scene.requestRender(); // flush one final frame
    }
  }

  /**
   * Safety reset — force-clears the animation counter and re-enables idle
   * render mode. Call after clearing the entire simulation stack to guarantee
   * the counter can never get stuck positive.
   */
  resetAnimationCount() {
    this._activeAnimationCount = 0;
    if (this._scene) {
      this._scene.requestRenderMode = true;
      this._scene.requestRender();
    }
  }

  // ── Stylized defaults ──────────────────────────────────────────────────────

  _applyStylizedDefaults() {
    const scene = this._scene;

    // Sun lighting + ground atmosphere — globe reads as a sphere, not a flat disc.
    // The terminator line at day/night boundary is scientifically accurate.
    this._globe.enableLighting     = true;
    this._globe.showGroundAtmosphere = true;

    // Increase atmospheric light intensity for a brighter, more saturated limb.
    // Default is 10; bumping to 15 gives the vivid blue-white edge you see in
    // ISS photography without tipping into unrealistic.
    this._globe.atmosphereLightIntensity = 15.0;
    this._globe.atmosphereRayleighCoefficient = new Cesium.Cartesian3(5.5e-6, 13.0e-6, 28.4e-6);
    this._globe.atmosphereMieCoefficient      = new Cesium.Cartesian3(21e-6, 21e-6, 21e-6);
    this._globe.atmosphereMieAnisotropy       = 0.9;  // tighter forward scattering (sundog effect)

    // SSE: lower = finer terrain + imagery tile selection
    this._globe.maximumScreenSpaceError = 1.2;
    this._globe.tileCacheSize = 500;

    scene.fog.enabled = false;  // fog muddies deep-space globe look

    // Sky atmosphere: vivid blue limb, slightly brighter than stock.
    scene.skyAtmosphere.show             = true;
    scene.skyAtmosphere.hueShift         = 0.0;   // keep Earth-blue
    scene.skyAtmosphere.saturationShift  = 0.15;  // more vivid
    scene.skyAtmosphere.brightnessShift  = 0.1;   // brighter limb glow

    // Light intensity on scene — stronger contrast between lit/shadow face
    scene.light = new Cesium.SunLight();

    scene.skyBox.show = true;
    // FXAA: smooth tile seams and label edges; cheap at idle
    scene.postProcessStages.fxaa.enabled = true;

    // Camera: start pulled back to full-globe view; allow zoom to ~100km altitude
    this.viewer.scene.screenSpaceCameraController.minimumZoomDistance = 1e5;
    this.viewer.scene.screenSpaceCameraController.maximumZoomDistance = 2.2e7;

    this.viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(10, 20, 2e7),
    });
  }

  // ── Public helpers ─────────────────────────────────────────────────────────

  resize() {
    this.viewer?.resize();
  }

  flyToISO(iso) {
    if (!this.viewer) return;
    const c = getCentroid(iso);
    if (!c) {
      console.warn('[GlobeRenderer] flyToISO: no centroid for', iso);
      return;
    }
    this.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(c.lon, c.lat, 1_800_000),
      duration: 1.8,
      easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
    });
  }

  destroy() {
    if (this._updateImageryDetail && this.viewer) {
      this.viewer.camera.changed.removeEventListener(this._updateImageryDetail);
    }
    if (this._clouds && this._scene) {
      try { this._scene.primitives.remove(this._clouds); } catch (_) {}
    }
    this.viewer?.destroy();
  }
}
