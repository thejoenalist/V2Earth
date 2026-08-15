# TODO

Open product / engineering follow-ups. Not a substitute for CLAUDE.md Open Action
Items or FAILURES.md — those stay the sources of truth for architecture and
known bugs. This file is for deferred feature work noticed in eyeball passes.

---

## Plausibility filter for stack suggestions

**Noticed:** 2026-08-14 eyeball. `region_inspect` on Bangladesh offered a
next-step / stack path into compound fire weather — the least appropriate
hazard for a delta nation known for water excess. The model wrote a defensible
pre-monsoon-dry-spell answer, but the *suggestion* was wrong before the answer
was good.

**Root:** `getStackablePartners()` returns COMPOUND_MAP partners with no check
that the hazard is geographically plausible. Offering wildfire in Bangladesh or
blizzard in Kenya undercuts credibility exactly where the app is trying to earn
it.

**Fix (later):** a plausibility filter over landmask / climate-zone / baked
climate fields (most of that data already exists). Do not implement in the
catastrophe→agency block.
