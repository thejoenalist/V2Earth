# Earth Simulator V2 — CLAUDE.md

This file is read by AI coding assistants at the start of every session.
It gives full project context so you can pick up exactly where we left off
without re-explaining the architecture.

---

## Mission

A CesiumJS-based Earth simulator that lets users type climate scenarios in
plain language and watch the planet execute them as 3D visual renders — concurrently,
while the chat responds. The end goal is to leave every user feeling empowered
to act on climate: not anxious, not helpless, but with a concrete next step
grounded in their specific place, role, and situation.

Secondary goal: capture genuine human curiosity about the planet. The telemetry
system records "session stories" — readable prose timelines of what each user
explored, asked, and learned — so the operator can understand what people actually
care about.

---

## Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Globe renderer | CesiumJS (open source, no Cesium ion) | Globe-native, time-dynamic, WMTS support |
| Build | Vite 5 | Fast HMR, ESM, env var injection |
| NLP parser | Claude Haiku (claude-haiku-4-5-20251001) | Fast, cheap, structured JSON output |
| API proxy | Supabase Edge Functions | Keys never reach the browser |
| Telemetry | Supabase (free tier) | Remote admin access, Row Level Security |
| Climate data | CMIP6 SSP2-4.5 + SSP5-8.5 | Real projections, baked at build time |
| Boundaries | Natural Earth GeoJSON | Public domain |
| Tiles | NASA GIBS Blue Marble WMTS | Free, high quality |
| US city data | NOAA LOCA2 | Downscaled regional projections |
| Python pipeline | bake_all.py + validate.py | Static JSON, no runtime API calls |
| Hosting | Netlify (free tier) | Auto-deploy on push, 100GB bandwidth |
| CI/CD | GitHub Actions + Netlify | Weekly data refresh + auto-deploy |

---

## Architecture Principles

These are non-negotiable rules. Never violate them.

1. **No `window.*` globals.** All inter-module communication goes through EventBus.
2. **Single `normalizeISO()`.** Never inline ISO normalization. Always import from `src/core/ISONormalizer.js`.
3. **LayerContract is the base class** for every visualization layer. No layer bypasses it.
4. **TimeController is the single source of truth** for current year + SSP. Layers never read time directly — they listen to `time:changed`.
5. **All data is baked at build time.** No runtime calls to CMIP6 or World Bank APIs. The Python pipeline produces static JSON in `public/data/`.
6. **The Claude API is never called from the browser.** ScenarioParser calls the Supabase Edge Function proxy, which calls Anthropic server-side.
7. **Max 3 concurrent simulation layers.** Hard limit enforced by EventSimulator. Performance budget: 30fps target.
8. **Schema validation before EventBus emission.** Every SimulationCommand from ScenarioParser is validated before `simulation:requested` is emitted.
9. **`destroy()` on every layer and simulation must remove all owned CesiumJS objects.** No memory leaks.

---

## Repository Structure

```
/
├── index.html                  UI shell — CSS vars, globe container, chat panel, timeline
├── vite.config.js              Vite build config, env var exposure
├── package.json                cesium, vite, vite-plugin-cesium
├── CLAUDE.md                   This file
│
├── src/
│   ├── main.js                 Thin orchestrator — instantiates everything, wires EventBus
│   ├── core/
│   │   ├── EventBus.js         Singleton event bus, Map-based, on/off/emit/clear
│   │   ├── TimeController.js   Chapter year + SSP state, emits time:changed
│   │   └── ISONormalizer.js    normalizeISO() — single function, alpha-2→alpha-3 + aliases
│   ├── globe/
│   │   ├── GlobeRenderer.js    CesiumJS Viewer, NASA GIBS WMTS, chapter aesthetic
│   │   └── LayerContract.js    Abstract base class for all visualization layers
│   ├── simulation/
│   │   ├── EventSimulator.js   Manages simulation stack (max 3), compound detection, eject
│   │   ├── CompoundEffectsResolver.js  Maps compound event relationships + amplification
│   │   └── ActiveSimulation.js Wraps one executing simulation, owns all CesiumJS objects
│   ├── chat/
│   │   ├── SimulationCommand.js  THE CENTRAL CONTRACT — all typedefs + EVENT_TYPES registry + system prompt
│   │   ├── ScenarioParser.js     Calls Supabase proxy → returns SimulationCommand
│   │   └── ChatInterface.js      Chat UI — renders all response types, quiz, report card
│   └── analytics/
│       └── TelemetryService.js     Session story format, Supabase flush
│
├── pipeline/
│   ├── bake_all.py             Master script — runs all fetchers, writes public/data/
│   ├── validate.py             Validates baked data — run after bake_all.py
│   ├── utils/
│   │   └── iso_normalize.py    Python mirror of ISONormalizer.js
│   └── requirements.txt        Python deps
│
├── public/
│   └── data/                   Baked static JSON served by the app
│       ├── climate.json        CMIP6 by ISO / chapter / SSP
│       ├── worldbank.json      Population, GDP, HDI, vulnerability
│       ├── countries.geojson   Natural Earth boundaries
│       ├── attribution.json    License attribution (required by CC BY 4.0)
│       ├── manifest.json       Pipeline metadata + baked_at timestamp
│       └── validation_report.json  Output of validate.py
│
├── admin/
│   └── session_viewer.html     Remote Supabase session viewer (requires auth)
│
└── .github/
    └── workflows/
        └── weekly-pipeline.yml  GitHub Actions cron — Monday 6am UTC
```

---

## EventBus Event Taxonomy

| Event | Direction | Payload |
|---|---|---|
| `time:changed` | TimeController → all layers | `{ year, ssp }` |
| `region:selected` | GlobeRenderer → chat, panel | `{ iso, name, coords }` |
| `region:hovered` | GlobeRenderer → UI | `{ iso }` |
| `layer:changed` | UI → layers | `{ layerId }` |
| `ssp:changed` | UI → TimeController | `{ ssp }` |
| `simulation:requested` | ChatInterface → EventSimulator | `SimulationCommand` |
| `simulation:layer_added` | EventSimulator → UI | `{ eventType, stackDepth, compound }` |
| `simulation:layer_removed` | EventSimulator → UI | `{ eventType, reason }` |
| `simulation:ejected` | EventSimulator → UI, chat | `{ reason }` |
| `simulation:stack_changed` | EventSimulator → ChatInterface | `{ stack: string[] }` |
| `simulation:compound_detected` | EventSimulator → ChatInterface | `{ incomingEvent, activeEvents, compound }` |
| `simulation:complete` | ActiveSimulation → UI | `{ eventType }` |
| `chat:query` | ChatInterface → TelemetryService | `{ text, sessionId }` |
| `session:start` | main.js → TelemetryService | `{ sessionId }` |
| `report:export_requested` | ChatInterface → ExportService | `{ type, report }` |
| `quiz:started` | ChatInterface → TelemetryService | `{ context }` |
| `quiz:completed` | ChatInterface → TelemetryService | `{ score, pct }` |

---

## SimulationCommand Types

| Type | When to use |
|---|---|
| `climate_event` | User asks about a specific hazard event |
| `scenario_compare` | User wants SSP2 vs SSP5 comparison |
| `region_inspect` | User clicks or asks about a country/region |
| `timeline_jump` | User asks about a specific year |
| `local_action` | User asks what THEY can do in a specific place |
| `research_query` | Academic/researcher query with audit/data needs |
| `resilience_plan` | Mitigation strategy with costs, jobs, financing |
| `explain` | General explanation request |
| `empowerment_quiz` | Quiz generated after a resilience_plan response |

**`eject: true`** on any command tells EventSimulator to clear all active layers first.
Detected when user says "forget that", "start over", "show me something different", etc.

---

## Event Types Registry

Located in `src/chat/SimulationCommand.js` — `EVENT_TYPES` object.

**Status tiers:**
- `ready` — 6 events: hurricane, sea_level_rise, wildfire, drought, heatwave, conflict
- `schema` — 19 events registered with render strategy and climate link notes
- `noted` — 10 events registered, render to be built when first requested
- `non_climate` — 1 event (solar_storm): system prompt responds honestly about scope

**Adding a new event:** add to `EVENT_TYPES`, add its render stub to `ActiveSimulation._dispatch()`, add to the system prompt event list in `SCENARIO_PARSER_SYSTEM_PROMPT`.

---

## Data Sources and Licenses

| Source | License | Attribution required? | Used for |
|---|---|---|---|
| CMIP6 (multiple modeling centers) | CC BY 4.0 | Yes — cite modeling centers | Temperature, sea level, precipitation projections |
| World Bank Open Data | CC BY 4.0 | Yes | Population, GDP, HDI, vulnerability indices |
| Natural Earth GeoJSON | Public domain | No | Country/state boundaries |
| NASA GIBS (Blue Marble, Black Marble) | US Gov public domain | No | Globe imagery tiles |
| NOAA LOCA2 | US Gov public domain | No | US city-level downscaled projections |

**Required:** `public/data/attribution.json` must exist and cite all sources.
This is checked by `validate.py` and is required for CC BY 4.0 compliance.

---

## Chapter Timeline

```
2025  →  2050  →  2075  →  2100
Today   Mid-Century  Late Century  End of Century
```

All CMIP6-backed. No speculative data past 2100. SSP2-4.5 and SSP5-8.5 only.
SSP pathways load on demand. Default is SSP2-4.5 (optimistic but achievable framing).

**Globe aesthetic:** desaturates progressively as year advances.
`t = (year - 2025) / (2100 - 2025)` — at t=0 full color, at t=1 near monochrome.

---

## Performance Budget

- **Max concurrent layers:** 3 (enforced by EventSimulator)
- **Frame rate target:** 30fps (optimal for user screen recording)
- **Layer memory rule:** every `ActiveSimulation` must track all owned CesiumJS objects
  in `this._owned` and remove them all in `destroy()`. No exceptions.
- **Particle count per layer:** TBD at Milestone 4 — calibrate to 30fps on mid-range laptop

---

## Empowerment Quiz Flow

1. User completes a `resilience_plan` query
2. ChatInterface auto-offers "Want to test your mitigation strategy?" after 1.2s
3. User clicks → ChatInterface sends "Generate an empowerment quiz" to parser
4. Parser returns `empowerment_quiz` command with 5–7 multiple choice questions
5. ChatInterface renders interactive question buttons
6. User answers all questions → score calculated → report card requested
7. Report card shows: A–F grade + risk reduction % + jobs created + economic benefit + 3 next steps
8. "Download Report Card" button emits `report:export_requested` → PDF export

Quiz `exportable: true` always triggers the download button.
All quiz interactions emitted to TelemetryService for session story.

---

## Compound Event System

When a user adds a second event on top of an active simulation:

1. `EventSimulator` calls `CompoundEffectsResolver.resolve(activeEvents, incomingEvent)`
2. If a compound relationship exists, `simulation:compound_detected` is emitted
3. `ChatInterface` renders a compound alert card (orange border) with:
   - Compound scenario name and narrative
   - New risks that only emerge from the combination
   - One-sentence insight grounded in a real historical case

**Defined compound pairs:** 20+ relationships in `CompoundEffectsResolver.js`
including earthquake+tsunami, drought+wildfire, heatwave+power_grid_failure,
conflict+flood, flood+epidemic_outbreak, hurricane+sea_level_rise, and more.

---

## Security Architecture

- **API keys never reach the browser.** ScenarioParser → Supabase Edge Function → Anthropic.
- **Supabase Row Level Security:** anon key = INSERT only. SELECT requires service role key (server-side only).
- **Admin session viewer** requires Supabase Auth (magic link to operator email).
- **SimulationCommand schema validation** before any command is emitted to EventBus.
- **Input sanitization:** `_addMessage` uses `textContent` everywhere (not innerHTML).
  DOMPurify required before any markdown/HTML rendering is added.
- **Rate limiting:** Supabase Edge Function enforces per-IP/per-session request limits.
- **Content Security Policy** headers on Netlify deployment.
- **`.env` files in `.gitignore`** — never commit real keys.

---

## Hosting (Free Tier Stack)

| Service | Role | Free tier limits |
|---|---|---|
| **Netlify** | App hosting + auto-deploy on push | 100GB bandwidth/month, 300 build min/month |
| **Supabase** | Telemetry DB + Edge Functions (API proxy) | 500MB DB, 2GB bandwidth, 500K function invocations |
| **GitHub** | Repo + Actions (CI/CD) | 2000 Actions min/month (private), unlimited (public) |

**Local development:** `npm run dev` (Vite dev server on localhost:5173)
All `.env.local` variables available locally. VS Code + Vite extension for HMR.

**Deploy flow:** push to `main` → GitHub Actions validates → Netlify auto-builds and deploys.
No manual deploy steps required.

---

## Milestone Plan

| Milestone | Status | Goal |
|---|---|---|
| M0 | ✅ Complete | Architecture, all stubs, CLAUDE.md |
| M1 | ✅ Complete | Working CesiumJS globe, chapter timeline, SSP toggle |
| M2 | ✅ Complete | Chat → SimulationCommand flow with API proxy (rolling 10-turn history included) |
| M3 | ✅ Complete | Real CMIP6 data baked (246 countries, validated); Temperature/SeaLevel/Precipitation layers live |
| M4 | ✅ Complete | All 6 "ready" event renders live in ActiveSimulation.js (hurricane, sea level, wildfire, drought, heatwave, conflict) |
| M5 | 🔧 In progress | TelemetryService done; RLS policies + admin viewer auth unverified |
| M6 | ✅ Complete | Quiz + report card + ExportService (HTML export, print-to-PDF ready) |

---

## Open Action Items

Updated 2026-07-03 after a full code audit. (Edge function, pipeline fetchers, SCHEMA.md,
ExportService, eject button, CSP headers, and rolling conversation history are all done.)

**Launch blockers**

1. **Privacy policy + Terms of Service + telemetry consent notice** — required before any public traffic. Telemetry stores full chat text remotely, and the system prompt actively invites emotional/personal context — disclosure is mandatory, not optional.
2. **Data source attribution UI** — `public/data/attribution.json` exists but is invisible in the UI. Required for CC BY 4.0 compliance.
3. **Supabase RLS policies** — verify anon key = INSERT only on the telemetry table before telemetry goes live.
4. **Admin session viewer auth** — verify the Supabase Auth gate on `admin/session_viewer.html` before deploy.
5. **Cost controls** — Anthropic spend cap; max query length in the edge function (none today = abuse vector); set `ALLOWED_ORIGIN` on the deployed function (defaults to `*`).

**Missing core product**

6. ~~**Region interaction**~~ ✅ Built 2026-07-03: `RegionPicker.js` (click/hover picking on an invisible boundary layer, selection highlight) + `CountryPanel.js` (slide-in inspector consuming climate.json + worldbank.json) + `#country-panel` element/CSS in index.html. `region_inspect` chat commands now fly to the country and open the panel. `WorldStateAnalytics.js` was retired 2026-07-03 — it expected V1's synthesized world-state metrics (systemicStress, migrationPressure…) that V2 never computes; recover from git history if a synthesis layer is ever built.
7. ~~**System prompt out of sync with EVENT_TYPES**~~ ✅ Fixed 2026-07-03: all 12 missing events added to the prompt + solar_storm honest-scope rule + earthquake/volcanic climate-framing rule; synced to the edge function (verified via `npm run sync-prompt` — "already up to date"). **Redeploy still required:** `npx supabase functions deploy parse-scenario`.
8. **scenario_compare / timeline_jump have no globe behavior** — EventSimulator handles `climate_event` and `region_inspect` only. (timeline_jump partially works: ChatInterface snaps the chapter when the command carries a year.)

**Known bugs (open)**

9. **CSP `frame-src 'none'`** in `public/_headers` may blank the ExportService modal (sandboxed `srcdoc` iframe) in production. Verify on Netlify; fall back to `frame-src 'self'` or a Blob-URL tab if blank.
10. **`session_end` telemetry is lost on unload** — async Supabase insert inside `beforeunload`; switch to `navigator.sendBeacon` or `fetch(..., { keepalive: true })`.
11. **`simulation:complete` is never emitted** — simulations run until evicted/ejected. Either implement a natural end or remove the event from the taxonomy.
12. **ActiveSimulation duplicates a centroid table** — should import from `RegionCentroids.js` (single-source rule).
13. **Sparse data disclosure in UI** — layers grey-fill sparse-tier countries but there's no user-facing notice. Current bake is all-"high" tier, so low priority.

**Fixed in the 2026-07-03 audit**

- SeaLevelLayer + PrecipitationLayer wired into main.js (layer buttons were dead)
- ScenarioParser: failed requests no longer break user/assistant role alternation (one failure used to brick chat for the session)
- LayerContract forwards `time:changed` to hidden layers (stale-data-on-reshow bug)
- `report.grade` escaped before `innerHTML` injection (XSS)
- TelemetryService: session start timestamp set (session_end `durationMs` was NaN) and now shares the app-wide `sessionId` from main.js
- ScenarioParser event validation uses `Object.hasOwn` (prototype keys no longer pass)

---

## Key Design Decisions (locked)

- **No window.* globals.** EventBus only.
- **4 chapters only (2025, 2050, 2075, 2100).** No data past 2100.
- **No chat history across sessions.** Each reload is a fresh session.
- **Stylized hybrid visual aesthetic** — not photorealistic, not wireframe.
  Globe desaturates as year advances toward 2100.
- **SSP pathways load on demand.** Default SSP2-4.5.
- **Simulator and game are separate.** V2 is the simulator only.
- **3D events are procedural** — pre-computed simulation assets, not live physics.
- **First-load experience is user-directed** — no cinematic intro.
- **Mobile is nice-to-have at launch**, not required.
- **30fps target** — optimal for user screen recording.
- **Max 3 concurrent simulation layers** — performance budget hard limit.
- **Earthquake and volcanic eruption are in-scope** with climate connection framing
  (glacial isostatic rebound, deglaciation-driven volcanic activity).
- **Non-climate events (solar_storm)** get an honest scope disclosure + mechanism explanation.

---

## Useful Prompts for Future Sessions

**To start a new coding session:**
> "I'm continuing Earth Simulator V2. Read CLAUDE.md for full context. Today I want to work on [Milestone X / specific feature]."

**To start Milestone 1 (working globe):**
> "Start Milestone 1: implement GlobeRenderer.js to render a working CesiumJS globe with NASA GIBS tiles, wire the chapter timeline in main.js, and make the SSP toggle functional. Reference CLAUDE.md for architecture rules."

**To implement the Supabase Edge Function proxy:**
> "Implement the Supabase Edge Function at supabase/functions/parse-scenario/index.ts. It receives { query, year, ssp } from the frontend, calls the Anthropic API with SCENARIO_PARSER_SYSTEM_PROMPT from SimulationCommand.js, validates the response against the SimulationCommand schema, and returns the validated command. See CLAUDE.md security section."

**To start the Python pipeline:**
> "Write pipeline/fetch_cmip6.py. It should download CMIP6 SSP2-4.5 and SSP5-8.5 ensemble means for temperature anomaly, sea level rise, and precipitation change for all 195 UN member states for chapters 2025, 2050, 2075, 2100. Output to public/data/climate.json following the schema in validate.py FIELD_BOUNDS. See CLAUDE.md data sources section."

**To implement a specific event render (Milestone 4):**
> "Implement the hurricane render in ActiveSimulation._renderParticleSpiral(). Use a CesiumJS ParticleSystem centered on command.params.center. The spiral should rotate inward, particle velocity should scale with command.params.magnitude. Reference the Sandcastle example at https://sandcastle.cesium.com/?src=Particle%20System.html. See ActiveSimulation.js for the _track() utility and destroy() memory management contract."

**To add a new compound relationship:**
> "Add a compound relationship between [event A] and [event B] to CompoundEffectsResolver.js. Research the actual mechanism of how these events interact, include a real historical case study in chatPrompt, and define plausible amplification multipliers. Follow the existing pattern in COMPOUND_MAP."
