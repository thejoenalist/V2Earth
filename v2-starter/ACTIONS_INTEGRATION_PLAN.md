# Actions Integration Plan — Baked Climate-Action Catalog

Status: proposal (2026-07-12). No code written yet.
Origin: incorporate five curated climate-action sources into the sim so every
`local_action` / `resilience_plan` / quiz flow ends on concrete, *sourced* next steps.

Sources to incorporate:
- UN ActNow — Ten Actions (per-action CO2e savings) — https://www.un.org/en/actnow/ten-actions
- COTAP — 25+ Ways to Reduce Your Carbon Footprint (sector depth) — https://cotap.org/reduce-carbon-footprint/
- Climate Responsible — tiered effort/impact framework — https://www.climateresponsible.org/what
- EPA — Community-Scale Action (community + civic tier) — https://www.epa.gov/climate-change/what-you-can-do-about-climate-change-community-scale-action
- EarthDay.org — Act on Climate Change

---

## Why this fits the existing architecture

The sim's stated mission is to leave the user with "a concrete next step grounded
in their specific place, role, and situation." Three payloads already exist for that
and currently lean on the LLM to invent the content:

| Surface | Payload field | Today | With the catalog |
|---|---|---|---|
| `local_action` | `LocalActions.opportunities[]` | LLM improvises actions | Parser *selects* from a baked, filtered catalog |
| `empowerment_quiz` | `QuizQuestion.category` (`individual`/`community`/`policy`/`economic`/`emergency_prep`) | LLM invents choices | Choices seeded from catalogued actions by category |
| report card | `EmpowermentReport.nextSteps[]` | LLM writes 3 steps | Steps point at catalogued actions with real savings |

Source-to-category mapping is clean: UN ActNow + COTAP → `individual`; EPA
community-scale → `community` + `policy`; Climate Responsible → the effort/impact
tier that orders them; EarthDay → cross-cutting civic/advocacy.

---

## The one constraint this must respect

Locked rule #4 ("the LLM's numbers never reach the screen") and rule #5 ("all data
baked at build time"). The UN/COTAP lists ship with specific figures — car-free
≈ 2 t CO2e/yr, oil/gas → heat-pump ≈ 900 kg, mixed → vegetarian diet ≈ 500 kg
(≈ 900 kg vegan), one fewer long-haul return flight ≈ 2 t, cutting food waste
≈ 300 kg. **None of these may be LLM-synthesized if they appear in the UI.**

Therefore the numbers and copy live in a baked JSON file. The parser's only job is
to pick *which* action IDs to surface for a given region/hazard/sector — never to
author the savings or the text. This is the same discipline `ImpactStats.js` already
enforces for hazard statistics.

---

## Proposed deliverable: `public/data/actions.json`

A static, hand-authored (not API-fetched) catalog. Suggested schema per entry:

```json
{
  "id": "transport-car-free",
  "title": "Live car-free",
  "sector": "transport",              // home_energy | transport | food | waste | water | community | civic | financial
  "scope": "individual",              // individual | household | community | policy
  "tier": 2,                          // 1–4, Climate Responsible effort/impact ordering
  "co2e_savings_kg_per_year": { "low": 1500, "high": 2000, "basis": "vs. car-owning lifestyle" },
  "summary": "Walk, bike, or take transit instead of driving.",
  "applicableHazards": ["heatwave", "sea_level_rise"],  // optional: link to sim hazards
  "source": { "name": "UN ActNow", "url": "https://www.un.org/en/actnow/ten-actions", "license": "UN / public info" }
}
```

Field notes:
- `tier` comes from Climate Responsible's effort/impact framing (1 = calculate your
  footprint; 2 = easy + consequential; 3 = harder; 4 = max). Lets `local_action`
  lead with low-hanging fruit before expensive steps.
- `scope` is what lets EPA's community/civic actions surface for `resilience_plan`
  and the quiz's `community`/`policy` categories, which are currently thin.
- `co2e_savings_kg_per_year` is nullable — many EPA community actions have no
  clean per-person figure, and that's fine; the UI just omits a number rather than
  inventing one.
- `applicableHazards` is the join key to the sim: a `local_action` for a coastal,
  heat-exposed city surfaces actions tagged with those hazards first.

---

## Wiring (when built — out of scope for this plan)

1. **Loader** — add `ActionCatalog.js` (mirror the `ImpactStats.js` pattern): load
   `actions.json` once, expose `select({ sector, scope, hazards, tier, limit })`.
2. **`local_action`** — after the parser returns, replace/augment `opportunities[]`
   with `ActionCatalog.select()` filtered by the region's dominant hazards. Parser
   prompt changes to *reference action IDs*, not free-text savings.
3. **Quiz** — seed `QuizQuestion.choices` from catalogued actions per category so
   the "correct/high-impact" answer and its `rationale` trace to a real source.
4. **Report card** — `nextSteps[]` become `{ text, savings, sourceUrl }` drawn from
   the catalog.
5. **Pipeline** — add `pipeline/bake_actions.py` (or keep hand-authored + a
   `validate.py` schema check: required fields, tier ∈ 1–4, savings low ≤ high,
   every `source.url` present).
6. **Attribution** — add UN ActNow, COTAP, EPA, Climate Responsible, EarthDay to
   `public/data/attribution.json` (surfaced by `AttributionModal.js`).

## Follow the existing multi-file discipline

- No `window.*`; catalog reaches layers via the normal payload path.
- Numbers on screen come only from `actions.json` (rule #4).
- Run `npm run verify` before calling any implementation step done.
- If quiz/`local_action` schemas change, keep `SimulationCommand.js`,
  `SCENARIO_PARSER_SYSTEM_PROMPT`, and the edge function in sync
  (`npm run sync-prompt && npx supabase functions deploy parse-scenario`) —
  the prompt-drift failure mode.

---

## Smallest useful first slice

Ship `actions.json` (≈ 20–30 entries covering the UN ten + COTAP sectors + a
handful of EPA community actions) plus the `attribution.json` entries, and wire
**only** `local_action.opportunities[]` to it. That alone converts the sim's most
common "what can I do here" answer from improvised to sourced, with zero quiz/report
schema churn. Quiz and report-card wiring follow as a second slice.
