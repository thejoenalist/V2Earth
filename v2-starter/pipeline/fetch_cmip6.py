#!/usr/bin/env python3
"""Fetch CMIP6 country projections via World Bank CCKP API → public/data/climate.json"""

import json
import sys
import time
from pathlib import Path

import requests

PIPELINE_DIR = Path(__file__).parent
sys.path.insert(0, str(PIPELINE_DIR))

from utils.iso_normalize import normalize_iso  # noqa: E402

OUTPUT_PATH = PIPELINE_DIR.parent / "public" / "data" / "climate.json"
CACHE_PATH = PIPELINE_DIR / ".cache" / "cmip6_cache.json"
CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)

CCKP_BASE = "https://cckpapi.worldbank.org/cckp/v1"
RATE_LIMIT_S = 0.5

CHAPTERS = [2025, 2050, 2075, 2100]
SSPS = {"SSP2-4.5": "ssp245", "SSP5-8.5": "ssp585"}
CHAPTER_PERIODS = {
    2025: "2020-2039",
    2050: "2040-2059",
    2075: "2060-2079",
    2100: "2080-2099",
}

# IPCC AR6 global mean sea level rise (m, median, relative to 1995–2014)
GLOBAL_SLR_M = {
    "SSP2-4.5": {2025: 0.08, 2050: 0.24, 2075: 0.38, 2100: 0.44},
    "SSP5-8.5": {2025: 0.09, 2050: 0.30, 2075: 0.55, 2100: 0.77},
}

LANDLOCKED = {
    "AFG", "ARM", "AUT", "AZE", "BFA", "BDI", "BOL", "BTN", "CAF", "CHE",
    "CZE", "ETH", "HUN", "KGZ", "LAO", "LIE", "LSO", "MKD", "MLI", "MNG",
    "NER", "NPL", "PRY", "RWA", "SRB", "SSD", "SVK", "SWZ", "TCD", "TJK",
    "TKM", "UGA", "UZB", "ZMB", "ZWE", "BWA", "MDA", "MNE", "KOS", "XKX",
}

PACIFIC_ISLANDS = {
    "TUV", "KIR", "MHL", "NRU", "PLW", "FSM", "TON", "WSM", "SLB", "VUT",
    "MDV", "COK", "NIU", "TKL",
}

COASTAL_HIGH = {
    "BGD", "NLD", "VNM", "EGY", "IDN", "PHL", "THA", "MMR", "KHM", "LKA",
    "PAK", "NGA", "GHA", "SEN", "GMB", "GNB", "MRT", "BEN", "TGO", "CMR",
    "GAB", "COG", "COD", "AGO", "MOZ", "TZA", "KEN", "SOM", "DJI", "ERI",
    "YEM", "OMN", "ARE", "QAT", "BHR", "KWT", "IRQ", "IRN", "LBY", "TUN",
    "DZA", "MAR", "USA", "MEX", "GTM", "BLZ", "HND", "NIC", "CRI", "PAN",
    "COL", "ECU", "PER", "CHL", "ARG", "URY", "BRA", "GUY", "SUR", "VEN",
    "CUB", "HTI", "DOM", "JAM", "TTO", "BHS", "BRB", "GRD", "VCT", "LCA",
    "KNA", "ATG", "DMA", "GBR", "IRL", "FRA", "ESP", "PRT", "ITA", "GRC",
    "HRV", "SVN", "MNE", "ALB", "TUR", "GEO", "RUS", "UKR", "ROU", "BGR",
    "CHN", "JPN", "KOR", "PRK", "TWN", "MYS", "SGP", "BRN", "AUS", "NZL",
    "PNG", "FJI", "NCL", "PYF",
}

COASTAL_POP_FRACTION = {
    "BGD": 0.28, "NLD": 0.55, "MDV": 0.99, "NLD": 0.55, "JPN": 0.92,
    "GBR": 0.22, "USA": 0.39, "AUS": 0.85, "IDN": 0.55, "PHL": 0.60,
}


def load_cache() -> dict:
    if CACHE_PATH.exists():
        with open(CACHE_PATH) as f:
            return json.load(f)
    return {}


def save_cache(cache: dict) -> None:
    with open(CACHE_PATH, "w") as f:
        json.dump(cache, f, separators=(",", ":"))


def cckp_url(variable: str, product: str, period: str, scenario: str) -> str:
    return (
        f"{CCKP_BASE}/cmip6-x0.25_climatology_{variable}_{product}_annual_"
        f"{period}_median_{scenario}_ensemble_all_mean/all_countries?_format=json"
    )


def fetch_layer(cache: dict, key: str, url: str) -> dict | None:
    if key in cache:
        return cache[key]

    time.sleep(RATE_LIMIT_S)
    try:
        resp = requests.get(url, timeout=120)
        resp.raise_for_status()
        payload = resp.json()
        if payload.get("metadata", {}).get("status") != "success":
            print(f"  ⚠ CCKP error for {key}")
            cache[key] = None
            save_cache(cache)
            return None
        data = payload.get("data")
        if not isinstance(data, dict) or not data:
            cache[key] = None
            save_cache(cache)
            return None
        cache[key] = data
        save_cache(cache)
        return data
    except requests.RequestException as exc:
        print(f"  ⚠ Request failed for {key}: {exc}")
        cache[key] = None
        save_cache(cache)
        return None


def extract_annual(country_entry: dict | None) -> float | None:
    if not country_entry or not isinstance(country_entry, dict):
        return None
    for val in country_entry.values():
        if isinstance(val, (int, float)):
            return round(float(val), 2)
    return None


def sea_level_multiplier(iso: str) -> float:
    if iso in LANDLOCKED:
        return 0.0
    if iso in PACIFIC_ISLANDS:
        return 1.25
    if iso in COASTAL_HIGH:
        return 1.15
    return 1.0


def exposed_population_pct(iso: str, slr_m: float) -> float:
    if slr_m <= 0:
        return 0.0
    base = COASTAL_POP_FRACTION.get(iso, 0.12)
    return round(min(1.0, base * (1.0 + slr_m * 1.5)), 4)


def drought_index(precip_change_pct: float | None) -> float | None:
    if precip_change_pct is None:
        return None
    return round(max(0.0, min(1.0, -precip_change_pct / 60.0)), 3)


def coverage_tier(confidence: float | None) -> str:
    if confidence is None or confidence < 0.3:
        return "sparse"
    if confidence >= 0.8:
        return "high"
    if confidence >= 0.6:
        return "medium"
    return "low"


def sparse_record() -> dict:
    return {
        "temperature_anomaly_c": None,
        "sea_level_rise_m": None,
        "precipitation_change_pct": None,
        "heat_days_gt35c": None,
        "drought_index": None,
        "exposed_population_pct": None,
        "confidence": None,
        "coverage_tier": "sparse",
    }


def main() -> int:
    print("▶ fetch_cmip6.py — CMIP6 via World Bank CCKP")
    cache = load_cache()

    layers: dict[str, dict] = {}
    for chapter, period in CHAPTER_PERIODS.items():
        for ssp_label, ssp_code in SSPS.items():
            tas_key = f"tas_anomaly_{period}_{ssp_code}"
            pr_key = f"prpercnt_anomaly_{period}_{ssp_code}"
            hi_key = f"hi35_climatology_{period}_{ssp_code}"

            tas_data = fetch_layer(cache, tas_key, cckp_url("tas", "anomaly", period, ssp_code))
            pr_data = fetch_layer(cache, pr_key, cckp_url("prpercnt", "anomaly", period, ssp_code))
            hi_data = fetch_layer(cache, hi_key, cckp_url("hi35", "climatology", period, ssp_code))

            layer_key = f"{chapter}|{ssp_label}"
            layers[layer_key] = {
                "tas": tas_data or {},
                "pr": pr_data or {},
                "hi": hi_data or {},
            }

    all_isos: set[str] = set()
    for layer in layers.values():
        for var_data in layer.values():
            all_isos.update(var_data.keys())

    climate: dict = {}
    for iso_raw in sorted(all_isos):
        iso = normalize_iso(iso_raw) or iso_raw
        if not iso or len(iso) != 3:
            continue

        climate.setdefault(iso, {})
        for chapter in CHAPTERS:
            climate[iso].setdefault(str(chapter), {})
            for ssp_label in SSPS:
                layer = layers[f"{chapter}|{ssp_label}"]
                tas_val = extract_annual(layer["tas"].get(iso_raw) or layer["tas"].get(iso))
                pr_val = extract_annual(layer["pr"].get(iso_raw) or layer["pr"].get(iso))
                hi_val = extract_annual(layer["hi"].get(iso_raw) or layer["hi"].get(iso))

                if tas_val is None and pr_val is None and hi_val is None:
                    climate[iso][str(chapter)][ssp_label] = sparse_record()
                    continue

                slr_base = GLOBAL_SLR_M[ssp_label][chapter]
                slr_m = round(slr_base * sea_level_multiplier(iso), 3)
                precip = pr_val
                if precip is not None:
                    precip = round(max(-60.0, min(100.0, precip)), 2)
                drought = drought_index(precip)
                exposed = exposed_population_pct(iso, slr_m)
                confidence = 0.91 if tas_val is not None else 0.3

                climate[iso][str(chapter)][ssp_label] = {
                    "temperature_anomaly_c": tas_val,
                    "sea_level_rise_m": slr_m,
                    "precipitation_change_pct": precip,
                    "heat_days_gt35c": hi_val,
                    "drought_index": drought,
                    "exposed_population_pct": exposed,
                    "confidence": round(confidence if tas_val is not None else 0.75, 2),
                    "coverage_tier": coverage_tier(confidence if tas_val is not None else 0.75),
                }

                # Sea level confidence is regional — cap blended confidence
                if tas_val is not None:
                    climate[iso][str(chapter)][ssp_label]["confidence"] = round(
                        min(0.91, max(0.75, 0.91 * 0.85 + 0.75 * 0.15)), 2
                    )
                    climate[iso][str(chapter)][ssp_label]["coverage_tier"] = coverage_tier(
                        climate[iso][str(chapter)][ssp_label]["confidence"]
                    )

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_PATH, "w") as f:
        json.dump(climate, f, separators=(",", ":"))

    print(f"  ✓ Wrote {len(climate)} countries → {OUTPUT_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
