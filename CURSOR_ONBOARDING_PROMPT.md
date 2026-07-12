# Cursor onboarding prompt — Earth Simulator V2

Paste everything below the line into a new Cursor chat as your first message.

---

You are picking up **Earth Simulator V2**, an existing project. Before doing anything, **read `CLAUDE.md` in full** — it is the source of truth for architecture, invariants, and locked decisions. Then read `DECISIONS.md`, `TODO.md`, and `v2-starter/VISUAL_UPGRADE_PLAN.md`. Do not re-derive or "improve" locked decisions; follow them.

## What this project is

A CesiumJS Earth simulator where users type climate scenarios in plain language and watch the planet render them in 3D, with a chat that responds concurrently. Vite 5 + vanilla JS modules, no framework. Claude Haiku parses queries into a `SimulationCommand`; a Supabase Edge Function proxies the Anthropic call so the API key never reaches the browser. Telemetry and the API proxy both run on Supabase. Climate data (CMIP6) is baked to static JSON at build time.

**All app code lives in `v2-starter/`.** The repo-structure paths in `CLAUDE.md` are relative to that directory.

## Hard architecture rules (do not violate)

- No `window.*` globals — all cross-module comms go through `EventBus`.
- One `normalizeISO()` (`src/core/ISONormalizer.js`); one centroid table (`src/globe/RegionCentroids.js`). Grep before writing any lookup.
- `TimeController` is the single source of truth for year + SSP; layers listen to `time:changed`, never read it directly.
- Every Cesium object is tracked in `this._owned` and removed in `destroy()`.
- Displayed statistics come from baked data only — never from the LLM. The parser only positions/sizes visuals.
- `EVENT_TYPES`, `SCENARIO_PARSER_SYSTEM_PROMPT`, and `ActiveSimulation._dispatch` must stay in sync; after editing the prompt, run `npm run sync-prompt` and redeploy the edge function.

## Current state (as of 2026-07-04)

- Milestones M0–M4 and M6 are complete. **M5 (telemetry) is the next milestone** — TelemetryService is done, but two things must be verified in the Supabase dashboard: RLS policies (anon key = INSERT-only on `telemetry_events`) and the admin session-viewer auth gate.
- Codebase is healthy: `npm run build` and `npm run verify` both pass. Most items in CLAUDE.md's "Known bugs" are already fixed in code (docs are stale — see TODO.md "Refresh CLAUDE.md").
- Recent fix: `TimeController.setSSP()` now emits `ssp:changed` (was subscribed by telemetry but never fired).
- Open engineering follow-ups are in `TODO.md`: fix the `drought_index` bake (`pipeline/fetch_cmip6.py:144`), add `scenario_compare` + `timeline_jump` globe behavior, build the privacy/consent + attribution UI, and refresh CLAUDE.md.

## What I want to do right now

1. **Get the app running locally so I can view the code and the globe.** Walk me through it:
   - `cd v2-starter && npm install`
   - If the build/dev server fails with a missing `@rollup/rollup-*` native module, install the platform binary for my machine (Windows: `npm install @rollup/rollup-win32-x64-msvc`), then retry.
   - `npm run dev` (Vite on localhost:5173). `npm run build` for a production build, `npm run verify` to check invariants.

2. **Update my Supabase API keys.** Show me exactly where each value lives and what to change:
   - Browser-exposed vars in `v2-starter/.env.local`: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and optional `VITE_CESIUM_ION_TOKEN` (3D terrain). `.env.local` is gitignored — never commit real keys. Template is `.env.local.example`.
   - Server-only secret (never in the browser or the repo): `ANTHROPIC_API_KEY`, set on the edge function via `npx supabase secrets set ANTHROPIC_API_KEY=sk-ant-...`.
   - Production CORS lock: `npx supabase secrets set ALLOWED_ORIGIN=https://<my-site>.netlify.app`.
   - The Supabase project ref is `silryqzempbblleqaokv` (matches `supabase/config.toml` and `.env.local`).

3. **Redeploy the edge function** — this is pending. The system prompt is already synced; it just needs a deploy with my credentials:
   - `npx supabase login`
   - `npx supabase link --project-ref silryqzempbblleqaokv`
   - `npx supabase functions deploy parse-scenario`

4. **Help me verify M5 in the Supabase dashboard:** confirm the anon key can only INSERT into `telemetry_events` (no SELECT/UPDATE/DELETE), that SELECT requires the service role key, and that `admin/session_viewer.html` is gated by Supabase Auth.

Start by reading the docs listed above, then confirm you understand the architecture and give me the exact local-run steps for my OS. Ask me which task to tackle first before making code changes.
