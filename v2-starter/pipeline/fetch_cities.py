#!/usr/bin/env python3
"""Fetch major world cities → public/data/cities.json  (VISUAL_UPGRADE_PLAN F1)

STATUS: STUB. The committed public/data/cities.json currently holds a small,
hand-authored set of approximate published figures so the ImpactStats +
city-pin foundation could ship without network access to GeoNames. This script
is the intended regeneration path; run it (with network access) to replace the
placeholder with a full GeoNames-derived dataset.

Source: GeoNames cities500 / cities1000 dump (CC BY 4.0).
  https://download.geonames.org/export/dump/cities1000.zip

Output schema (matches the placeholder):
  {
    "_meta": { ... },
    "cities": [
      { "name", "iso" (alpha-3), "lon", "lat", "population",
        "coastal" (bool),
        "metro_population"? , "mean_elev_m"? },
      ...
    ]
  }

Coastal flag + per-city coastal fields (mean_elev_m, % land below 0.5/1/2 m)
are NOT computed here — they come from the DEM in pipeline/bake_geodata.py (F3),
which is the deferred coastline-inundation build. This script only produces the
name/coordinate/population layer; bake_geodata.py enriches the flagship metros.
"""

import io
import json
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

import requests

PIPELINE_DIR = Path(__file__).parent
sys.path.insert(0, str(PIPELINE_DIR))

from utils.iso_normalize import normalize_iso  # noqa: E402

OUTPUT_PATH = PIPELINE_DIR.parent / "public" / "data" / "cities.json"
GEONAMES_URL = "https://download.geonames.org/export/dump/cities15000.zip"

# Keep the file small: cap at the largest N cities (plan target ~500–1000).
MAX_CITIES = 1000
MIN_POPULATION = 250_000

# GeoNames cities table columns (tab-separated). See the readme in the dump.
COLS = [
    "geonameid", "name", "asciiname", "alternatenames", "latitude", "longitude",
    "feature_class", "feature_code", "country_code", "cc2", "admin1_code",
    "admin2_code", "admin3_code", "admin4_code", "population", "elevation",
    "dem", "timezone", "modification_date",
]


def fetch_geonames() -> list[dict]:
    """Download + parse the GeoNames city dump into raw row dicts."""
    resp = requests.get(GEONAMES_URL, timeout=120)
    resp.raise_for_status()
    zf = zipfile.ZipFile(io.BytesIO(resp.content))
    name = next(n for n in zf.namelist() if n.endswith(".txt"))
    rows = []
    for line in zf.read(name).decode("utf-8").splitlines():
        parts = line.split("\t")
        if len(parts) < len(COLS):
            continue
        rows.append(dict(zip(COLS, parts)))
    return rows


def build_cities(rows: list[dict]) -> list[dict]:
    """Filter, normalize ISO, and shape rows into the output schema."""
    out = []
    for r in rows:
        try:
            pop = int(r["population"])
        except (ValueError, KeyError):
            continue
        if pop < MIN_POPULATION:
            continue
        iso3 = normalize_iso(r.get("country_code"))
        if not iso3:
            continue
        out.append({
            "name": r["name"],
            "iso": iso3,
            "lon": round(float(r["longitude"]), 3),
            "lat": round(float(r["latitude"]), 3),
            "population": pop,
            # coastal + mean_elev_m are filled by bake_geodata.py (DEM), not here.
            "coastal": False,
        })
    out.sort(key=lambda c: c["population"], reverse=True)
    return out[:MAX_CITIES]


# ── Natural Earth fallback source ────────────────────────────────────────────
# GeoNames requires direct HTTP to download.geonames.org, which some build
# environments can't reach. Natural Earth's populated-places layer (PUBLIC
# DOMAIN) is mirrored on GitHub, and a blob-filtered sparse clone rides plain
# https://github.com — reachable in far more environments. ~1 MB transferred.

NE_REPO = "https://github.com/nvkelso/natural-earth-vector.git"
NE_FILE = "geojson/ne_10m_populated_places_simple.geojson"


def fetch_natural_earth() -> list[dict]:
    """Sparse-clone Natural Earth and shape populated places into GeoNames-ish rows."""
    tmp = Path(tempfile.mkdtemp(prefix="ne_cities_"))
    try:
        subprocess.run(
            ["git", "clone", "--depth", "1", "--filter=blob:none", "--sparse",
             NE_REPO, str(tmp)],
            check=True, capture_output=True, text=True, timeout=300,
        )
        subprocess.run(
            ["git", "-C", str(tmp), "sparse-checkout", "set", "geojson"],
            check=True, capture_output=True, text=True, timeout=300,
        )
        geo = json.loads((tmp / NE_FILE).read_text(encoding="utf-8"))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    rows = []
    for feat in geo.get("features", []):
        p = feat.get("properties", {})
        coords = (feat.get("geometry") or {}).get("coordinates")
        if not coords:
            continue
        pop = p.get("pop_max") or 0
        rows.append({
            "name": p.get("name") or "",
            "country_code": p.get("adm0_a3") or "",   # alpha-3; normalize_iso handles it
            "longitude": coords[0],
            "latitude": coords[1],
            "population": str(int(pop)),
        })
    return rows


def load_enrichment() -> dict:
    """Carry forward hand-authored coastal fields from the existing cities.json.

    mean_elev_m / metro_population / coastal on flagship coastal metros were
    authored for ImpactStats before the DEM bake exists. Regenerating the city
    list must not silently drop them — bake_geodata.py (F3) is the thing that
    eventually replaces them with DEM-derived values.
    """
    if not OUTPUT_PATH.exists():
        return {}
    try:
        prior = json.loads(OUTPUT_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}
    keep = {}
    for c in prior.get("cities", []):
        extras = {k: c[k] for k in ("coastal", "metro_population", "mean_elev_m") if k in c}
        if extras.get("coastal") or "mean_elev_m" in extras or "metro_population" in extras:
            keep[(c["name"].lower(), c["iso"])] = extras
    return keep


def apply_enrichment(cities: list[dict], keep: dict) -> int:
    hits = 0
    for c in cities:
        extras = keep.get((c["name"].lower(), c["iso"]))
        if extras:
            c.update(extras)
            hits += 1
    return hits


def main() -> None:
    source_arg = sys.argv[1] if len(sys.argv) > 1 else "auto"

    rows, source_tag = None, None
    if source_arg in ("auto", "geonames"):
        try:
            print(f"Fetching GeoNames dump: {GEONAMES_URL}")
            rows = fetch_geonames()
            source_tag = "GeoNames cities15000 (CC BY 4.0)"
        except Exception as e:  # network-restricted environment — fall back
            if source_arg == "geonames":
                raise
            print(f"GeoNames unreachable ({e.__class__.__name__}); "
                  f"falling back to Natural Earth via GitHub.")
    if rows is None:
        print(f"Fetching Natural Earth populated places: {NE_REPO}")
        rows = fetch_natural_earth()
        source_tag = "Natural Earth 10m populated places (public domain)"

    cities = build_cities(rows)
    enriched = apply_enrichment(cities, load_enrichment())

    doc = {
        "_meta": {
            "description": "Named cities with population for on-globe city pins "
                           "and ImpactStats human anchors (VISUAL_UPGRADE_PLAN F1).",
            "source": source_tag,
            "population_basis": "largest published figure for the urban area "
                                "(pop_max / agglomeration)",
            "note": "coastal flag + mean_elev_m are added by pipeline/bake_geodata.py "
                    "(DEM); hand-authored coastal fields on flagship metros are "
                    "carried forward until that bake exists.",
            "count": len(cities),
        },
        "cities": cities,
    }
    OUTPUT_PATH.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")),
                           encoding="utf-8")
    print(f"Wrote {len(cities)} cities ({enriched} carried coastal enrichment) → {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
