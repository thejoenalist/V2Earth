---
name: add-event-type
description: Add a new climate event type to Earth Simulator V2, or promote an existing event between tiers (noted → schema → ready). Use whenever the user asks to add, register, enable, or upgrade an event type. This touches 3+ files that MUST stay in sync — follow every step in order.
---

# Add / Promote an Event Type

This task has drifted before: the system prompt once fell 12 events behind
`EVENT_TYPES`. Every step below exists because skipping it broke something.
All paths relative to `v2-starter/`.

## Step 1 — Register in EVENT_TYPES
`src/chat/SimulationCommand.js`, `EVENT_TYPES` object (~line 219).

Pick a tier:
- `noted` — key + label + `render: 'tbd'`. Placeholder render is automatic.
- `schema` — also choose a render strategy name (kebab-case, describes the
  visual, e.g. `wave-propagation`) and add a `climateLink` note.
- `ready` — everything above, plus a working render (Step 2 becomes mandatory).
- `non_climate` — only for events with no climate mechanism; the system prompt
  must give an honest scope disclosure (see `solar_storm` for the pattern).

Earthquake/volcanic-style geophysical events are IN scope but must carry
climate-connection framing (isostatic rebound, deglaciation-driven activity).

## Step 2 — Render route (ready tier only)
`src/simulation/ActiveSimulation.js`, `_dispatch()` (~line 166): add
`'your-strategy': () => this._renderYourEvent()` to the routes map, then
implement the render. **Use the `implement-render` skill for the render
itself** — it carries the memory contract and performance budget.

## Step 3 — System prompt
`SCENARIO_PARSER_SYSTEM_PROMPT` in the same `SimulationCommand.js` file:
add the event to the prompt's event list with a one-line description so the
parser can map user language onto it. Match the existing list format exactly.

## Step 4 — Compound relationships (usually yes)
`src/simulation/CompoundEffectsResolver.js`: if the new event plausibly
interacts with any existing event (most do), add pairs to `COMPOUND_MAP`
following the existing pattern — real mechanism, a real historical case in
`chatPrompt`, plausible amplification multipliers. Do not invent case studies;
if you cannot name a real one, leave the pair out and say so.

## Step 5 — Sync and deploy
```
npm run sync-prompt
npx supabase functions deploy parse-scenario
```
sync-prompt copies the prompt into `supabase/functions/parse-scenario/index.ts`.
**The deploy step cannot be skipped** — production keeps serving the old prompt
until it runs. If you cannot run the deploy, end your response with a bolded
reminder that the user must run it.

## Step 6 — Verify (mandatory, no exceptions)
```
npm run verify
```
Must pass parity: EVENT_TYPES ⊆ system prompt, ready-tier strategies all
routed in `_dispatch`, no sync drift. Also update the EVENT_TYPES tier counts
in CLAUDE.md ("Status tiers" section) if they changed.

## Definition of done
All six steps completed or explicitly flagged as blocked. Never report the
event as "added" if only Step 1 happened — a registered-but-unrouted ready
event silently falls back to the placeholder render, and an unsynced prompt
means the parser will never emit the event at all.
