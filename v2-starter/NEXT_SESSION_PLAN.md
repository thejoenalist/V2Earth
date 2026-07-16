# Next Session Plan — Earth Simulator V2

## SESSION CLOSE-OUT 2026-07-14 — read this block first

Everything below this block is DONE and verified in CI. State at close:

- **All three dispatches ran + landed on main** (geodata → tracks → elevation,
  serialized): `slr_houston.json` (5th SLR flagship), `hurricane_houston.json`
  (Ike + Galveston surge), `hurricane_dhaka.json` (Sidr, track-only, NI basin),
  and `cities.json` elevation-enriched (Miami mean_elev_m 3.3 — was null; 38
  cities total, flagship-scoped by design). Registry SIDs for Ike/Sidr were
  exact (no name+season fallback needed).
- **Cron regression found + permanently fixed:** the 2026-07-13 weekly run
  regenerated cities.json from GeoNames (city-proper ranking) and silently
  dropped Miami + the hand-authored coastal flags. fetch_cities.py is now
  Natural-Earth-first (GeoNames explicit fallback); validate.py has a
  flagship-anchor tripwire; dataset regenerated + coastal flags restored.
- **Still owed (ONLY remaining item from this plan):** the manual render
  eyeball pass — `VERIFY_CHECKLIST_2026-07-14.md` §2 + §4.

Next-session candidates, roughly by value:
1. Manual render pass above, then fix whatever it surfaces.
2. Rule #4 visual-intensity audit (flagged 2026-07-13): heatwave/wildfire/
   conflict may still scale visual *intensity* from parser magnitude (drought's
   fill was fixed) — decoration, not stats, but worth one pass.
3. Wildfire fuller version: MODIS/ESA WorldCover land-cover (desert exclusion +
   vegetation-biased placement) — fixes the Outback-fire-on-sand eyeball.
4. More flagship metros (norfolk, lagos, shanghai, rotterdam) — the whole chain
   (SLR + hurricane + elevation) is now just registry entries.
5. Launch-blocker remainders: legal review of privacy/terms copy; Anthropic
   console spend cap. Plus bug #13 (sparse-data disclosure UI, low priority).
6. Deferred with written rationale: SLOSH-MOM (HURRICANE_TRACKS_PLAN.md),
   conflict named-place arcs, sub-national CMIP6 for the drought choropleth.

---

Written 2026-07-12, end of the per-event render session. Ordering refined with the
user; **Phase B (depth: admin-1 + land-cover) is the chosen priority** after the
Phase A quick wins.

Context: this session brought all six ready-tier events onto the polygon +
ImpactStats + city-callout template, added hurricane analog tracks (Phase 1) +
bathtub surge (Phase 2), gave `scenario_compare`/`timeline_jump` real globe
behavior, and did a dedup/perf audit pass. Several renders are **code-complete but
waiting on CI bakes** — that's the throughline of the plan below.

Operational constant: the Cowork Linux sandbox can't run the DEM/NOAA bakes
(egress is GitHub/PyPI/npm only) and truncates large files on read, so it can't run
`npm run verify` or the Cesium app either. Everything below runs **in CI or on the
real machine**, and each code step ends with a local `npm run verify` + a manual
render check.

---

## Phase A — light up what's already built (cheap; do first)

A feedback loop: turns "code done, waiting on data" into "actually live," and
surfaces any bake bugs while the code is fresh.

*Progress 2026-07-13:* **#1 + #2 DONE (code).** `bake_tracks.py` wired into
`bake_all.py`'s `FETCHERS` immediately after `bake_geodata.py` (surge reuses its
DEM helpers + tile cache). `validate.py` gains a `geodata` validator (+ `--only
geodata`): `slr_*.json` (center/bbox order/levels → `area_km2` ≥ 0 + ring
geometry in range) and `hurricane_*.json` (`_meta.analog.sid` + `peak_category`
1–5, `track` ≥2 pts with `category` 0–5, `landfall` in range, optional `surge`
{height_m>0, area_km2≥0, rings}). Optional-by-design: a missing file/dir warns
rather than errors; a `seed:true` file warns. Traced clean against both committed
files (slr_miami real, hurricane_new_orleans seed → 1 seed warning). Could not run
in-sandbox (mount truncates validate.py on read) — **run `python pipeline/validate.py
--only geodata` on the real machine to confirm.** #3 (run pipeline) + #4 (backfill
`mean_elev_m`) still pending — both need CI / real-machine egress.

1. ~~**Wire `bake_tracks.py` into the pipeline.**~~ ✅ 2026-07-13 — added after
   `bake_geodata.py` in `bake_all.py` `FETCHERS`.
2. ~~**Add `validate.py` geodata checks.**~~ ✅ 2026-07-13 — `validate_geodata`
   covers `slr_*.json` (levels, `area_km2`, rings) and `hurricane_*.json` (track
   category 0–5, `landfall`, IBTrACS `sid`, `peak_category` 1–5; optional `surge`).
3. ~~**Run the pipeline**~~ ✅ 2026-07-14 — all three metros baked (Katrina 31 pts,
   Sandy 40 pts, Andrew 47 pts after SID correction to 1992230N11325), seeds gone;
   SLR expanded to 4 metros. Manual render checks still owed (see
   `VERIFY_CHECKLIST_2026-07-14.md`).
4. ~~**Backfill `mean_elev_m`**~~ ✅ 2026-07-14 (code) — NEW
   `pipeline/bake_city_elevation.py`: DEM window-mean (±0.005°, land cells only,
   water/nodata excluded) for every city inside flagship-metro tile coverage;
   reuses `bake_geodata` helpers + warm `.dem_cache` (wired after `bake_tracks` in
   `bake_all.py`); overwrites hand-authored values (DEM more defensible);
   `--only elevation` workflow dispatch added; new `cities` validator in
   `validate.py` (schema + mean_elev_m bounds + under-enrichment warning).
   Synthetic-DEM unit test green; deps-missing path exits 0. Data lands when the
   `elevation` dispatch runs.

Exit: hurricane flagship is fully live; SLR close-up picks the true low point.

---

## Phase B — depth: admin-1 + land-cover (CHOSEN PRIORITY)

The biggest remaining fidelity lever on the existing events. Both are gated on new
bakes in `bake_geodata.py`; **bake first, then the render that consumes it.**

5. **Admin-1 boundaries bake → full drought choropleth.**
   - Bake sub-national (admin-1) boundaries (Natural Earth admin-1, public domain)
     to `public/data/geodata/` or alongside `countries.geojson`.
   - Upgrade `_renderDrought` from the national-polygon interim to a real per-admin-1
     choropleth colored by baked `drought_index`. (Today it polygon-binds to the
     whole country — honest but coarse.) Needs a per-admin-1 `drought_index`, or
     national value applied per region until sub-national climate is baked — decide
     which is defensible before shipping (rule #4).

   *Progress 2026-07-13 (CODE DONE; data pending CI):* Decision locked with the user
   — **national value applied per region, labeled** (option A; rule #4-clean).
   Built: `pipeline/bake_admin1.py` (Natural Earth 1:50m admin-1 → one compact
   `admin1_<ISO3>.json` per country, shapely-simplified when available, else
   rounded-only; runs in CI, **can't run in the Cowork sandbox — proxy 403s
   raw.githubusercontent**). `src/simulation/Admin1Geodata.js` loader (mirrors
   InundationGeodata; `regionToPolygonRings` flattens to Cesium arrays).
   `_renderDrought` now prefers the admin-1 choropleth (every region filled from the
   NATIONAL `drought_index`, per-region outline for legibility, 250-polygon cap) →
   falls back to the national boundary polygon → ellipse; the label gains a fixed
   "national value shown per region (sub-national CMIP6 not yet baked)" line when the
   choropleth path is used. `validate.py` gains `admin1_*.json` checks; `bake_admin1.py`
   wired into `bake_all.py`; workflow `only` dispatch gains `tracks` + `admin1`.
   **Also fixed a latent gap:** `requirements.txt` lacked rasterio/scipy/shapely that
   `bake_geodata`/`bake_tracks` already import — added (cp311 wheels, no system GDAL).
   ⚠ No admin1 files committed (nothing honest to seed); the choropleth is invisible
   until CI bakes them — until then drought shows the national polygon (unchanged).
   Run `npm run verify`, then a manual dispatch of `admin1` + a "drought in the USA"
   check once the bake lands.

   *Progress 2026-07-13 (bake + severity fix):* CI/manual `admin1` bake landed — 9
   countries / 294 regions committed (Natural Earth **1:50m** only carries admin-1
   for large nations: USA, CAN, BRA, RUS, CHN, IND, IDN, AUS, ZAF — happily the
   drought-relevant giants). Choropleth verified live for the USA; region outlines
   render fine. **Bug caught + fixed on the eyeball:** the fill color was still
   driven by the parser `magnitude` (index 0.09 shown under a severe-orange fill —
   a rule #4 break). `_renderDrought` now fetches `stats` first and drives the fill
   severity AND the ring opacity from the baked `drought_index` (0→1); `magnitude`
   only sizes the footprint/animation now. Broader coverage (all ~200 countries)
   would need the **1:10m** source — deferred (heavier CI fetch; 50m covers the big
   drought nations). Possible follow-up audit: heatwave/wildfire/conflict visual
   *intensity* may still be magnitude-scaled like drought's fill was — worth a rule
   #4 pass, though those are shimmer/particle decoration, not a color-coded stat.

   *Progress 2026-07-13 (coverage broadened to 1:10m):* Switched `bake_admin1.py`
   from Natural Earth **1:50m → 1:10m** — full global admin-1 (~200 countries) vs the
   9 large nations 1:50m carries. Same schema/loader/render; only the source URL,
   fetch timeout (→300 s for the ~100 MB file) and `_meta.source` changed. Re-run the
   `admin1` dispatch to regenerate + commit the global set (overwrites the 9 1:50m
   files). The choropleth then works for any targeted country.

   *Progress 2026-07-13 (wildfire label fix, from the Australia eyeball):* the "By the
   numbers" card hardcoded the wildfire precip basis as "annual — drier fuels" even for
   a POSITIVE precip change (+7.7% shown as "drier fuels"). `ImpactStats.js` now only
   says "drier fuels" when precip < 0, else plain "annual" — matching the globe label.
   Separately, the Australia eyeball confirmed the land+ice mask's known gap: the fire
   anchored on the country centroid (Outback desert) and the mask allows desert, so
   fire renders on sand — the MODIS/ESA land-cover upgrade (#6 follow-up) is what fixes
   both desert exclusion and vegetation-biased placement.

6. **Land-cover / cropland mask bake → full wildfire.**
   - Bake a burnable-land mask (land-cover source, e.g. ESA WorldCover / MODIS) so
     fire only appears on vegetated/burnable land, never ocean/desert/ice.
   - Upgrade `_renderWildfire`: clip the fire/burn-scar to the land mask + add
     directional smoke drift. Keep it localized (a wildfire is not nationwide — the
     reason it was deliberately NOT polygon-bound this session).

   *Progress 2026-07-13 (CODE DONE; data pending CI):* Decision locked with the user
   — **land + ice mask from Natural Earth** (not the full MODIS/ESA land-cover; deserts
   deferred). Built: `pipeline/bake_landmask.py` (NE 1:50m `land` minus
   `glaciated_areas`, Antarctica cut at lat ≤ -60, rasterized to a 0.25° global grid,
   shipped as base64-packed bits in `landmask.json`; CI-only — sandbox proxy 403s
   raw.github). `src/simulation/LandMaskGeodata.js` (decoder + `isBurnable`/
   `nearestBurnable`). `_renderWildfire`: nudges the fire onto the nearest burnable
   cell (fixes offshore/ice centroids), replaces the single burn-scar ellipse with a
   **mask-clipped cell scar** (skips water/ice, hugs coastline; 220-cell cap; ellipse
   fallback when no mask), and adds **prevailing-wind smoke drift** (latitude-band
   climatology via a particle `updateCallback` — decorative direction, no wind speed
   claimed on-screen). `validate.py` gains a `landmask.json` check; `bake_landmask.py`
   wired into `bake_all.py`; workflow `only` gains `landmask`. **Deliberately still
   localized** (particles centroid-anchored — a wildfire isn't nationwide). ⚠ No
   `landmask.json` committed (can't bake in-sandbox); until CI bakes it, wildfire keeps
   its current unclipped centroid behavior. Run `npm run verify`, dispatch `landmask`,
   then a "wildfire in Australia/Indonesia" (coastal) check. Deserts-excluded upgrade
   (MODIS/ESA WorldCover) noted as the fuller follow-up.

Exit: drought and wildfire reach their full spec; `bake_geodata.py` foundations
(item #14) substantially done.

---

## Phase C — breadth + stretch (deferred)

7. ~~**Extend the template to schema-tier (19) + noted-tier (10) events**~~
   ✅ 2026-07-14 (code) — `_renderGenericEvent` in `ActiveSimulation.js`: ALL
   schema/noted-tier events now route to the shared template instead of the
   placeholder (dispatch branches on `EVENT_TYPES[…].status`; non_climate/unknown
   keep the honest placeholder). Three extent modes to avoid the wildfire lesson
   (over-claiming): `national` (real country polygon; 11 country-scale events like
   crop_failure/epidemic_outbreak), `ocean` (blue ellipse; 6 marine events), `local`
   (default modest ellipse — tornado/landslide/earthquake etc. never paint a whole
   nation). ImpactStats default branch supplies the label (temp anomaly CMIP6-tagged
   + precip + population + nearest-city callout) + city pins; magnitude sizes
   visuals only; fixed honest line "…— not a modeled footprint" always on-screen.
   A bespoke render later just claims its strategy string in the routes map.
   No EVENT_TYPES/prompt change → no edge-function resync. Manual checks in
   `VERIFY_CHECKLIST_2026-07-14.md` §4.
8. ~~**Hurricane Phase 3**~~ ✅ 2026-07-14 (code; data pending `tracks` dispatch) —
   metros: `houston`/Ike 2008 (also added to `bake_geodata.METROS` → 5th SLR
   flagship in the same pass) + `dhaka`/Sidr 2007 (first non-Atlantic basin, NI;
   track-only by design — Ganges-delta bathtub needs its own honesty pass); both in
   `FLAGSHIP_METROS` (partial-geodata metros degrade per-kind). Robustness:
   `build_track` resolves by NAME+SEASON (closest-approach tie-break) when the
   registry SID misses and writes the resolved SID to `_meta.analog.sid`.
   SLOSH-MOM assessed and **deferred** with rationale in `HURRICANE_TRACKS_PLAN.md`
   (trigger not demonstrated; CONUS-only; CI budget). Drive-by: `bake_tracks`'s
   dep guard now catches `SystemExit` (bake_geodata exits at import time).

---

## Guardrails carried forward (don't relitigate)

- **Rule #4:** every on-screen number/geometry comes from a baked file, never the
  LLM or the parser magnitude. No fabricated seed geometry (surge, admin-1 values)
  to make something render early — wait for the bake.
- **Honest framing** stays on-screen for analog/scenario events (hurricane track,
  conflict displacement).
- Keep EVENT_TYPES ↔ system prompt ↔ `_dispatch` in sync; re-sync + redeploy the
  edge function only if a new event type or command shape is added (none of Phase
  A–B needs it).
- `npm run verify` (+ manual render) before reporting any multi-file step done.
