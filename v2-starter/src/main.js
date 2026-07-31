/**
 * Earth Simulator V2 — main entry point.
 *
 * Thin orchestrator: boots core modules, wires timeline + SSP UI to TimeController,
 * and syncs globe aesthetic on time:changed.
 *
 * GlobeRenderer.init() is async (terrain loads before Viewer creation), so the
 * boot sequence is wrapped in an async IIFE. Everything that needs globeRenderer.viewer
 * runs inside that IIFE after await.
 */

import 'cesium/Build/Cesium/Widgets/widgets.css';

import { EventBus } from './core/EventBus.js';
import { TimeController, CHAPTERS, CHAPTER_META } from './core/TimeController.js';
import { GlobeRenderer } from './globe/GlobeRenderer.js';
import { EventSimulator } from './simulation/EventSimulator.js';
import { ChatInterface } from './chat/ChatInterface.js';
import { TemperatureLayer } from './layers/TemperatureLayer.js';
import { SeaLevelLayer } from './layers/SeaLevelLayer.js';
import { PrecipitationLayer } from './layers/PrecipitationLayer.js';
import { TelemetryService } from './analytics/TelemetryService.js';
import { ExportService } from './export/ExportService.js';
import { RegionPicker } from './globe/RegionPicker.js';
import { CountryPanel } from './ui/CountryPanel.js';
import { ConsentBanner } from './ui/ConsentBanner.js';
import { AttributionModal } from './ui/AttributionModal.js';

/** App-wide session ID — shared by ChatInterface and TelemetryService. */
export let sessionId = crypto.randomUUID();

// ── Non-globe modules boot synchronously ──────────────────────────────────────
const timeController = new TimeController();

// ── UI helpers (no globe dependency) ─────────────────────────────────────────

function updateActiveChapter(year) {
  document.querySelectorAll('.chapter-stop').forEach((el) => {
    el.classList.toggle('active', Number(el.dataset.year) === year);
  });

  const i = CHAPTERS.indexOf(year);
  const pct = i >= 0 ? (i / (CHAPTERS.length - 1)) * 100 : 0;
  const fill = document.getElementById('timeline-fill');
  if (fill) fill.style.width = `${pct}%`;

  const label = document.getElementById('chapter-label');
  if (label) label.textContent = CHAPTER_META[year]?.name ?? '';
}

function buildTimeline() {
  const track = document.getElementById('timeline-track');
  if (!track) return;

  const positions = CHAPTERS.map((_, i) => (i / (CHAPTERS.length - 1)) * 100);

  CHAPTERS.forEach((year, i) => {
    const meta = CHAPTER_META[year];
    const stop = document.createElement('div');
    stop.className = 'chapter-stop';
    stop.style.left = `${positions[i]}%`;
    stop.dataset.year = String(year);
    stop.title = `${meta.name} — ${meta.description}`;

    const dot = document.createElement('div');
    dot.className = 'chapter-dot';

    const label = document.createElement('div');
    label.className = 'chapter-stop-label';
    label.textContent = meta.name;

    const yearLabel = document.createElement('div');
    yearLabel.className = 'chapter-stop-year';
    yearLabel.textContent = year === 2025 ? 'Today' : String(year);

    stop.append(dot, label, yearLabel);
    stop.addEventListener('click', () => timeController.setChapter(year));
    track.appendChild(stop);
  });
}

function wireSSPToggle() {
  document.querySelectorAll('[data-ssp]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-ssp]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      timeController.setSSP(btn.dataset.ssp);
    });
  });
}

buildTimeline();
wireSSPToggle();
updateActiveChapter(timeController.year);

// Consent banner + attribution modal — pure UI, no globe dependency.
// ConsentBanner is constructed early so its wiring exists before
// TelemetryService starts buffering, but the banner itself only appears
// after onboarding is dismissed (otherwise it covers Explore the Earth).
// Onboarding dismiss itself is handled by public/onboarding-boot.js so the
// button works before this Cesium-heavy module finishes loading.
const consentBanner = new ConsentBanner();
new AttributionModal();

function revealConsentAfterOnboarding() {
  consentBanner.revealIfNeeded();
}
document.addEventListener('earthsim:onboarding-done', revealConsentAfterOnboarding);
// If the user clicked Explore before this module evaluated, catch up.
if (document.getElementById('onboarding')?.classList.contains('hidden')) {
  revealConsentAfterOnboarding();
}

// ── Async boot — waits for terrain before creating Viewer ────────────────────
(async () => {
  const globeRenderer = new GlobeRenderer('cesium-container');
  await globeRenderer.init();   // terrain loads here; Viewer created inside

  const eventSimulator = new EventSimulator({ globeRenderer, timeController });
  const chatInterface = new ChatInterface({ timeController, sessionId });

  // ExportService listens for report:export_requested and renders the
  // download-ready document. No globe dependency, so it boots unconditionally.
  const exportService = new ExportService();

  // Region interaction: click picking on the globe + slide-in country panel.
  const countryPanel = new CountryPanel({ timeController });
  const regionPicker = new RegionPicker(globeRenderer.viewer);
  regionPicker.load().catch((err) =>
    console.error('[main] RegionPicker load failed:', err));

  // TelemetryService wires its own EventBus listeners internally.
  // Wrapped in try/catch so a Supabase config error never blocks globe boot.
  try {
    new TelemetryService({ sessionId });
  } catch (err) {
    console.warn('[main] TelemetryService failed to initialize:', err.message);
  }

  /** @type {import('./globe/LayerContract.js').LayerContract | null} */
  let activeDataLayer = null;

  // Data layer registry — matches the data-layer attributes in index.html.
  // All layers are OFF by default (user call 2026-07-12: fills obstruct the
  // prompt-driven renders) and lazy-load on first click. Clicking the active
  // button toggles it off. While a simulation is on the globe, any active
  // fill auto-hides and comes back when the stack empties.
  const dataLayers = {
    temperature:   new TemperatureLayer(globeRenderer.viewer),
    sea_level:     new SeaLevelLayer(globeRenderer.viewer),
    precipitation: new PrecipitationLayer(globeRenderer.viewer),
  };

  // True while a simulation render is active — data layer fills stay hidden.
  let dataLayerSuppressed = false;

  function wireLayerSelector() {
    document.querySelectorAll('.layer-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const layerId = btn.dataset.layer;
        const wasActive = btn.classList.contains('active');

        document.querySelectorAll('.layer-btn').forEach((b) => b.classList.remove('active'));
        if (activeDataLayer) {
          activeDataLayer.hide();
          activeDataLayer = null;
        }

        // Toggle off: clicking the active button leaves everything hidden.
        if (wasActive) {
          EventBus.emit('layer:changed', { layerId: null });
          return;
        }

        btn.classList.add('active');
        const layer = dataLayers[layerId];
        if (layer) {
          try {
            await layer.load();
            // Guard against a stale click racing a slower load
            if (btn.classList.contains('active')) {
              activeDataLayer = layer;
              if (!dataLayerSuppressed) layer.show();
            }
          } catch (err) {
            console.error(`[main] ${layerId} layer load failed:`, err);
          }
        }

        EventBus.emit('layer:changed', { layerId });
      });
    });
  }

  wireLayerSelector();

  // Auto-hide the active fill while simulations own the globe.
  EventBus.on('simulation:stack_changed', ({ stack }) => {
    const simsActive = (stack?.length ?? 0) > 0;
    if (simsActive && !dataLayerSuppressed) {
      dataLayerSuppressed = true;
      activeDataLayer?.hide();
    } else if (!simsActive && dataLayerSuppressed) {
      dataLayerSuppressed = false;
      activeDataLayer?.show();
    }
  });

  EventBus.on('time:changed', ({ year }) => {
    updateActiveChapter(year);
    globeRenderer.applyChapterAesthetic(year);
  });

  // Cinematic city close-up (VISUAL_UPGRADE_PLAN F5): flagship renders ask for
  // it mid-simulation; the globe owns the camera + OSM Buildings toggle.
  // Any layer teardown restores the global view contract.
  EventBus.on('camera:closeup_requested', ({ lon, lat }) => {
    globeRenderer.cityCloseUp(lon, lat).catch((err) =>
      console.warn('[main] cityCloseUp failed:', err.message));
  });
  EventBus.on('simulation:layer_removed', () => globeRenderer.exitCloseUp());
  EventBus.on('simulation:ejected',       () => globeRenderer.exitCloseUp());

  globeRenderer.applyChapterAesthetic(timeController.year);
  window.addEventListener('resize', () => globeRenderer.resize());

  EventBus.emit('session:start', { sessionId });
})().catch((err) => {
  console.error('[main] Boot failed:', err);
});
