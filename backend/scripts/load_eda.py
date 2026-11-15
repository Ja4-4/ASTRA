#!/usr/bin/env python3
"""One-shot loader for the NASA OSDR EDA data: prepare -> train model -> import into the DB.

    cargo build --release
    python3 -I scripts/load_eda.py            # uses data/astra.db (or ASTRA_DB), seeds it if empty

Reads only local files (no network): data/raw/eda_telemetry_all_missions.csv.gz (or .csv).
data/raw/eda_radiation_all_missions.csv is optional: without it radiation stays "not available".
The model is trained before the exe is needed, so prepare + train also work without a Rust build.
Also fills the evidence_sources URLs from the team guide (section 8). Licences stay "not yet
reviewed": the team must check NASA's OSDR terms before submission.
"""
import os
import pathlib
import sqlite3
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
exe_name = "astra-rs.exe" if os.name == "nt" else "astra-rs"
EXE = ROOT / "target" / "release" / exe_name
DB = pathlib.Path(os.environ.get("ASTRA_DB", ROOT / "data" / "astra.db"))
env = dict(os.environ, ASTRA_DB=str(DB))

URLS = {  # from the ASTRA team guide, section 8 and its references
    "NASA Spaceflight Standard Measures": "https://www.nasa.gov/reference/standard-measures/",
    "NASA Open Science Data Repository (OSDR)": "https://osdr.nasa.gov/bio/repo/",
    "NASA Inspiration4 mission datasets": "https://www.nasa.gov/osdr-latest-news-i4-mission-datasets/",
    "NASA OSDR Environmental Data App (ISS cabin data)": "https://visualization.osdr.nasa.gov/eda/",
    "NASA OSDR FAQ and API documentation": "https://science.nasa.gov/reference/osdr-faq/",
}
TERMS = "https://www.nasa.gov/reference/osdr-help-terms-and-conditions/"


def run(*cmd):
    subprocess.run([str(c) for c in cmd], check=True, cwd=ROOT, env=env)


run(sys.executable, "-I", "scripts/prepare_eda.py")
run(sys.executable, "-I", "scripts/train_env_model.py")
if not EXE.exists():
    sys.exit(f"model trained, database import skipped: build first with cargo build --release  (missing {EXE})")
if not DB.exists():
    run(EXE, "seed")
for f in sorted((RAW / "eda").glob("*.csv")):
    run(EXE, "import", f, ROOT / "mappings" / "eda" / (f.stem + ".json"))

con = sqlite3.connect(DB)
for title, url in URLS.items():
    con.execute("UPDATE evidence_sources SET url=? WHERE title=? AND url=''", (url, title))
con.execute(
    "UPDATE evidence_sources SET license=?, note=? WHERE title LIKE 'NASA OSDR Environmental Data App%' AND license IS NULL",
    (f"NOT YET REVIEWED - see {TERMS}", "Real ISS cabin telemetry/radiation, imported; used for the mission-context view and the cabin reference model."),
)
con.commit()
n = con.execute("SELECT COUNT(*) FROM env_readings").fetchone()[0]
print(f"done: {n} environmental readings in {DB}")
