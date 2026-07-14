# Visual & Contextual Upgrade Plan — "Make It Relatable"

Created 2026-07-03. Origin: environmental-scientist feedback on V1/V2 — the sea level
query for Florida produced "a blue circle and unclear statistics." What resonates with
non-technical people is the *delta on real geography*: South Beach visibly shrinking,
named cities, real population counts, human-scale comparisons.

**Decision (locked 2026-07-03): commit to Cesium ion** (World Terrain + OSM Buildings,
free tier). CLAUDE.md tech-stack table updated to match — the old "no Cesium ion" note
was stale; `GlobeRenderer.js` has loaded World Terrain via `VITE_CESIUM_ION_TOKEN`
since the quality pass.

---

## 1. Diagnosis — why the current renders don't land

All six "ready" renders in `ActiveSimulation.js` share three structural problems:

1. **Centroid + ellipse geometry.** Every event draws abstract shapes (ellipses, rings,
   particle cones, spokes) at `_getCenter()`. The water in the Florida demo was an
   ellipse — it cannot hug a coastline because it has never seen one, even though
   `countries.geojson` is already loaded for other layers.
2. **Synthesized statistics.** On-globe labels and chat numbers are derived from the
   parser's 1–10 `magnitude` (heatwave label = `mag × 2.5°C`) or written free-text by
   Haiku ("19% of the coastline"). Real numbers exist in `climate.json`
   (`sea_level_rise_m`, `heat_days_gt35c`, `exposed_population_pct`) and
   `worldbank.json` (population, GDP, urban %) but the render path never reads them.
3. **No human anchor.** Nothing on the globe names a city, counts people, or compares
   to something a person knows ("water past the first row of buildings"). That's the
   entire gap the friend identified.

---

## 2. Shared foundations (build once, every event benefits)

### F1. Baked cities dataset — `public/data/cities.json`
Pipeline script `pipeline/fetch_cities.py`: ~500–1000 major cities (GeoNames, public
domain) with `name, iso, lon, lat, population`, plus per-city coastal fields where
relevant (mean elevation, % land below 0.5/1/2 m — computed from the DEM in F3).
Reusable by every event render and by CountryPanel.

### F2. `ImpactStats.js` — statistics come from baked data, never the LLM
New module `src/data/ImpactStats.js`: given `(eventType, iso, year, ssp, magnitude)`,
returns display-ready numbers pulled from `climate.json` / `worldbank.json` /
`cities.json`, each with a source tag ("CMIP6 SSP2-4.5", "World Bank 2024").
ScenarioParser keeps returning location + magnitude; ChatInterface and the on-globe
labels render ImpactStats output. This kills the vague-"19%" class of problem and
enforces the existing "never fabricate statistics" rule mechanically.

### F3. Baked event geodata pipeline — `pipeline/bake_geodata.py`
One script, several products, all static JSON/GeoJSON under `public/data/geodata/`,
lazy-loaded per event (Netlify bandwidth stays sane):
- **Inundation polygons** (sea level, storm surge): bathtub model from Copernicus
  GLO-30 DEM (free, 30 m) at rise steps 0.5 / 1 / 2 m, clipped to ~10 flagship coastal
  metros (Miami, New Orleans, NYC, Norfolk, Houston-Galveston, Jakarta, Dhaka, Lagos,
  Shanghai, Rotterdam). Simplified geometry, target < 300 KB per metro.
- **Land/water + cropland mask** (wildfire, drought): coarse raster→vector mask from
  Natural Earth + ESA WorldCover so fire and drought stop rendering on ocean.
- **Admin-1 boundaries** (drought, heatwave choropleths): Natural Earth states/provinces,
  already public domain.

### F4. Human-scale copy in ChatInterface
A small comparison library: rise in meters → "reaches the second floor";
area → "× Manhattans"; population → "everyone in <known city>". Deterministic
lookups keyed off ImpactStats — not LLM-generated.

### F5. Close-up camera choreography + OSM Buildings
`GlobeRenderer` gains a `cityCloseUp(lon, lat)` flight profile (globe → tilt →
street-ish altitude) and loads the **OSM Buildings** ion tileset once, toggled
visible only during close-ups (perf: hidden by default, counted against the 30fps
budget when shown). Terrain is already live via ion.

---

## 3. Per-event plans — possible vs. limited

### 3.1 Sea level rise ★ flagship (direct answer to the feedback)
**Today:** blue ellipse + wave rings + "+X.X m" label.
**Upgrade:**
- Replace ellipse with the baked inundation polygon for the nearest flagship metro;
  animate current coastline → flooded coastline; render the **delta band** (land lost)
  in a contrasting color. This IS the "coastline delta" the friend asked for.
- City pins from `cities.json`: "Miami Beach — 80K people · 56% of land below 1 m".
- Close-up shot: fly to South Beach with terrain + OSM Buildings, water plane at the
  projected level so it visibly laps the first blocks.
- Stats via ImpactStats: `sea_level_rise_m` for the chapter/SSP, exposed population.
**Limitations (state honestly in-app):**
- 30 m DEM ⇒ block-level accuracy, not "the beach got 6 feet shorter." Feet-scale
  beach erosion is below data resolution — frame close-ups as *inundation*, not
  measured erosion. (True erosion-delta modeling, e.g. Bruun rule, is contested
  science; do not fake it.)
- Bathtub model ignores levees, pumps, drainage — matches NOAA SLR Viewer caveats;
  reuse their disclosure language.
- "Next 10 years" queries: interpolate between chapter values; 10 yr of SLR ≈ 4 cm,
  so the UI should say "showing 2050 / 2100 where change is visible."
- Non-flagship coasts fall back to an improved generic render (polygon-clipped to
  the actual coastline via land mask, still no DEM detail).

### 3.2 Hurricane
**Today:** rotating spiral rings at centroid.
**Upgrade:**
- Animate the storm **along a real historical-analog track** (HURDAT2, public domain;
  bake ~20 iconic tracks): genesis offshore → landfall at the queried coast. Framing:
  "a Category 4 on Ian's track under 2075 conditions."
- On landfall: storm-surge zone reuses the F3 inundation polygons (surge = temporary
  +2–4 m step) — one dataset, two events.
- City pins in the cone: population, evacuation-scale numbers from cities.json.
**Limitations:** not a forecast — always an analog, labeled as such. Particle counts
must be re-budgeted against 30fps with terrain+buildings on. Track library is
Atlantic/Pacific-biased at first.

### 3.3 Drought
**Today:** color-shifting ellipse + ring "cracks." Also: `drought_index` bakes as 0.0
for USA — **verify the pipeline actually computes it** before building on it.
**Upgrade:**
- Choropleth on **real admin-1 polygons** (F3) instead of an ellipse — the browning
  follows state lines people recognize.
- Cropland mask so browning concentrates on agricultural land.
- ImpactStats: population in affected states, agri-GDP share, reservoir analogies
  ("Lake Mead −X ft" class of comparison from baked reference table).
**Limitations:** sub-national climate data is US-only (LOCA2); elsewhere the
choropleth uses country-level values spread across states. No hydrological model —
severity is stylized from `drought_index`/`precipitation_change_pct`.

### 3.4 Heatwave
**Today:** shimmer shader (keep it — it works) + pulsing ellipse + fabricated "+X°C".
**Upgrade (cheapest win in the set):**
- Label reads real `heat_days_gt35c` + `temperature_anomaly_c` from climate.json —
  data is **already baked**, this is nearly free.
- Ellipse → country/admin-1 polygon bound.
- City pins: "Phoenix — 3.1 wet-bulb danger days by 2050" style callouts (US via
  LOCA2 bake; elsewhere country-level with disclosure).
- Night mode moment: Black Marble tiles + "nights that never cool below 30°C".
**Limitations:** city-level projections outside the US are downscaled approximations;
tag them. Wet-bulb calc needs humidity fields — add to `fetch_cmip6.py` or omit.

### 3.5 Wildfire
**Today:** fire/smoke/ember particles + expanding scar ellipse at centroid (can burn
the ocean).
**Upgrade:**
- Clip burn scar to the F3 land/vegetation mask; optionally use a historical
  perimeter shape (MTBS/GlobFire) as the scar geometry — real fire shapes read as
  real.
- **Smoke drift** toward a named downwind city with an air-quality radius:
  "smoke reaches Denver — 2.9M people under an AQI alert." Population from cities.json.
**Limitations:** no fuel/wind physics — drift direction is prevailing-wind lookup,
labeled illustrative. Particles are the biggest fps risk; cap emission rates when
2–3 layers are stacked.

### 3.6 Conflict
**Today:** abstract spokes + shockwave rings.
**Upgrade:**
- Displacement **arcs between real named places** (origin city → actual historical
  refuge corridors), with UNHCR-order-of-magnitude numbers from a small baked
  reference table.
- Tie to climate driver via ImpactStats (water stress, crop failure %) — the
  climate-conflict chain stated explicitly.
**Limitations:** the most speculative event class. Never render as prediction for a
named real country-pair without "historical analog / scenario" framing — this is an
ethics + credibility requirement, not a nice-to-have. Lowest priority accordingly.

---

## 4. Priority order (biggest immediate impact first)

| # | Work | Why first |
|---|---|---|
| 1 | **Phase 0 — foundations F1/F2/F4** (cities.json, ImpactStats, human-scale copy) | Every event instantly gets real numbers + named cities; directly fixes "unclear statistics" for all six with no new render work |
| 2 | **Sea level rise** (F3 inundation + delta band + Miami close-up) | The flagship demo and the friend's exact critique; highest wow-per-effort |
| 3 | **Heatwave** (baked stats + polygon bound) | Near-free: data already baked; big credibility gain |
| 4 | **Hurricane** (analog tracks + surge reuse) | Most-requested event type; reuses sea-level geodata |
| 5 | **Drought** (admin-1 choropleth + cropland mask) | Requires F3 admin-1 + pipeline fix for drought_index |
| 6 | **Wildfire** (land mask + smoke drift) | Good payoff but particle/fps re-budgeting needed |
| 7 | **Conflict** (named-place arcs) | Most care needed in framing; least visual-delta per effort |

Schema-tier and noted-tier events (19 + 10) inherit the same pattern when built:
polygon-anchored geometry + ImpactStats + city callouts. Tracked in CLAUDE.md
Open Action Items.

---

## 5. Architecture compliance & risks

- **No principle violations.** All new data is baked (rule 5); renders stay inside
  ActiveSimulation/LayerContract (rules 3, 9); stats flow beats the no-fabrication
  rule into the architecture (F2). Max-3-layers and 30fps budgets unchanged — but
  OSM Buildings + particles + terrain together need a real fps pass on a mid-range
  laptop (extend the M4 calibration TODO).
- **Cesium ion quotas (free tier):** World Terrain + OSM Buildings streaming counts
  against ion's monthly quota. Acceptable for current traffic; add quota monitoring
  to the launch checklist and keep the no-token flat-ellipsoid fallback working.
- **Bandwidth:** all geodata lazy-loaded per event/metro; budget < 300 KB per metro
  file, < 5 MB total baked geodata added to the repo/CDN.
- **`destroy()` contract:** every new entity/primitive/tileset-toggle goes through
  `_track()`; OSM Buildings tileset is owned by GlobeRenderer (loaded once, toggled),
  not by simulations.
- **Honest-limits UI:** each upgraded render gets a one-line data-caveat in its chat
  response (resolution, analog framing, bathtub caveat). This is what keeps an
  environmental scientist on side.

---

## 6. Addendum (2026-07-12) — SLR data source: NOAA Digital Coast vs. baked DEM

Origin: doubt that the §3.1 approach (F3 baked Copernicus GLO-30 bathtub inundation)
is the right *long-term* foundation for the flagship sea-level render. Question raised:
can we pull NOAA's Sea Level Rise Viewer (coast.noaa.gov/digitalcoast/tools/slr.html)
data in instead? Answer: yes, and it's a real option — but it's a partial swap, not a
clean replacement. Findings below so we can decide deliberately.

### 6.1 What NOAA actually exposes
Two integration-friendly forms beyond the web viewer:
- **Live ArcGIS REST map services** — `https://www.coast.noaa.gov/arcgis/rest/services/dc_slr`.
  Per-scenario `MapServer` endpoints, confirmed live: `slr_0ft … slr_10ft` in **0.5 ft
  steps**, `conf_0ft … conf_10ft` (mapping confidence), `marsh_000 … marsh_1000` (marsh
  migration), plus `Data_Extent` and `Point_Layers`. NOAA hosts, updates, and vets them.
- **Raw data download** — `https://coast.noaa.gov/slrdata`. The DEM-derived inundation
  rasters/GIS, i.e. the same product we could bake through `bake_geodata.py` ourselves.

### 6.2 Cesium fit
Each `MapServer` is consumed natively by `ArcGisMapServerImageryProvider`, draped over
the World Terrain we already load in `GlobeRenderer`. Rise animation = crossfade `alpha`
across the scenario layers:

```js
const slr3 = await Cesium.ArcGisMapServerImageryProvider.fromUrl(
  "https://www.coast.noaa.gov/arcgis/rest/services/dc_slr/slr_3ft/MapServer"
);
const layer = viewer.imageryLayers.addImageryProvider(slr3);
layer.alpha = 0.7; // drive 0→10 ft by fading scenario layers in/out
```

### 6.3 Why it's attractive long-term
NOAA owns hosting, updates, and methodology — the same authority whose caveat language
§3.1 already borrows. No DEM pipeline for us to maintain; half-foot scenarios out of the
box (finer than our 0.5/1/2 m bathtub steps); confidence and marsh-migration layers we
would never bake ourselves.

### 6.4 Why it's not a clean swap — tensions to resolve
- **Live external dependency vs. baked-data rule 5.** This is the crux. Calling the
  services live introduces a network dependency at render time, outside our offline/quota
  control, that NOAA can change or deprecate. That directly contradicts the "all data is
  baked" principle §5 leans on. Reading the raw `slrdata` download through the existing
  pipeline honors rule 5; calling the MapServers live does not.
- **US-only coverage.** `dc_slr` is contiguous US coasts (no Great Lakes), AK, HI, and
  territories. It cannot render Jakarta, Dhaka, Lagos, Shanghai, or Rotterdam — half the
  §2 flagship list. So NOAA can be *a* source, never the *sole* source; the GLO-30 bathtub
  path still has to exist for international metros. Two code paths regardless.
- **Draped raster, not vector.** Layers arrive as pre-styled raster imagery, not polygons.
  That makes the **delta band (land lost) in a contrasting color** — the exact thing §3.1
  and the original critique center on — harder: we'd get "blue over flooded areas," not
  clean current-vs-flooded delta geometry or per-city "% land below X m." Deriving the
  delta from raster is more work than a baked polygon where we own the geometry.
- **Dynamic export, not a tile cache.** Rendered on demand per view — snappy at regional
  zoom, not meant for whole-globe draping; scope to the AOI. And **CORS must be verified**
  from our origin, since Cesium needs cross-origin access for imagery.

### 6.5 Recommendation (proposed, not locked)
Keep F3 baked inundation as the portable, offline, globally-uniform, vector-delta-capable
foundation — it's what keeps the delta band and the non-US metros possible. Layer NOAA
`dc_slr` in as an **optional high-fidelity US overlay** for flagship close-ups (Miami,
NOLA, NYC, Norfolk), where its half-foot scenarios + confidence layer beat our GLO-30
steps, and reuse NOAA's published caveats we already cite. Gate it behind the same
lazy-load + fps budget as everything else. Validate CORS and a single Miami crossfade POC
before committing any of this into `SeaLevelLayer.js`.

### 6.6 Open question for the source decision
"Works long term" has two readings, and they point at different implementations:
1. *Maintained by someone credible so it won't rot* → live NOAA services, accept the
   rule-5 exception for the US path.
2. *No fragile runtime dependency* → download `slrdata` and **bake it through the existing
   pipeline** (US-only, but higher-res than GLO-30), stay fully rule-5 compliant, no live
   calls.

Both are viable; they're mutually exclusive for the US path. Needs a call before build.
