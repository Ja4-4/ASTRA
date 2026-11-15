#!/usr/bin/env python3
"""Prepare NASA OSDR "Environmental Data App" (EDA) exports for the ASTRA importer.

Reads only local files, standard library only (no network, no pip install):
  data/raw/eda_telemetry_all_missions.csv.gz   (or the unpacked .csv)
  data/raw/eda_radiation_all_missions.csv      (optional; skipped with a note if absent)
Writes data/raw/eda/<mission>_{telemetry,radiation}.csv, mappings/eda/<mission>_*.json and
data/clean/eda_prepare_report.json.

Cleaning rules, each one counted per mission in the report:
  * Station model uses the *_iss_* columns only. Ground-control lab columns are not ISS
    measurements, so they are left out.
  * Rows sharing (mission, time_utc) are merged. Some missions store each sensor on its own
    row. If two rows give different values for one column, that value becomes "not available".
  * Relative humidity outside 0-100 % is physically impossible, so it is dropped.
  * CO2 below 300 ppm is flagged suspect: it is lower than Earth's outdoor air, which a closed
    crewed cabin cannot reach. The reading stays in place and the column co2_iss_ppm_quality
    says "suspect". The importer stores it with quality = suspect and the model skips it.
  * Missing stays missing. Nothing is interpolated or invented.
  * One source_name per mission, so overlapping missions never collide on the UNIQUE key.
Run with:  python3 -I scripts/prepare_eda.py
"""
import csv
import gzip
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = RAW / "eda"
MAPS = ROOT / "mappings" / "eda"
CLEAN = ROOT / "data" / "clean"

SRC = "NASA OSDR Environmental Data App (ISS) - {m}"
ISS_COLS = ["temperature_iss_c", "humidity_iss_pct", "co2_iss_ppm"]
QUALITY_COL = "co2_iss_ppm_quality"
CO2_MIN_PLAUSIBLE_PPM = 300.0
TELEMETRY = "eda_telemetry_all_missions.csv"
RADIATION = "eda_radiation_all_missions.csv"


def open_telemetry():
    gz, plain = RAW / (TELEMETRY + ".gz"), RAW / TELEMETRY
    if gz.exists():
        return gzip.open(gz, "rt", encoding="utf-8", newline="")
    if plain.exists():
        return open(plain, "r", encoding="utf-8", newline="")
    sys.exit(f"missing {gz} (or {plain.name})")


def write_mapping(path, mission, timestamp_col, columns):
    path.write_text(json.dumps({
        "target": "env",
        "source_name": SRC.format(m=mission),
        "source_type": "imported",
        "format": "wide",
        "timestamp_col": timestamp_col,
        "wide": {"columns": columns},
    }, ensure_ascii=False, indent=2), encoding="utf-8")


def prepare_telemetry():
    """Returns {mission: report}. Merges per (mission, time_utc) while streaming the file."""
    merged = {}   # mission -> {time_utc: {col: text | None(conflict)}}
    rows_in = {}
    conflicts = {}
    with open_telemetry() as f:
        for row in csv.DictReader(f):
            m, t = row["mission"], row["time_utc"]
            rows_in[m] = rows_in.get(m, 0) + 1
            slot = merged.setdefault(m, {}).setdefault(t, {})
            for c in ISS_COLS:
                text = row[c].strip()
                if not text:
                    continue
                if c not in slot:
                    slot[c] = text
                elif slot[c] is not None and float(slot[c]) != float(text):
                    slot[c] = None
                    conflicts.setdefault(m, dict.fromkeys(ISS_COLS, 0))[c] += 1

    report = {}
    for mission in sorted(merged):
        by_time = merged[mission]
        rh_dropped = co2_suspect = 0
        readings = dict.fromkeys(ISS_COLS, 0)
        out_rows = []
        for t in sorted(by_time):
            v = {c: by_time[t].get(c) or "" for c in ISS_COLS}
            v[QUALITY_COL] = ""
            if v["humidity_iss_pct"] and not 0.0 <= float(v["humidity_iss_pct"]) <= 100.0:
                v["humidity_iss_pct"] = ""
                rh_dropped += 1
            if v["co2_iss_ppm"] and float(v["co2_iss_ppm"]) < CO2_MIN_PLAUSIBLE_PPM:
                v[QUALITY_COL] = "suspect"
                co2_suspect += 1
            if not any(v[c] for c in ISS_COLS):
                continue
            for c in ISS_COLS:
                readings[c] += bool(v[c])
            readings["co2_iss_ppm"] -= v[QUALITY_COL] == "suspect"
            out_rows.append({"time_utc": t, **v})

        rep = {
            "rows_in": rows_in[mission],
            "timestamps_in": len(by_time),
            "rows_merged_same_timestamp": rows_in[mission] - len(by_time),
            "conflicting_values_set_not_available": conflicts.get(mission, dict.fromkeys(ISS_COLS, 0)),
            "humidity_out_of_range_dropped": rh_dropped,
            "co2_below_300ppm_flagged_suspect": co2_suspect,
            "rows_out": len(out_rows),
            "usable_readings": readings,
        }
        if out_rows:
            rep["start"], rep["end"] = out_rows[0]["time_utc"], out_rows[-1]["time_utc"]
            with open(OUT / f"{mission}_telemetry.csv", "w", encoding="utf-8", newline="") as f:
                w = csv.DictWriter(f, fieldnames=["time_utc", *ISS_COLS, QUALITY_COL])
                w.writeheader()
                w.writerows(out_rows)
            write_mapping(MAPS / f"{mission}_telemetry.json", mission, "time_utc", {
                "temperature_iss_c": {"indicator": "cabin_temp", "unit": "°C"},
                "humidity_iss_pct": {"indicator": "humidity", "unit": "%"},
                "co2_iss_ppm": {"indicator": "co2", "unit": "ppm", "quality_col": QUALITY_COL},
            })
        else:
            rep["note"] = "no ISS cabin readings in the source file for this mission (the ISS columns are empty)"
        report[mission] = rep
    return report


def prepare_radiation():
    path = RAW / RADIATION
    if not path.exists():
        return {"status": "not available", "missing_file": f"data/raw/{RADIATION}"}
    per = {}
    with open(path, "r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        fields = [c for c in reader.fieldnames if c != "mission"]
        for row in reader:
            per.setdefault(row["mission"], {}).setdefault(row["date_utc"], row)
    report = {}
    for mission in sorted(per):
        days = [per[mission][d] for d in sorted(per[mission])]
        with open(OUT / f"{mission}_radiation.csv", "w", encoding="utf-8", newline="") as f:
            w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
            w.writeheader()
            w.writerows(days)
        write_mapping(MAPS / f"{mission}_radiation.json", mission, "date_utc", {
            "gcr_mGy_d": {"indicator": "radiation_gcr_dose", "unit": "mGy/day"},
            "saa_mGy_d": {"indicator": "radiation_saa_dose", "unit": "mGy/day"},
            "total_mGy_d": {"indicator": "radiation_total_dose", "unit": "mGy/day"},
        })
        report[mission] = {"rows": len(days), "start": days[0]["date_utc"], "end": days[-1]["date_utc"]}
    return report


def main():
    for d in (OUT, MAPS, CLEAN):
        d.mkdir(parents=True, exist_ok=True)
    for stale in OUT.glob("*.csv"):
        stale.unlink()

    tel = prepare_telemetry()
    rad = prepare_radiation()
    (CLEAN / "eda_prepare_report.json").write_text(
        json.dumps({"telemetry": tel, "radiation": rad}, indent=2), encoding="utf-8")

    total = lambda key: sum(r[key] for r in tel.values())
    with_iss = [m for m, r in tel.items() if r["rows_out"]]
    print(f"telemetry: {total('rows_in')} rows in, {len(tel)} missions, {len(with_iss)} with ISS cabin data")
    print(f"  rows merged on the same timestamp:       {total('rows_merged_same_timestamp')}")
    print(f"  conflicting values set to not available: "
          f"{sum(sum(r['conflicting_values_set_not_available'].values()) for r in tel.values())}")
    print(f"  humidity outside 0-100 % dropped:        {total('humidity_out_of_range_dropped')}")
    print(f"  CO2 below 300 ppm flagged suspect:       {total('co2_below_300ppm_flagged_suspect')}")
    print(f"  rows out:                                {total('rows_out')}")
    if rad.get("status") == "not available":
        print(f"radiation: not available (missing {rad['missing_file']}), skipped")
    else:
        print(f"radiation: {len(rad)} missions prepared")


if __name__ == "__main__":
    main()
