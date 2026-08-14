/**
 * PromptChips — suggested chat prompts above the input.
 *
 * Two authored static pools (never model output):
 *   IDLE   — entry points across events + command types; biased to flagship metros
 *   ACTIVE — compound / follow-up prompts when a simulation is already on the stack
 *
 * Pool swaps on simulation:stack_changed. Shows 4 sampled chips + a shuffle control.
 * Picks route through ChatInterface._handleSubmit (typed-input path).
 *
 * City chips draw ONLY from FLAGSHIP_METROS (InundationGeodata). A suggested
 * prompt is a promise that the result is worth seeing — the generic ellipse is
 * an honest fallback, not a demo. Users can still type any city in the input.
 *
 * That metro rule applies only to chips that name a city. Country / region /
 * non-place chips (e.g. "Wildfire · Australia", "Jump to 2100") are
 * discoverability entry points, not geodata demos — do not hold them to
 * FLAGSHIP_METROS.
 */

import { EventBus } from '../core/EventBus.js';

/**
 * @typedef {{ id: string, label: string, text: string }} ChipPrompt
 */

/** Entry-point prompts — discover events + SimulationCommand types. */
const IDLE_PROMPTS = Object.freeze(/** @type {ChipPrompt[]} */ ([
  // Flagship metros with baked geodata (SLR / hurricane)
  { id: 'idle-slr-miami',       label: 'Sea level · Miami',        text: 'Show sea level rise in Miami by 2050' },
  { id: 'idle-hur-nola',        label: 'Hurricane · New Orleans',  text: 'Simulate a major hurricane hitting New Orleans' },
  { id: 'idle-slr-norfolk',     label: 'Sea level · Norfolk',      text: 'What does sea level rise look like in Norfolk by 2075?' },
  { id: 'idle-hur-shanghai',    label: 'Hurricane · Shanghai',     text: 'Show a hurricane near Shanghai' },
  { id: 'idle-slr-lagos',       label: 'Sea level · Lagos',        text: 'Sea level rise in Lagos by 2100' },
  { id: 'idle-slr-rotterdam',   label: 'Sea level · Rotterdam',    text: 'How does sea level rise affect Rotterdam by 2050?' },
  { id: 'idle-hur-houston',     label: 'Hurricane · Houston',      text: 'Hurricane landfall near Houston' },
  { id: 'idle-hur-dhaka',       label: 'Hurricane · Dhaka',        text: 'Show a hurricane near Dhaka' },

  // Other ready-tier events
  { id: 'idle-heat-india',      label: 'Heatwave · India',         text: 'Show a severe heatwave in India in 2050' },
  { id: 'idle-drought-sahel',   label: 'Drought · Sahel',          text: 'Visualize drought across the Sahel in 2075' },
  { id: 'idle-fire-australia',  label: 'Wildfire · Australia',     text: 'Wildfire in Australia' },
  { id: 'idle-conflict-syria',  label: 'Conflict · climate stress', text: 'How does climate stress relate to conflict risk in Syria?' },

  // Schema / noted events (discoverability)
  { id: 'idle-flood-bangladesh', label: 'Flood · Bangladesh',      text: 'Show flooding in Bangladesh' },
  { id: 'idle-quake-chile',     label: 'Earthquake · Chile',       text: 'Earthquake in Chile — frame the climate connection' },
  { id: 'idle-grid-texas',      label: 'Power grid · Texas',       text: 'What if the power grid fails during a heatwave in Texas?' },
  { id: 'idle-epidemic',        label: 'Epidemic outbreak',        text: 'Show an epidemic outbreak after a flood' },

  // Non-event SimulationCommand types
  { id: 'idle-compare-miami',   label: 'Compare pathways',         text: 'Compare SSP2-4.5 vs SSP5-8.5 for Miami sea level rise' },
  { id: 'idle-jump-2100',       label: 'Jump to 2100',             text: 'Take me to the year 2100' },
  { id: 'idle-local-miami',     label: 'What can I do · Miami',    text: 'What can I do about sea level rise if I live in Miami?' },
  { id: 'idle-plan-norfolk',    label: 'Resilience plan',          text: 'Build a resilience plan for Norfolk against coastal flooding' },
  { id: 'idle-inspect-bangladesh', label: 'Inspect Bangladesh',    text: 'Tell me about climate risk in Bangladesh' },
  { id: 'idle-explain-ssp',     label: 'Explain SSPs',             text: 'Explain the difference between SSP2-4.5 and SSP5-8.5' },
]));

/** Follow-ups once a simulation is active — compounds + layering. */
const ACTIVE_PROMPTS = Object.freeze(/** @type {ChipPrompt[]} */ ([
  { id: 'active-add-drought',   label: 'Add drought',              text: 'Now layer a drought on top of this' },
  { id: 'active-add-heat',      label: 'Add heatwave',             text: 'Add a heatwave to this scenario' },
  { id: 'active-add-slr',       label: 'Add sea level rise',       text: 'What if sea level rise compounds this?' },
  { id: 'active-add-fire',      label: 'Add wildfire',             text: 'Stack a wildfire on this' },
  { id: 'active-add-grid',      label: 'Add grid failure',         text: 'What if the power grid fails during this?' },
  { id: 'active-add-flood',     label: 'Add flood',                text: 'Add flooding on top of this event' },
  { id: 'active-compare',       label: 'Compare SSP paths',        text: 'Compare this under SSP2-4.5 versus SSP5-8.5' },
  { id: 'active-jump-2100',     label: 'Jump to 2100',             text: 'Jump this scenario to 2100' },
  { id: 'active-local',         label: 'What can I do here?',      text: 'What can someone living here actually do about this?' },
  { id: 'active-plan',          label: 'Resilience plan',          text: 'Build a resilience plan for this hazard and place' },
  { id: 'active-clear',         label: 'Start over',               text: 'Forget that — start over with something different' },
]));

const VISIBLE_COUNT = 4;

/**
 * Fisher–Yates shuffle (copy).
 * @template T
 * @param {readonly T[]} arr
 * @returns {T[]}
 */
function shuffled(arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

export class PromptChips {
  /**
   * @param {{
   *   container: HTMLElement,
   *   sessionId?: string|null,
   *   onPick: (text: string) => void,
   * }} opts
   */
  constructor({ container, sessionId = null, onPick }) {
    this._el = container;
    this._sessionId = sessionId;
    this._onPick = onPick;
    /** @type {'idle'|'active'} */
    this._pool = 'idle';
    this._onStackChanged = ({ stack }) => {
      const next = (stack?.length ?? 0) > 0 ? 'active' : 'idle';
      if (next !== this._pool) {
        this._pool = next;
        this.render();
      }
    };
    EventBus.on('simulation:stack_changed', this._onStackChanged);
    this.render();
  }

  destroy() {
    EventBus.off('simulation:stack_changed', this._onStackChanged);
    this._el.replaceChildren();
  }

  render() {
    const pool = this._pool === 'active' ? ACTIVE_PROMPTS : IDLE_PROMPTS;
    const sample = shuffled(pool).slice(0, Math.min(VISIBLE_COUNT, pool.length));

    this._el.replaceChildren();

    for (const prompt of sample) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chat-chip';
      btn.textContent = prompt.label;
      btn.title = prompt.text;
      btn.addEventListener('click', () => this._pick(prompt));
      this._el.appendChild(btn);
    }

    const shuffle = document.createElement('button');
    shuffle.type = 'button';
    shuffle.className = 'chat-chip chat-chip--shuffle';
    shuffle.textContent = '↻';
    shuffle.title = 'Show different suggestions';
    shuffle.setAttribute('aria-label', 'Shuffle suggestions');
    shuffle.addEventListener('click', () => this.render());
    this._el.appendChild(shuffle);
  }

  /** @param {ChipPrompt} prompt */
  _pick(prompt) {
    EventBus.emit('chat:chip', {
      promptId: prompt.id,
      sessionId: this._sessionId,
    });
    this._onPick(prompt.text);
  }
}
