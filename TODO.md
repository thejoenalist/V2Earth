# Earth Simulator V2 — Launch Checklist

Things that must be done before public traffic. Tracked here so they don't get
lost between sessions. See CLAUDE.md → Open Action Items for full context.

## Pre-launch (blockers)

- [x] **Privacy policy + Terms of Service + telemetry consent notice** — built 2026-07-05.
  - First-visit consent banner (`src/ui/ConsentBanner.js` + `#consent-banner` in
    index.html); TelemetryService buffers pre-consent, flushes on accept, drops on
    decline — NO Supabase write before accept. Decline = app fully works, telemetry
    off for the session, banner re-asks next visit.
  - Consent flag is the one approved localStorage use (`earthsim.telemetryConsent`,
    accept only) — DECISIONS.md amended with rationale; single source
    `src/core/ConsentState.js`; new EventBus event `consent:changed`.
  - `public/privacy.html` + `public/terms.html` drafted (ship in dist/), linked from
    the banner and the new footer. ⚠ Copy is a careful draft, NOT legally reviewed —
    get it checked before public traffic (see session notes for flagged gaps:
    jurisdiction/GDPR-CCPA specifics, contact address placeholder, IP-in-logs wording).

- [x] **Data source attribution UI** — built 2026-07-05.
  - "About the data" footer link → modal (`src/ui/AttributionModal.js`) rendering
    `public/data/attribution.json`; textContent-only rendering; CC BY 4.0 satisfied.

- [x] **Supabase RLS verification** — done 2026-07-05.
  - Finding: `telemetry_events` did NOT exist — all telemetry inserts had been failing
    silently. Created via SQL editor (`id` identity PK, `"sessionId"` text, `"timestamp"`
    timestamptz, `event` text, `payload` jsonb, `inserted_at` timestamptz); RLS enabled;
    single anon INSERT-only policy.
  - Verified with the anon key over REST: INSERT 201; SELECT returns `[]`;
    UPDATE/DELETE affect 0 rows.
  - Cleanup: one leftover test row, sessionId `rls-test-2026-07-05`.

- [ ] **Anthropic spend cap**
  - Set a monthly spend limit in the Anthropic console before any public traffic.
  - Optional: usage alerts at 50% / 80%.

- [x] **ALLOWED_ORIGIN on the edge function** — done 2026-07-05.
  - Set to `https://chipper-faun-a051b1.netlify.app` (was `*`); `parse-scenario`
    redeployed. Also: stored `ANTHROPIC_API_KEY` (2026-06-18) was invalid
    (Anthropic 401 → 502) — replaced with current key; live test 200 + valid
    SimulationCommand.

- [x] **Admin session viewer — magic-link gate** — decided + built 2026-07-05.
  - `admin/session_viewer.html` rewritten: Supabase Auth magic-link sign-in
    (`signInWithOtp`, `shouldCreateUser: false`), data loaded with the signed-in
    user's JWT via supabase-js. The service role key NEVER enters the browser
    (old paste-key flow removed). Also fixed: chat text was interpolated into
    innerHTML (XSS from telemetry rows) — now textContent-only. Still not in `dist/`.
  - [x] ADMIN_SETUP — completed + verified end-to-end 2026-07-06: operator user
    created; viewer URL allow-listed (`http://localhost:5173/admin/session_viewer.html`);
    `operator select` policy in place (was already present — confirmed it targets the
    operator email); magic-link sign-in works; Load Sessions renders real session
    stories via the operator JWT; anon key re-proven blocked over REST
    (SELECT `[]`, UPDATE 0 rows, DELETE 0 rows). **M5 complete.**

## Post-launch verification

Production is live at `https://chipper-faun-a051b1.netlify.app` (2026-07-05; full `dist/`
deploy — first attempt was index.html-only, fixed). Bundle/data/CSP headers verified via
HTTP probe. Still to check manually in the browser:

- [ ] Export modal renders on Netlify (CSP was relaxed to `frame-src 'self' blob: about:`;
      "Open in tab" fallback exists if the iframe is still blank).
- [ ] Live chat end-to-end against the deployed edge function.
- [ ] `session_end` telemetry rows appear in Supabase after closing the tab.
- [x] Admin viewer: magic-link gate verified 2026-07-06 (see ADMIN_SETUP above);
      viewer stays local-only, not in `dist/`.

Also verified 2026-07-06: consent banner functioning on production after the
full-`dist/` redeploy (user-confirmed).

## Engineering follow-ups (from 2026-07-04 audit)

- [x] **Fix `drought_index` bake** — done 2026-07-05. `drought_index()` in
      `pipeline/fetch_cmip6.py` now blends 0.6 × precip deficit (−precip/60) with
      0.4 × evaporative-demand term (temp_anomaly/6, clamped); precip-only fallback
      when tas is null so sparse records are unchanged. Re-baked (246 countries) +
      `validate.py` PASS. USA now 0.037 (2025) → 0.228 (2100 SSP5-8.5); nonzero
      records 83% (was ~40%). Note: manifest `baked_at` still 2026-06-13 — only
      climate.json was re-baked; run `bake_all.py` for a full refresh.

- [ ] **scenario_compare + timeline_jump globe behavior (bug #8)** —
      `EventSimulator._onRequested` only acts on `climate_event` and
      `region_inspect`. Add real handling so SSP-comparison and year-jump queries
      drive the globe (timeline_jump partially works via ChatInterface chapter snap).

- [x] **Privacy/consent + attribution UI** — built 2026-07-05; see Pre-launch
      blockers above for details. Remaining: legal review of the drafted copy,
      redeploy `dist/` to Netlify so the banner/pages go live.

- [x] **Refresh CLAUDE.md stale sections** — done 2026-07-05: Known Bugs #9–#12 moved
      to fixed; blocker #5 narrowed to the spend cap; RLS/deploy/Netlify/admin-viewer
      findings folded in; Security Architecture + Milestone M5 rows corrected.

## Done / verified 2026-07-05

- [x] Edge function `parse-scenario` deployed (CLI logged in + linked,
      `silryqzempbblleqaokv`); invalid stored `ANTHROPIC_API_KEY` replaced;
      live test 200 + valid SimulationCommand.
- [x] `ALLOWED_ORIGIN` locked to production URL.
- [x] Netlify production deploy live; bundle/data/CSP verified via HTTP probe.
- [x] `telemetry_events` table created; RLS anon INSERT-only verified over REST.
- [x] `npm run verify` green locally. (Note: stale June-29 node process holds
      port 5173, so `npm run dev` uses 5174 — kill it to reclaim the port.)

## Done / verified in 2026-07-04 audit

- [x] `ssp:changed` now emitted by `TimeController.setSSP()` — SSP switches were
      subscribed by TelemetryService but never fired, so they were missing from
      session stories. Fixed + build/verify green.
