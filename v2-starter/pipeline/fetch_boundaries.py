#!/usr/bin/env python3
"""Download Natural Earth boundaries → public/data/countries.geojson"""

import json
import sys
from pathlib import Path

import requests

PIPELINE_DIR = Path(__file__).parent
sys.path.insert(0, str(PIPELINE_DIR))

from utils.iso_normalize import normalize_iso  # noqa: E402

SOURCE_URL = (
    "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/"
    "geojson/ne_110m_admin_0_countries.geojson"
)
OUTPUT_PATH = PIPELINE_DIR.parent / "public" / "data" / "countries.geojson"

# Natural Earth uses -99 for disputed/missing ISO_A3
NAME_TO_ISO = {
    "Kosovo": "XKX",
    "Taiwan": "TWN",
    "eSwatini": "SWZ",
    "North Macedonia": "MKD",
    "New Caledonia": "NCL",
    "Puerto Rico": "PRI",
    "Falkland Is.": "FLK",
    "Fr. S. Antarctic Lands": "ATF",
    "Northern Cyprus": None,
    "Somaliland": None,
    "N. Cyprus": None,
    "W. Sahara": "ESH",
    "Antarctica": "ATA",
}


def resolve_iso(props: dict) -> str | None:
    for key in ("ISO_A3", "ADM0_A3", "GU_A3", "SOV_A3"):
        raw = props.get(key)
        if raw is None or str(raw).strip() in ("-99", "-1", "", "None"):
            continue
        iso = normalize_iso(str(raw))
        if iso:
            return iso

    name = props.get("NAME") or props.get("ADMIN") or props.get("name")
    if name in NAME_TO_ISO:
        return NAME_TO_ISO[name]

    if name:
        return normalize_iso(name)

    return None


def main() -> int:
    print("▶ fetch_boundaries.py — Natural Earth 110m")
    resp = requests.get(SOURCE_URL, timeout=60)
    resp.raise_for_status()
    source = resp.json()

    features = []
    skipped = 0
    for feat in source.get("features", []):
        props = feat.get("properties", {})
        iso = resolve_iso(props)
        if not iso:
            skipped += 1
            name = props.get("NAME", "unknown")
            print(f"  ⚠ Skipping feature with unresolvable ISO: {name}")
            continue

        features.append({
            "type": "Feature",
            "properties": {
                "iso": iso,
                "NAME": props.get("NAME") or props.get("ADMIN") or "",
                "CONTINENT": props.get("CONTINENT", ""),
                "REGION_UN": props.get("REGION_UN", ""),
            },
            "geometry": feat.get("geometry"),
        })

    output = {"type": "FeatureCollection", "features": features}
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_PATH, "w") as f:
        json.dump(output, f, separators=(",", ":"))

    print(f"  ✓ Wrote {len(features)} features ({skipped} skipped) → {OUTPUT_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
