# Failure log

Date | Title | What happened / fix | Tooling catches it?

---

2026-08-03 | Support path shipped broken (deploy skew) | Local verify passed while production ran older client code. Caught by manual live testing, not by tooling. Fix: support-type short-circuits before validation; `npm run verify-ship` compares deployed bundle against local `SHIP_MARKERS`. | Yes (`verify-ship`)

2026-08-14 | Generic national extent ellipse sits offshore | `epidemic_outbreak` (and other `_renderGenericEvent` national-mode events) showed the label "national extent shown — not a modeled footprint" while drawing a small centroid ellipse ~618 km offshore in the Gulf of Guinea (Accra nearest city). Label claims national extent; geometry is an unconstrained ocean centroid — contradictory and worse than an unlabeled ellipse. Root cause: `_renderGenericEvent` places the ellipse at the event center with no land constraint. Fix (not yet implemented): land-nudge via `LandMaskGeodata` the way wildfire already does. | No

2026-08-14 | Conflict ring axes race kills Cesium render loop | Stacking onto a conflict/displacement render threw `DeveloperError: semiMajorAxis must be greater than or equal to the semiMinorAxis` and stopped rendering entirely ("An error occurred while rendering. Rendering has stopped") until reload — not a visual glitch, a hard loop death. Root cause: conflict shockwave rings used two independent `CallbackProperty` reads of `this._elapsed()` for major and minor with the *same* formula (perfect circle → zero tolerance). Cesium evaluates the callbacks separately; time advances between them so minor can briefly exceed major. Other ring sites survived only because a constant factor (`* 0.75`, `* 0.7`, `* 0.8`) masked the drift — latent race, not safe. Fix: `_ellipseAxisPair()` samples once per `frameState.frameNumber` for both axes, plus a minor≤major clamp in that sample path (`_track()` cannot clamp CallbackProperty values at add time). Rule going forward: paired animated ellipse axes must come from one time sample. | No
