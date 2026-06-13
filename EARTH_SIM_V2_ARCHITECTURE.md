# Earth Simulator V2 — Architecture & Build Plan

*PM + Graphics Engineer document. Written after full V1 code audit.*
*Last updated: June 2026*

---

## Why We're Rebuilding

V1 audit revealed three structural problems that cannot be refactored:

1. **ClimateStressDataService is entirely synthetic.** All climate numbers are generated from `hashCode(regionId)` — a deterministic random function. No real CMIP6, World Bank climate, or NASA data is behind any projection. This is the most critical issue.
2. **main.js is a 1,078-line god file** wiring everything via `window.*` globals. There is no EventBus, no formal module contract, and no testable seam anywhere. Adding the chat interface and 3D simulations would require rewriting it anyway.
3. **Three.js cannot support V2's visual requirements.** Volumetric weather events, terrain-accurate sea level inundation, and atmospheric particle systems require WebGL2 + a proper geospatial renderer. Three.js flatShading on a 32-segment sphere is the ceiling, not the foundation.

**What we're keeping from V1 (logic, not code):**
- `WorldStateAnalytics.js` — the analytics schema is excellent, port directly
- `WorldState.js` — the data shape (economy, trade, population, stability, development)
- The layer manager pattern — formalized as a `LayerContract` interface
- Natural Earth GeoJSON as the boundary source
- The telemetry intent (behavior tracking) — redesigned properly

---

## Tech Stack

| Concern | V1 | V2 | Reason |
|---|---|---|---|
| Globe renderer | Three.js (32-seg sphere) | **CesiumJS (open source)** | WGS84-accurate, terrain, atmosphere, time-dynamic data native |
| Geospatial layers | Manual Three.js meshes | **deck.gl + luma.gl** | GPU-instanced rendering, large-scale data viz |
| Build | `npx serve` (no bundler) | **Vite** | Actually use it this time |
| Data pipeline | Runtime API calls | **Python preprocessing scripts** → static JSON | No CORS, no latency, no runtime failures |
| Chat → simulation | None | **Claude API** (natural language → command schema) | You already have access |
| State management | `window.*` globals | **EventBus + DataStore** | Testable, decoupled, no hidden dependencies |
| Telemetry storage | In-memory only | **Supabase (free tier)** | Persistent, queryable, readable in admin dashboard |
| Framework | Vanilla JS | **Vanilla JS + Web Components** | Keep it lightweight; no React needed |

**CesiumJS note:** Use the open-source CesiumJS library, NOT Cesium ion cloud platform. Pair with NASA Visible Earth tiles (free) for imagery and SRTM elevation data (free) for terrain. Zero cost dependency.

---

## Data Stack (All Free, All Credible)

### Pipeline-baked at build time (no runtime API calls)

| Layer | Source | Format | Pipeline script |
|---|---|---|---|
| Country/state boundaries | Natural Earth 1:10m | GeoJSON | `fetch_natural_earth.py` |
| GDP, HDI, trade, debt | World Bank Open Data bulk CSV | JSON | `fetch_worldbank.py` |
| Military expenditure | SIPRI annual CSV | JSON | `fetch_sipri.py` |
| Population density | WorldPop gridded CSV | JSON | `fetch_worldpop.py` |
| Climate projections 2025–2100 | **CMIP6 via ESGF** (SSP2-4.5, SSP5-8.5) | NetCDF → JSON | `fetch_cmip6.py` |
| Sea level projections | NASA Sea Level Projection Tool | CSV → JSON | `fetch_sealevel.py` |
| Conflict events | ACLED historical CSV | JSON | `fetch_acled.py` |
| Food/water stress | FAO FAOSTAT + WRI Aqueduct | JSON | `fetch_fao.py` |
| Wildfire risk | NASA FIRMS historical | GeoJSON | `fetch_firms.py` |
| Fault lines / volcanoes | USGS + Smithsonian GVP | GeoJSON | Already in V1, keep |
| Satellite TLEs | CelesTrak grouped | TLE → JSON | `fetch_celestrak.py` |

### Data ceiling

Timeline ends at 2100 — the limit of CMIP6 scientific projection range.
Every value displayed is peer-reviewed and source-attributed. No extrapolation, no speculation.

---

## Repo Structure

```
earth-sim-v2/
│
├── pipeline/                     # Python — run once, bakes all data
│   ├── fetch_worldbank.py
│   ├── fetch_cmip6.py
│   ├── fetch_natural_earth.py
│   ├── fetch_acled.py
│   ├── fetch_sealevel.py
│   ├── fetch_firms.py
│   ├── fetch_sipri.py
│   ├── bake_all.py               # Master script: run all fetchers
│   └── utils/
│       └── iso_normalize.py      # Single shared ISO normalization utility
│
├── public/
│   ├── data/                     # Output of pipeline — committed to repo
│   │   ├── worldbank/
│   │   ├── climate/
│   │   │   ├── ssp245/           # Optimistic pathway
│   │   │   └── ssp585/           # Worst-case pathway
│   │   ├── natural_earth/
│   │   ├── conflict/
│   │   └── speculative/          # 2200, 2500 authored scenario files
│   └── textures/
│       ├── blue_marble/          # NASA Visible Earth seasonal
│       └── night_lights/         # NASA night lights composite
│
├── src/
│   ├── core/
│   │   ├── EventBus.js           # The nervous system. All inter-module communication.
│   │   ├── DataStore.js          # Single source of truth (replaces WorldState)
│   │   ├── TimeController.js     # Chapter state + SSP pathway + interpolation
│   │   └── ISONormalizer.js      # Single function imported everywhere
│   │
│   ├── globe/
│   │   ├── GlobeRenderer.js      # CesiumJS setup + camera
│   │   ├── LayerContract.js      # Interface: load(), show(), hide(), updateTime(year, ssp)
│   │   ├── LayerOrchestrator.js  # Routes EventBus signals to active layers
│   │   └── layers/
│   │       ├── ClimateLayer.js
│   │       ├── ConflictLayer.js
│   │       ├── EconomicLayer.js
│   │       ├── MigrationLayer.js
│   │       ├── FoodWaterLayer.js
│   │       └── SatelliteLayer.js
│   │
│   ├── simulations/
│   │   ├── EventSimulator.js     # Orchestrates procedural event playback
│   │   ├── SimulationCommand.js  # The command schema (see below)
│   │   └── events/
│   │       ├── HurricaneSimulation.js    # GLSL particle system
│   │       ├── SeaLevelSimulation.js     # Terrain inundation mesh morph
│   │       ├── WildfireSimulation.js     # Spread particle system
│   │       ├── DroughtSimulation.js      # Choropleth animation
│   │       └── ConflictSimulation.js     # Displacement flow vectors
│   │
│   ├── chat/
│   │   ├── ChatInterface.js      # UI: input + message thread
│   │   ├── ScenarioParser.js     # User text → Claude API → SimulationCommand
│   │   └── ResponseRenderer.js  # Streams Claude narrative into the chat panel
│   │
│   ├── narrative/
│   │   ├── NarrativeEngine.js    # { learned, action, emotion, sources[] } per event
│   │   └── ChapterLore.js        # Authored content for 2200 + 2500 chapters
│   │
│   ├── analytics/
│   │   ├── WorldStateAnalytics.js   # Ported from V1 — unchanged
│   │   └── TelemetryService.js      # User behavior logging (see schema below)
│   │
│   └── ui/
│       ├── ChapterTimeline.js    # The chapter rail slider component
│       ├── LayerSelector.js      # Plain-language lens toggles
│       ├── CountryPanel.js       # Slides in on country click
│       ├── AdminDashboard.js     # Session story viewer (Joe-facing)
│       └── OnboardingOverlay.js  # First-load orientation
│
├── admin/
│   └── session_viewer.html       # Joe's log reader (local, not public)
│
├── index.html
├── package.json
├── vite.config.js
└── ARCHITECTURE.md               # This document
```

---

## The Chapter Timeline

### Design

Seven named stops on a horizontal rail. The handle snaps to stops but can slide freely between them for interpolated views. Between stops, all data layers interpolate linearly (or via CMIP6 curves where available).

```
●————●————●————●————●————●————●
Present  2050  2075  2100  2150  2200  2500
  |                          |         |
  Scientific data          Extrapolated  Story Mode
  (CMIP6 / World Bank)
```

Each stop has:
- A chapter name (plain language, not just a year)
- A short descriptor that updates the page header: e.g., "Near Future — High confidence projections"
- A visual signal in the globe: color temperature shifts warmer as you advance, sky color changes subtly

### Chapter names

| Stop | Year | Chapter Name | Data source |
|---|---|---|---|
| 1 | Today | *Today* | World Bank + CMIP6 baseline |
| 2 | 2050 | *Mid-Century* | CMIP6 SSP primary range |
| 3 | 2075 | *Late Century* | CMIP6 SSP divergence zone |
| 4 | 2100 | *End of Century* | CMIP6 endpoint — full projection range |

Timeline stops at 2100. Every number shown is scientifically grounded.
Post-2100 chapters dropped — no speculative or extrapolated data in V2.

### Play mode

A ▶ button animates through all chapters automatically: 2 seconds per chapter, easing in/out. Hitting any chapter stop fires the same `timeChanged` event as manual drag. This is how users who don't interact still experience the full arc.

---

## The Chat Interface

This is the most architecturally significant V2 feature.

### How it works

```
User types → ScenarioParser → Claude API → SimulationCommand → EventSimulator → Globe renders
                                        ↓
                                 ResponseRenderer → Chat panel streams narrative
```

### SimulationCommand schema

Every chat input resolves to one of these:

```js
{
  type: "climate_event",         // "climate_event" | "scenario_compare" | "region_inspect" | "timeline_jump"
  target: "BGD",                 // ISO country or region ID (null for global)
  event: "sea_level_rise",       // event type
  params: {
    magnitude: 2,
    unit: "meters",
    year: 2075,
    ssp: "SSP5-8.5"
  },
  narrative: {                   // Returned by Claude alongside the command
    learned: "...",
    action: "...",
    emotion: "..."
  }
}
```

### ScenarioParser prompt (the Claude system prompt)

The system prompt for ScenarioParser instructs Claude to:
1. Extract intent, target region, event type, and parameters from the user's question
2. Return a JSON SimulationCommand
3. Also return a short narrative object (learned/action/emotion)
4. If the question is unanswerable with available data, return `{ type: "explain", text: "..." }` instead of a command

### What gets rendered concurrently

While Claude streams the narrative into the chat panel, the EventSimulator fires the 3D event on the globe. The user sees both simultaneously — text on the left, the earth reacting on the right. This is the core V2 experience.

---

## Telemetry — Reading User "Train of Thought"

### What gets logged (per event)

```js
{
  sessionId: "uuid",
  userId: null,                 // anonymous until gated
  timestamp: ISO8601,
  event: "region_click",        // event type (see below)
  payload: {
    iso: "BGD",
    chapterYear: 2075,
    ssp: "SSP5-8.5",
    activeLayer: "climate",
    timeOnPreviousRegion: 45000  // ms
  }
}
```

### Event types to capture

- `session_start` — first load, viewport size, referrer
- `chapter_change` — which chapter, from where
- `ssp_change` — pathway selected
- `layer_change` — which lens activated
- `region_click` — ISO, chapter, active layer at time of click
- `region_dwell` — ISO, duration in ms (fire on navigation away)
- `chat_query` — the exact user text (most valuable signal)
- `simulation_trigger` — which event ran, which region, which year
- `session_end` — total duration, chapters visited, regions touched

### The "session story" format (admin readable)

Rather than showing raw events, the admin dashboard renders each session as a prose timeline:

```
Session 001 — 8 min 23 sec — Jun 12 2026

  Started on global view, SSP2
  → Clicked climate layer (0:12)
  → Moved to 2075 chapter (0:34)
  → Clicked Bangladesh — dwelled 1m 45s
  → Asked: "what happens to Dhaka when sea levels rise?"
  → Simulation: sea_level_rise / BGD / 2075
  → Clicked India — dwelled 32s
  → Asked: "why are so many people leaving South Asia?"
  → Moved to 2100 chapter
  → Session ended
```

This format makes it immediately legible what the user was thinking and what questions the simulator couldn't answer (gaps between what they asked and what exists).

### Storage

Supabase (free tier) — Postgres under the hood, queryable via REST, no backend required. The admin dashboard queries it directly with a service key kept out of the public bundle. For pre-launch / local testing, log to `localStorage` and export as JSON.

---

## EventBus Design

Replaces all `window.*` globals and `window.dispatchEvent` calls. Central import in every module that needs cross-module communication.

```js
// EventBus.js
const _listeners = new Map();

export const EventBus = {
  on(event, handler) { ... },
  off(event, handler) { ... },
  emit(event, payload) { ... },
};

// Usage anywhere:
import { EventBus } from '../core/EventBus.js';
EventBus.on('time:changed', ({ year, ssp }) => { ... });
EventBus.emit('time:changed', { year: 2075, ssp: 'SSP5-8.5' });
```

### Event taxonomy

| Event | Payload | Who emits | Who listens |
|---|---|---|---|
| `time:changed` | `{ year, ssp }` | TimeController | All layers, NarrativeEngine, TelemetryService |
| `region:selected` | `{ iso, screenX, screenY }` | InputHandler | CountryPanel, TelemetryService, ChatInterface |
| `region:hovered` | `{ iso \| null }` | InputHandler | LayerOrchestrator (tooltip) |
| `simulation:requested` | SimulationCommand | ScenarioParser | EventSimulator |
| `simulation:complete` | `{ commandId }` | EventSimulator | ChatInterface (narrative display) |
| `layer:changed` | `{ layerId }` | LayerSelector | LayerOrchestrator |
| `chat:query` | `{ text, sessionId }` | ChatInterface | ScenarioParser, TelemetryService |
| `ssp:changed` | `{ ssp }` | LayerSelector | TimeController, all layers |

---

## V2 Layer Contract

Every layer implements this interface. No exceptions. This is what makes the LayerOrchestrator generic.

```js
export class LayerContract {
  /** @returns {Promise<void>} */
  async load() { throw new Error('Not implemented'); }

  /** @returns {void} */
  show() { throw new Error('Not implemented'); }

  /** @returns {void} */
  hide() { throw new Error('Not implemented'); }

  /**
   * Called whenever time or SSP changes.
   * @param {{ year: number, ssp: string }} params
   * @returns {void}
   */
  updateTime({ year, ssp }) { throw new Error('Not implemented'); }

  /**
   * Called on region hover.
   * @param {{ iso: string | null, x: number, y: number }} params
   * @returns {void}
   */
  onHover({ iso, x, y }) {}

  /**
   * Called on region click.
   * @param {{ iso: string }} params
   */
  onSelect({ iso }) {}
}
```

---

## Milestone Plan

### Milestone 1 — Proof of Globe (Week 1)
- Cesium.js running with NASA Blue Marble texture
- Natural Earth country borders + fill meshes
- Chapter timeline component wired to TimeController
- EventBus in place, no `window.*` globals
- Basic country click → CountryPanel slide-in

### Milestone 2 — Real Data (Week 2)
- Python pipeline: fetch_worldbank + fetch_cmip6 + fetch_natural_earth
- ISO normalizer in place and tested
- ClimateLayer rendering real CMIP6 data (SSP2 and SSP5 on demand)
- Sea level inundation layer (coastal mesh morph)
- EconomicLayer with World Bank data

### Milestone 3 — Chat Interface (Week 3)
- ChatInterface component
- ScenarioParser wired to Claude API
- First working simulation: sea_level_rise procedural event
- Telemetry logging to localStorage (Supabase later)
- Narrative streaming into chat panel

### Milestone 4 — Full Simulation Suite (Week 4)
- Hurricane, wildfire, drought simulations
- All 7 chapters with data / extrapolation / lore
- SSP pathway toggle with on-demand load
- Play mode (auto-advance animation)

### Milestone 5 — Polish + Admin (Week 5)
- Onboarding overlay
- Color accessibility pass
- Telemetry migrated to Supabase
- Admin session viewer
- Performance profiling (target: 60fps on mid-range laptop)

---

## First 5 Cursor Prompts

Use these in order. Each is scoped to a single file.

**Prompt 1 — EventBus**
> Create `src/core/EventBus.js`. It should export a singleton `EventBus` with `on(event, handler)`, `off(event, handler)`, and `emit(event, payload)` methods. Use a Map internally. Emit should be synchronous. Add JSDoc. No dependencies.

**Prompt 2 — TimeController**
> Create `src/core/TimeController.js`. Import EventBus. It should manage: current chapter year (one of [2025, 2050, 2075, 2100, 2150, 2200, 2500]), current SSP pathway ('SSP2-4.5' or 'SSP5-8.5'), and a `setChapter(year)` and `setSSP(ssp)` method that each emit a `time:changed` event via EventBus. Also expose a `getInterpolatedYear(rawYear)` that snaps to the nearest chapter or returns the raw value for slider positions between chapters. No DOM dependencies.

**Prompt 3 — ISONormalizer**
> Create `src/core/ISONormalizer.js`. Export a single function `normalizeISO(input)` that accepts any string and returns a 3-letter uppercase ISO 3166-1 alpha-3 code, or `null` if unresolvable. Include a lookup table for common mismatches (UK/GBR, USA/US, etc.). This function must be the only place in the entire codebase that performs ISO normalization — import it everywhere else.

**Prompt 4 — LayerContract**
> Create `src/globe/LayerContract.js`. Export a base class `LayerContract` with these methods that all throw `Not implemented`: `async load()`, `show()`, `hide()`, `updateTime({ year, ssp })`. Also export two optional methods with empty default implementations: `onHover({ iso, x, y })` and `onSelect({ iso })`. Add JSDoc on every method. The class should also import EventBus and in its constructor subscribe to `time:changed` → `this.updateTime(payload)` and `layer:changed` → handle visibility automatically.

**Prompt 5 — GlobeRenderer**
> Create `src/globe/GlobeRenderer.js`. It should initialize a CesiumJS viewer on a canvas element passed to the constructor. Configure it to use NASA Blue Marble as the base imagery layer (URL: `https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/BlueMarble_NextGeneration/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpg`). Disable the default Cesium ion credit. Expose a `camera` property and a `resize()` method. No data loading — pure renderer setup.

---

## Questions Still Open

- **Onboarding:** First-load experience — cinematic flyby to a specific hotspot, or user chooses? (affects OnboardingOverlay design)
- **Mobile:** Is mobile a launch requirement or post-launch? CesiumJS performs differently on mobile and the chat interface needs a different layout.
- **Chat history:** Should the chat panel persist across sessions (returning user sees their conversation history), or reset on each visit?
- **Admin auth:** Is the session viewer only for you locally, or does it need to be a hosted dashboard you can check remotely?
