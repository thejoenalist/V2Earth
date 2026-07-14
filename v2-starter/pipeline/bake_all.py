#!/usr/bin/env python3
"""
bake_all.py — master pipeline script.

Run this once before first launch and whenever source data needs refreshing.
Outputs land in public/data/ and are committed to the repo as static assets.

Usage:
    python pipeline/bake_all.py              # Run all fetchers + validate
    python pipeline/bake_all.py --only climate  # Run a specific fetcher

Requirements:
    pip install -r pipeline/requirements.txt
"""

import argparse
import json
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

PIPELINE_DIR = Path(__file__).parent
PROJECT_ROOT = PIPELINE_DIR.parent
OUTPUT_DIR = PROJECT_ROOT / "public" / "data"

FETCHERS = [
    ("fetch_boundaries.py", "Country boundaries (Natural Earth)"),
    ("fetch_worldbank.py", "GDP, population, HDI (World Bank + UNDP)"),
    ("fetch_cmip6.py", "Climate projections SSP2+SSP5 (CMIP6 via CCKP)"),
    ("fetch_cities.py", "City pins + populations (GeoNames / Natural Earth)"),
    ("bake_geodata.py", "Coastal inundation polygons (Copernicus GLO-30 DEM)"),
    # After bake_geodata.py: bake_tracks' surge reuses its DEM helpers + tile cache.
    ("bake_tracks.py", "Hurricane analog tracks + surge (IBTrACS + GLO-30)"),
    ("bake_admin1.py", "Admin-1 boundaries for drought choropleth (Natural Earth 10m, global)"),
    ("bake_landmask.py", "Burnable land+ice mask for wildfire (Natural Earth 50m)"),
    ("build_attribution.py", "Data source attribution (CC BY 4.0)"),
]


def run_script(script: str) -> bool:
    path = PIPELINE_DIR / script
    if not path.exists():
        print(f"  ⚠ Skipping {script} — not found")
        return False
    result = subprocess.run([sys.executable, str(path)], capture_output=False)
    return result.returncode == 0


def write_manifest() -> None:
    climate_path = OUTPUT_DIR / "climate.json"
    country_count = 0
    if climate_path.exists():
        with open(climate_path) as f:
            country_count = len(json.load(f))

    manifest = {
        "baked_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "pipeline_version": "2.0.0",
        "cmip6_version": "CMIP6 via CCKP",
        "worldbank_vintage": "2023",
        "country_count": country_count,
    }
    with open(OUTPUT_DIR / "manifest.json", "w") as f:
        json.dump(manifest, f, indent=2)


def run_validate() -> bool:
    validate_path = PIPELINE_DIR / "validate.py"
    result = subprocess.run([sys.executable, str(validate_path)], capture_output=False)
    return result.returncode == 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Earth Simulator data pipeline")
    parser.add_argument("--only", help="Run only a fetcher matching this keyword")
    parser.add_argument("--skip-validate", action="store_true", help="Skip validate.py")
    args = parser.parse_args()

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    print("\nEarth Simulator V2 — Data Pipeline\n")
    start = time.time()
    failures = []

    for script, description in FETCHERS:
        if args.only and args.only.lower() not in script.lower():
            continue
        print(f"▶ {description}")
        ok = run_script(script)
        if not ok:
            failures.append(script)
            print(f"  x Failed\n")
        else:
            print()

    if not args.only:
        write_manifest()
        print(f"  OK manifest.json written ({OUTPUT_DIR / 'manifest.json'})")

    elapsed = round(time.time() - start, 1)

    if failures:
        print(f"Pipeline completed with {len(failures)} failure(s): {', '.join(failures)}")
        print(f"  Total time: {elapsed}s")
        return 1

    print(f"Fetchers complete in {elapsed}s")
    print(f"   Output: {OUTPUT_DIR}")

    if args.skip_validate:
        return 0

    print("\n▶ Running validate.py …\n")
    if not run_validate():
        print("\nValidation failed — fix errors before deploying.\n")
        return 1

    print("\nPipeline + validation complete.\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
