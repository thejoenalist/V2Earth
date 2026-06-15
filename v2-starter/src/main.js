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
import { TelemetryService } from './analytics/TelemetryService.js';

/** Session ID for telemetry — imported by TelemetryService in Milestone 5. */
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

document.getElementById('onboarding-start')?.addEventListener('click', () => {
  document.getElementById('onboarding')?.classList.add('hidden');
});

// ── Async boot — waits for terrain before creating Viewer ────────────────────
(async () => {
  const globeRenderer = new GlobeRenderer('cesium-container');
  await globeRenderer.init();   // terrain loads here; Viewer created inside

  const eventSimulator = new EventSimulator({ globeRenderer, timeController });
  const chatInterface = new ChatInterface({ timeController, sessionId });

  // TelemetryService wires its own EventBus listeners internally.
  // Wrapped in try/catch so a Supabase config error never blocks globe boot.
  try {
    new TelemetryService();
  } catch (err) {
    console.warn('[main] TelemetryService failed to initialize:', err.message);
  }

  /** @type {import('./globe/LayerContract.js').LayerContract | null} */
  let activeDataLayer = null;

  const temperatureLayer = new TemperatureLayer(globeRenderer.viewer);
  temperatureLayer.load().then(() => {
    const activeBtn = document.querySelector('.layer-btn.active');
    if (activeBtn?.dataset.layer === 'temperature') {
      temperatureLayer.show();
      activeDataLayer = temperatureLayer;
    }
  }).catch((err) => console.error('[main] TemperatureLayer load failed:', err));

  function wireLayerSelector() {
    document.querySelectorAll('.layer-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.layer-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');

        if (activeDataLayer) {
          activeDataLayer.hide();
          activeDataLayer = null;
        }

        const layerId = btn.dataset.layer;
        if (layerId === 'temperature') {
          temperatureLayer.show();
          activeDataLayer = temperatureLayer;
        }

        EventBus.emit('layer:changed', { layerId });
      });
    });
  }

  wireLayerSelector();

  EventBus.on('time:changed', ({ year }) => {
    updateActiveChapter(year);
    globeRenderer.applyChapterAesthetic(year);
  });

  globeRenderer.applyChapterAesthetic(timeController.year);
  window.addEventListener('resize', () => globeRenderer.resize());

  EventBus.emit('session:start', { sessionId });
})().catch((err) => {
  console.error('[main] Boot failed:', err);
});
