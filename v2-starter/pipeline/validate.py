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
    with open(path, encoding="utf-8-sig") as f:
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
                tier = record.get("coverage_tier", "high")

                # Check required fields exist
                for field, (lo, hi) in FIELD_BOUNDS.items():
                    if field not in record:
                        warnings.append(f"climate.json: {iso}/{year}/{ssp} missing field '{field}'")
                        continue
                    val = record[field]
                    if val is None:
                        if tier != "sparse":
                            warnings.append(
                                f"climate.json: {iso}/{year}/{ssp}/{field} is null but tier is {tier}"
                            )
                        continue
                    if not isinstance(val, (int, float)):
                        errors.append(f"climate.json: {iso}/{year}/{ssp}/{field} not numeric: {val}")
                        continue
                    if not (lo <= val <= hi):
                        errors.append(
                            f"climate.json: {iso}/{year}/{ssp}/{field} = {val} "
                            f"out of expected range [{lo}, {hi}]"
                        )

                # Flag sparse coverage (skip if already set by fetcher)
                conf = record.get("confidence")
                if conf is None:
                    if tier != "sparse":
                        record["coverage_tier"] = "sparse"
                elif conf < SPARSE_THRESHOLD:
                    sparse_isos.append(f"{iso}/{year}/{ssp} (confidence={conf:.2f})")
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


# ── Geodata (high-fidelity render layers) ─────────────────────────────────────

def _num(x) -> bool:
    """True for a real number (not a bool, which is an int subclass)."""
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def _in_range(lon, lat) -> bool:
    return _num(lon) and _num(lat) and -180 <= lon <= 180 and -90 <= lat <= 90


def _validate_rings(rings, label: str, errors: list) -> None:
    """A rings array: list of polygons, each ≥3 [lon,lat] points in range."""
    if not isinstance(rings, list) or not rings:
        errors.append(f"{label}: 'rings' missing or empty")
        return
    for i, ring in enumerate(rings):
        if not isinstance(ring, list) or len(ring) < 3:
            errors.append(f"{label}: ring[{i}] has fewer than 3 points")
            continue
        for pt in ring:
            if not (isinstance(pt, (list, tuple)) and len(pt) >= 2 and _in_range(pt[0], pt[1])):
                errors.append(f"{label}: ring[{i}] has a malformed / out-of-range [lon,lat] point")
                break


def _validate_slr_file(path: Path, errors: list, warnings: list) -> None:
    """slr_<metro>.json — coastal inundation delta bands (bake_geodata.py)."""
    tag = f"geodata/{path.name}"
    data = load_json(path)
    if not isinstance(data, dict):
        errors.append(f"{tag}: not a JSON object / unreadable")
        return

    for key in ("_meta", "center", "bbox", "levels"):
        if key not in data:
            errors.append(f"{tag}: missing top-level key '{key}'")

    center = data.get("center", {})
    if not (isinstance(center, dict) and _in_range(center.get("lon"), center.get("lat"))):
        errors.append(f"{tag}: 'center' must be {{lon,lat}} in range")

    bbox = data.get("bbox")
    if not (isinstance(bbox, list) and len(bbox) == 4 and all(_num(v) for v in bbox)):
        errors.append(f"{tag}: 'bbox' must be [w,s,e,n] numbers")
    elif not (bbox[0] < bbox[2] and bbox[1] < bbox[3]):
        errors.append(f"{tag}: 'bbox' not ordered [w<e, s<n]: {bbox}")

    levels = data.get("levels")
    if not (isinstance(levels, dict) and levels):
        errors.append(f"{tag}: 'levels' must be a non-empty object")
        return
    for lvl_key, lvl in levels.items():
        try:
            float(lvl_key)
        except (TypeError, ValueError):
            errors.append(f"{tag}: level key '{lvl_key}' is not a numeric string")
        if not isinstance(lvl, dict):
            errors.append(f"{tag}: level '{lvl_key}' is not an object")
            continue
        area = lvl.get("area_km2")
        if not (_num(area) and area >= 0):
            errors.append(f"{tag}: level '{lvl_key}' area_km2 missing or negative")
        _validate_rings(lvl.get("rings"), f"{tag} level '{lvl_key}'", errors)


def _validate_hurricane_file(path: Path, errors: list, warnings: list) -> None:
    """hurricane_<metro>.json — analog track + optional bathtub surge (bake_tracks.py)."""
    tag = f"geodata/{path.name}"
    data = load_json(path)
    if not isinstance(data, dict):
        errors.append(f"{tag}: not a JSON object / unreadable")
        return

    meta = data.get("_meta")
    if not isinstance(meta, dict):
        errors.append(f"{tag}: missing '_meta'")
    else:
        analog = meta.get("analog", {})
        if not isinstance(analog, dict) or not analog.get("sid"):
            errors.append(f"{tag}: _meta.analog.sid (IBTrACS SID) missing")
        pc = analog.get("peak_category") if isinstance(analog, dict) else None
        if not (isinstance(pc, int) and not isinstance(pc, bool) and 1 <= pc <= 5):
            errors.append(f"{tag}: _meta.analog.peak_category must be an int 1–5")
        if meta.get("seed") is True:
            warnings.append(f"{tag}: seed:true — hand-seeded placeholder; bake_tracks.py "
                            f"overwrites it with real IBTrACS best-track in CI")

    track = data.get("track")
    if not (isinstance(track, list) and len(track) >= 2):
        errors.append(f"{tag}: 'track' must have ≥2 points")
    else:
        for i, p in enumerate(track):
            if not isinstance(p, dict) or not _in_range(p.get("lon"), p.get("lat")):
                errors.append(f"{tag}: track[{i}] has an out-of-range lon/lat")
                break
            cat = p.get("category")
            if not (isinstance(cat, int) and not isinstance(cat, bool) and 0 <= cat <= 5):
                errors.append(f"{tag}: track[{i}].category must be an int 0–5")
                break

    lf = data.get("landfall")
    if not (isinstance(lf, dict) and _in_range(lf.get("lon"), lf.get("lat"))):
        errors.append(f"{tag}: 'landfall' must be {{lon,lat}} in range")

    surge = data.get("surge")
    if surge is not None:
        if not isinstance(surge, dict):
            errors.append(f"{tag}: 'surge' must be an object when present")
        else:
            if not (_num(surge.get("height_m")) and surge["height_m"] > 0):
                errors.append(f"{tag}: surge.height_m must be a positive number")
            if not (_num(surge.get("area_km2")) and surge["area_km2"] >= 0):
                errors.append(f"{tag}: surge.area_km2 missing or negative")
            _validate_rings(surge.get("rings"), f"{tag} surge", errors)


def _validate_ring(ring, label: str, errors: list) -> None:
    """A single polygon ring: ≥3 in-range [lon,lat] points."""
    if not isinstance(ring, list) or len(ring) < 3:
        errors.append(f"{label}: ring has fewer than 3 points")
        return
    for pt in ring:
        if not (isinstance(pt, (list, tuple)) and len(pt) >= 2 and _in_range(pt[0], pt[1])):
            errors.append(f"{label}: ring has a malformed / out-of-range [lon,lat] point")
            return


def _validate_admin1_file(path: Path, errors: list, warnings: list) -> None:
    """admin1_<ISO>.json — state/province boundaries for the drought choropleth."""
    tag = f"geodata/{path.name}"
    data = load_json(path)
    if not isinstance(data, dict):
        errors.append(f"{tag}: not a JSON object / unreadable")
        return

    if not isinstance(data.get("_meta"), dict):
        errors.append(f"{tag}: missing '_meta'")
    if not isinstance(data.get("iso"), str) or not data.get("iso"):
        errors.append(f"{tag}: 'iso' must be a non-empty string")

    regions = data.get("regions")
    if not (isinstance(regions, list) and regions):
        errors.append(f"{tag}: 'regions' must be a non-empty array")
        return
    for ri, region in enumerate(regions):
        if not isinstance(region, dict):
            errors.append(f"{tag}: region[{ri}] is not an object")
            continue
        polys = region.get("polygons")
        if not (isinstance(polys, list) and polys):
            errors.append(f"{tag}: region[{ri}] 'polygons' must be a non-empty array")
            continue
        for pi, poly in enumerate(polys):
            if not isinstance(poly, dict):
                errors.append(f"{tag}: region[{ri}].polygons[{pi}] is not an object")
                continue
            _validate_ring(poly.get("outer"), f"{tag} region[{ri}].polygons[{pi}] outer", errors)
            holes = poly.get("holes", [])
            if not isinstance(holes, list):
                errors.append(f"{tag}: region[{ri}].polygons[{pi}] 'holes' must be a list")
                continue
            for hi, hole in enumerate(holes):
                _validate_ring(hole, f"{tag} region[{ri}].polygons[{pi}] hole[{hi}]", errors)


def _validate_landmask_file(path: Path, errors: list, warnings: list) -> None:
    """landmask.json — global burnable-land bitmask for the wildfire render."""
    import base64
    import math
    tag = f"geodata/{path.name}"
    data = load_json(path)
    if not isinstance(data, dict):
        errors.append(f"{tag}: not a JSON object / unreadable")
        return

    w, h = data.get("width"), data.get("height")
    if not (isinstance(w, int) and w > 0 and isinstance(h, int) and h > 0):
        errors.append(f"{tag}: 'width'/'height' must be positive integers")
        return
    if not (_num(data.get("res_deg")) and data["res_deg"] > 0):
        errors.append(f"{tag}: 'res_deg' must be a positive number")
    bbox = data.get("bbox")
    if not (isinstance(bbox, list) and len(bbox) == 4 and all(_num(v) for v in bbox)):
        errors.append(f"{tag}: 'bbox' must be [w,s,e,n] numbers")
    packed = data.get("packed")
    if not isinstance(packed, str) or not packed:
        errors.append(f"{tag}: 'packed' must be a non-empty base64 string")
        return
    try:
        raw = base64.b64decode(packed, validate=True)
    except Exception:
        errors.append(f"{tag}: 'packed' is not valid base64")
        return
    need = math.ceil(w * h / 8)
    if len(raw) < need:
        errors.append(f"{tag}: packed bytes {len(raw)} < ceil(w*h/8)={need}")


def validate_geodata(errors: list, warnings: list) -> bool:
    """
    Validates public/data/geodata/*.json — the high-fidelity render layers
    (coastal inundation deltas + hurricane analog tracks/surge).

    These are OPTIONAL: each render falls back gracefully when its metro file is
    absent, so a missing file/dir is a warning, not an error. But every number
    and polygon in a present file reaches the screen verbatim (rule #4), so any
    file that IS shipped must be well-formed — malformed geometry is a hard error.
    """
    geo_dir = BAKED_DATA_DIR / "geodata"
    if not geo_dir.is_dir():
        warnings.append("geodata/ absent — high-fidelity render layers not baked yet "
                        "(renders use generic fallbacks). Run bake_geodata.py + bake_tracks.py.")
        return True

    slr_files = sorted(geo_dir.glob("slr_*.json"))
    hur_files = sorted(geo_dir.glob("hurricane_*.json"))
    adm_files = sorted(geo_dir.glob("admin1_*.json"))
    landmask = geo_dir / "landmask.json"
    if not slr_files and not hur_files and not adm_files and not landmask.exists():
        warnings.append("geodata/ present but has no slr_*/hurricane_*/admin1_*/landmask files.")
        return True

    n_err_before = len(errors)
    for path in slr_files:
        _validate_slr_file(path, errors, warnings)
    for path in hur_files:
        _validate_hurricane_file(path, errors, warnings)
    for path in adm_files:
        _validate_admin1_file(path, errors, warnings)
    if landmask.exists():
        _validate_landmask_file(landmask, errors, warnings)

    return len(errors) == n_err_before


# ── Main ──────────────────────────────────────────────────────────────────────

VALIDATORS = {
    "climate":     validate_climate,
    "worldbank":   validate_world_bank,
    "attribution": validate_attribution,
    "geojson":     validate_geojson,
    "manifest":    validate_pipeline_manifest,
    "geodata":     validate_geodata,
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
