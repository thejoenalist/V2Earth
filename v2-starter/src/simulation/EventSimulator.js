/**
 * EventSimulator — manages the active simulation stack.
 *
 * RULES:
 *  - Max 3 concurrent layers (performance budget: 30fps target)
 *  - New events can layer on existing ones; CompoundEffectsResolver infers
 *    amplification relationships and surfaces them to the chat panel
 *  - eject:true on an incoming command clears the entire stack first,
 *    then optionally starts the new event clean
 *  - When the stack is full (3 layers), the oldest is evicted before adding the new one
 *  - After SIMULATION_LIFETIME_MS a sim emits simulation:decision_requested;
 *    ChatInterface prompts keep-or-clear and emits simulation:complete when the
 *    user clears it (or the grace window lapses), which triggers teardown here
 *
 * EventBus contract:
 *   Listens:  simulation:requested  { command: SimulationCommand }
 *             simulation:eject      (no payload — full clear)
 *   Emits:    simulation:layer_added    { eventType, stackDepth, compound }
 *             simulation:layer_removed  { eventType, reason }
 *             simulation:ejected        { reason }
 *             simulation:compound_detected { incomingEvent, activeEvents, compound }
 *             simulation:stack_changed  { stack: string[] }  — for UI layer indicator
 */

import { EventBus } from '../core/EventBus.js';
import { CompoundEffectsResolver } from './CompoundEffectsResolver.js';
import { ActiveSimulation } from './ActiveSimulation.js';

export const MAX_LAYERS = 3;

export class EventSimulator {
  /**
   * @param {{
   *   globeRenderer: import('../globe/GlobeRenderer.js').GlobeRenderer,
   *   timeController: import('../core/TimeController.js').TimeController
   * }} deps
   */
  constructor({ globeRenderer, timeController }) {
    this._renderer    = globeRenderer;
    this._time        = timeController;
    this._resolver    = new CompoundEffectsResolver();

    /** @type {ActiveSimulation[]} Ordered oldest→newest */
    this._stack = [];

    /** Monotonic token so a newer command cancels an in-flight SSP sweep. */
    this._sweepToken = 0;

    this._boundOnRequested = this._onRequested.bind(this);
    this._boundOnEject     = this._onEject.bind(this);
    this._boundOnComplete  = this._onComplete.bind(this);

    EventBus.on('simulation:requested', this._boundOnRequested);
    EventBus.on('simulation:eject',     this._boundOnEject);
    EventBus.on('simulation:complete',  this._boundOnComplete);
  }

  // ── Public ───────────────────────────────────────────────────────────────

  /** @returns {string[]} event types currently in the stack, oldest first */
  get activeEventTypes() {
    return this._stack.map(s => s.eventType).filter(Boolean);
  }

  /** @returns {number} */
  get depth() { return this._stack.length; }

  // ── Private ──────────────────────────────────────────────────────────────

  /**
   * @param {import('../chat/SimulationCommand.js').SimulationCommand} command
   */
  async _onRequested(command) {
    // Crisis carve-out: never touch the globe or clear layers.
    if (command?.type === 'support') return;

    const incomingEvent = command.params?.eventType ?? command.event ?? null;

    if (command.eject === true) {
      this._clearStack('user_requested');
      if (!incomingEvent) return;
    }

    // timeline_jump: the chapter is already snapped by ChatInterface (it sets
    // TimeController.year before emitting simulation:requested). All we add here
    // is camera framing when the query named a place.
    if (command.type === 'timeline_jump') {
      if (command.target) this._renderer.flyToISO?.(command.target);
      return;
    }

    // scenario_compare: frame the region, then sweep the pathway
    // SSP2-4.5 → SSP5-8.5 so any active data layer, the open CountryPanel, the
    // SSP toggle, and the session story all re-render against the worse case.
    // The numeric delta card is rendered separately by ChatInterface from baked
    // climate.json (rule #4 — the LLM never supplies these numbers).
    if (command.type === 'scenario_compare') {
      if (command.target) this._renderer.flyToISO?.(command.target);
      await this._sweepSSP();
      return;
    }

    // region_inspect: fly the camera to the country and open the inspector
    // panel — same event RegionPicker emits on a direct globe click.
    if (command.type === 'region_inspect' && command.target) {
      this._renderer.flyToISO?.(command.target);
      EventBus.emit('region:selected', {
        iso: command.target,
        name: null,
        coords: null,
      });
      return;
    }

    if (command.type !== 'climate_event' || !incomingEvent) return;

    // ── Step 2: resolve compound effects before modifying the stack ─────────
    let compound = null;

    if (this._stack.length > 0 && incomingEvent) {
      compound = this._resolver.resolve(this.activeEventTypes, incomingEvent);
      if (compound) {
        EventBus.emit('simulation:compound_detected', {
          incomingEvent,
          activeEvents: this.activeEventTypes,
          compound,
        });
      }
    }

    // ── Step 3: enforce layer cap — evict oldest if full ───────────────────
    if (this._stack.length >= MAX_LAYERS) {
      const evicted = this._stack.shift();
      const evictedType = evicted.eventType;
      this._destroySim(evicted);
      EventBus.emit('simulation:layer_removed', {
        eventType: evictedType,
        reason: 'stack_full',
      });
    }

    // ── Step 4: create and start the new simulation ────────────────────────
    const sim = new ActiveSimulation({
      command,
      compound,
      viewer: this._renderer.viewer,
      year:   this._time.year,
      ssp:    this._time.ssp,
      stackIndex: this._stack.length,
    });

    this._stack.push(sim);
    this._emitStackChanged();

    // Tell the globe to disable requestRenderMode so particles/shaders animate.
    // Paired endAnimation() calls happen in _destroySim().
    this._renderer.beginAnimation?.();

    try {
      await sim.start();
      EventBus.emit('simulation:layer_added', {
        eventType:  incomingEvent,
        stackDepth: this._stack.length,
        compound:   compound ?? null,
      });
    } catch (err) {
      console.error('[EventSimulator] Simulation failed to start:', err);
      const idx = this._stack.indexOf(sim);
      if (idx !== -1) this._stack.splice(idx, 1);
      this._destroySim(sim);
      this._emitStackChanged();
    }
  }

  /**
   * SSP sweep for scenario_compare: animate the pathway low→high. Each setSSP
   * fires ssp:changed + time:changed, so active data layers, the open
   * CountryPanel, the SSP toggle UI, and telemetry all follow. The sweep settles
   * on SSP5-8.5 — the divergence the user asked to see; the delta card makes the
   * exact gap explicit. Token-guarded so a newer command cancels a stale sweep.
   */
  async _sweepSSP() {
    const token = ++this._sweepToken;
    this._time.setSSP('SSP2-4.5');
    await new Promise((resolve) => setTimeout(resolve, 2200));
    if (token !== this._sweepToken) return; // superseded by a newer command
    this._time.setSSP('SSP5-8.5');
  }

  /** Eject triggered directly via EventBus (e.g. from UI button) */
  _onEject() {
    this._clearStack('user_requested');
  }

  /**
   * A simulation reached its natural lifetime (emitted by ActiveSimulation).
   * Wind it down and update the stack.
   * @param {{ commandId: string, eventType: string|null }} payload
   */
  _onComplete({ commandId }) {
    const idx = this._stack.findIndex(s => s.command?.id === commandId);
    if (idx === -1) return; // already evicted/ejected
    const [sim] = this._stack.splice(idx, 1);
    const eventType = sim.eventType;
    this._destroySim(sim);
    EventBus.emit('simulation:layer_removed', { eventType, reason: 'completed' });
    this._emitStackChanged();
  }

  /**
   * Destroy one simulation and release its animation hold on the globe renderer.
   * Always use this instead of calling sim.destroy() directly.
   * @param {ActiveSimulation} sim
   */
  _destroySim(sim) {
    sim.destroy();
    this._renderer.endAnimation?.();
  }

  /**
   * @param {string} reason
   */
  _clearStack(reason = 'unknown') {
    for (const sim of this._stack) this._destroySim(sim);
    this._stack = [];
    // Safety net: force-reset animation counter so requestRenderMode can never
    // get stuck off if a sim crashed before calling endAnimation.
    this._renderer.resetAnimationCount?.();
    this._emitStackChanged();
    EventBus.emit('simulation:ejected', { reason });
  }

  _emitStackChanged() {
    EventBus.emit('simulation:stack_changed', { stack: this.activeEventTypes });
  }

  destroy() {
    this._clearStack('destroyed');
    EventBus.off('simulation:requested', this._boundOnRequested);
    EventBus.off('simulation:eject',     this._boundOnEject);
    EventBus.off('simulation:complete',  this._boundOnComplete);
  }
}
