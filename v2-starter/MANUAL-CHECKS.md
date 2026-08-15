# Manual dashboard checks

Operator-verified console items. `npm run verify-ship` fails if any `verified`
date is missing or older than 90 days. Re-verify in the live dashboards and
update the date when you confirm.

| id | check | verified |
|----|-------|----------|
| rls-on | RLS enabled on `telemetry_events` | 2026-08-03 |
| anon-insert | anon key is INSERT-only (SELECT / UPDATE / DELETE blocked) | 2026-08-03 |
| admin-policy | admin SELECT policy is identity-scoped (operator JWT only) | 2026-08-03 |
| signup-disabled | public signup disabled in Supabase Auth | 2026-08-03 |
| anthropic-ceiling | Anthropic credit / spend ceiling set; auto-reload off | 2026-08-03 |
| cesium-token | Cesium ion token scoped and URL-restricted to production host | 2026-08-03 |

## Eyeball / live chat testing

Do eyeball passes in a **real browser** (Chrome, Edge, Firefox) against
`localhost` or production — **never** Cursor's embedded Simple Browser.

Simple Browser is a VS Code webview. Its origin is not a normal page origin,
so the parse-scenario edge function's origin validation rejects the request
before the model call. Symptom: immediate generic chat failure, ~31 ms CPU,
no exception in Supabase logs. That is the origin check working correctly.
Do **not** add the webview origin to the allowlist to make in-IDE testing work.

**Before starting an eyeball pass:** confirm the page's loaded JS bundle matches
`dist/assets/` (DevTools → Network, or View Source → `script`/`module` href).
A stale `vite preview` or cached tab can serve yesterday's hash while `src/`
already has today's fix — two separate environment traps in one session cost
more time than the features did. If they diverge, rebuild and hard-refresh
(or restart preview) before testing.
