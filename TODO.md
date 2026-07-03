# Earth Simulator V2 — Launch Checklist

Things that must be done before public traffic. Tracked here so they don't get
lost between sessions. See CLAUDE.md → Open Action Items for full context.

## Pre-launch (blockers)

- [ ] **Privacy policy + Terms of Service + telemetry consent notice**
  - Telemetry stores full chat text remotely (Supabase), and the system prompt
    invites users to share emotional/personal context — disclosure is mandatory.
  - Add a first-visit consent banner in the UI (block telemetry until accepted).
  - Host privacy policy + ToS pages and link them from the banner and footer.

- [ ] **Data source attribution UI**
  - `public/data/attribution.json` exists but is invisible in the app.
  - Add an "About the data" / attribution modal or footer link that renders it.
  - Required for CC BY 4.0 compliance (CMIP6, World Bank).

- [ ] **Supabase RLS verification**
  - Confirm the anon key can ONLY INSERT into `telemetry_events` (no SELECT/UPDATE/DELETE).
  - Confirm SELECT requires the service role key.
  - Test from the browser console with the anon key to prove it.

- [ ] **Anthropic spend cap**
  - Set a monthly spend limit in the Anthropic console before any public traffic.
  - Optional: usage alerts at 50% / 80%.

- [ ] **ALLOWED_ORIGIN on the edge function**
  - Currently defaults to `*`. Set it to the production Netlify URL:
    `npx supabase secrets set ALLOWED_ORIGIN=https://<your-site>.netlify.app`
  - Redeploy: `npx supabase functions deploy parse-scenario`

## Post-launch verification

- [ ] Export modal renders on Netlify (CSP was relaxed to `frame-src 'self' blob: about:`;
      "Open in tab" fallback exists if the iframe is still blank).
- [ ] `session_end` telemetry rows appear in Supabase after closing the tab.
- [ ] Admin session viewer requires auth in production.
