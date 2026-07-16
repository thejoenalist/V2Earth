#!/usr/bin/env python3
"""Bake coastal inundation polygons → public/data/geodata/slr_<metro>.json

VISUAL_UPGRADE_PLAN F3 — the sea-level-rise flagship geometry. Bathtub model
from the Copernicus GLO-30 DEM (30 m, free) at rise steps 0.5 / 1.0 / 2.0 m,
clipped to flagship coastal metros. The frontend renders the "delta band" —
land that is dry today but below the projected water level and hydrologically
connected to the ocean.

RUNS IN CI (GitHub Actions), where network to the Copernicus AWS Open Data
bucket is available. Local runs work too if you can reach S3. If a metro's DEM
can't be downloaded the metro is skipped with a warning — this script must
never break the weekly pipeline.

Model honesty (surface these caveats in the UI, mirrored into each output's
_meta.caveats):
  - BATHTUB model: ignores levees, pumps, drainage, erosion. Same class of
    caveat NOAA's SLR Viewer discloses.
  - 30 m DEM: block-level accuracy. Not "the beach got six feet shorter".
  - Hydrological connectivity enforced (flood fill from the ocean), so inland
    depressions below sea level don't light up.

Deps: numpy, rasterio, shapely, scipy (see requirements.txt).

Usage:
  python pipeline/bake_geodata.py            # all metros
  python pipeline/bake_geodata.py miami      # one metro
"""

from __future__ import annotations

import json
import sys
import time
import urllib.request
from pathlib import Path

import numpy as np

try:
    import rasterio
    from rasterio.features import shapes as raster_shapes
    from rasterio.windows import from_bounds
    from scipy import ndimage
    from shapely.geometry import shape as shapely_shape, mapping
    from shapely.ops import unary_union
except ImportError as e:  # pragma: no cover
    print(f"bake_geodata: missing dependency ({e.name}). "
          f"pip install -r pipeline/requirements.txt", file=sys.stderr)
    sys.exit(1)

PIPELINE_DIR = Path(__file__).parent
OUT_DIR = PIPELINE_DIR.parent / "public" / "data" / "geodata"

DEM_URL = ("https://copernicus-dem-30m.s3.amazonaws.com/"
           "{tile}/{tile}.tif")

RISE_LEVELS_M = [0.5, 1.0, 2.0]

# Water/ocean threshold: Copernicus GLO-30 is ~0 over ocean.
OCEAN_ELEV_M = 0.05

# Output budget per metro file (bytes) — simplify harder until under this.
MAX_FILE_BYTES = 300_000

# Flagship metros (VISUAL_UPGRADE_PLAN §3.1). bbox = (lon_min, lat_min, lon_max, lat_max).
# tiles = Copernicus GLO-30 tile ids covering the bbox.
METROS = {
    "miami": {
        "display": "Miami",
        "bbox": (-80.50, 25.55, -80.05, 26.40),
        "center": {"lon": -80.19, "lat": 25.78},
        "tiles": [
            "Copernicus_DSM_COG_10_N25_00_W081_00_DEM",
            "Copernicus_DSM_COG_10_N26_00_W081_00_DEM",
        ],
    },
    "nyc": {
        "display": "New York City",
        "bbox": (-74.30, 40.45, -73.65, 40.95),
        "center": {"lon": -74.00, "lat": 40.71},
        "tiles": [
            "Copernicus_DSM_COG_10_N40_00_W075_00_DEM",
            "Copernicus_DSM_COG_10_N40_00_W074_00_DEM",
        ],
    },
    "new_orleans": {
        "display": "New Orleans",
        # Includes Lakeview/Gentilly north of 30°N (the Katrina flood bowl) —
        # hence the four-tile spread.
        "bbox": (-90.30, 29.80, -89.75, 30.10),
        "center": {"lon": -90.07, "lat": 29.95},
        "tiles": [
            "Copernicus_DSM_COG_10_N29_00_W091_00_DEM",
            "Copernicus_DSM_COG_10_N29_00_W090_00_DEM",
            "Copernicus_DSM_COG_10_N30_00_W091_00_DEM",
            "Copernicus_DSM_COG_10_N30_00_W090_00_DEM",
        ],
    },
    "jakarta": {
        "display": "Jakarta",
        # lon_max kept below 107°E so the bake stays inside the E106 tiles;
        # the flood-critical north coast (Pluit, Tanjung Priok) is included.
        "bbox": (106.65, -6.35, 106.99, -5.95),
        "center": {"lon": 106.83, "lat": -6.17},
        "tiles": [
            "Copernicus_DSM_COG_10_S07_00_E106_00_DEM",
            "Copernicus_DSM_COG_10_S06_00_E106_00_DEM",
        ],
    },
    "houston": {
        "display": "Houston–Galveston",
        # Galveston Bay + the ship channel up toward Houston proper — the
        # surge-critical geography for the Ike analog (bake_tracks.py).
        "bbox": (-95.40, 29.05, -94.60, 29.80),
        "center": {"lon": -95.36, "lat": 29.76},
        "tiles": [
            "Copernicus_DSM_COG_10_N29_00_W096_00_DEM",
            "Copernicus_DSM_COG_10_N29_00_W095_00_DEM",
        ],
    },
    # Wave 3 (2026-07-16): norfolk/lagos/shanghai/rotterdam. lagos + rotterdam
    # are SLR-only (no TC analog in bake_tracks — Gulf of Guinea / North Sea);
    # dhaka stays DEM-less on purpose (Ganges-delta bathtub needs its own
    # honesty pass — see bake_tracks REGISTRY note).
    "norfolk": {
        "display": "Norfolk–Hampton Roads",
        # Elizabeth River + Hampton Roads (Norfolk, Portsmouth, Hampton) — the
        # surge-critical geography for the Isabel analog. Virginia Beach's
        # oceanfront (east of 76.05°W) is outside to stay in the W077 tiles.
        "bbox": (-76.55, 36.70, -76.05, 37.05),
        "center": {"lon": -76.29, "lat": 36.85},
        "tiles": [
            "Copernicus_DSM_COG_10_N36_00_W077_00_DEM",
            "Copernicus_DSM_COG_10_N37_00_W077_00_DEM",
        ],
    },
    "lagos": {
        "display": "Lagos",
        # Lagos Island, Victoria Island, Lekki barrier coast + lagoon rim —
        # all within the single N06/E003 tile.
        "bbox": (3.10, 6.35, 3.70, 6.65),
        "center": {"lon": 3.39, "lat": 6.45},
        "tiles": [
            "Copernicus_DSM_COG_10_N06_00_E003_00_DEM",
        ],
    },
    "shanghai": {
        "display": "Shanghai",
        # Huangpu bend + Pudong out to the airport; lat_min held at 31.00 to
        # stay inside the single N31/E121 tile.
        "bbox": (121.20, 31.00, 121.90, 31.45),
        "center": {"lon": 121.47, "lat": 31.23},
        "tiles": [
            "Copernicus_DSM_COG_10_N31_00_E121_00_DEM",
        ],
    },
    "rotterdam": {
        "display": "Rotterdam",
        # City + port toward Hoek van Holland, single N51/E004 tile. NOTE:
        # much of the metro sits BELOW sea level behind the Delta Works — the
        # bathtub's "ignores levees/pumps" caveat is doing maximum work here
        # (same class as New Orleans, more extreme). The baked area_km2 is the
        # honest bathtub number; the render's existing caveat line covers it.
        "bbox": (4.00, 51.80, 4.60, 51.99),
        "center": {"lon": 4.48, "lat": 51.92},
        "tiles": [
            "Copernicus_DSM_COG_10_N51_00_E004_00_DEM",
        ],
    },
}

CAVEATS = [
    "Bathtub model — ignores levees, pumps, drainage and erosion "
    "(same caveat class as NOAA's Sea Level Rise Viewer).",
    "30 m elevation data — block-level accuracy, not parcel-level.",
    "Extent shown is land below the water level and connected to the ocean.",
]


def download_dem(tile: str, dest: Path) -> bool:
    url = DEM_URL.format(tile=tile)
    if dest.exists() and dest.stat().st_size > 0:
        return True
    try:
        print(f"  downloading {tile} …")
        urllib.request.urlretrieve(url, dest)  # noqa: S310 — fixed https host
        return True
    except Exception as e:
        print(f"  WARNING: DEM download failed for {tile}: {e}", file=sys.stderr)
        return False


def read_dem_mosaic(tile_paths: list[Path], bbox: tuple) -> tuple[np.ndarray, object]:
    """Read + mosaic the bbox window from the tile set.

    Returns (elevation array, affine transform). Tiles are 1°×1°; the mosaic is
    assembled on a common grid from each tile's windowed read.
    """
    lon_min, lat_min, lon_max, lat_max = bbox
    datasets = [rasterio.open(p) for p in tile_paths]
    try:
        res = abs(datasets[0].transform.a)  # ~0.000277° (varies with lat band)
        width = int(round((lon_max - lon_min) / res))
        height = int(round((lat_max - lat_min) / abs(datasets[0].transform.e)))
        mosaic = np.full((height, width), -9999.0, dtype=np.float32)
        from rasterio.transform import from_origin
        transform = from_origin(lon_min, lat_max, res, abs(datasets[0].transform.e))
        for ds in datasets:
            inter = (max(lon_min, ds.bounds.left), max(lat_min, ds.bounds.bottom),
                     min(lon_max, ds.bounds.right), min(lat_max, ds.bounds.top))
            if inter[0] >= inter[2] or inter[1] >= inter[3]:
                continue
            win = from_bounds(*inter, transform=ds.transform)
            data = ds.read(1, window=win, boundless=False)
            r0 = int(round((lat_max - inter[3]) / abs(transform.e)))
            c0 = int(round((inter[0] - lon_min) / res))
            # from_bounds yields fractional windows; ds.read rounds the shape
            # independently of r0/c0, so adjacent tiles can come back a pixel
            # larger than the destination slot (first hit: NYC's E-W tile pair,
            # (1800,1261) into (1800,1260)). Clip both sides to the overlap —
            # at worst one 30 m edge pixel at a tile seam, well inside the
            # DEM's stated block-level accuracy.
            dr0 = max(0, -r0)
            dc0 = max(0, -c0)
            r0 = max(r0, 0)
            c0 = max(c0, 0)
            r1 = min(r0 + data.shape[0] - dr0, height)
            c1 = min(c0 + data.shape[1] - dc0, width)
            if r1 <= r0 or c1 <= c0:
                continue
            mosaic[r0:r1, c0:c1] = data[dr0:dr0 + (r1 - r0), dc0:dc0 + (c1 - c0)]
        return mosaic, transform
    finally:
        for ds in datasets:
            ds.close()


def bathtub_delta(elev: np.ndarray, level_m: float) -> np.ndarray:
    """Newly-inundated land mask: below level, ocean-connected, dry today."""
    valid = elev > -9000
    wet = (elev <= level_m) & valid
    labels, _ = ndimage.label(wet)
    ocean = (elev <= OCEAN_ELEV_M) & valid
    ocean_labels = np.unique(labels[ocean])
    ocean_labels = ocean_labels[ocean_labels != 0]
    connected = np.isin(labels, ocean_labels)
    return connected & (elev > OCEAN_ELEV_M)  # exclude today's ocean → delta band


def mask_to_rings(mask: np.ndarray, transform, cell_area_km2: float,
                  simplify_deg: float, min_area_km2: float = 0.2) -> list:
    """Vectorize mask → simplified exterior rings [[lon,lat], …]."""
    polys = []
    for geom, val in raster_shapes(mask.astype(np.uint8), mask=mask, transform=transform):
        if val != 1:
            continue
        polys.append(shapely_shape(geom))
    if not polys:
        return []
    merged = unary_union(polys)
    geoms = list(merged.geoms) if merged.geom_type == "MultiPolygon" else [merged]
    rings = []
    for g in geoms:
        g = g.simplify(simplify_deg, preserve_topology=True)
        if g.is_empty:
            continue
        # rough km² (small-angle): 1° lon ≈ 111 km × cos(lat)
        lat0 = g.centroid.y
        area_km2 = g.area * 111.0 * 111.0 * abs(np.cos(np.radians(lat0)))
        if area_km2 < min_area_km2:
            continue
        ring = [[round(x, 4), round(y, 4)] for x, y in g.exterior.coords]
        if len(ring) >= 4:
            rings.append(ring)
    rings.sort(key=len, reverse=True)
    return rings


def bake_metro(key: str, cfg: dict, cache_dir: Path) -> bool:
    print(f"[{key}] baking …")
    tile_paths = []
    for tile in cfg["tiles"]:
        dest = cache_dir / f"{tile}.tif"
        if not download_dem(tile, dest):
            print(f"[{key}] SKIPPED (DEM unavailable)", file=sys.stderr)
            return False
        tile_paths.append(dest)

    elev, transform = read_dem_mosaic(tile_paths, cfg["bbox"])
    res_deg = abs(transform.a)
    lat_mid = (cfg["bbox"][1] + cfg["bbox"][3]) / 2
    cell_area_km2 = (res_deg * 111.0) ** 2 * abs(np.cos(np.radians(lat_mid)))

    levels = {}
    for level in RISE_LEVELS_M:
        mask = bathtub_delta(elev, level)
        area_km2 = round(float(mask.sum()) * cell_area_km2, 1)
        # tighten simplification until the whole file fits the budget
        for tol in (0.0004, 0.0008, 0.0016, 0.0032):
            rings = mask_to_rings(mask, transform, cell_area_km2, tol)
            if sum(len(r) for r in rings) * 18 < MAX_FILE_BYTES / len(RISE_LEVELS_M):
                break
        levels[f"{level:.1f}"] = {"area_km2": area_km2, "rings": rings}
        print(f"  +{level} m → {area_km2} km² newly inundated, "
              f"{len(rings)} polygons")

    doc = {
        "_meta": {
            "metro": key,
            "display": cfg["display"],
            "source": "Copernicus GLO-30 DEM (ESA/Airbus, via AWS Open Data) — "
                      "bathtub model, ocean-connected cells only",
            "baked_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "caveats": CAVEATS,
            "levels_m": RISE_LEVELS_M,
        },
        "center": cfg["center"],
        "bbox": cfg["bbox"],
        "levels": levels,
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUT_DIR / f"slr_{key}.json"
    out_path.write_text(json.dumps(doc, separators=(",", ":")), encoding="utf-8")
    size = out_path.stat().st_size
    print(f"[{key}] wrote {out_path.name} ({size/1024:.0f} KB)")
    if size > MAX_FILE_BYTES:
        print(f"[{key}] WARNING: exceeds {MAX_FILE_BYTES/1024:.0f} KB budget",
              file=sys.stderr)
    return True


def main() -> None:
    wanted = sys.argv[1:] or list(METROS)
    cache_dir = PIPELINE_DIR / ".dem_cache"
    cache_dir.mkdir(exist_ok=True)
    ok = 0
    for key in wanted:
        if key not in METROS:
            print(f"unknown metro '{key}' — known: {', '.join(METROS)}", file=sys.stderr)
            continue
        if bake_metro(key, METROS[key], cache_dir):
            ok += 1
    print(f"bake_geodata: {ok}/{len(wanted)} metros baked")
    # Exit 0 even on partial failure — weekly pipeline must not break on a
    # transient S3 problem; validate.py treats geodata as optional.


if __name__ == "__main__":
    main()
