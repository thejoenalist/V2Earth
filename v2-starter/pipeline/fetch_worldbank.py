#!/usr/bin/env python3
"""Fetch World Bank + UNDP indicators → public/data/worldbank.json"""

import io
import json
import sys
import time
from pathlib import Path

import pandas as pd
import requests

PIPELINE_DIR = Path(__file__).parent
sys.path.insert(0, str(PIPELINE_DIR))

from utils.iso_normalize import normalize_iso  # noqa: E402

OUTPUT_PATH = PIPELINE_DIR.parent / "public" / "data" / "worldbank.json"
WB_BASE = "https://api.worldbank.org/v2"
HDI_URL = (
    "https://hdr.undp.org/sites/default/files/2023-24_HDR/"
    "HDR23-24_Composite_indices_complete_time_series.csv"
)

INDICATORS = {
    "population": "SP.POP.TOTL",
    "gdp_usd": "NY.GDP.MKTP.CD",
    "urban_pct": "SP.URB.TOTL.IN.ZS",
}

AGGREGATE_CODES = {
    "WLD", "AFE", "AFW", "ARB", "CEB", "CSS", "EAP", "ECA", "ECS", "EUU",
    "FCS", "HIC", "HPC", "IBD", "IBT", "IDA", "IDB", "IDX", "LAC", "LCN",
    "LDC", "LMY", "LTE", "MEA", "MIC", "MNA", "NAC", "OED", "OSS", "PRE",
    "PSS", "PST", "SAS", "SSA", "SSF", "SST", "TEA", "TEC", "TLA", "TMN",
    "TSA", "TSS", "UMC", "INX",
}


def fetch_indicator(indicator_id: str) -> dict[str, float | None]:
    """Fetch latest value for all countries for one indicator."""
    url = f"{WB_BASE}/country/all/indicator/{indicator_id}"
    params = {"format": "json", "mrv": 1, "per_page": 400}
    time.sleep(0.3)
    resp = requests.get(url, params=params, timeout=60)
    resp.raise_for_status()
    payload = resp.json()
    if not isinstance(payload, list) or len(payload) < 2:
        return {}

    result: dict[str, float | None] = {}
    for row in payload[1]:
        iso3 = row.get("countryiso3code", "")
        if not iso3 or iso3 in AGGREGATE_CODES or len(iso3) != 3:
            continue
        iso = normalize_iso(iso3) or iso3
        val = row.get("value")
        if val is not None:
            result[iso] = float(val)
    return result


def fetch_hdi() -> dict[str, float]:
    time.sleep(0.3)
    resp = requests.get(HDI_URL, timeout=120)
    resp.raise_for_status()
    df = pd.read_csv(io.StringIO(resp.text))
    hdi_col = "hdi_2022" if "hdi_2022" in df.columns else None
    if not hdi_col:
        hdi_cols = [c for c in df.columns if c.startswith("hdi_")]
        hdi_col = sorted(hdi_cols)[-1] if hdi_cols else None
    if not hdi_col:
        print("  ⚠ Could not find HDI column in HDR CSV")
        return {}

    result: dict[str, float] = {}
    for _, row in df.iterrows():
        iso = normalize_iso(str(row.get("iso3", "")))
        if not iso:
            continue
        val = row.get(hdi_col)
        if pd.notna(val):
            result[iso] = round(float(val), 3)
    return result


def main() -> int:
    print("▶ fetch_worldbank.py — World Bank + UNDP HDR")

    datasets = {field: fetch_indicator(ind_id) for field, ind_id in INDICATORS.items()}
    hdi_data = fetch_hdi()

    all_isos = set()
    for data in datasets.values():
        all_isos.update(data.keys())
    all_isos.update(hdi_data.keys())

    worldbank: dict = {}
    for iso in sorted(all_isos):
        worldbank[iso] = {
            "population": datasets["population"].get(iso),
            "gdp_usd": datasets["gdp_usd"].get(iso),
            "hdi": hdi_data.get(iso),
            "urban_pct": datasets["urban_pct"].get(iso),
        }

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_PATH, "w") as f:
        json.dump(worldbank, f, separators=(",", ":"))

    print(f"  ✓ Wrote {len(worldbank)} countries → {OUTPUT_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
