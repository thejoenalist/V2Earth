#!/usr/bin/env python3
"""Bake a global burnable-land mask → public/data/geodata/landmask.json

NEXT_SESSION_PLAN Phase B #6 — the mask the wildfire render samples so fire only
appears on burnable ground, never open ocean or ice. Source: Natural Earth 1:50m
`land` minus `glaciated_areas` (public domain, GitHub — the source already used by
fetch_boundaries), plus an Antarctica cut (lat ≤ -60). Rasterized to a coarse
global grid and shipped as base64-packed bits (one bit per cell, MSB-first,
row-major from the north).

RUNS IN CI (GitHub Actions). It does NOT run inside a Cowork sandbox (that proxy
403s raw.githubusercontent) — same caveat as the DEM / IBTrACS / admin-1 bakes.
Until it runs, _renderWildfire keeps its current centroid behavior (no clipping);
the loader resolves to null and never throws.

Honest scope (mirror in _meta.note + surface nothing false on-screen):
  - Land vs water + ice, minus MAJOR NAMED DESERTS (Natural Earth 1:10m
    geography regions, featurecla=Desert — Sahara, Gobi, the Australian
    Outback deserts, etc.; decision locked 2026-07-16). This fixes the
    Outback-fire-on-sand eyeball and, via the render's nearestBurnable nudge,
    biases placement toward vegetated land. It is still NOT a full land-cover
    product: unnamed barren/urban areas are not excluded (MODIS / ESA
    WorldCover remains the documented fuller follow-up).
  - Coarse grid (RES_DEG): block-level, not parcel-level. A small coastal fire
    near a cell boundary may read as on/off by one ~25 km cell.

Deps: numpy, rasterio (already in requirements.txt for the DEM bake). If rasterio
is unavailable the bake is skipped (non-fatal) and the render falls back.

Usage:
  python pipeline/bake_landmask.py
"""

from __future__ import annotations

import base64
import json
import sys
import time
import urllib.request
from pathlib import Path

import numpy as np

PIPELINE_DIR = Path(__file__).parent
OUT_DIR = PIPELINE_DIR.parent / "public" / "data" / "geodata"

RES_DEG = 0.25                 # ~28 km cells; 1440×720 grid → ~127 KB packed
ANTARCTICA_LAT = -60.0         # rows south of this are forced non-burnable

NE_BASE = ("https://raw.githubusercontent.com/nvkelso/natural-earth-vector/"
           "master/geojson/")
LAND_URL = NE_BASE + "ne_50m_land.geojson"
ICE_URL = NE_BASE + "ne_50m_glaciated_areas.geojson"
# 1:10m geography regions (~24 MB) — the only NE product carrying named desert
# polygons; longer timeout for it, same pattern as the admin-1 1:10m fetch.
DESERT_URL = NE_BASE + "ne_10m_geography_regions_polys.geojson"


def _fetch_geojson(url: str, timeout: int = 120) -> dict:
    print(f"  downloading {url.rsplit('/', 1)[-1]} …")
    req = urllib.request.Request(url, headers={"User-Agent": "earthsim-pipeline"})
    with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 fixed https host
        return json.loads(r.read().decode("utf-8", errors="replace"))


def _geoms(fc: dict):
    for feat in fc.get("features", []):
        g = feat.get("geometry")
        if g:
            yield (g, 1)


def _desert_geoms(fc: dict):
    """Named desert polygons only (featurecla == 'Desert').

    NOTE: the geography-regions geojson uses UPPERCASE property keys
    (FEATURECLA/NAME), unlike ne_50m_land etc. The first CI bake (2026-07-16,
    run 29509684304) read the lowercase key, matched 0 features and degraded
    to land−ice — so keys are matched case-insensitively now. Verified against
    the real file: 58 Desert features incl. Sahara, Gobi, Kalahari, Taklimakan
    and all the Australian Outback deserts.
    """
    for feat in fc.get("features", []):
        g = feat.get("geometry")
        props = feat.get("properties") or {}
        cla = ""
        for k, v in props.items():
            if str(k).lower() == "featurecla":
                cla = str(v or "").strip().lower()
                break
        if g and cla == "desert":
            yield (g, 1)


def main() -> int:
    try:
        from rasterio.features import rasterize
        from rasterio.transform import from_origin
    except Exception as e:  # pragma: no cover
        print(f"bake_landmask: SKIPPED (rasterio unavailable: {e})", file=sys.stderr)
        return 0

    try:
        land = _fetch_geojson(LAND_URL)
        ice = _fetch_geojson(ICE_URL)
    except Exception as e:  # network — non-fatal, keep any existing file
        print(f"bake_landmask: SKIPPED (source unavailable: {e})", file=sys.stderr)
        return 0

    # Desert exclusion is best-effort: a failed fetch (or a featurecla drift
    # matching 0 features) degrades to the land-minus-ice mask rather than
    # killing the bake; _meta.desert_excluded records which mask shipped.
    desert_feats = []
    try:
        deserts = _fetch_geojson(DESERT_URL, timeout=300)
        desert_feats = list(_desert_geoms(deserts))
        if not desert_feats:
            print("bake_landmask: WARNING — geography regions fetched but no "
                  "featurecla='Desert' features found (schema drift?); deserts "
                  "NOT excluded", file=sys.stderr)
    except Exception as e:
        print(f"bake_landmask: WARNING — desert source unavailable ({e}); "
              f"deserts NOT excluded", file=sys.stderr)

    width = int(round(360.0 / RES_DEG))
    height = int(round(180.0 / RES_DEG))
    transform = from_origin(-180.0, 90.0, RES_DEG, RES_DEG)

    land_mask = rasterize(_geoms(land), out_shape=(height, width),
                          transform=transform, fill=0, default_value=1,
                          dtype="uint8", all_touched=True)
    ice_mask = rasterize(_geoms(ice), out_shape=(height, width),
                         transform=transform, fill=0, default_value=1,
                         dtype="uint8", all_touched=True)

    burnable = (land_mask == 1) & (ice_mask == 0)

    # Named-desert cut (all_touched=False on purpose: only cells whose center
    # region is desert are excluded, so desert-EDGE cells — where vegetation
    # transitions begin — stay burnable rather than over-excluding).
    desert_excluded = False
    if desert_feats:
        desert_mask = rasterize(desert_feats, out_shape=(height, width),
                                transform=transform, fill=0, default_value=1,
                                dtype="uint8", all_touched=False)
        burnable &= (desert_mask == 0)
        desert_excluded = True

    # Antarctica cut: force every row whose cell-center latitude ≤ -60 to False.
    row_lat = 90.0 - (np.arange(height) + 0.5) * RES_DEG
    burnable[row_lat <= ANTARCTICA_LAT, :] = False

    packed = np.packbits(burnable.astype(np.uint8).ravel())  # MSB-first, row-major
    b64 = base64.b64encode(packed.tobytes()).decode("ascii")

    src = "Natural Earth 1:50m land minus glaciated_areas (public domain)"
    if desert_excluded:
        src += " minus 1:10m geography-regions named deserts"
        note = ("burnable = land AND NOT ice AND NOT named desert; Antarctica "
                "(lat ≤ -60) excluded. Named deserts only (NE geography "
                "regions) — unnamed barren/urban areas are NOT excluded; a "
                "full land-cover product (MODIS / ESA WorldCover) remains the "
                "fuller follow-up. Coarse grid, block-level accuracy.")
    else:
        note = ("burnable = land AND NOT ice; Antarctica (lat ≤ -60) excluded. "
                "Desert source unavailable this bake — deserts NOT excluded. "
                "Coarse grid, block-level accuracy.")
    doc = {
        "_meta": {
            "source": src,
            "baked_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "note": note,
            "desert_excluded": desert_excluded,
            "burnable_cells": int(burnable.sum()),
        },
        "width": width,
        "height": height,
        "bbox": [-180.0, -90.0, 180.0, 90.0],
        "res_deg": RES_DEG,
        "row_order": "north_to_south",   # row 0 spans lat 90 → 90-RES
        "bit_order": "msb_first",         # np.packbits default
        "packed": b64,
    }

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / "landmask.json"
    out.write_text(json.dumps(doc, separators=(",", ":")), encoding="utf-8")
    pct = 100.0 * burnable.sum() / burnable.size
    print(f"bake_landmask: {width}×{height} grid, {burnable.sum()} burnable cells "
          f"({pct:.1f}%), deserts {'excluded' if desert_excluded else 'NOT excluded'} "
          f"→ {out} ({out.stat().st_size/1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
