# Hurricane Historical-Analog Track + Surge — Scoping Plan

Status: proposal (2026-07-12). No code written. Scopes the remaining flagship
piece of the per-event upgrade program (CLAUDE.md open item #15, hurricane).

What already shipped (in code, 2026-07-12): `_renderHurricane` now draws the
animated spiral **plus** a baked overlay — surge-baseline sea-level label
(`getImpactStats('hurricane')`) and coastal city callout pins. What this plan
scopes is the part that still doesn't exist: the **historical-analog track
polyline** and the **storm-surge inundation footprint**.

---

## Goal — what "done" looks like

A `hurricane` event near a supported coast renders:

1. A **real past storm's track** as a polyline hugging the actual path it took
   (points colored by intensity), with the spiral positioned at the landfall
   point and, optionally, a marker that walks the track over the animation.
2. A **surge inundation footprint** — the coastal land a plausible surge would
   put under water, as real polygons on the DEM (same visual language as the sea
   level rise delta band).
3. Honest framing throughout: "Historical analog under future conditions — not a
   forecast" (the caveat `getImpactStats` already returns for hurricanes).

Non-flagship coasts keep today's spiral + baked label (graceful fallback, exactly
like the SLR flagship/generic split).

---

## Why it fits the architecture

The sea-level-rise flagship is the proven template and this is the same shape:

| Concern | Sea level rise (done) | Hurricane (this plan) |
|---|---|---|
| Bake script | `pipeline/bake_geodata.py` | `pipeline/bake_tracks.py` (new) + surge reuses `bake_geodata.py` helpers |
| Baked file | `public/data/geodata/slr_<metro>.json` | `public/data/geodata/hurricane_<metro>.json` |
| Loader | `InundationGeodata.js` (`findFlagshipMetro`/`loadInundation`/`pickLevel`) | `HurricaneGeodata.js` (mirror) |
| Render | `_renderInundationDelta` (delta-band polygons) | extend `_renderHurricane` (track polyline + surge polygons) |
| Stats | `getImpactStats('sea_level_rise')` | `getImpactStats('hurricane')` — already implemented |

No new SimulationCommand type, no parser/prompt change (hurricane already exists),
so **no edge-function resync** — same as the SLR work.

Locked rules it must respect: **#4** (every displayed number baked, never the LLM
— track coordinates, categories, surge heights, areas all come from the file) and
**#5** (baked at build time; no runtime NOAA calls). The `Cat N` label stays as
the user's *scenario* storm, not a projection.

---

## The two data pieces

### A. Analog tracks — IBTrACS

- **Source:** IBTrACS (International Best Track Archive for Climate Stewardship),
  NOAA NCEI. Global, authoritative, US-Gov public domain. Per-storm points carry
  lat/lon, max wind, pressure, and a Saffir–Simpson category. (HURDAT2 is an
  alternative but Atlantic/E-Pacific only; IBTrACS is global, so preferred for
  extensibility to Jakarta-class basins later.)
- **Analog selection is curated, not computed.** A small registry maps each
  flagship metro to a real historical landfalling storm of the intensity we want
  to show — the same pattern as `FLAGSHIP_METROS` in `InundationGeodata.js`:

  | Metro | Analog storm | Notes |
  |---|---|---|
  | Miami | Andrew (1992, Cat 5) or Irma (2017) | direct SE-FL landfall |
  | New Orleans | Katrina (2005, Cat 3 landfall) | canonical surge case |
  | New York City | Sandy (2012) | post-tropical, huge surge footprint |
  | Jakarta | **none** | near-equator, low Coriolis — tropical cyclones effectively don't strike; its flooding is monsoonal. Do **not** fabricate a hurricane analog here. Honest-scope gap to surface in the render. |

- **Bake output:** the storm's track points (subsampled to a sane cadence),
  peak category, name, year, and IBTrACS SID for provenance.

### B. Surge footprint — reuse the SLR bathtub

The elegant part: `bake_geodata.py` already has everything needed.

- `bathtub_delta(elev, level_m)` → ocean-connected newly-inundated mask.
- `mask_to_rings(mask, …)` → simplified rings + `area_km2`.
- Per-metro Copernicus GLO-30 DEM tiles are already enumerated in its `METROS`.

So a surge footprint = `bathtub_delta(elev, surge_height_m)` where
`surge_height_m = category_surge_baseline + baked_SLR_baseline`, then
`mask_to_rings`. The result drops into the **same schema and renderer** as the
SLR delta band. Two honesty requirements:

1. `category_surge_baseline` must be a **cited constant table** (e.g. SLOSH /
   Saffir–Simpson typical surge ranges), baked into the file — never invented.
2. Bathtub surge ignores storm forward-speed, angle, bathymetry funnelling, and
   defenses. Either carry the existing bathtub caveat (cheap, honest) **or** use
   NOAA **SLOSH MOM** composite surge rasters for real physics (higher fidelity,
   more pipeline work). Recommend bathtub + caveat for the first cut; SLOSH MOM
   as a later fidelity upgrade.

---

## Proposed deliverables

1. **`pipeline/bake_tracks.py`** — reads a curated analog registry, pulls the
   IBTrACS track for each analog SID, and (importing `bake_geodata.py` helpers)
   computes the surge footprint on the metro DEM. Writes
   `public/data/geodata/hurricane_<metro>.json`. Runs in CI alongside
   `bake_geodata.py` (weekly pipeline / manual dispatch).
2. **`src/simulation/HurricaneGeodata.js`** — mirror of `InundationGeodata.js`:
   `findFlagshipMetro` reuse (or shared), cached `loadHurricane(metro)`,
   null-safe. Missing file → today's spiral + baked label (no throw).
3. **`_renderHurricane` extension** — draw the track polyline (Cesium
   `PolylineGraphics`, per-segment intensity color), optional storm marker
   walking the track via a tracked postRender listener, and the surge polygons
   (reuse the `_renderInundationDelta` polygon pattern). Everything `_track()`ed;
   `destroy()` already removes tracked entities.
4. **Attribution** — add IBTrACS (+ SLOSH if used) to
   `public/data/attribution.json`; surfaced by `AttributionModal.js`.
5. **`validate.py`** — schema checks: track points in-range, category ∈ 1–5,
   surge `area_km2` present, every record carries an IBTrACS SID.

---

## Proposed baked schema (`hurricane_<metro>.json`)

```json
{
  "_meta": {
    "metro": "new_orleans", "display": "New Orleans",
    "analog": { "name": "Katrina", "year": 2005, "sid": "2005236N23285", "peak_category": 5 },
    "track_source": "IBTrACS v04r01 (NOAA NCEI, public domain)",
    "surge_source": "Copernicus GLO-30 bathtub at Cat-derived height + CMIP6 SLR baseline",
    "baked_at": "…",
    "caveats": [
      "Track is a real historical storm shown as an analog — not a forecast for this location/date.",
      "Surge is a bathtub fill at a category-typical height; ignores forward speed, angle, bathymetry, levees."
    ]
  },
  "track": [
    { "lon": -85.1, "lat": 23.9, "wind_kt": 150, "category": 5 },
    { "lon": -89.6, "lat": 29.3, "wind_kt": 110, "category": 3 }
  ],
  "landfall": { "lon": -89.6, "lat": 29.3 },
  "surge": { "height_m": 4.0, "area_km2": 812.5, "rings": [[[lon,lat], …]] }
}
```

The renderer positions the spiral at `landfall`, draws `track` as the polyline,
and `surge.rings` as the flood polygons with `surge.area_km2` in the label
(baked → rule #4 clean).

---

## CI / egress note

`bake_geodata.py` already downloads DEM tiles from AWS Open Data **in GitHub
Actions**, which has open network — so pulling IBTrACS from NOAA in CI is fine.
The GitHub/PyPI/npm egress limit is the **Cowork sandbox**, not CI; that only
means this bake (like the SLR bake) can't be produced from inside a Cowork
session — it must run in CI or on a real machine. Same operational caveat already
documented for `slr_miami.json`.

---

## Phasing

- **Phase 1 — track only (no surge).** Analog registry + IBTrACS bake + polyline
  render + moving marker. Smaller, no DEM work, already high-impact (turns the
  abstract spiral into a real named storm on its real path). One metro
  (New Orleans/Katrina or Miami/Andrew) as the proof.
- **Phase 2 — surge footprint.** Add the bathtub surge via `bake_geodata.py`
  reuse + surge polygons in the render. Bigger, but mostly parameterization of
  proven code.
- **Later — SLOSH MOM fidelity** and more metros, if the bathtub caveat proves
  too coarse.

### Phase 3 status (2026-07-14)

**More metros: DONE (code; data pending the next `tracks` dispatch).**
Registry gains `houston` (Ike 2008 — the canonical Galveston Bay surge storm;
Harvey was considered and rejected: its damage signature is rain flooding, not
surge) and `dhaka` (Sidr 2007, North Indian basin — first non-Atlantic analog;
TRACK-ONLY since a bathtub over the Ganges delta floodplain needs its own
file-budget/honesty pass before shipping). `houston` was also added to
`bake_geodata.METROS` (Galveston Bay tiles), so the same dispatch pair yields
Ike surge AND a fifth SLR flagship (`slr_houston.json`). Both metros added to
`FLAGSHIP_METROS` in `InundationGeodata.js` — a metro with only one kind of
geodata degrades to the generic render for the missing kind (loaders resolve
missing files to null).

**Robustness:** `build_track` now resolves the storm by NAME + SEASON (closest
metro approach breaks ties) when the registry SID misses, and writes the
resolved SID to `_meta.analog.sid` — hand-written SIDs already burned one
session (Andrew, corrected 2026-07-14). New-metro SIDs are best-effort hints.

**SLOSH-MOM: assessed and DEFERRED.** Rationale: (1) the trigger condition —
"bathtub proves too coarse" — has not been demonstrated; nobody has eyeballed
the baked surge footprints against known Ike/Katrina extents yet; (2) SLOSH
MOM composites are CONUS-only, so they can never serve Dhaka or any future
WP/NI metro — the bathtub is the only surge model that scales with the
registry; (3) the MOM rasters are a per-basin multi-GB fetch that would
dominate the 30-minute CI budget. Revisit only after a real-machine eyeball of
the baked Ike/Katrina surge vs. published high-water extents shows the bathtub
materially misleading.

**Smallest useful first slice:** Phase 1 for a single metro. It needs only
IBTrACS + the analog registry + a polyline in `_renderHurricane`; no DEM, no new
schema beyond `track`/`landfall`. It de-risks the loader/registry pattern before
any surge work.

---

## Effort & risks

- **Track render:** low. Polyline + marker is cheap and within the 30fps budget.
- **Analog curation:** low but judgment-heavy — pick defensible storms; document
  why; leave Jakarta without a hurricane analog (honest gap).
- **Surge bake:** moderate. Bathtub reuse is the accelerant; the real work is the
  cited category→height table and validating footprints per metro.
- **Main risk — over-claiming.** A real named track next to a real city invites
  "is this a prediction?" The caveat plumbing and the "analog, not forecast"
  label are non-negotiable, not polish.
- **Data provenance:** keep IBTrACS SID in every record so any figure on screen
  traces back to a specific archived storm.

No parser/prompt/edge-function change at any phase.
