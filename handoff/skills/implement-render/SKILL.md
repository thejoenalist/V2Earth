---
name: implement-render
description: Implement or upgrade a 3D event render in Earth Simulator V2 (ActiveSimulation.js). Use when the user asks to build, implement, or visually upgrade any event visualization (hurricane, flood, tsunami, drought, etc.). Carries the memory contract, performance budget, and the visual-upgrade template.
---

# Implement an Event Render

All paths relative to `v2-starter/`. Before writing code, read one
gold-standard example end-to-end: `_renderWildfire()` in
`src/simulation/ActiveSimulation.js` (particles + tracking + animation) or
`_renderSeaLevelRise()` (geometry-based). Copy their structure, not just
their ideas.

## Non-negotiable contract

1. **Track everything.** Every Cesium object you create — Entity, Primitive,
   ParticleSystem, PostProcessStage — goes through `this._track(...)`.
   Every `postRender` listener's removal function goes in `this._listeners`.
   `destroy()` already sweeps both arrays; an untracked object is a leak.
2. **Check `this._destroyed`** inside any async continuation or postRender
   callback before touching the viewer. Simulations can be evicted mid-flight.
3. **Lifetime:** simulations auto-complete after `SIMULATION_LIFETIME_MS`
   (60s) and emit `simulation:complete`. Design the animation to look
   complete by then, not to run forever.
4. **Never read time directly.** Year/SSP arrive via constructor params;
   ongoing changes come from `time:changed` if the render is time-sensitive.
5. **Centroids come from `getCentroid()`** (`src/globe/RegionCentroids.js`).
   Never inline a country→coords table.
6. **Performance budget: 30fps on a mid-range laptop, max 3 concurrent
   layers.** Keep per-render particle counts in line with existing renders
   (check `_renderHurricane`/`_renderWildfire` for current numbers and stay
   at or below them). Reuse the module-level texture canvases
   (`_FIRE_CANVAS`, `_SMOKE_CANVAS`, `_EMBER_CANVAS`) where possible.

## Visual-upgrade template (see VISUAL_UPGRADE_PLAN.md for full detail)

Renders must move away from "abstract ellipse at country centroid + stats the
LLM made up." Every new or upgraded render should have:

- **Real geometry.** Anchor to coastlines, admin boundaries, or baked polygons
  (`public/data/countries.geojson`, plus `bake_geodata.py` outputs as they
  land) — not a centroid ellipse.
- **Stats from baked data, never from the LLM.** Displayed numbers
  (population exposed, heat days, inundation area) come from
  `public/data/climate.json` / `worldbank.json` (via ImpactStats once it
  exists). Command params from the parser control *where and how big the
  visual is*, not the on-screen statistics. This is a hard rule: an LLM-
  synthesized statistic shown as fact is a correctness bug, not a style issue.
- **Named places.** City callouts with real names/populations where the data
  supports it.
- **Human-scale comparison copy** ("an area the size of X"), computed, not
  invented.

## Aesthetic rules
Stylized hybrid — not photorealistic, not wireframe. Respect the chapter
desaturation (globe fades toward monochrome at 2100); don't fight it with
oversaturated permanent colors. Compound-affected renders may amplify per
`CompoundEffectsResolver` multipliers.

## Definition of done
- Route added in `_dispatch()` and strategy name matches `EVENT_TYPES`.
- Manual leak test: start the sim, eject it (`"start over"` in chat), confirm
  the globe returns to its prior state and `viewer.entities.values.length`
  returns to baseline.
- Stack test: run with 2 other active sims; still ~30fps.
- `npm run verify` passes.
- If the event moved tiers, update EVENT_TYPES status and CLAUDE.md counts.
