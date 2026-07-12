# V3 One-Day Plan — Cinematic Pass + Flagship Render

Created 2026-07-11. Goal: one focused day with Fable 5 before API pricing.
Strategy: **not a rewrite.** V2's architecture is sound and deployed. The day goes to
(a) closing the visual gap to the "hero globe" reference look, and (b) executing the
top of VISUAL_UPGRADE_PLAN.md — real geometry + real numbers — which is where the
actual wow-gap lives.

Reference look (TheAIGRID Fable 5 video @6:00): atmospheric rim glow, animated
clouds, day/night city lights, specular ocean, bloom. **Audit finding: GlobeRenderer
already has ~70% of this** — bloom stage, Black Marble night layer, tuned
Rayleigh/Mie atmosphere, sun lighting, MSAA 4x, cloud puffs. What's missing is below.

---

## Hour-by-hour

### 0:00 — Kick off the slow thing first (15 min)
Start the Copernicus GLO-30 DEM download for Miami (+ NYC if bandwidth allows) in the
background. This is the schedule risk for Block C — if it stalls, fall back to
NOAA SLR Viewer–derived polygons (US metros, already bathtub-modeled, public domain).

### Block A — Cinematic globe polish (2 h)
The visible delta from today's globe to the video look:

1. **HDR:** `scene.highDynamicRange = true` + re-tune bloom threshold. Biggest
   single-line visual win; the limb and city lights start to glow properly.
2. **Real cloud layer:** replace the 30 hand-placed cloud puffs with a GIBS
   VIIRS/MODIS cloud imagery layer at low alpha, or a semi-transparent rotating
   cloud-texture shell. Animated ever so slowly. (Keep the puffs as a fallback flag.)
3. **Atmosphere fine-tune under HDR:** the current Rayleigh/Mie values were tuned for
   SDR; re-check `atmosphereLightIntensity`, `brightnessShift` after enabling HDR.
4. **`cityCloseUp(lon, lat)` camera choreography (plan item F5):** globe → tilt →
   low-altitude flight profile + OSM Buildings ion tileset loaded once, toggled only
   during close-ups. Needed by Block C's Miami shot anyway — build it here.
5. **Skip:** custom GLSL fresnel/ocean-specular shaders. Cesium's water mask +
   atmosphere gets close; hand-rolled shaders are a half-day rabbit hole for a
   marginal delta. Cut first if behind schedule. Note: idle auto-rotation would look
   cinematic but conflicts with the locked "user-directed first-load" decision — ask
   before adding.

### Block B — Foundations F1/F2/F4 (2.5 h)
Straight from VISUAL_UPGRADE_PLAN.md priority #1 — every event benefits at once:

- **F1** `pipeline/fetch_cities.py` → `public/data/cities.json` (~500 GeoNames
  cities: name, iso, lon, lat, population).
- **F2** `src/data/ImpactStats.js` — display numbers from climate.json /
  worldbank.json / cities.json with source tags. Kills LLM-synthesized stats
  mechanically (failure mode #4 in CLAUDE.md).
- **F4** human-scale comparison copy in ChatInterface (deterministic lookups keyed
  off ImpactStats).

### Block C — Sea level rise flagship (3 h)
Priority #2, the environmental-scientist critique, highest wow-per-effort:

- Bathtub inundation polygons for **Miami only** (scope discipline: one metro done
  beats three half-done) at 0.5 / 1 / 2 m from the DEM started at 0:00.
- Render: current coastline → flooded coastline animation, **delta band** (land
  lost) in contrast color. Replaces the blue ellipse.
- City pins from cities.json ("Miami Beach — 80K people · 56% below 1 m").
- Close-up: `cityCloseUp` to South Beach, water plane at projected level, OSM
  Buildings visible.
- Honest-limits caveat line in the chat response (bathtub model, 30 m DEM,
  NOAA-style disclosure).

### Block D — Heatwave quick win (45 min)
Priority #3, nearly free: label reads baked `heat_days_gt35c` +
`temperature_anomaly_c` via ImpactStats; ellipse → country polygon bound.

### Block E — Verify + ship (1 h)
- `npm run verify` (non-negotiable before calling anything done).
- `audit-checklist` skill manual checks; fps check with terrain + buildings +
  one particle layer stacked (30fps budget).
- Re-run `validate.py` if pipeline outputs changed; confirm `attribution.json`
  covers GeoNames + Copernicus + any new imagery (CC BY / license check).
- Push → Netlify auto-deploy → smoke-test production URL.
- No system-prompt changes expected; if any happen, `npm run sync-prompt` +
  redeploy the edge function.

---

## Degradation order (if behind)
Cut in this order: D heatwave → A5 already cut → C close-up shot (keep the polygon
delta render) → A2 cloud layer (keep puffs). Never cut Block E.

## Architecture compliance
All within existing rules: baked data only, LayerContract renders, `_track()`/
`destroy()` for every Cesium object (incl. the OSM Buildings toggle owned by
GlobeRenderer), stats from ImpactStats never the LLM, textContent/escapeHtml
everywhere. Cesium ion quota: buildings toggled off by default.

## Status — end of day 2026-07-11

- **0:00 DEM download:** sandbox network allowlist blocked Copernicus S3 / NOAA /
  GeoNames / ArcGIS (only GitHub + PyPI + npm reachable). Decision: bake runs in
  GitHub Actions instead (user choice). `slr_miami.json` will appear after the
  first pipeline run — until then the render falls back to the generic visual.
- **Block A DONE:** HDR (guarded), procedural cloud-shell primitive (static,
  non-pickable, `USE_CLOUD_SHELL` kill switch, chapter-fade wired),
  `cityCloseUp()`/`exitCloseUp()` + lazy OSM Buildings, destroy() cleanup.
  A5 (custom GLSL ocean/fresnel) cut as planned.
- **Block B DONE:** cities.json regenerated — 1,006 cities from Natural Earth
  populated places (git sparse clone; GeoNames stays the CI-preferred source in
  fetch_cities.py, NE is the fallback). Coastal enrichment (mean_elev_m etc.)
  carried forward; Miami Beach / Venice / Malé etc. re-authored after the NE
  population floor dropped them. ImpactStats/HumanScale existed from a prior
  session and were left as-is.
- **Block C DONE (code) / PENDING (data):** `pipeline/bake_geodata.py`
  (bathtub + ocean-connectivity, unit-tested on a synthetic DEM in-session),
  wired into bake_all.py + weekly-pipeline.yml (`only: geodata` option),
  requirements.txt + build_attribution.py updated (Copernicus attribution
  text). Frontend: `InundationGeodata.js` + `_renderInundationDelta()` +
  `camera:closeup_requested` (added to CLAUDE.md taxonomy).
- **Block D DONE:** heatwave label now reads baked anomaly + heat days via
  ImpactStats (fabricated `mag × 2.5` removed). Polygon-bound still open.
- **Block E:** `npm run verify` + visual eyeball must run on the user's
  machine (session sandbox served stale copies of edited files). NOTE: the
  working folder has NO .git — deploy path (push to GitHub → Netlify) needs
  the user's actual repo location.

## Explicitly out of scope for the day
Three.js hero-globe rewrite, custom GLSL ocean/fresnel, hurricane/drought/wildfire/
conflict upgrades (plan items 4–7), second-brain project (doesn't need frontier
compute — build later on cheaper models or Obsidian + MCP).
