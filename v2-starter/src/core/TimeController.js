import { EventBus } from './EventBus.js';

/**
 * TimeController - manages chapter state and SSP pathway.
 *
 * The single source of truth for "when" the simulation is set.
 * All layers listen to `time:changed` via EventBus - they never
 * read TimeController directly.
 */

/** @type {readonly number[]} */
export const CHAPTERS = Object.freeze([2025, 2050, 2075, 2100]);

/** @type {readonly string[]} */
export const SSP_PATHWAYS = Object.freeze(['SSP2-4.5', 'SSP5-8.5']);

/** Human-readable chapter metadata */
export const CHAPTER_META = Object.freeze({
  2025: { name: 'Today',           dataMode: 'scientific', description: 'Present-day observed data' },
  2050: { name: 'Mid-Century',     dataMode: 'scientific', description: 'High confidence CMIP6 projections' },
  2075: { name: 'Late Century',    dataMode: 'scientific', description: 'CMIP6 SSP divergence zone' },
  2100: { name: 'End of Century',  dataMode: 'scientific', description: 'CMIP6 endpoint - full projection range' },
});

export class TimeController {
  constructor() {
    /** @type {number} */
    this._year = 2025;

    /** @type {string} */
    this._ssp = 'SSP2-4.5';
  }

  /** @returns {number} */
  get year() { return this._year; }

  /** @returns {string} */
  get ssp() { return this._ssp; }

  /** @returns {typeof CHAPTER_META[keyof typeof CHAPTER_META]} */
  get chapterMeta() { return CHAPTER_META[this._year] ?? CHAPTER_META[2025]; }

  /**
   * Jump to a chapter year. Must be one of CHAPTERS.
   * @param {number} year
   */
  setChapter(year) {
    if (!CHAPTERS.includes(year)) {
      console.warn(`[TimeController] Invalid chapter year: ${year}. Valid: ${CHAPTERS.join(', ')}`);
      return;
    }
    this._year = year;
    this._emit();
  }

  /**
   * Set SSP pathway. Must be one of SSP_PATHWAYS.
   * @param {string} ssp
   */
  setSSP(ssp) {
    if (!SSP_PATHWAYS.includes(ssp)) {
      console.warn(`[TimeController] Invalid SSP: ${ssp}. Valid: ${SSP_PATHWAYS.join(', ')}`);
      return;
    }
    this._ssp = ssp;
    // Broadcast the SSP change on its own channel (TelemetryService listens here
    // to record pathway switches in the session story) AND emit time:changed so
    // data layers re-render against the new pathway.
    EventBus.emit('ssp:changed', { ssp: this._ssp });
    this._emit();
  }

  /**
   * Snap a raw slider value (any number) to the nearest chapter year.
   * Use this for smooth slider drag before committing on release.
   * @param {number} rawYear
   * @returns {number} nearest chapter year
   */
  snapToNearest(rawYear) {
    return CHAPTERS.reduce((prev, curr) =>
      Math.abs(curr - rawYear) < Math.abs(prev - rawYear) ? curr : prev
    );
  }

  _emit() {
    EventBus.emit('time:changed', { year: this._year, ssp: this._ssp });
  }
}
