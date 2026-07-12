# Task prompt — Earth Simulator V2 (run on Claude Fable 5)

Create a new task, set the model to **Fable 5**, and paste everything below the line as the task prompt. Add your specific ask at the very bottom where noted.

---

You are continuing work on **Earth Simulator V2**, an existing project in this workspace folder. **Read `CLAUDE.md` first** (in the project root) — it is the source of truth for architecture, invariants, and locked decisions. Then skim `DECISIONS.md`, `TODO.md`, and `v2-starter/VISUAL_UPGRADE_PLAN.md`. Follow the locked decisions; do not re-derive or "improve" them.

## What it is

A CesiumJS + Vite 5 Earth simulator: users type climate scenarios in plain language and the globe renders them in 3D while a chat responds. Claude Haiku parses queries into a `SimulationCommand` via a Supabase Edge Function proxy (the Anthropic key never reaches the browser). CMIP6 climate data is baked to static JSON at build time. **All app code lives in `v2-starter/`** — the paths in CLAUDE.md are relative to that folder.

## Hard rules (do not violate)

- No `window.*` globals — everything goes through `EventBus`.
- One `normalizeISO()` (`src/core/ISONormalizer.js`) and one centroid table (`src/globe/RegionCentroids.js`) — grep before writing any lookup.
- `TimeController` owns year + SSP; layers listen to `time:changed`, never read it directly.
- Every Cesium object is tracked in `this._owned` and freed in `destroy()`.
- Displayed statistics come from baked data only — never the LLM.
- `EVENT_TYPES`, `SCENARIO_PARSER_SYSTEM_PROMPT`, and `ActiveSimulation._dispatch` stay in sync; after editing the prompt run `npm run sync-prompt`, then redeploy the edge function.
- Before reporting any multi-file change as done, run `npm run verify` (in `v2-starter/`). If it fails, the task is not done.

## Current state (as of 2026-07-04)

- Milestones M0–M4 and M6 are complete. **M5 (telemetry) is the next milestone**: TelemetryService is done, but two dashboard items are unverified — Supabase RLS (anon key = INSERT-only on `telemetry_events`) and the admin session-viewer auth gate.
- Healthy build: `npm run build` and `npm run verify` both pass (66 modules, 0 failures). Many items in CLAUDE.md's "Known bugs" are already fixed in code — the docs are stale.
- Last fix: `TimeController.setSSP()` now emits `ssp:changed` (telemetry subscribed to it but it was never fired).
- Open engineering follow-ups are logged in `TODO.md`:
  1. Fix the `drought_index` bake — `pipeline/fetch_cmip6.py:144` uses `clamp(-precip_change_pct / 60, 0, 1)`, so ~60% of records (incl. USA) read 0.0. Rework to factor in heat / evaporative demand, then re-bake and re-run `validate.py`.
  2. Add `scenario_compare` + `timeline_jump` globe behavior — `EventSimulator._onRequested` only handles `climate_event` and `region_inspect`.
  3. Build the privacy/consent + attribution UI (launch blockers).
  4. Refresh CLAUDE.md's stale Known-Bugs / Action-Items sections.

## Environment notes

- Shell/`npm` runs in the sandbox; the project folder is mounted. Use the file tools to read/edit, the sandbox for `npm run dev|build|verify`.
- If a build fails with a missing `@rollup/rollup-*` native module, install the platform binary and retry.
- Supabase project ref is `silryqzempbblleqaokv`. Secrets (`ANTHROPIC_API_KEY`, `ALLOWED_ORIGIN`) live on the edge function, set via `npx supabase secrets set ...`; browser vars (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, optional `VITE_CESIUM_ION_TOKEN`) live in `v2-starter/.env.local` (gitignored — never commit keys).
- Still pending and requires my credentials (can't run headless): `npx supabase functions deploy parse-scenario` (prompt is already synced), plus the M5 RLS/admin-auth verification in the dashboard.

## My ask for this task

<Write what you want done here — e.g. "Implement TODO item 1 (drought_index)", "Do a fresh audit and run npm run verify", or "Draft the privacy/consent banner." If left blank, read the docs, run npm run verify, and report the current state plus the single highest-value next step.>
