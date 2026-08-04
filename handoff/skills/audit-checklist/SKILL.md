---
name: audit-checklist
description: Run a mechanical code audit of Earth Simulator V2. Use before any release, after any multi-file change, or when the user says "audit", "review the code", or "check for bugs". Every check below is derived from a real bug class found in this codebase — do not skip any.
---

# Earth Simulator V2 — Audit Checklist

Run every check. Report each as PASS / FAIL / WARN with file:line evidence.
Do not reason about whether a check "probably" passes — run the grep and look.

First run the automated half: `npm run verify` (in `v2-starter/`). It covers
checks marked [auto] below. After any production client deploy (or when claiming
a ship is live), also run `npm run verify-ship` — it compares local `SHIP_MARKERS`
against the deployed Netlify bundle (deploy-skew tripwire; see §8). Then do the
manual checks.

## 1. XSS / injection [manual]
Bug class: `report.grade` was injected into `innerHTML` unescaped (fixed 2026-07-03).

- `grep -rn "innerHTML" src/` — every hit must be either (a) a static template
  with zero interpolated values, or (b) all interpolations wrapped in the local
  `escapeHtml()` helper. User text and LLM output must use `textContent`.
- No `insertAdjacentHTML`, `document.write`, or unescaped template-literal HTML.
- If markdown/HTML rendering has been added anywhere: DOMPurify must be in
  package.json and applied. If it isn't, FAIL.

## 2. CesiumJS memory leaks [manual]
Bug class: layers/simulations leaking entities, primitives, listeners.

- In `ActiveSimulation.js`: every `entities.add`, `primitives.add`,
  `postProcessStages.add`, and `postRender.addEventListener` must be wrapped in
  `this._track(...)` or pushed to `this._listeners`. Grep each and verify.
- Every class extending `LayerContract` must implement `destroy()` and remove
  everything it created. `destroy()` must also be reachable (called from
  EventSimulator eviction or main.js teardown).
- New timers (`setTimeout`/`setInterval`) must be cleared in `destroy()`.

## 3. Event taxonomy parity [auto]
Bug class: system prompt drifted 12 events behind `EVENT_TYPES` (fixed 2026-07-03).

- Every key in `EVENT_TYPES` appears in `SCENARIO_PARSER_SYSTEM_PROMPT`.
- Every `ready`-status event's `render` strategy has a route in
  `ActiveSimulation._dispatch()`.
- The prompt block in `supabase/functions/parse-scenario/index.ts` matches the
  canonical prompt (sync-prompt drift check).
- If the prompt changed: remind the user `npx supabase functions deploy parse-scenario`
  is still required. Code sync alone does NOT update production.

## 4. Architecture invariants [auto + manual]
- No `window.*` global assignments in `src/` (EventBus only).
- No inline ISO normalization — any alpha-2→alpha-3 mapping outside
  `src/core/ISONormalizer.js` is a FAIL.
- Layers never read TimeController state directly; they consume `time:changed`.
- Every event name emitted on EventBus exists in the CLAUDE.md taxonomy table.
  If a new event was added to code, CLAUDE.md must be updated in the same change.
- Max 3 concurrent simulations still enforced in `EventSimulator`.

## 5. Chat robustness [manual]
Bug class: one failed API request broke user/assistant role alternation and
bricked chat for the whole session (fixed 2026-07-03).

- In `ScenarioParser.js`: a failed/invalid response must not leave an orphaned
  user turn in the rolling history. Trace the error path explicitly.
- Schema validation runs on every command BEFORE `simulation:requested` is
  emitted, and uses `Object.hasOwn` (not `in` / truthy lookup).

## 6. Security & telemetry [manual]
- No API keys, service-role keys, or secrets anywhere in `src/` or committed
  files. `grep -rn "sk-ant\|service_role" src/ supabase/` (anon key in the
  client is acceptable; service role is not).
- `.env` / `.env.local` in `.gitignore`.
- Telemetry unload path uses `sendBeacon` or `fetch(..., keepalive: true)` —
  a plain async insert in `beforeunload` silently loses `session_end`.
- Edge function: max query length enforced, `ALLOWED_ORIGIN` not `*` in prod.

## 7. Data & licensing [auto]
- `public/data/attribution.json` exists and cites CMIP6 + World Bank (CC BY 4.0).
- `public/data/manifest.json` has a `baked_at` timestamp.
- No runtime fetches to external climate APIs from `src/` (baked data only).

## 8. Deploy skew / verify-ship [auto]
Bug class: support path shipped broken 2026-08-03 — edge returned `type:"support"`
while production JS still lacked the client path. Local verify passed; only
manual live testing caught it.

- Run `npm run verify-ship` (in `v2-starter/`). Every marker in
  `scripts/verify-ship.mjs` → `SHIP_MARKERS` that exists in local source must
  appear in the live production bundle (`SHIP_URL`, default joenalism.netlify.app).
- Prefer EventBus event names / URL literals as needles (survive minification).
- When adding a client feature that must not lag the edge/API, add a `SHIP_MARKERS`
  entry in the same change.

## Report format
End with a table: check | status | evidence. Then a one-paragraph verdict:
safe to ship / blockers found. Never say "looks good" without having run the
greps in this session.
