"""
pipeline/validate.py — Earth Simulator V2 data validation

Runs after bake_all.py to verify the baked static JSON is complete,
plausible, and correctly attributed before it can be served.

Usage:
  python pipeline/validate.py                  # validate all baked data
  python pipeline/validate.py --only climate   # validate one dataset

Exit codes:
  0 — all checks passed
  1 — one or more checks failed (CI/CD will catch this and fail the build)

Output:
  validation_report.json committed to the repo alongside the baked data.
  Human-readable summary printed to stdout.
"""

import json
import sys
import argparse
from pathlib import Path
from datetime import datetime, timezone

# ── Configuration ─────────────────────────────────────────────────────────────

BAKED_DATA_DIR   = Path(__file__).parent.parent / "public" / "data"
REPORT_PATH      = BAKED_DATA_DIR / "validation_report.json"
EXPECTED_CHAPTERS = [2025, 2050, 2075, 2100]
EXPECTED_SSPS     = ["SSP2-4.5", "SSP5-8.5"]

# Minimum expected ISO alpha-3 country codes (195 UN member states + key territories)
# A shorter sentinel list — full coverage is checked via count threshold
REQUIRED_ISOS = [
    "USA", "CHN", "IND", "BRA", "DEU", "FRA", "GBR", "JPN", "AUS", "CAN",
    "ZAF", "NGA", "ETH", "EGY", "BGD", "IDN", "PAK", "MEX", "ARG", "RUS",
    "IRN", "TUR", "SAU", "NLD", "SWE", "NOR", "DNK", "FIN", "NZL", "SGP",
    # Low-lying / high climate risk — must always be present
    "MDV", "TUV", "KIR", "MHL", "NRU", "PLW", "FSM", "TON", "SLB", "VUT",
    # Conflict + climate overlap
    "PSE", "YEM", "SOM", "SSD", "SDN", "SYR",
]

# Value sanity bounds for climate fields
FIELD_BOUNDS = {
    "temperature_anomaly_c":  (-2.0, 8.0),    # CMIP6 range for global mean surface temp change
    "sea_level_rise_m":       (-0.05, 1.5),   # negative = slight fall in some regions
    "precipitation_change_pct": (-60.0, 100.0),
    "heat_days_gt35c":        (0, 365),
    "drought_index":          (0.0, 1.0),
    "exposed_population_pct": (0.0, 1.0),
    "confidence":             (0.0, 1.0),
}

# Coverage tier thresholds
# 'high'   = ensemble mean + 10th/90th percentile available
# 'medium' = ensemble mean only
# 'low'    = single-model or downscaled proxy
# 'sparse' = no CMIP6 coverage — simulator will explicitly disclose this to the user
SPARSE_THRESHOLD = 0.3   # confidence below this → flag as sparse in the output

# ── Validators ────────────────────────────────────────────────────────────────

def load_json(path: Path) -> dict | list | None:
    if not path.exists():
        return None
    with open(path) as f:
        return json.load(f)


def validate_climate(errors: list, warnings: list) -> bool:
    """
    Validates public/data/climate.json — the main CMIP6 baked output.
    Expected schema: { "<ISO3>": { "<year>": { "<ssp>": { ...fields } } } }
    """
    path = BAKED_DATA_DIR / "climate.json"
    data = load_json(path)

    if data is None:
        errors.append("climate.json missing — run bake_all.py first")
        return False

    iso_count = len(data)
    if iso_count < 150:
        errors.append(f"climate.json: only {iso_count} countries (expected ≥150)")

    sparse_isos = []

    for iso in REQUIRED_ISOS:
        if iso not in data:
            errors.append(f"climate.json: required ISO missing: {iso}")
            continue

        for year in EXPECTED_CHAPTERS:
            if str(year) not in data[iso]:
                errors.append(f"climate.json: {iso} missing chapter {year}")
                continue

            for ssp in EXPECTED_SSPS:
                if ssp not in data[iso][str(year)]:
                    errors.append(f"climate.json: {iso}/{year} missing SSP {ssp}")
                    continue

                record = data[iso][str(year)][ssp]

                # Check required fields exist
                for field, (lo, hi) in FIELD_BOUNDS.items():
                    if field not in record:
                        warnings.append(f"climate.json: {iso}/{year}/{ssp} missing field '{field}'")
                        continue
                    val = record[field]
                    if not isinstance(val, (int, float)):
                        errors.append(f"climate.json: {iso}/{year}/{ssp}/{field} not numeric: {val}")
                        continue
                    if not (lo <= val <= hi):
                        errors.append(
                            f"climate.json: {iso}/{year}/{ssp}/{field} = {val} "
                            f"out of expected range [{lo}, {hi}]"
                        )

                # Flag sparse coverage
                conf = record.get("confidence", 1.0)
                if conf < SPARSE_THRESHOLD:
                    sparse_isos.append(f"{iso}/{year}/{ssp} (confidence={conf:.2f})")
                    # Mark in the data so the simulator UI can surface this
                    data[iso][str(year)][ssp]["coverage_tier"] = "sparse"
                elif conf < 0.6:
                    data[iso][str(year)][ssp]["coverage_tier"] = "low"
                elif conf < 0.8:
                    data[iso][str(year)][ssp]["coverage_tier"] = "medium"
                else:
                    data[iso][str(year)][ssp]["coverage_tier"] = "high"

    if sparse_isos:
        warnings.append(
            f"Sparse CMIP6 coverage flagged for {len(sparse_isos)} region/chapter/ssp "
            f"combinations — simulator will disclose this to users. "
            f"First 5: {sparse_isos[:5]}"
        )
        # Write back the annotated data with coverage_tier fields
        with open(path, "w") as f:
            json.dump(data, f, separators=(",", ":"))

    return len([e for e in errors if "climate.json" in e]) == 0


def validate_world_bank(errors: list, warnings: list) -> bool:
    """
    Validates public/data/worldbank.json — population, GDP, vulnerability indices.
    """
    path = BAKED_DATA_DIR / "worldbank.json"
    data = load_json(path)

    if data is None:
        errors.append("worldbank.json missing — run pipeline/fetch_worldbank.py")
        return False

    required_fields = ["population", "gdp_usd", "hdi", "urban_pct"]
    for iso in REQUIRED_ISOS[:20]:   # spot check key nations
        if iso not in data:
            warnings.append(f"worldbank.json: {iso} missing")
            continue
        for field in required_fields:
            if field not in data[iso]:
                warnings.append(f"worldbank.json: {iso} missing field '{field}'")

    return True


def validate_attribution(errors: list, warnings: list) -> bool:
    """
    Validates public/data/attribution.json — source attribution for all datasets.
    This file must exist and must contain entries for every dataset used.
    Required for CC BY 4.0 compliance (CMIP6, World Bank).
    """
    path = BAKED_DATA_DIR / "attribution.json"
    data = load_json(path)

    if data is None:
        errors.append(
            "attribution.json missing — CC BY 4.0 compliance requires attribution "
            "for CMIP6 and World Bank data. Run pipeline/build_attribution.py"
        )
        return False

    required_sources = ["CMIP6", "WorldBank", "NaturalEarth", "NOAA_LOCA2"]
    for src in required_sources:
        if src not in data:
            errors.append(f"attribution.json: missing required source '{src}'")

    return True


def validate_geojson(errors: list, warnings: list) -> bool:
    """
    Validates public/data/countries.geojson — boundary data from Natural Earth.
    """
    path = BAKED_DATA_DIR / "countries.geojson"
    data = load_json(path)

    if data is None:
        errors.append("countries.geojson missing — run pipeline/fetch_boundaries.py")
        return False

    feature_count = len(data.get("features", []))
    if feature_count < 150:
        errors.append(f"countries.geojson: only {feature_count} features (expected ≥150)")

    return True


def validate_pipeline_manifest(errors: list, warnings: list) -> bool:
    """
    Validates public/data/manifest.json — records when data was last baked and from what.
    """
    path = BAKED_DATA_DIR / "manifest.json"
    data = load_json(path)

    if data is None:
        errors.append("manifest.json missing — bake_all.py should generate this")
        return False

    required_keys = ["baked_at", "cmip6_version", "worldbank_vintage", "pipeline_version"]
    for key in required_keys:
        if key not in data:
            warnings.append(f"manifest.json: missing key '{key}'")

    # Warn if data is more than 8 days old (weekly pipeline should prevent this)
    if "baked_at" in data:
        try:
            baked_at = datetime.fromisoformat(data["baked_at"])
            age_days = (datetime.now(timezone.utc) - baked_at).days
            if age_days > 8:
                warnings.append(
                    f"manifest.json: data is {age_days} days old "
                    f"(baked {data['baked_at']}) — weekly pipeline may have failed"
                )
        except (ValueError, TypeError):
            warnings.append("manifest.json: could not parse baked_at timestamp")

    return True


# ── Main ──────────────────────────────────────────────────────────────────────

VALIDATORS = {
    "climate":     validate_climate,
    "worldbank":   validate_world_bank,
    "attribution": validate_attribution,
    "geojson":     validate_geojson,
    "manifest":    validate_pipeline_manifest,
}


def main():
    parser = argparse.ArgumentParser(description="Validate Earth Simulator V2 baked data")
    parser.add_argument("--only", choices=list(VALIDATORS.keys()),
                        help="Run only one validator")
    args = parser.parse_args()

    errors:   list[str] = []
    warnings: list[str] = []

    validators_to_run = (
        {args.only: VALIDATORS[args.only]} if args.only else VALIDATORS
    )

    print(f"\n🌍 Earth Simulator V2 — Data Validation")
    print(f"   {datetime.now(timezone.utc).isoformat()}\n")

    results = {}
    for name, fn in validators_to_run.items():
        passed = fn(errors, warnings)
        results[name] = "PASS" if passed else "FAIL"
        icon = "✅" if passed else "❌"
        print(f"   {icon} {name:<16} {results[name]}")

    if warnings:
        print(f"\n⚠️  Warnings ({len(warnings)}):")
        for w in warnings:
            print(f"   · {w}")

    if errors:
        print(f"\n❌ Errors ({len(errors)}):")
        for e in errors:
            print(f"   · {e}")

    # Write report
    report = {
        "validated_at": datetime.now(timezone.utc).isoformat(),
        "passed": len(errors) == 0,
        "results": results,
        "error_count": len(errors),
        "warning_count": len(warnings),
        "errors": errors,
        "warnings": warnings,
    }

    BAKED_DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(REPORT_PATH, "w") as f:
        json.dump(report, f, indent=2)

    print(f"\n   Report saved to: {REPORT_PATH.relative_to(Path.cwd())}")

    if errors:
        print(f"\n❌ Validation FAILED — {len(errors)} error(s). Fix before deploying.\n")
        sys.exit(1)
    else:
        print(f"\n✅ Validation PASSED — {len(warnings)} warning(s).\n")
        sys.exit(0)


if __name__ == "__main__":
    main()
