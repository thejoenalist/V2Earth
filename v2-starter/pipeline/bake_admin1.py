#!/usr/bin/env python3
"""Bake admin-1 (state/province) boundaries → public/data/geodata/admin1_<ISO3>.json

NEXT_SESSION_PLAN Phase B #5 — the geometry the drought choropleth binds to.
Source: Natural Earth 1:10m admin-1 states/provinces (public domain) — the 1:10m
set has full global coverage (~200 countries), where 1:50m only carried admin-1
for a handful of large nations. Split into one compact file per country so the
frontend fetches only the country it needs (Netlify bandwidth: the global set
never ships to a user who explores one nation).

RUNS IN CI (GitHub Actions), where network to raw.githubusercontent.com is
available. It does NOT run inside a Cowork sandbox (that proxy 403s raw.github) —
same operational caveat as the DEM / IBTrACS bakes. Until it runs, _renderDrought
falls back to the national-boundary polygon; no seed is committed (Natural Earth
geometry can't be fabricated, and there's nothing to hand-seed honestly).

Rule #4 note: this bakes GEOMETRY only. The choropleth colors every region by the
country's NATIONAL drought_index (climate.json) and labels it as such — no
sub-national climate value is invented here.

Usage:
  python pipeline/bake_admin1.py            # all countries
  python pipeline/bake_admin1.py USA AUS    # only these ISO3 codes
"""

from __future__ import annotations

import json
import sys
import time
import urllib.request
from pathlib import Path

PIPELINE_DIR = Path(__file__).parent
sys.path.insert(0, str(PIPELINE_DIR))

from utils.iso_normalize import normalize_iso  # noqa: E402

OUT_DIR = PIPELINE_DIR.parent / "public" / "data" / "geodata"

SOURCE_URL = (
    "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/"
    "geojson/ne_10m_admin_1_states_provinces.geojson"
)

# Geometry budget knobs — keep each per-country file small.
SIMPLIFY_DEG = 0.01        # ~1 km at the equator; plenty for a country-scale fill
COORD_DECIMALS = 3         # ~100 m rounding
MAX_POLYGONS_PER_REGION = 8   # largest N rings; drops archipelago islet spam
MIN_RING_POINTS = 4        # a valid polygon ring needs ≥4 (closed) points

# shapely is optional: used only to simplify. Without it we still bake, just
# with rounded-but-unsimplified geometry (larger files).
try:
    from shapely.geometry import shape as shapely_shape
    _HAVE_SHAPELY = True
except Exception:  # pragma: no cover
    _HAVE_SHAPELY = False


def _round_ring(ring: list) -> list:
    return [[round(x, COORD_DECIMALS), round(y, COORD_DECIMALS)] for x, y in ring]


def _polys_from_geometry(geom: dict) -> list[list]:
    """GeoJSON (Multi)Polygon → list of GeoJSON polygons (each = [outer, *holes])."""
    if not geom:
        return []
    t = geom.get("type")
    if t == "Polygon":
        return [geom["coordinates"]]
    if t == "MultiPolygon":
        return list(geom["coordinates"])
    return []


def _simplify_geometry(geom: dict) -> dict:
    if not _HAVE_SHAPELY:
        return geom
    try:
        g = shapely_shape(geom).simplify(SIMPLIFY_DEG, preserve_topology=True)
        if g.is_empty:
            return geom
        from shapely.geometry import mapping
        return mapping(g)
    except Exception:
        return geom


def _region_polygons(geom: dict) -> list[dict]:
    """→ [{outer:[[lon,lat]…], holes:[[[lon,lat]…]…]}], largest first, capped."""
    polys = _polys_from_geometry(_simplify_geometry(geom))
    out = []
    for rings in polys:
        if not rings or len(rings[0]) < MIN_RING_POINTS:
            continue
        outer = _round_ring(rings[0])
        holes = [_round_ring(h) for h in rings[1:] if len(h) >= MIN_RING_POINTS]
        out.append({"outer": outer, "holes": holes, "_n": len(outer)})
    out.sort(key=lambda p: p["_n"], reverse=True)
    for p in out:
        p.pop("_n", None)
    return out[:MAX_POLYGONS_PER_REGION]


def resolve_iso(props: dict) -> str | None:
    for key in ("adm0_a3", "iso_a2", "sr_adm0_a3", "gu_a3"):
        raw = props.get(key)
        if raw is None or str(raw).strip() in ("-99", "-1", "", "None"):
            continue
        iso = normalize_iso(str(raw))
        if iso:
            return iso
    return None


def region_name(props: dict) -> str:
    for key in ("name", "name_en", "gn_name", "woe_name"):
        v = props.get(key)
        if v:
            return str(v)
    return "—"


def fetch_source() -> dict:
    # 1:10m admin-1 is a large file (~100 MB+); give the download generous headroom.
    print(f"  downloading {SOURCE_URL.rsplit('/', 1)[-1]} (large — 1:10m) …")
    req = urllib.request.Request(SOURCE_URL, headers={"User-Agent": "earthsim-pipeline"})
    with urllib.request.urlopen(req, timeout=300) as r:  # noqa: S310 fixed https host
        return json.loads(r.read().decode("utf-8", errors="replace"))


def main() -> int:
    wanted = {normalize_iso(a) for a in sys.argv[1:]} if len(sys.argv) > 1 else None
    if wanted:
        wanted.discard(None)

    try:
        source = fetch_source()
    except Exception as e:  # network — non-fatal, keep any existing files
        print(f"bake_admin1: SKIPPED (source unavailable: {e})", file=sys.stderr)
        return 0

    # Group admin-1 features by country ISO3. Property-name casing differs across
    # Natural Earth releases (ISO_A3 vs iso_a3), so normalize keys to lowercase.
    by_iso: dict[str, list[dict]] = {}
    display: dict[str, str] = {}
    for feat in source.get("features", []):
        props = {str(k).lower(): v for k, v in (feat.get("properties") or {}).items()}
        iso = resolve_iso(props)
        if not iso or (wanted and iso not in wanted):
            continue
        polys = _region_polygons(feat.get("geometry"))
        if not polys:
            continue
        by_iso.setdefault(iso, []).append({"name": region_name(props), "polygons": polys})
        display.setdefault(iso, props.get("admin") or props.get("geonunit") or iso)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    baked_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    for iso, regions in by_iso.items():
        doc = {
            "_meta": {
                "iso": iso,
                "display": display.get(iso, iso),
                "source": "Natural Earth 1:10m admin-1 states/provinces (public domain)",
                "baked_at": baked_at,
                "region_count": len(regions),
                "note": "Geometry only. The drought choropleth colors every region "
                        "by the NATIONAL drought_index and labels it as such — no "
                        "sub-national climate value is baked here (rule #4).",
            },
            "iso": iso,
            "regions": regions,
        }
        out = OUT_DIR / f"admin1_{iso}.json"
        out.write_text(json.dumps(doc, separators=(",", ":")), encoding="utf-8")

    total_regions = sum(len(v) for v in by_iso.values())
    print(f"bake_admin1: {len(by_iso)} countries, {total_regions} admin-1 regions → {OUT_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
