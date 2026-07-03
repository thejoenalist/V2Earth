import { EventBus } from '../core/EventBus.js';

/**
 * LayerContract — base class every visualization layer must extend.
 *
 * Provides auto-wiring of EventBus events so individual layers
 * only need to implement the payload-handling methods.
 *
 * @example
 * import { LayerContract } from '../globe/LayerContract.js';
 *
 * export class ClimateLayer extends LayerContract {
 *   async load() { ... }
 *   show() { ... }
 *   hide() { ... }
 *   updateTime({ year, ssp }) { ... }
 * }
 */
export class LayerContract {
  constructor() {
    this._visible = false;

    // Auto-wire: listen for time changes and forward to updateTime.
    // Forwarded even while hidden — otherwise a layer re-shown after a
    // chapter/SSP change renders stale data. Hidden updates are cheap
    // (recoloring a non-rendered datasource).
    this._onTimeChanged = (payload) => {
      this.updateTime(payload);
    };
    EventBus.on('time:changed', this._onTimeChanged);

    // Auto-wire: hover forwarded to onHover
    this._onHover = (payload) => {
      if (this._visible) this.onHover(payload);
    };
    EventBus.on('region:hovered', this._onHover);

    // Auto-wire: selection forwarded to onSelect
    this._onSelect = (payload) => {
      if (this._visible) this.onSelect(payload);
    };
    EventBus.on('region:selected', this._onSelect);
  }

  // ── Required overrides ──────────────────────────────────────────────────

  /**
   * Load all data and GPU assets needed by this layer.
   * Called once during app bootstrap. Must be idempotent.
   * @returns {Promise<void>}
   */
  async load() {
    throw new Error(`[LayerContract] ${this.constructor.name} must implement load()`);
  }

  /**
   * Make the layer visible.
   * @returns {void}
   */
  show() {
    throw new Error(`[LayerContract] ${this.constructor.name} must implement show()`);
  }

  /**
   * Hide the layer without destroying its assets.
   * @returns {void}
   */
  hide() {
    throw new Error(`[LayerContract] ${this.constructor.name} must implement hide()`);
  }

  /**
   * Called whenever the active year or SSP pathway changes,
   * whether or not the layer is currently visible.
   * @param {{ year: number, ssp: string }} params
   * @returns {void}
   */
  updateTime({ year, ssp }) {
    throw new Error(`[LayerContract] ${this.constructor.name} must implement updateTime()`);
  }

  // ── Optional overrides ──────────────────────────────────────────────────

  /**
   * Called on region hover. Default: no-op.
   * @param {{ iso: string | null, x: number, y: number }} params
   */
  onHover({ iso, x, y }) {}  // eslint-disable-line no-unused-vars

  /**
   * Called on region click. Default: no-op.
   * @param {{ iso: string }} params
   */
  onSelect({ iso }) {}  // eslint-disable-line no-unused-vars

  // ── Utilities ───────────────────────────────────────────────────────────

  /** Remove all EventBus subscriptions. Call on teardown. */
  destroy() {
    EventBus.off('time:changed', this._onTimeChanged);
    EventBus.off('region:hovered', this._onHover);
    EventBus.off('region:selected', this._onSelect);
  }
}
