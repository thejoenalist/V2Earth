#!/usr/bin/env python3
"""
bake_city_elevation.py — backfill cities.json `mean_elev_m` from the DEM.

Phase A #4 (NEXT_SESSION_PLAN). Only ~44/1006 cities carry `mean_elev_m`
(hand-authored approximations on flagship metros; Miami is null), so the SLR
close-up's lowest-lying-city pick falls through to its fallback chain. This
step computes a real DEM-derived mean elevation for every city inside the
flagship-metro DEM tile coverage and writes it back into cities.json.

Deliberately scoped to the flagship metros' Copernicus GLO-30 tiles (the ones
bake_geodata.py already downloads into pipeline/.dem_cache) — enriching all
~1000 cities globally would mean hundreds of 1° DEM tiles (tens of GB) for no
render that consumes them yet. Extend METROS in bake_geodata.py and this step
follows automatically.

Method (documented in _meta): per city, mean of valid LAND cells (elevation
above the ocean threshold) in a ~1.1 km square window centred on the city
point. Window mean on a 30 m DEM — block-level, not a survey datum.

RUNS IN CI (needs S3 egress to the Copernicus bucket, like bake_geodata.py).
Must NEVER break the weekly pipeline: any missing dep / DEM / file degrades to
a warning and exit 0. DEM-derived values OVERWRITE hand-authored ones (they
are strictly more defensible — rule #4); cities outside tile coverage keep
whatever they had.

Usage:
  python pipeline/bake_city_elevation.py            # all flagship metros
  python pipeline/bake_city_elevation.py miami nyc  # subset
"""

from __future__ import annotations

import json
import re
import sys
import time
from pathlib import Path

PIPELINE_DIR = Path(__file__).parent
CITIES_PATH = PIPELINE_DIR.parent / "public" / "data" / "cities.json"

# Half-width of the sampling window around each city point, in degrees.
# 0.005° ≈ 550 m → a ~1.1 km square, ~37×37 GLO-30 cells at the equator.
SAMPLE_HALF_DEG = 0.005

# Sanity bounds for a computed mean (m). Outside → skip the city, warn.
ELEV_MIN_M, ELEV_MAX_M = -450.0, 9000.0

_TILE_RE = re.compile(r"_(N|S)(\d+)_00_(E|W)(\d+)_00_DEM$")


def tile_bbox(tile: str) -> tuple | None:
    """Copernicus tile id → (lon_min, lat_min, lon_max, lat_max) of its 1°×1° cell."""
    m = _TILE_RE.search(tile)
    if not m:
        return None
    lat = int(m.group(2)) * (1 if m.group(1) == "N" else -1)
    lon = int(m.group(4)) * (1 if m.group(3) == "E" else -1)
    return (lon, lat, lon + 1, lat + 1)


def union_bbox(tiles: list[str]) -> tuple | None:
    boxes = [b for b in (tile_bbox(t) for t in tiles) if b]
    if not boxes:
        return None
    return (min(b[0] for b in boxes), min(b[1] for b in boxes),
            max(b[2] for b in boxes), max(b[3] for b in boxes))


def enrich_metro(key: str, cfg: dict, cities: list[dict], cache_dir: Path,
                 geo, warnings: list[str]) -> int:
    """Compute mean_elev_m for cities inside this metro's tile coverage.

    Returns the number of cities enriched. Best-effort — a missing DEM tile
    skips the metro (warning), never raises.
    """
    np, download_dem, read_dem_mosaic, ocean_elev_m = geo
    bbox = union_bbox(cfg["tiles"])
    if not bbox:
        warnings.append(f"[{key}] unparseable tile ids — skipped")
        return 0

    lon_min, lat_min, lon_max, lat_max = bbox
    targets = [c for c in cities
               if lon_min <= c["lon"] <= lon_max and lat_min <= c["lat"] <= lat_max]
    if not targets:
        print(f"[{key}] no cities inside tile coverage — nothing to do")
        return 0

    tile_paths = []
    for tile in cfg["tiles"]:
        dest = cache_dir / f"{tile}.tif"
        if not download_dem(tile, dest):
            warnings.append(f"[{key}] DEM tile unavailable ({tile}) — metro skipped")
            return 0
        tile_paths.append(dest)

    elev, transform = read_dem_mosaic(tile_paths, bbox)
    res_lon = abs(transform.a)
    res_lat = abs(transform.e)
    height, width = elev.shape

    enriched = 0
    for c in targets:
        # window in pixel space (row 0 = lat_max, matching read_dem_mosaic)
        c0 = int((c["lon"] - SAMPLE_HALF_DEG - lon_min) / res_lon)
        c1 = int((c["lon"] + SAMPLE_HALF_DEG - lon_min) / res_lon) + 1
        r0 = int((lat_max - (c["lat"] + SAMPLE_HALF_DEG)) / res_lat)
        r1 = int((lat_max - (c["lat"] - SAMPLE_HALF_DEG)) / res_lat) + 1
        window = elev[max(r0, 0):min(r1, height), max(c0, 0):min(c1, width)]
        if window.size == 0:
            continue
        # valid land cells only: DEM nodata (-9999) and open water (~0) excluded
        land = window[(window > -9000) & (window > ocean_elev_m)]
        if land.size == 0:
            continue
        val = round(float(np.mean(land)), 1)
        if not (ELEV_MIN_M <= val <= ELEV_MAX_M):
            warnings.append(f"[{key}] {c['name']}: mean {val} m outside sanity "
                            f"bounds — skipped")
            continue
        c["mean_elev_m"] = val
        enriched += 1

    print(f"[{key}] enriched {enriched}/{len(targets)} cities in tile coverage")
    return enriched


def main() -> int:
    # Guard geo deps exactly like bake_tracks.compute_surge — bake_geodata
    # calls sys.exit(1) at import time when deps are missing, so SystemExit
    # must be caught too. Degrade to a no-op; never break the pipeline.
    try:
        import numpy as np
        from bake_geodata import METROS, OCEAN_ELEV_M, download_dem, read_dem_mosaic
    except (Exception, SystemExit) as e:
        print(f"bake_city_elevation: geo deps unavailable ({e}) — skipped", file=sys.stderr)
        return 0

    if not CITIES_PATH.exists():
        print("bake_city_elevation: cities.json missing — run fetch_cities.py first",
              file=sys.stderr)
        return 0
    try:
        doc = json.loads(CITIES_PATH.read_text(encoding="utf-8-sig"))
        cities = doc["cities"]
    except (json.JSONDecodeError, KeyError, OSError) as e:
        print(f"bake_city_elevation: cities.json unreadable ({e}) — skipped",
              file=sys.stderr)
        return 0

    wanted = sys.argv[1:] or list(METROS)
    cache_dir = PIPELINE_DIR / ".dem_cache"
    cache_dir.mkdir(exist_ok=True)
    geo = (np, download_dem, read_dem_mosaic, OCEAN_ELEV_M)

    warnings: list[str] = []
    total = 0
    metros_run = []
    for key in wanted:
        if key not in METROS:
            print(f"unknown metro '{key}' — known: {', '.join(METROS)}", file=sys.stderr)
            continue
        total += enrich_metro(key, METROS[key], cities, cache_dir, geo, warnings)
        metros_run.append(key)

    for w in warnings:
        print(f"  WARNING: {w}", file=sys.stderr)

    if total == 0:
        print("bake_city_elevation: nothing enriched — cities.json left untouched")
        return 0

    meta = doc.setdefault("_meta", {})
    meta["elevation"] = {
        "source": "Copernicus GLO-30 DEM (ESA/Airbus, via AWS Open Data)",
        "method": f"mean of valid land cells in a ±{SAMPLE_HALF_DEG}° window "
                  f"around the city point; water/nodata excluded",
        "metros": metros_run,
        "cities_enriched": total,
        "baked_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    meta["note"] = ("mean_elev_m: DEM-derived (bake_city_elevation.py) inside "
                    "flagship-metro tile coverage; hand-authored values elsewhere "
                    "are carried forward by fetch_cities.py until covered.")
    CITIES_PATH.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")),
                           encoding="utf-8")
    with_elev = sum(1 for c in cities if c.get("mean_elev_m") is not None)
    print(f"bake_city_elevation: {total} cities enriched "
          f"({with_elev}/{len(cities)} now carry mean_elev_m) → {CITIES_PATH.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
