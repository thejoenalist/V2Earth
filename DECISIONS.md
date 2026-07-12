# DECISIONS.md — Locked Decisions and Why

CLAUDE.md lists *what* is locked. This file records *why*, so a future
assistant doesn't relitigate a decision it doesn't understand. If you find
yourself about to argue against one of these, read its rationale first, then
raise it with the user — never silently deviate.

## Data integrity

**All displayed statistics come from baked data, never from the LLM.**
The parser (Claude Haiku) decides *what to show and where*; it must never be
the source of on-screen numbers. Rationale: an environmental scientist
reviewed the app and flagged LLM-synthesized stats as the credibility killer.
A climate tool that hallucinates numbers is worse than no tool. This is the
single most important rule in the project.

**All data baked at build time; no runtime climate-API calls.**
Rationale: free-tier hosting (bandwidth + invocation caps), reproducibility
(a deploy is a snapshot with a `baked_at` timestamp), and no API keys or rate
limits in the client. The weekly GitHub Action is the only thing that
refreshes data.

**4 chapters (2025/2050/2075/2100), SSP2-4.5 + SSP5-8.5 only, nothing past 2100.**
Rationale: CMIP6 coverage is solid for these; beyond 2100 is speculation the
project explicitly refuses to visualize. Two SSPs keep the mental model
simple: "likely path" vs "worst case." Default SSP2-4.5 because the product
goal is empowerment, not doom — the optimistic-but-achievable framing is a
product decision, not a data limitation.

## Architecture

**EventBus only; no `window.*` globals.**
Rationale: V1 died of tangled cross-module references. The bus makes every
interaction greppable (the taxonomy table in CLAUDE.md is the contract) and
lets modules be destroyed/rebuilt independently.

**One `normalizeISO()`, mirrored in Python.**
Rationale: ISO drift between pipeline and frontend caused silent country
mismatches (data present but never rendered). One JS source + one Python
mirror; any third copy will eventually disagree.

**TimeController is the single source of truth for year/SSP.**
Rationale: layers caching their own year is how stale-data bugs happen — one
already did (hidden layers missed `time:changed`; fixed by forwarding events
to hidden layers in LayerContract).

**Max 3 concurrent simulation layers, 30fps target.**
Rationale: performance budget for mid-range laptops, and 30fps is deliberate —
users screen-record the globe; dropped frames in recordings look broken.
Don't "optimize" to 60fps at the cost of particle richness.

**Claude API only via the Supabase Edge Function.**
Rationale: keys must never reach the browser, and the function is the one
place for rate limiting, query-length caps, and origin checks. There is no
acceptable "temporary" direct-from-browser call, even for local debugging —
use the dev plugin (`scripts/devParseScenarioPlugin.mjs`).

## Product

**Simulator and game are separate; V2 is the simulator only.**
Rationale: scope control. Game mechanics (win states, resources) were cut so
V2 could ship. Don't reintroduce them as "small features."

**Renders are procedural set-pieces, not live physics.**
Rationale: believability per watt. Real physics can't hit 30fps on a laptop
in a browser, and abstract-but-honest beats realistic-but-wrong.

**Earthquake/volcanic are in scope WITH climate framing; solar_storm gets an
honest scope disclosure.**
Rationale: users will ask about them regardless. Pretending the app can't
hear the question erodes trust; answering honestly about scope builds it.
The framing (isostatic rebound, deglaciation-volcanism) is real science, but
it must be presented as a connection, not a claim that climate causes
earthquakes.

**No chat history across sessions; telemetry stores session stories.**
Rationale: privacy posture — the chat invites personal context, so nothing
persists client-side, and the remote story format exists for the operator to
understand curiosity patterns, not to profile users. This is also why the
privacy policy + consent notice is a hard launch blocker.

*Amended 2026-07-05 (explicit user instruction):* one localStorage exception —
the telemetry **consent flag** (`earthsim.telemetryConsent`, a single boolean
set only on Accept). Rationale: without it the consent banner would nag on
every visit, and the flag contains no personal content, so it doesn't weaken
the privacy posture the rule protects. Decline is deliberately NOT persisted
(session-only), so a "no" is re-asked next visit rather than silently stored.
All reads/writes go through `src/core/ConsentState.js` — no other module may
touch localStorage.

**First load is user-directed; no cinematic intro. Mobile is nice-to-have.**
Rationale: the empowerment goal means the user drives from second one.
Mobile was deferred because CesiumJS + particles on phones is a project of
its own.

## Amending this file
Decisions here change only by explicit user instruction. When one changes,
update the entry with the new rationale and date rather than deleting it.
