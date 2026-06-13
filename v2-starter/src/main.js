/**
 * Earth Simulator V2 — main entry point.
 *
 * Responsibilities:
 *  1. Boot core modules (EventBus is a singleton, no init needed)
 *  2. Initialize GlobeRenderer
 *  3. Wire TimeController → chapter timeline UI
 *  4. Wire SSP toggle UI
 *  5. Dismiss onboarding
 *  6. Bootstrap is deliberately thin — heavy work belongs in modules
 *
 * If main.js grows past ~150 lines, extract to a dedicated AppController.
 */

import { EventBus } from './core/EventBus.js';
import { TimeController, CHAPTERS, CHAPTER_META } from './core/TimeController.js';
import { GlobeRenderer } from './globe/GlobeRenderer.js';

// ── Instantiate core ────────────────────────────────────────────────────────

const timeController = new TimeController();
window.__timeController = timeController; // Debug access only

const globeRenderer = new GlobeRenderer(document.getElementById('cesium-container'));
window.__globeRenderer = globeRenderer;

// ── Onboarding ──────────────────────────────────────────────────────────────

document.getElementById('onboarding-start')?.addEventListener('click', () => {
  document.getElementById('onboarding')?.classList.add('hidden');
});

// ── Chapter timeline ────────────────────────────────────────────────────────

function buildTimeline() {
  const track = document.getElementById('timeline-track');
  if (!track) return;

  const positions = CHAPTERS.map((_, i) => (i / (CHAPTERS.length - 1)) * 100);

  CHAPTERS.forEach((year, i) => {
    const meta = CHAPTER_META[year];
    const pct = positions[i];

    const stop = document.createElement('div');
    stop.className = 'chapter-stop';
    stop.style.left = `${pct}%`;
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

  // Mark first stop active
  updateActiveChapter(2025);
}

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

buildTimeline();

// ── SSP toggle ──────────────────────────────────────────────────────────────

document.querySelectorAll('.ssp-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.ssp-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    timeController.setSSP(btn.dataset.ssp);
  });
});

// ── Layer selector ──────────────────────────────────────────────────────────

document.querySelectorAll('.layer-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.layer-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    EventBus.emit('layer:changed', { layerId: btn.dataset.layer });
  });
});

// ── EventBus listeners ──────────────────────────────────────────────────────

EventBus.on('time:changed', ({ year }) => {
  updateActiveChapter(year);
  globeRenderer.applyChapterAesthetic(year);
});

// ── Resize ──────────────────────────────────────────────────────────────────

window.addEventListener('resize', () => globeRenderer.resize());
