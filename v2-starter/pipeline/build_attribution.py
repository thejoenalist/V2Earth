#!/usr/bin/env python3
"""Write public/data/attribution.json — required for CC BY 4.0 compliance."""

import json
from pathlib import Path

OUTPUT_PATH = Path(__file__).parent.parent / "public" / "data" / "attribution.json"

ATTRIBUTION = {
    "CMIP6": {
        "full_name": "Coupled Model Intercomparison Project Phase 6",
        "license": "CC BY 4.0",
        "citation": "Eyring et al. (2016), doi:10.5194/gmd-9-1937-2016",
        "accessed_via": "World Bank Climate Change Knowledge Portal",
        "url": "https://climateknowledgeportal.worldbank.org",
    },
    "WorldBank": {
        "full_name": "World Bank Open Data",
        "license": "CC BY 4.0",
        "url": "https://data.worldbank.org",
    },
    "NaturalEarth": {
        "full_name": "Natural Earth",
        "license": "Public Domain",
        "url": "https://naturalearthdata.com",
    },
    "NOAA_LOCA2": {
        "full_name": "NOAA LOCA2 Downscaled Projections",
        "license": "US Government Public Domain",
        "url": "https://loca.ucsd.edu",
    },
}


def main() -> int:
    print("▶ build_attribution.py")
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_PATH, "w") as f:
        json.dump(ATTRIBUTION, f, indent=2)
    print(f"  ✓ Wrote {OUTPUT_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
