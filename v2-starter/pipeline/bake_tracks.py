#!/usr/bin/env python3
"""
bake_tracks.py — bake historical-analog hurricane tracks to static JSON.

HURRICANE_TRACKS_PLAN Phase 1 (track only; surge is a later phase that reuses
bake_geodata.py's bathtub helpers). For each flagship metro with a curated
analog storm, this pulls that storm's best track from IBTrACS and writes
public/data/geodata/hurricane_<metro>.json in the schema _renderHurricaneTrack
consumes.

RUNS IN CI (GitHub Actions), where the network to NOAA NCEI is available. It
does NOT run inside a Cowork sandbox (egress is limited to GitHub/PyPI/npm there)
— same operational caveat as bake_geodata.py's DEM download. A committed
hand-seeded seed file (seed:true) keeps the render working until this runs.

Data source: IBTrACS v04r01 (International Best Track Archive for Climate
Stewardship), NOAA NCEI — US-Gov public domain. One basin "list" CSV per storm.

Every value written here is measured/archived — no synthesis. rule #4 (CLAUDE.md):
displayed numbers come from baked data only.
"""

import csv
import io
import json
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

PIPELINE_DIR = Path(__file__).parent
OUT_DIR = PIPELINE_DIR.parent / "public" / "data" / "geodata"

IBTRACS_CSV = (
    "https://www.ncei.noaa.gov/data/"
    "international-best-track-archive-for-climate-stewardship-ibtracs/"
    "v04r01/access/csv/ibtracs.{basin}.list.v04r01.csv"
)

# Curated analog registry: metro -> the historical storm we show for that coast.
# metro_lon/lat are used only to pick the nearest-approach point as landfall.
# Jakarta is intentionally absent — near-equator, no meaningful TC landfall.
REGISTRY = {
    "new_orleans": {
        "display": "New Orleans", "basin": "NA",
        "sid": "2005236N23285", "name": "Katrina", "year": 2005,
        "metro_lon": -90.07, "metro_lat": 29.95,
    },
    "miami": {
        "display": "Miami", "basin": "NA",
        "sid": "1992230N11325", "name": "Andrew", "year": 1992,
        "metro_lon": -80.19, "metro_lat": 25.78,
    },
    "nyc": {
        "display": "New York City", "basin": "NA",
        "sid": "2012296N14283", "name": "Sandy", "year": 2012,
        "metro_lon": -74.00, "metro_lat": 40.71,
    },
}

SYNOPTIC_HOURS = {0, 6, 12, 18}  # 6-hourly cadence keeps files small

# Category-typical still-water surge height (m), keyed by the storm's PEAK
# Saffir–Simpson category. These are coarse representative values in the range
# NOAA/NHC uses for public surge guidance — NOT a modeled surge for a specific
# storm/coast. The bathtub footprint they drive carries an explicit caveat, and
# the render labels it "category-typical, bathtub" so nothing on screen claims
# storm-specific accuracy. (For real physics, Phase 3 would swap in NOAA SLOSH
# MOM composites — see HURRICANE_TRACKS_PLAN.md.)
SURGE_HEIGHT_M = {1: 1.5, 2: 2.5, 3: 3.5, 4: 5.0, 5: 6.5}


def _to_float(s):
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def _category(sshs):
    """USA_SSHS (-5..5) → Saffir–Simpson category clamped to 0..5."""
    v = _to_float(sshs)
    if v is None:
        return 0
    return max(0, min(5, int(v)))


def fetch_basin_rows(basin: str):
    url = IBTRACS_CSV.format(basin=basin)
    print(f"  downloading IBTrACS {basin} …")
    with urllib.request.urlopen(url, timeout=120) as resp:  # noqa: S310 fixed https host
        text = resp.read().decode("utf-8", errors="replace")
    reader = csv.reader(io.StringIO(text))
    header = next(reader)
    next(reader, None)  # units row
    idx = {name: i for i, name in enumerate(header)}
    return reader, idx


def build_track(cfg: dict):
    reader, idx = fetch_basin_rows(cfg["basin"])
    sid = cfg["sid"]
    col = lambda row, name: row[idx[name]] if name in idx else ""

    pts = []
    for row in reader:
        if not row or col(row, "SID") != sid:
            continue
        iso = col(row, "ISO_TIME")
        try:
            hour = datetime.fromisoformat(iso).hour
        except ValueError:
            hour = None
        if hour is not None and hour not in SYNOPTIC_HOURS:
            continue
        lon, lat = _to_float(col(row, "LON")), _to_float(col(row, "LAT"))
        if lon is None or lat is None:
            continue
        pts.append({
            "lon": round(lon, 2),
            "lat": round(lat, 2),
            "wind_kt": int(_to_float(col(row, "USA_WIND")) or 0),
            "category": _category(col(row, "USA_SSHS")),
        })
    return pts


def nearest_landfall(pts, mlon, mlat):
    """Point of closest approach to the metro — a stand-in for landfall."""
    best, bestd = None, float("inf")
    for p in pts:
        d = (p["lon"] - mlon) ** 2 + (p["lat"] - mlat) ** 2
        if d < bestd:
            best, bestd = p, d
    return {"lon": best["lon"], "lat": best["lat"]} if best else None


def compute_surge(key: str, peak_category: int, cache_dir: Path):
    """
    Bathtub surge footprint on the Copernicus GLO-30 DEM, reusing
    bake_geodata.py. Best-effort: returns None (and the metro stays track-only)
    if the geo deps or DEM tiles aren't available — e.g. inside a Cowork sandbox.
    Height is category-typical (SURGE_HEIGHT_M), never storm-modeled.
    """
    try:
        import numpy as np
        from bake_geodata import (
            METROS, download_dem, read_dem_mosaic, bathtub_delta, mask_to_rings,
        )
    except Exception as e:
        print(f"[{key}] surge skipped (geo deps unavailable: {e})")
        return None
    if key not in METROS:
        print(f"[{key}] surge skipped (no DEM tiles registered in bake_geodata.METROS)")
        return None

    cfg = METROS[key]
    cache_dir.mkdir(parents=True, exist_ok=True)
    tile_paths = []
    for tile in cfg["tiles"]:
        dest = cache_dir / f"{tile}.tif"
        if not download_dem(tile, dest):
            print(f"[{key}] surge skipped (DEM tile unavailable: {tile})")
            return None
        tile_paths.append(dest)

    elev, transform = read_dem_mosaic(tile_paths, cfg["bbox"])
    res_deg = abs(transform.a)
    lat_mid = (cfg["bbox"][1] + cfg["bbox"][3]) / 2
    cell_area_km2 = (res_deg * 111.0) ** 2 * abs(np.cos(np.radians(lat_mid)))

    height = SURGE_HEIGHT_M.get(peak_category, 3.5)
    mask = bathtub_delta(elev, height)
    area_km2 = round(float(mask.sum()) * cell_area_km2, 1)
    rings = mask_to_rings(mask, transform, cell_area_km2,
                          simplify_deg=0.002, min_area_km2=0.5)
    if not rings:
        print(f"[{key}] surge produced no rings at {height} m")
        return None
    print(f"[{key}] surge: {height} m → {area_km2} km², {len(rings)} rings")
    return {"height_m": height, "area_km2": area_km2, "rings": rings}


def bake_metro(key: str, cfg: dict, cache_dir: Path) -> bool:
    print(f"[{key}] baking track for {cfg['name']} ({cfg['year']}) …")
    try:
        pts = build_track(cfg)
    except Exception as e:  # network / parse — skip, keep any existing seed
        print(f"[{key}] SKIPPED ({e})", file=sys.stderr)
        return False
    if len(pts) < 2:
        print(f"[{key}] SKIPPED (no track points for SID {cfg['sid']})", file=sys.stderr)
        return False

    peak = max(p["category"] for p in pts)
    caveats = [
        "Track is a real historical storm shown as an analog — NOT a "
        "forecast for this location or date.",
    ]
    surge = compute_surge(key, peak, cache_dir)
    if surge:
        caveats.append(
            "Surge is a category-typical bathtub fill on a 30 m DEM — ignores "
            "storm forward speed, angle, bathymetry and defenses; not this "
            "storm's observed surge."
        )

    doc = {
        "_meta": {
            "metro": key, "display": cfg["display"],
            "analog": {
                "name": cfg["name"], "year": cfg["year"],
                "sid": cfg["sid"], "peak_category": peak,
            },
            "track_source": "IBTrACS v04r01 (NOAA NCEI, public domain)",
            "surge_source": (
                "Copernicus GLO-30 bathtub at category-typical height"
                if surge else None
            ),
            "seed": False,
            "baked_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "caveats": caveats,
        },
        "track": pts,
        "landfall": nearest_landfall(pts, cfg["metro_lon"], cfg["metro_lat"]),
    }
    if surge:
        doc["surge"] = surge

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / f"hurricane_{key}.json"
    out.write_text(json.dumps(doc, separators=(",", ":")))
    print(f"[{key}] wrote {out.name} ({len(pts)} points, peak Cat {peak})")
    return True


def main():
    cache_dir = PIPELINE_DIR / ".dem_cache"
    ok = 0
    for key, cfg in REGISTRY.items():
        if bake_metro(key, cfg, cache_dir):
            ok += 1
    print(f"bake_tracks: {ok}/{len(REGISTRY)} metros baked.")
    # Non-fatal: a skipped metro keeps its committed seed file.
    return 0


if __name__ == "__main__":
    sys.exit(main())
