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
| Globe renderer | CesiumJS + Cesium ion (World Terrain via `VITE_CESIUM_ION_TOKEN`; flat-ellipsoid fallback without token) | Globe-native, time-dynamic, WMTS support, real 3D elevation |
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
| `simulation:decision_requested` | ActiveSimulation → ChatInterface | `{ commandId, eventType }` — 3-min lifetime reached; ChatInterface prompts keep-or-clear (60s grace) then emits `simulation:complete` |
| `simulation:complete` | ActiveSimulation / ChatInterface → EventSimulator | `{ commandId, eventType }` |
| `chat:query` | ChatInterface → TelemetryService | `{ text, sessionId }` |
| `session:start` | main.js → TelemetryService | `{ sessionId }` |
| `consent:changed` | ConsentState → TelemetryService | `{ granted: boolean }` |
| `report:export_requested` | ChatInterface → ExportService | `{ type, report }` |
| `camera:closeup_requested` | ActiveSimulation → main.js (GlobeRenderer) | `{ lon, lat, name }` |
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
- **Supabase Row Level Security:** anon key = INSERT only on `telemetry_events`. SELECT requires the service role key or the authenticated operator (magic-link policy). Verified over REST 2026-07-05.
- **Admin session viewer:** gated by Supabase Auth magic link (2026-07-05) — `signInWithOtp` with `shouldCreateUser: false`, reads via the operator's JWT; the service role key never enters the browser. Not in `dist/`. ADMIN_SETUP completed + end-to-end verified 2026-07-06 (operator user, redirect allow-list, operator SELECT policy; anon key re-proven SELECT `[]`, UPDATE/DELETE 0 rows).
- **Telemetry consent gate (2026-07-05):** no Supabase write before the user accepts the consent banner; decline = telemetry off for the session. Consent flag in localStorage is the single approved exception (see DECISIONS.md amendment); single source `src/core/ConsentState.js`.
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
**Production URL:** `https://chipper-faun-a051b1.netlify.app` (live since 2026-07-05).

---

## Milestone Plan

| Milestone | Status | Goal |
|---|---|---|
| M0 | ✅ Complete | Architecture, all stubs, CLAUDE.md |
| M1 | ✅ Complete | Working CesiumJS globe, chapter timeline, SSP toggle |
| M2 | ✅ Complete | Chat → SimulationCommand flow with API proxy (rolling 10-turn history included) |
| M3 | ✅ Complete | Real CMIP6 data baked (246 countries, validated); Temperature/SeaLevel/Precipitation layers live |
| M4 | ✅ Complete | All 6 "ready" event renders live in ActiveSimulation.js (hurricane, sea level, wildfire, drought, heatwave, conflict) |
| M5 | ✅ Complete | TelemetryService + consent gate done; RLS verified (anon INSERT-only); admin viewer magic-link gate live — ADMIN_SETUP done + full flow verified 2026-07-06 (magic-link sign-in, Load Sessions renders real session stories, anon SELECT/UPDATE/DELETE still blocked) |
| M6 | ✅ Complete | Quiz + report card + ExportService (HTML export, print-to-PDF ready) |

**Note:** all app code lives in `v2-starter/` — the repo-structure paths above are relative to that directory.

---

## Open Action Items

Updated 2026-07-05 after the deploy + RLS verification pass.

**Launch blockers**

1. ~~**Privacy policy + Terms of Service + telemetry consent notice**~~ ✅ Built 2026-07-05: first-visit consent banner (`src/ui/ConsentBanner.js`); TelemetryService buffers pre-consent, flushes on accept, drops on decline — no Supabase write before accept; decline keeps the app fully working with telemetry off for the session. Consent flag = the one approved localStorage use (`earthsim.telemetryConsent`, single source `src/core/ConsentState.js`, new `consent:changed` EventBus event; DECISIONS.md amended). `public/privacy.html` + `public/terms.html` drafted, linked from banner + footer. Redeployed to Netlify + banner verified working in production 2026-07-06. ⚠ Remaining: legal review of the copy. *2026-07-16 self-review pass (not a lawyer):* copy verified against actual code behavior — decline-not-stored ✓ (ConsentState session-only), collected-fields list ✓ (exactly chat text/interactions/sessionId/timestamps/viewport/referrer), Anthropic wording tightened (rolling 10-turn history is sent, not just "the message text"); the "banner reappears on material change" promise had NO mechanism — ConsentState now versions the consent flag (`accepted:<CONSENT_VERSION>`, legacy value upgraded in place; bump the constant with privacy.html's Last-updated date). **Open:** both privacy + terms point deletion/contact requests at "the contact address published on the site footer" — the footer has none; needs the operator to pick a channel (footer mailto or repo link) and update both docs.
2. ~~**Data source attribution UI**~~ ✅ Built 2026-07-05: "About the data" footer link → modal (`src/ui/AttributionModal.js`) rendering `attribution.json`; textContent-only. Redeployed 2026-07-06 — CC BY 4.0 satisfied.
3. ~~**Supabase RLS policies**~~ ✅ Verified 2026-07-05. Finding: the `telemetry_events` table did NOT exist — all telemetry inserts had been failing silently. Created via SQL editor (`id` identity PK, `"sessionId"` text, `"timestamp"` timestamptz, `event` text, `payload` jsonb, `inserted_at` timestamptz); RLS enabled; single anon INSERT-only policy. Proven over REST with the anon key: INSERT 201, SELECT returns `[]`, UPDATE/DELETE affect 0 rows. (Leftover test row: sessionId `rls-test-2026-07-05`.)
4. ~~**Admin session viewer — auth decision**~~ ✅ Decided + built 2026-07-05: magic-link gate. `admin/session_viewer.html` rewritten — Supabase Auth `signInWithOtp` (`shouldCreateUser: false`), reads with the signed-in operator's JWT; the service role key never enters the browser (paste-key flow removed; also fixed an innerHTML XSS from telemetry chat text). Still not in `dist/`. ADMIN_SETUP completed + verified end-to-end 2026-07-06: magic-link sign-in works, Load Sessions renders real session stories via the operator JWT, and the anon key re-proven blocked (SELECT `[]`, UPDATE/DELETE 0 rows).
5. **Cost controls** — remaining: Anthropic spend cap in the console. Done: max query length enforced in the edge function; `ALLOWED_ORIGIN` set 2026-07-05 to `https://chipper-faun-a051b1.netlify.app` (was `*`) and function redeployed.

**Missing core product**

6. ~~**Region interaction**~~ ✅ Built 2026-07-03: `RegionPicker.js` (click/hover picking on an invisible boundary layer, selection highlight) + `CountryPanel.js` (slide-in inspector consuming climate.json + worldbank.json) + `#country-panel` element/CSS in index.html. `region_inspect` chat commands now fly to the country and open the panel. `WorldStateAnalytics.js` was retired 2026-07-03 — it expected V1's synthesized world-state metrics (systemicStress, migrationPressure…) that V2 never computes; recover from git history if a synthesis layer is ever built.
7. ~~**System prompt out of sync with EVENT_TYPES**~~ ✅ Fixed 2026-07-03: all 12 missing events added to the prompt + solar_storm honest-scope rule + earthquake/volcanic climate-framing rule; synced to the edge function (verified via `npm run sync-prompt` — "already up to date"). Deployed 2026-07-05 (CLI logged in + linked, project `silryqzempbblleqaokv`); the stored `ANTHROPIC_API_KEY` secret (2026-06-18) was invalid (Anthropic 401 → 502) and was replaced with the current key. Live test: 200 + valid SimulationCommand.
8. ~~**scenario_compare / timeline_jump have no globe behavior**~~ ✅ Built 2026-07-12: `EventSimulator._onRequested` now branches on both types. `timeline_jump` adds camera framing (`flyToISO`) on top of the chapter snap ChatInterface already does. `scenario_compare` frames the target, then runs an SSP2-4.5→SSP5-8.5 sweep via `TimeController.setSSP` (token-guarded against supersession; settles on SSP5-8.5) so any active data layer + open CountryPanel + SSP toggle + telemetry follow, paired with a baked side-by-side delta card in ChatInterface (`_renderScenarioCompare`, numbers from climate.json only — rule #4). **Bonus:** added a real `GlobeRenderer.flyToISO(iso)` (via RegionCentroids) — it never existed, so the `region_inspect` camera fly (item #6) had been a silent `?.` no-op; it now actually flies. No parser/prompt change (existing types), so no edge-function resync. ⚠ Run `npm run verify` locally — the Cowork mount truncates files so it can't run in-sandbox.

**Visual & contextual upgrade program (added 2026-07-03)**

See `v2-starter/VISUAL_UPGRADE_PLAN.md` for the full plan. Origin: environmental-scientist
feedback — renders are abstract centroid ellipses with LLM-synthesized stats; they
need real coastline/boundary geometry, named cities, real population counts, and
baked-data statistics. Committed to Cesium ion (terrain + OSM Buildings).

14. **Foundations:** `cities.json` bake, `ImpactStats.js` (all displayed stats from baked data, never the LLM), human-scale comparison copy, `bake_geodata.py` (inundation polygons, land/cropland masks, admin-1 boundaries), city close-up camera + OSM Buildings toggle.
    *Progress 2026-07-11 (V3 day, see `v2-starter/V3_DAY_PLAN.md`):* `cities.json` regenerated with 1,006 real cities (Natural Earth populated places via GitHub sparse clone — GeoNames path kept for CI; hand-authored coastal enrichment carried forward). `bake_geodata.py` written (Copernicus GLO-30 bathtub, ocean-connectivity enforced, tested on synthetic DEM) — **runs in CI; slr_miami.json does not exist until the weekly pipeline (or a manual dispatch) runs.** `cityCloseUp()` + OSM Buildings toggle live in GlobeRenderer (`camera:closeup_requested` event). Cinematic pass: HDR enabled (guarded), procedural cloud shell primitive (allowPicking:false; kill switch `USE_CLOUD_SHELL`).
15. **Per-event upgrades, priority order:** sea level rise (coastline inundation delta — flagship) → heatwave (near-free: `heat_days_gt35c` already baked) → hurricane (historical-analog tracks + surge) → drought (admin-1 choropleth; `drought_index` bake fixed 2026-07-05: 0.6 × precip deficit + 0.4 × evaporative-demand term, re-baked + validated) → wildfire (land mask + smoke drift) → conflict (named-place displacement arcs, analog framing required).
    *Progress 2026-07-11:* **sea level rise flagship DONE in code** — `InundationGeodata.js` loader + `_renderInundationDelta()` (real delta-band polygons, baked `area_km2` in the label, level shown ≥ projection and labeled honestly, city close-up at +7 s, generic ellipse fallback for non-flagship coasts and until the CI bake lands). **Heatwave label DONE** — reads `temperature_anomaly_c` + `heat_days_gt35c` via ImpactStats; the fabricated `mag × 2.5 °C` label is gone. **Polygon-bound swap DONE** (confirmed 2026-07-12): the ground heat-tint binds to the real country boundary via `CountryGeometry` (`getCountryFeature` + `featureToPolygonRings`), with the ellipse only as the null/unknown-target fallback; the only ellipses left are the radial heat-shimmer rings, which are inherently radial. Stale "swap still open" note corrected.
    *Progress 2026-07-12:* **sea level rise flagship VERIFIED LIVE** — `slr_miami.json` bake landed (Copernicus GLO-30, levels 0.5/1.0/2.0 m with baked `area_km2` + rings). End-to-end trace confirmed: `sea_level_rise` → `mesh-flood` → `_renderSeaLevelRise`; loader/`pickLevel` match the file; headline rise reads baked `climate.json` `sea_level_rise_m` tagged `(CMIP6 <ssp>)` and extent reads baked `area_km2` (rule #4 clean); all polygons `_track()`ed. **Bug fixed:** the +7 s close-up filtered `nearestCities` for `meanElevM != null`, but only ~44/1006 cities carry `mean_elev_m` (Miami is null), so it silently never fired — `_renderSeaLevelRise` now falls back lowest-lying-with-elevation → nearest named city → baked metro centre (`doc.center`), so the close-up always fires in the flagship path. `npm run verify` green (0 failures). Note: the Cowork Linux mount truncates files on read — `verify` must be run on the real machine, not the sandbox. Backfilling `mean_elev_m` for coastal cities (only ~44/1006 populated) is still worthwhile so the close-up picks the genuine low point rather than the fallback.
    *Progress 2026-07-12 (per-event cont.):* **Hurricane baked overlay DONE** — `_renderHurricane` now calls `getImpactStats('hurricane')` (already had a hurricane branch: coastal-city bias + surge-baseline SLR) and renders a baked label (`+X.XX m baseline sea level by <year> (CMIP6 <ssp>) — adds to storm surge`) plus coastal city callout pins (name + population), matching the SLR/heatwave template; all `_track()`ed. The `Cat N` label stays — it's the scenario storm the user chose, not a baked projection (no CMIP6 "future hurricane category" exists), so it's an honest scenario descriptor, not a fabricated stat. Full scope written up in `v2-starter/HURRICANE_TRACKS_PLAN.md` (analog tracks via IBTrACS; surge reuses `bake_geodata.py`'s bathtub helpers; phased).
    *Progress 2026-07-12 (hurricane Phase 1 — track):* **Analog-track polyline DONE (track-only).** New: `pipeline/bake_tracks.py` (curated metro→IBTrACS-SID registry: New Orleans/Katrina, Miami/Andrew, NYC/Sandy; runs in CI — NOAA egress isn't available in the Cowork sandbox), `src/simulation/HurricaneGeodata.js` (loader mirroring InundationGeodata — reuses `findFlagshipMetro`, null-safe), and a committed **hand-seeded** `public/data/geodata/hurricane_new_orleans.json` (Katrina, `seed:true`, coarse cited waypoints) so it renders now until the CI bake overwrites it. `_renderHurricane` now loads the flagship track and calls `_renderHurricaneTrack`: glow polyline + per-point Saffir–Simpson category dots + a marker that walks the track over ~12 s + an honest "historical analog — not a forecast" label at landfall; all `_track()`ed; spiral-only fallback when no file (e.g. Jakarta — deliberately no analog). IBTrACS added to `attribution.json`. **Phase 2 (surge footprint) built in code 2026-07-12:** `bake_tracks.py` now computes a category-typical bathtub surge by reusing `bake_geodata.py` (`download_dem`/`read_dem_mosaic`/`bathtub_delta`/`mask_to_rings`) — guarded so track-only still bakes where geo deps/DEM are absent (e.g. the sandbox); surge height from a cited `SURGE_HEIGHT_M` table keyed on peak category, never storm-modeled. Schema gains an optional `surge:{height_m,area_km2,rings}`; `_renderHurricaneSurge` draws teal bathtub polygons (fade-in) + a "category-typical, bathtub" extent label; all `_track()`ed. **Surge geometry only appears after the CI DEM bake runs** (no seed — fabricating surge polygons would violate rule #4), so today's committed seed is track-only. `attribution.json` now has IBTrACS **and** Copernicus GLO-30 entries (the pre-existing Copernicus gap is closed). **Still open:** Phase 3 SLOSH-MOM fidelity + more metros. ⚠ Run `npm run verify` locally + a manual "hurricane in New Orleans" check (mount can't run either here).
    *Progress 2026-07-12 (drought):* **Drought render upgraded** — same treatment heatwave got. `_renderDrought` now polygon-binds the drought zone to the real country boundary via `CountryGeometry` (`getCountryFeature` + `featureToPolygonRings`), ellipse only as the null/unknown-target fallback; the animated green→amber→brown color + concentric crack rings (radial decoration) are kept, `mag` sizes visuals only. The `round(mag)` severity name (Abnormal…Exceptional) — a fabricated on-screen stat despite a baked `drought_index` existing — is **gone**, replaced by a baked label from the ImpactStats drought branch: `index N.NN (0 = none, 1 = extreme) (CMIP6 <ssp>)` + baked precip change + nearest-city callout. **Interim, not the full admin-1 choropleth:** that needs baked sub-national boundaries (`bake_geodata.py` admin-1, item #14 — not done); national polygon is the honest stand-in. ⚠ `npm run verify` locally.
    *Progress 2026-07-12 (wildfire):* **Wildfire label upgraded.** `_renderWildfire`'s `Severity <mag>/10` label (fabricated from the parser magnitude) is **gone**, replaced by a baked label from the ImpactStats wildfire branch: `+X.X°C anomaly (CMIP6 <ssp>)` (the fire driver) + baked precip change (appends "— drier fuels" only when precip < 0, so it never contradicts a wetter projection) + nearest-city callout. **Deliberately NOT polygon-bound:** unlike heatwave/drought, a wildfire is localized — binding a burn scar to the whole country boundary would falsely imply the nation is ablaze — so the fire/smoke/ember particle systems + expanding burn scar stay centroid-anchored (correct). **Still open (fuller version):** land/cropland mask (fire only on burnable land) + directional smoke drift — both need the baked land-cover mask from `bake_geodata.py` (item #14, not done). ⚠ `npm run verify` locally.
    *Progress 2026-07-12 (conflict):* **Conflict label upgraded — completes all 6 ready-tier events.** `_renderConflict`'s `<Local…Global> scale` label (fabricated from parser magnitude) is **gone**, replaced by a baked label from the ImpactStats conflict branch: national population (World Bank) + climate driver (`+X.X°C anomaly (CMIP6 <ssp>) — water/crop stress`) + nearest-city callout. **Added the mandatory analog framing on-screen** — a fixed "illustrative displacement — not a prediction" line (the ImpactStats conflict caveat requires this event never read as a country-pair forecast). The 8 displacement flow spokes stay **schematic/radial on purpose** — arcs to real named destinations would imply migration routes we can't predict; `mag` sizes visuals only. **Still open (fuller version):** real named-place displacement arcs with analog framing (item #15's original spec) — deferred as it risks over-claiming without a defensible analog dataset. ⚠ `npm run verify` locally.
    *Progress 2026-07-16 (eyeball close-out + wave 3):* **§2+§4 eyeball pass DONE** (user, real machine): all hurricane/SLR/generic checks pass; one finding — solar storm drew its placeholder circle mid-Atlantic (`_getCenter()` ocean fallback) → `_renderPlaceholder` now draws nothing when there's no real anchor (no `params.center`, no centroid); chat scope disclosure is the content. **Rule #4 intensity audit DONE:** wildfire/conflict/generic clean (mag → size/density only); heatwave violated it — shimmer + ring strength was `mag/5`, now a function-uniform `intensityRef` re-driven by the baked temp anomaly once ImpactStats loads; mag only seeds pre-stats + sizes the footprint. **Regression caught same day (user eyeball):** the first mapping (`clamp(anomaly/4, 0.15, 1)`) made 2025 heatwaves invisible (+0.7 °C → 0.17 intensity ≈ no shimmer, ring alpha ≤0.07). Corrected to `0.45 + 0.55·clamp(anomaly/4.5, 0, 1)` — perceptible baseline announces the scenario (like the hurricane Cat-N spiral); the baked anomaly drives the ordering (rule #4 = data drives severity ordering, baseline is scenario framing). Re-eyeball owed: heatwave at 2025 vs 2100 SSP5 should now visibly differ. **Landmask desert exclusion (code):** `bake_landmask.py` now subtracts NE 1:10m geography-regions `featurecla=Desert` polygons (decision locked: NE named deserts over MODIS/ESA — no auth, tiny CI; WorldCover stays the fuller follow-up); degrades to land−ice if the desert fetch fails (`_meta.desert_excluded`); validator gains burnable-fraction (8–35%) + desert-excluded warnings; `nearestBurnable` search bumped 10→40 rings (~1,100 km) so a centroid deep in the Outback escapes the desert complex — this is what fixes fire-on-sand + gives vegetation-biased placement. Data lands on the next `landmask` dispatch. **Wave-3 metros (code):** norfolk (Isabel 2003, NA) + shanghai (In-fa 2021, first WP-basin entry — watch the name+season fallback in the log) in `bake_tracks.REGISTRY`; norfolk/lagos/shanghai/rotterdam in `bake_geodata.METROS` (lagos + rotterdam SLR-only by design — no defensible TC analog; rotterdam carries an explicit below-sea-level/Delta-Works bathtub caveat note) and in the JS `FLAGSHIP_METROS`. Data needs serialized dispatches: `geodata` → `tracks` → `elevation`. **Consent versioning:** ConsentState flag now `accepted:<CONSENT_VERSION>` (see launch-blocker #1 note). ⚠ Run `npm run verify` + py_compile on the real machine before committing (sandbox mount can't).
    *Progress 2026-07-12 (audit/cleanup):* Post-session audit of `ActiveSimulation.js`. **Perf:** removed a redundant per-frame `requestRender` postRender listener in `_renderHurricaneTrack` (the spiral's rotation listener already forces the render; the marker's CallbackProperty rode on it). **Dedup:** extracted two shared render helpers — `_addStatLabel(lon,lat,text,color)` (replaced 4 identical label-entity blocks in heatwave/drought/wildfire/conflict) and `_addCityPins(cities)` (replaced the 2 byte-identical city-pin loops in SLR + hurricane); ~90 lines of duplication gone, styling now single-sourced. **Verified:** `flyToISO` uses `getCentroid`'s `{lat,lon}` shape correctly; no window.*/inline-ISO/innerHTML regressions; imports all still used. No behavioral change intended — pure cleanup. ⚠ Run `npm run verify` + a manual event render locally (mount still can't execute in-sandbox).
16. ~~**Extend the same pattern to `schema`-tier (19) and `noted`-tier (10) events**~~ ✅ 2026-07-14 — `_renderGenericEvent` in ActiveSimulation.js: all schema/noted events route to the shared template (dispatch branches on EVENT_TYPES status; non_climate/unknown keep the placeholder). Three extent modes for honesty: `national` (real country polygon, 11 country-scale events), `ocean` (6 marine events), `local` (default — localized hazards never paint a whole nation). ImpactStats default-branch label + city pins; magnitude sizes visuals only; fixed "not a modeled footprint" line on-screen. Bespoke renders later just claim their strategy string in the routes map. No prompt/EVENT_TYPES change → no edge resync.
    *Also 2026-07-14:* **Phase A #4 done (code)** — new `pipeline/bake_city_elevation.py` backfills `mean_elev_m` (DEM window-mean, land cells only) for all cities inside flagship tile coverage; wired into bake_all + `--only elevation` dispatch + new `cities` validator. **Hurricane Phase 3** — houston/Ike (+ 5th SLR flagship via bake_geodata.METROS) and dhaka/Sidr (NI basin, track-only) added; NAME+SEASON SID fallback in bake_tracks; SLOSH-MOM assessed + deferred (see HURRICANE_TRACKS_PLAN.md). *Close-out 2026-07-14 (later same day):* pull done; static checks + `npm run verify` green on the real machine; commit 4371661 pushed; all three dispatches ran serialized and landed (slr_houston, hurricane_houston/Ike + surge, hurricane_dhaka/Sidr track-only, cities.json elevation-enriched — Miami 3.3 m, was null). **Cron regression fixed:** the 2026-07-13 weekly run had regenerated cities.json from GeoNames (city-proper ranking → no Miami row, coastal flags lost); fetch_cities.py is now Natural-Earth-first, validate.py gained a flagship-anchor tripwire, dataset regenerated + flags restored. ⚠ Only remaining: the manual render eyeball pass — `VERIFY_CHECKLIST_2026-07-14.md` §2 + §4.

**Known bugs (open)**

13. **Sparse data disclosure in UI** — layers grey-fill sparse-tier countries but there's no user-facing notice. Current bake is all-"high" tier, so low priority.

**Fixed / closed 2026-07-04 → 2026-07-05**

- Bugs #9–#12 were already implemented in code (verified 2026-07-04: clean build + `npm run verify` pass): CSP relaxed to `frame-src 'self' blob: about:` (+ "Open in tab" fallback); `session_end` uses keepalive delivery; `simulation:complete` taxonomy resolved; ActiveSimulation imports centroids from `RegionCentroids.js`.
- `ssp:changed` now emitted by `TimeController.setSSP()` (2026-07-04) — TelemetryService subscribed to it but it was never fired; SSP switches were missing from session stories.
- Edge function `parse-scenario` deployed with fresh `ANTHROPIC_API_KEY`; live test 200 + valid SimulationCommand (2026-07-05).
- `ALLOWED_ORIGIN` locked to the production Netlify URL (2026-07-05).
- Netlify production deploy live at `https://chipper-faun-a051b1.netlify.app` (full `dist/` from `npm run build`; first attempt was index.html-only, fixed). Bundle/data/CSP headers verified via HTTP probe. Export-modal + live-chat manual checks still pending.
- `telemetry_events` table created + RLS verified anon INSERT-only (2026-07-05) — see launch-blocker #3.

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

## Assistant Handoff — Read This First

This project was architected with a stronger model; you are expected to follow
its decisions, not re-derive them. Three companion resources exist:

- **`DECISIONS.md`** — locked decisions WITH rationale. Read before proposing
  any architectural change.
- **Skills in `.claude/skills/`** — `audit-checklist` (run before releases /
  after multi-file changes), `add-event-type` (the multi-file sync procedure),
  `implement-render` (memory contract + visual template). Use them; they
  encode bugs that already happened once.
- **`npm run verify`** (in `v2-starter/`) — automated invariant checks.
  Run it before reporting ANY multi-file task as complete. If it fails, the
  task is not done.

### Predictable failure modes — check yourself against these

Each of these has happened (or nearly happened) in this codebase:

1. **Editing `EVENT_TYPES` or the system prompt without the other two steps.**
   EVENT_TYPES, `SCENARIO_PARSER_SYSTEM_PROMPT`, and `ActiveSimulation._dispatch`
   must stay in sync, and the edge function must be re-synced AND redeployed
   (`npm run sync-prompt && npx supabase functions deploy parse-scenario`).
   The prompt once drifted 12 events behind.
2. **Inlining what already has a single source.** ISO codes → `normalizeISO()`.
   Country centroids → `RegionCentroids.js`. Year/SSP → `time:changed` events.
   If you're writing a lookup table, stop and grep for the existing one.
3. **Creating Cesium objects without tracking them.** Everything goes through
   `_track()` / `this._owned`, and `destroy()` must remove it. An untracked
   entity is a leak that survives ejection.
4. **Letting the LLM's numbers reach the screen.** Parser output positions and
   sizes visuals; displayed statistics come from baked data only. See
   DECISIONS.md for why this is the project's most important rule.
5. **`innerHTML` with unescaped interpolation.** Use `textContent`, or the
   `escapeHtml()` helper for every interpolated value. This was a real XSS.
6. **Declaring work done without running anything.** `npm run verify`, then the
   manual checks in the `audit-checklist` skill for anything it doesn't cover.
7. **"Improving" locked decisions** (60fps, more SSPs, photorealism, chat
   persistence, direct API calls "just for dev"). Raise with the user; never
   silently deviate.
8. **Testing prompt changes against a stale dev server.** The local parse proxy
   (devParseScenarioPlugin.mjs) imports SCENARIO_PARSER_SYSTEM_PROMPT ONCE at
   dev-server startup — prompt edits need a dev-server restart to take effect.
   And when a restart lands on a new port (5174, 5175…) because the old server
   is still running, the OLD app keeps serving on the old port: confirm which
   port you're testing before concluding a change "didn't work". This burned
   two test cycles on 2026-07-12.

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
