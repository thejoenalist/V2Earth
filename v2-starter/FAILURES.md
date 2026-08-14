# Failure log

Date | Title | What happened / fix | Tooling catches it?

---

2026-08-03 | Support path shipped broken (deploy skew) | Local verify passed while production ran older client code. Caught by manual live testing, not by tooling. Fix: support-type short-circuits before validation; `npm run verify-ship` compares deployed bundle against local `SHIP_MARKERS`. | Yes (`verify-ship`)

2026-08-14 | Generic national extent ellipse sits offshore | `epidemic_outbreak` (and other `_renderGenericEvent` national-mode events) showed the label "national extent shown — not a modeled footprint" while drawing a small centroid ellipse ~618 km offshore in the Gulf of Guinea (Accra nearest city). Label claims national extent; geometry is an unconstrained ocean centroid — contradictory and worse than an unlabeled ellipse. Root cause: `_renderGenericEvent` places the ellipse at the event center with no land constraint. Fix (not yet implemented): land-nudge via `LandMaskGeodata` the way wildfire already does. | No
