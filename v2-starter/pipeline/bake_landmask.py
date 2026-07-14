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
  - Land vs water + ice only. Deserts / barren / urban are NOT excluded — that
    needs a land-cover product (MODIS / ESA WorldCover), a documented follow-up.
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


def _fetch_geojson(url: str) -> dict:
    print(f"  downloading {url.rsplit('/', 1)[-1]} …")
    req = urllib.request.Request(url, headers={"User-Agent": "earthsim-pipeline"})
    with urllib.request.urlopen(req, timeout=120) as r:  # noqa: S310 fixed https host
        return json.loads(r.read().decode("utf-8", errors="replace"))


def _geoms(fc: dict):
    for feat in fc.get("features", []):
        g = feat.get("geometry")
        if g:
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

    # Antarctica cut: force every row whose cell-center latitude ≤ -60 to False.
    row_lat = 90.0 - (np.arange(height) + 0.5) * RES_DEG
    burnable[row_lat <= ANTARCTICA_LAT, :] = False

    packed = np.packbits(burnable.astype(np.uint8).ravel())  # MSB-first, row-major
    b64 = base64.b64encode(packed.tobytes()).decode("ascii")

    doc = {
        "_meta": {
            "source": "Natural Earth 1:50m land minus glaciated_areas (public domain)",
            "baked_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "note": "burnable = land AND NOT ice; Antarctica (lat ≤ -60) excluded. "
                    "Deserts / barren / urban are NOT excluded — that needs a "
                    "land-cover product (MODIS / ESA WorldCover). Coarse grid, "
                    "block-level accuracy.",
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
          f"({pct:.1f}%) → {out} ({out.stat().st_size/1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
