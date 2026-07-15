# Verification Checklist — 2026-07-14 session

Run on the REAL Windows machine, in order. The Cowork sandbox could not run
any of this (and today it served a corrupted copy of `bake_geodata.py` — a
phantom missing-colon syntax error at line 292 that does NOT exist in the real
file; distrust sandbox-side syntax errors on freshly edited files).

## 0. Sync first — the working copy is BEHIND origin/main

Local checkout is missing last session's CI commits: `hurricane_miami.json`
is absent and `cities.json` is still the old 1000-city GeoNames bake (no Miami
row at all). Before anything else:

```
git stash            # if this session's edits aren't committed yet — see note
git pull --rebase
git stash pop
```

Note: this session edited files directly in the working copy. If pull
conflicts on any of them, this session's versions are authoritative for:
`pipeline/bake_city_elevation.py` (new), `pipeline/bake_tracks.py`,
`pipeline/bake_geodata.py`, `pipeline/bake_all.py`, `pipeline/validate.py`,
`src/simulation/ActiveSimulation.js`, `src/simulation/InundationGeodata.js`,
`.github/workflows/weekly-pipeline.yml`, `HURRICANE_TRACKS_PLAN.md`,
`NEXT_SESSION_PLAN.md`, `CLAUDE.md`, this file. Data files under
`public/data/` are main's (CI is authoritative there).

## 1. Static checks

```
cd v2-starter
python -m py_compile pipeline/bake_city_elevation.py pipeline/bake_tracks.py pipeline/bake_geodata.py pipeline/validate.py pipeline/bake_all.py
npm run verify
python pipeline/validate.py            # expect PASS; cities validator will warn
                                       # "only N cities carry mean_elev_m" until the elevation dispatch runs
```

(Sandbox ran `npm run verify` green + py_compile green on all but the
corrupted-mount file, but per the rules that doesn't count — rerun locally.)

## 2. Verification debt from LAST session (still unrun)

Manual render checks against the deployed/local app:

- "hurricane in New Orleans" → Katrina track + surge polygons (seed gone)
- "hurricane in Miami" → Andrew track (SID 1992230N11325) + surge
- "hurricane in NYC" → Sandy track + surge
- "sea level rise in Jakarta" → baked delta-band polygons + area label

## 3. Commit + dispatch (ONE at a time; never push while a run is in flight)

Commit this session's code, push, then run these manual dispatches
(Actions → Weekly Data Pipeline → Run workflow → only=…), each after the
previous one's auto-commit lands, `git pull` between:

1. `only=geodata`  → bakes `slr_houston.json` (new 5th SLR metro)
2. `only=tracks`   → bakes `hurricane_houston.json` (Ike + surge),
                     `hurricane_dhaka.json` (Sidr, track-only, NI basin —
                     watch the log for "resolved … by name+season": both new
                     SIDs are best-effort hints)
3. `only=elevation`→ NEW step: backfills `mean_elev_m` into cities.json for
                     all cities inside flagship DEM tile coverage
                     (Miami/NYC/NOLA/Jakarta/Houston areas)
4. `only=validate` (or rely on each run's validate step)

## 4. Manual render checks for THIS session's code (after dispatches land)

- "hurricane in Houston" → Ike track + Galveston Bay surge + baked label
- "hurricane in Dhaka" → Sidr track, NO surge (track-only by design), honest
  analog label
- "sea level rise in Houston" → delta-band polygons from slr_houston.json
- "sea level rise in Miami" → close-up should now fly to a genuinely
  low-lying city (mean_elev_m backfilled) instead of the fallback chain
- Generic template (Phase C): "tornado in Oklahoma" (local ellipse — NOT
  nationwide), "crop failure in India" (national polygon + "national extent
  shown — not a modeled footprint" line), "coral bleaching in Australia"
  (ocean-blue ellipse), "marine heatwave in Japan" (ocean) — each should show
  the ImpactStats label (temp anomaly CMIP6 tag + population + nearest city)
  and city pins; NO parser-magnitude numbers on screen
- "solar storm" → still the honest placeholder (non_climate unchanged)
- Eject ("start over") after a generic event → no leftover entities (destroy
  path uses the same _track contract, but eyeball it once)

## 5. Optional cleanup

- Delete the leftover RLS test row in Supabase (`sessionId rls-test-2026-07-05`).
- After the elevation dispatch: spot-check `cities.json` — Miami/Miami Beach
  should carry plausible small values (~1–3 m), NYC boroughs ~5–30 m.
