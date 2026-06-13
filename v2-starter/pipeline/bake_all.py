#!/usr/bin/env python3
"""
bake_all.py — master pipeline script.

Run this once before first launch and whenever source data needs refreshing.
Outputs land in public/data/ and are committed to the repo as static assets.

Usage:
    python pipeline/bake_all.py              # Run all fetchers
    python pipeline/bake_all.py --only climate  # Run a specific fetcher

Requirements:
    pip install requests pandas numpy
"""

import argparse
import subprocess
import sys
import time
from pathlib import Path

PIPELINE_DIR = Path(__file__).parent
PROJECT_ROOT = PIPELINE_DIR.parent
OUTPUT_DIR = PROJECT_ROOT / "public" / "data"

FETCHERS = [
    # (script_name, output_subdir, description)
    ("fetch_natural_earth.py",  "natural_earth",  "Country/state boundaries (Natural Earth)"),
    ("fetch_worldbank.py",      "worldbank",      "GDP, HDI, trade, debt (World Bank)"),
    ("fetch_cmip6.py",          "climate",        "Climate projections SSP2+SSP5 (CMIP6)"),
    ("fetch_sealevel.py",       "climate",        "Sea level projections (NASA)"),
    ("fetch_acled.py",          "conflict",       "Armed conflict events (ACLED)"),
]

def run_fetcher(script):
    path = PIPELINE_DIR / script
    if not path.exists():
        print(f"  ⚠ Skipping {script} — not yet implemented")
        return True
    result = subprocess.run([sys.executable, str(path)], capture_output=False)
    return result.returncode == 0

def main():
    parser = argparse.ArgumentParser(description="Earth Simulator data pipeline")
    parser.add_argument("--only", help="Run only a specific fetcher by keyword")
    args = parser.parse_args()

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    print("\n🌍 Earth Simulator V2 — Data Pipeline\n")
    start = time.time()
    failures = []

    for script, subdir, description in FETCHERS:
        if args.only and args.only.lower() not in script.lower():
            continue
        print(f"▶ {description}")
        (OUTPUT_DIR / subdir).mkdir(parents=True, exist_ok=True)
        ok = run_fetcher(script)
        if not ok:
            failures.append(script)
            print(f"  ✗ Failed\n")
        else:
            print(f"  ✓ Done\n")

    elapsed = round(time.time() - start, 1)
    if failures:
        print(f"⚠ Pipeline completed with {len(failures)} failure(s): {', '.join(failures)}")
        print(f"  Total time: {elapsed}s")
        sys.exit(1)
    else:
        print(f"✅ Pipeline complete in {elapsed}s")
        print(f"   Output: {OUTPUT_DIR}")

if __name__ == "__main__":
    main()
