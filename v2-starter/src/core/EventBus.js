/**
 * EventBus — central nervous system for Earth Simulator V2.
 *
 * All inter-module communication flows through here.
 * No module should import another module's internals — use events instead.
 *
 * @example
 * import { EventBus } from '../core/EventBus.js';
 * EventBus.on('time:changed', ({ year, ssp }) => { ... });
 * EventBus.emit('time:changed', { year: 2075, ssp: 'SSP5-8.5' });
 */

/** @type {Map<string, Set<Function>>} */
const _listeners = new Map();

export const EventBus = {
  /**
   * Subscribe to an event.
   * @param {string} event
   * @param {Function} handler
   */
  on(event, handler) {
    if (!_listeners.has(event)) _listeners.set(event, new Set());
    _listeners.get(event).add(handler);
  },

  /**
   * Unsubscribe from an event.
   * @param {string} event
   * @param {Function} handler
   */
  off(event, handler) {
    _listeners.get(event)?.delete(handler);
  },

  /**
   * Emit an event synchronously to all subscribers.
   * @param {string} event
   * @param {*} payload
   */
  emit(event, payload) {
    const handlers = _listeners.get(event);
    if (!handlers) return;
    for (const h of handlers) {
      try { h(payload); }
      catch (err) { console.error(`[EventBus] Error in handler for "${event}":`, err); }
    }
  },

  /** Remove all listeners. Useful for tests. */
  clear() {
    _listeners.clear();
  },
};

/**
 * Event taxonomy — all valid event names.
 * Update this list as new events are added.
 *
 * time:changed         { year: number, ssp: string }
 * region:selected      { iso: string, name: string|null, coords: {lat,lon}|null }
 * region:hovered       { iso: string | null }
 * region:cleared       {}  — CountryPanel closed; RegionPicker drops highlight
 * layer:changed        { layerId: string }
 * ssp:changed          { ssp: string }
 * simulation:requested SimulationCommand (see SimulationCommand.js)
 * simulation:complete  { commandId: string }
 * chat:query           { text: string, sessionId: string }
 * session:start        { sessionId: string }
 * consent:changed      { granted: boolean }  — ConsentState → TelemetryService
 * report:export_requested  { type: string, report: object, context?: object }  → ExportService
 */
