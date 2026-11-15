#!/usr/bin/env python3
"""Train ASTRA's explainable ISS-cabin baseline model from REAL NASA OSDR EDA data.

What it is: for each cabin parameter (temperature, relative humidity, CO2) it learns a robust
reference range (median, MAD and percentile bands) from the ISS missions in data/raw/eda.
What it is NOT: a health model and not an operational safety limit. A reading outside the band
only means "statistically unusual compared with past ISS missions". The Rust API uses it to
explain WHY a cabin reading is flagged (guide rule: every alert must explain which rule fired).

Input: the cleaned per-mission files from scripts/prepare_eda.py. Only the *_iss_* columns are
read. CO2 readings flagged suspect (below 300 ppm, co2_iss_ppm_quality = suspect) never reach
the model. Standard library only, no network.

Validation: leave-one-mission-out. For every mission the bands are learned from all OTHER
missions and the share of that mission's readings falling outside is measured. A stable model
shows similar rates across missions; the report lists them so weak spots are visible.

Output: models/env_baseline.json   Run: python3 -I scripts/train_env_model.py
"""
import csv
import json
import math
import pathlib
import statistics
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw" / "eda"
CLEAN = ROOT / "data" / "clean"
OUT = ROOT / "models"

PARAMS = {
    "cabin_temp": ("temperature_iss_c", "°C"),
    "humidity": ("humidity_iss_pct", "%"),
    "co2": ("co2_iss_ppm", "ppm"),
}
MIN_READINGS_PER_MISSION = 500          # ignore tiny missions when learning bands
WATCH_Q = (1.0, 99.0)                   # outside -> "watch"
ALERT_Q = (0.1, 99.9)                   # outside -> "attention"


def percentile(sorted_values, q):
    """Linear interpolation between closest ranks (the same definition numpy uses by default)."""
    pos = (len(sorted_values) - 1) * q / 100.0
    lo = math.floor(pos)
    hi = min(lo + 1, len(sorted_values) - 1)
    return sorted_values[lo] + (sorted_values[hi] - sorted_values[lo]) * (pos - lo)


def bands(values):
    v = sorted(values)
    med = statistics.median(v)
    mad = statistics.median(abs(x - med) for x in v)
    return {
        "n": len(v),
        "median": round(med, 4),
        "mad": round(mad, 4),
        "watch_low": round(percentile(v, WATCH_Q[0]), 4),
        "watch_high": round(percentile(v, WATCH_Q[1]), 4),
        "alert_low": round(percentile(v, ALERT_Q[0]), 4),
        "alert_high": round(percentile(v, ALERT_Q[1]), 4),
    }


def outside_rate(values, b, kind):
    lo, hi = b[f"{kind}_low"], b[f"{kind}_high"]
    return sum(1 for x in values if x < lo or x > hi) / len(values)


def load():
    """{mission: {column: [float, ...]}} from the cleaned per-mission telemetry files."""
    data = {}
    for f in sorted(RAW.glob("*_telemetry.csv")):
        cols = {col: [] for col, _ in PARAMS.values()}
        with open(f, "r", encoding="utf-8", newline="") as fh:
            for row in csv.DictReader(fh):
                for col in cols:
                    suspect = col == "co2_iss_ppm" and row["co2_iss_ppm_quality"] == "suspect"
                    if row[col] and not suspect:
                        cols[col].append(float(row[col]))
        data[f.name.removesuffix("_telemetry.csv")] = cols
    return data


def main():
    data = load()
    if not data:
        sys.exit(f"no cleaned telemetry in {RAW}: run scripts/prepare_eda.py first")
    OUT.mkdir(exist_ok=True)
    CLEAN.mkdir(parents=True, exist_ok=True)

    prep_path = CLEAN / "eda_prepare_report.json"
    prep = json.loads(prep_path.read_text(encoding="utf-8"))["telemetry"] if prep_path.exists() else {}
    excluded = {
        "co2_below_300ppm_flagged_suspect": sum(r["co2_below_300ppm_flagged_suspect"] for r in prep.values()),
        "humidity_out_of_range_dropped": sum(r["humidity_out_of_range_dropped"] for r in prep.values()),
        "conflicting_values_set_not_available":
            sum(sum(r["conflicting_values_set_not_available"].values()) for r in prep.values()),
    } if prep else "not available"

    model = {
        "model_type": "robust_percentile_baseline", "version": 2,
        "trained_on": "NASA OSDR Environmental Data App (ISS cabin telemetry)",
        "disclaimer": "Statistical reference from past ISS missions - not a safety limit and not a diagnosis.",
        "data_note": "Cabin readings logged during Rodent Research experiment periods on the ISS. "
                     "ISS columns only. Not astronaut health data.",
        "excluded_before_training": excluded,
        "watch_percentiles": list(WATCH_Q), "alert_percentiles": list(ALERT_Q), "parameters": {},
    }
    report = {}

    for code, (col, unit) in PARAMS.items():
        per = {m: d[col] for m, d in data.items() if len(d[col]) >= MIN_READINGS_PER_MISSION}
        too_small = sorted(m for m, d in data.items() if 0 < len(d[col]) < MIN_READINGS_PER_MISSION)
        b = bands([x for v in per.values() for x in v])
        b["unit"] = unit
        b["missions"] = sorted(per)
        model["parameters"][code] = b

        rows = []
        for m, v in per.items():
            others = bands([x for k, o in per.items() if k != m for x in o])
            rows.append({"mission": m, "n": len(v),
                         "watch_rate": round(outside_rate(v, others, "watch"), 4),
                         "alert_rate": round(outside_rate(v, others, "alert"), 5)})
        watch_rates = [r["watch_rate"] for r in rows]
        report[code] = {
            "unit": unit, "n_missions": len(rows), "n_readings": b["n"],
            "missions_below_min_readings": too_small,
            "expected_watch_rate": 0.02, "expected_alert_rate": 0.002,
            "watch_rate_median": round(statistics.median(watch_rates), 4),
            "watch_rate_max": round(max(watch_rates), 4),
            "per_mission": rows,
        }

    model["validation"] = {k: {x: v[x] for x in v if x != "per_mission"} for k, v in report.items()}
    (OUT / "env_baseline.json").write_text(json.dumps(model, ensure_ascii=False, indent=2), encoding="utf-8")
    (CLEAN / "env_model_validation.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    for code, b in model["parameters"].items():
        v = report[code]
        print(f"{code} ({b['unit'].replace('°', 'deg ')}): n={b['n']} from {v['n_missions']} missions, "
              f"median={b['median']}, MAD={b['mad']}")
        print(f"  watch band 1-99 %:      [{b['watch_low']}, {b['watch_high']}]")
        print(f"  alert band 0.1-99.9 %:  [{b['alert_low']}, {b['alert_high']}]")
        print(f"  leave-one-mission-out watch rate: median {v['watch_rate_median']}, "
              f"max {v['watch_rate_max']} (expected about {v['expected_watch_rate']})")
    print("excluded before training:", json.dumps(excluded))


if __name__ == "__main__":
    main()
