//! Demo data: the frontend's story, read from data/demo/history.raw.json. build.rs copies that
//! file from frontend/src/data/demo/ so the backend and the bundled frontend demo show the same
//! numbers. Nothing is generated here; every row keeps the provenance label it has in the file.
use crate::{adapter, logic};
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// Must match DEMO_PROFILE.name in frontend/src/data/demo/profile.ts.
pub const DEMO_ASTRONAUT: &str = "Cmdr. Layla Haddad";
/// Name used by the first backend seed; renamed in place so astronaut id 1 stays the demo astronaut.
const LEGACY_DEMO_ASTRONAUT: &str = "Demo Astronaut A";
const HISTORY_JSON: &str = include_str!("../data/demo/history.raw.json");

/// Frontend metric code (history.raw.json, frontend/src/data/adapter.ts) -> backend indicator code.
pub const METRIC_CODES: [(&str, &str); 9] = [
    ("HR_REST", "heart_rate"),
    ("BP_SYS", "bp_systolic"),
    ("BP_DIA", "bp_diastolic"),
    ("GLU", "glucose"),
    ("TEMP", "body_temp"),
    ("SLEEP", "sleep_hours"),
    ("MOOD", "mood"),
    ("EX_MIN", "exercise_minutes"),
    ("RAD_CUM", "radiation_dose_cumulative"),
];

pub fn indicator_for(metric: &str) -> Option<&'static str> {
    METRIC_CODES.iter().find(|(m, _)| *m == metric).map(|(_, code)| *code)
}

const RULES: &[(&str, &str, f64, &str, &str, &str)] = &[
    ("heart_rate", "threshold_high", 100.0, "review", "self", "Heart rate is above the placeholder review level."),
    ("heart_rate", "threshold_low", 45.0, "review", "crew", "Heart rate is below the placeholder review level."),
    ("heart_rate", "baseline_deviation", 2.0, "info", "self", "Heart rate is unusual compared with this astronaut's own baseline."),
    ("bp_systolic", "threshold_high", 140.0, "review", "flight_surgeon", "Systolic pressure is above the placeholder review level."),
    ("bp_systolic", "threshold_low", 90.0, "review", "flight_surgeon", "Systolic pressure is below the placeholder review level."),
    ("glucose", "threshold_high", 180.0, "review", "flight_surgeon", "Glucose is above the placeholder review level (context: fasting or not is unknown)."),
    ("glucose", "threshold_low", 70.0, "review", "flight_surgeon", "Glucose is below the placeholder review level."),
    ("body_temp", "threshold_high", 38.0, "review", "flight_surgeon", "Body temperature is above the placeholder review level."),
    ("body_temp", "threshold_low", 35.0, "review", "crew", "Body temperature is below the placeholder review level."),
    ("spo2", "threshold_low", 92.0, "review", "flight_surgeon", "Blood oxygen is below the placeholder review level."),
    ("sleep_hours", "threshold_low", 6.0, "review", "self", "Sleep was short compared with the placeholder review level."),
    ("sleep_hours", "baseline_deviation", 2.0, "info", "self", "Sleep differs from this astronaut's own baseline."),
    ("mood", "threshold_low", 2.0, "review", "crew", "Mood check-in was low; consider a crew check-in."),
];

// Titles from the team guide, section 8. URLs and licences must be copied from the guide and verified.
const EVIDENCE: &[&str] = &[
    "NASA Spaceflight Standard Measures",
    "NASA Open Science Data Repository (OSDR)",
    "NASA Inspiration4 mission datasets",
    "NASA OSDR Environmental Data App (ISS cabin data)",
    "NASA OSDR FAQ and API documentation",
];

#[derive(Deserialize)]
struct RawRow {
    time_utc: String,
    metric: String,
    value: f64,
    unit: String,
    source: String,
    provenance: String,
}

/// One row of the demo history, already in backend terms.
#[derive(Debug, Clone, PartialEq)]
pub struct DemoRow {
    pub indicator: &'static str,
    pub measured_at: String,
    pub value: f64,
    pub source_name: String,
    pub source_type: String,
}

/// Parse history.raw.json. Fails loudly on an unknown metric, unit or provenance: the demo is
/// never silently converted or relabelled.
pub fn demo_rows() -> Result<Vec<DemoRow>, String> {
    let raw: Vec<RawRow> = serde_json::from_str(HISTORY_JSON).map_err(|e| format!("history.raw.json: {e}"))?;
    raw.into_iter()
        .map(|r| {
            let indicator = indicator_for(&r.metric).ok_or_else(|| format!("history.raw.json: unknown metric '{}'", r.metric))?;
            if adapter::canon_token(indicator) != Some(adapter::norm_unit(&r.unit).as_str()) {
                return Err(format!("history.raw.json: unit '{}' is not the stored unit of {indicator}", r.unit));
            }
            if !["real", "imported", "simulated"].contains(&r.provenance.as_str()) {
                return Err(format!("history.raw.json: unknown provenance '{}'", r.provenance));
            }
            let at = DateTime::parse_from_rfc3339(&r.time_utc).map_err(|e| format!("history.raw.json: time '{}': {e}", r.time_utc))?;
            Ok(DemoRow {
                indicator,
                measured_at: at.with_timezone(&Utc).format("%Y-%m-%dT%H:%M:%SZ").to_string(),
                value: r.value,
                source_name: r.source,
                source_type: r.provenance,
            })
        })
        .collect()
}

/// Load the demo astronaut and the demo history. Safe to run again: it replaces the previous seed.
pub fn seed(conn: &Connection) -> Result<Value, String> {
    let rows = demo_rows()?;
    seed_db(conn, &rows).map_err(|e| e.to_string())
}

fn seed_db(conn: &Connection, demo: &[DemoRow]) -> rusqlite::Result<Value> {
    conn.execute(
        "UPDATE astronauts SET display_name=?1 WHERE display_name=?2 AND NOT EXISTS (SELECT 1 FROM astronauts WHERE display_name=?1)",
        params![DEMO_ASTRONAUT, LEGACY_DEMO_ASTRONAUT],
    )?;
    // Remove a previous seed completely (alerts/events/follow-ups reference its measurements).
    // Readings the astronaut logged themselves (source_type real/manual) are kept.
    let seeded = "SELECT id FROM measurements WHERE source_type='simulated' AND astronaut_id IN (SELECT id FROM astronauts WHERE display_name=?1)";
    for sql in [
        format!("DELETE FROM follow_ups WHERE event_id IN (SELECT id FROM events WHERE alert_id IN (SELECT id FROM alerts WHERE measurement_id IN ({seeded})))"),
        format!("DELETE FROM events WHERE alert_id IN (SELECT id FROM alerts WHERE measurement_id IN ({seeded}))"),
        format!("DELETE FROM follow_ups WHERE result_measurement_id IN ({seeded})"),
        format!("DELETE FROM alerts WHERE measurement_id IN ({seeded})"),
        format!("DELETE FROM measurements WHERE id IN ({seeded})"),
    ] {
        conn.execute(&sql, params![DEMO_ASTRONAUT])?;
    }
    conn.execute("DELETE FROM baselines", [])?;

    let aid: i64 = match conn.query_row("SELECT id FROM astronauts WHERE display_name=?1", params![DEMO_ASTRONAUT], |r| r.get(0)) {
        Ok(id) => id,
        Err(_) => {
            conn.execute("INSERT INTO astronauts (display_name,is_synthetic,mission_setting) VALUES (?1,1,'station')", params![DEMO_ASTRONAUT])?;
            conn.last_insert_rowid()
        }
    };
    let count = |t: &str| -> rusqlite::Result<i64> { conn.query_row(&format!("SELECT COUNT(*) FROM {t}"), [], |r| r.get(0)) };
    if count("alert_rules")? == 0 {
        for (ind, ty, p, sev, esc, msg) in RULES {
            conn.execute(
                "INSERT INTO alert_rules (indicator_code,rule_type,param,severity,escalation,message) VALUES (?1,?2,?3,?4,?5,?6)",
                params![ind, ty, p, sev, esc, msg],
            )?;
        }
    }
    if conn.query_row("SELECT COUNT(*) FROM routines WHERE astronaut_id=?1", params![aid], |r| r.get::<_, i64>(0))? == 0 {
        for (title, code) in [
            ("Morning check-in: heart rate and blood pressure", Some("heart_rate")),
            ("Log last night's sleep", Some("sleep_hours")),
            ("Mood check-in", Some("mood")),
            ("Approved exercise session (per mission plan)", None),
        ] {
            conn.execute("INSERT INTO routines (astronaut_id,title,indicator_code,every_hours) VALUES (?1,?2,?3,24)", params![aid, title, code])?;
        }
    }
    if count("evidence_sources")? == 0 {
        for t in EVIDENCE {
            conn.execute(
                "INSERT INTO evidence_sources (title,url,license,note) VALUES (?1,'',NULL,'Copy the URL from the team guide (section 8) and record the licence before submission.')",
                params![t],
            )?;
        }
    }

    let mut n = 0usize;
    for r in demo {
        n += conn.execute(
            "INSERT OR IGNORE INTO measurements (astronaut_id,indicator_code,value,unit,measured_at,source_type,source_name,quality) \
             SELECT ?1,?2,?3,unit,?4,?5,?6,'ok' FROM indicators WHERE code=?2",
            params![aid, r.indicator, r.value, r.measured_at, r.source_type, r.source_name],
        )?;
    }
    let alerts = logic::evaluate_all(conn)?;
    Ok(json!({"astronaut_id": aid, "astronaut": DEMO_ASTRONAUT, "measurements": n, "alerts_created": alerts}))
}

/// Source labels the web app and Atlas write under (readings, events, state); `reset_ui` removes exactly these.
pub const APP_SOURCES: [&str; 5] = ["ASTRA check-in", "ASTRA web app%", "camera estimate%", "camera-verified%", "Atlas assistant"];

fn purge(conn: &Connection, source: &str) -> rusqlite::Result<()> {
    let seeded = "SELECT id FROM measurements WHERE source_name LIKE ?1";
    for sql in [
        format!("DELETE FROM follow_ups WHERE event_id IN (SELECT id FROM events WHERE alert_id IN (SELECT id FROM alerts WHERE measurement_id IN ({seeded})))"),
        format!("DELETE FROM events WHERE alert_id IN (SELECT id FROM alerts WHERE measurement_id IN ({seeded}))"),
        format!("DELETE FROM follow_ups WHERE result_measurement_id IN ({seeded})"),
        format!("DELETE FROM alerts WHERE measurement_id IN ({seeded})"),
        "DELETE FROM measurements WHERE source_name LIKE ?1".to_string(),
    ] {
        conn.execute(&sql, params![source])?;
    }
    Ok(())
}

/// Put the demo back to its starting story: what the web app and Atlas wrote, its events and routine ticks,
/// and the saved app state are removed, then the demo history is loaded again. Imported data stays.
pub fn reset_ui(conn: &Connection) -> Result<Value, String> {
    let e = |x: rusqlite::Error| x.to_string();
    for src in APP_SOURCES {
        purge(conn, src).map_err(e)?;
    }
    // the table exists only once the exercise module has run; nothing to remove when it does not
    let _ = conn.execute("DELETE FROM exercise_sessions", []);
    let aid: i64 = conn.query_row("SELECT id FROM astronauts WHERE display_name=?1", params![DEMO_ASTRONAUT], |r| r.get(0)).unwrap_or(1);
    conn.execute("DELETE FROM follow_ups WHERE event_id IN (SELECT id FROM events WHERE astronaut_id=?1)", params![aid]).map_err(e)?;
    conn.execute("DELETE FROM events WHERE astronaut_id=?1", params![aid]).map_err(e)?;
    conn.execute("DELETE FROM routine_completions WHERE routine_id IN (SELECT id FROM routines WHERE astronaut_id=?1)", params![aid]).map_err(e)?;
    conn.execute("DELETE FROM astronaut_state WHERE astronaut_id=?1", params![aid]).map_err(e)?;
    seed(conn)
}

/// True when the database has no astronaut yet, which is how `serve` recognises a first start.
pub fn is_empty(conn: &Connection) -> Result<bool, String> {
    conn.query_row("SELECT COUNT(*) FROM astronauts", [], |r| r.get::<_, i64>(0)).map(|n| n == 0).map_err(|e| e.to_string())
}

/// Import every prepared ISS cabin file in <base>/data/raw/eda that has a mapping in
/// <base>/mappings/eda (both written by scripts/prepare_eda.py). No files means "not available".
pub fn import_cabin_data(conn: &Connection, base: &Path) -> Result<Value, String> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(base.join("data/raw/eda"))
        .map(|dir| dir.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "csv")).collect())
        .unwrap_or_default();
    files.sort();
    let (mut imported, mut readings, mut suspect) = (0i64, 0i64, 0i64);
    for f in &files {
        let stem = f.file_stem().and_then(|s| s.to_str()).unwrap_or_default();
        let mapping_path = base.join("mappings/eda").join(format!("{stem}.json"));
        if !mapping_path.is_file() {
            continue;
        }
        let report = adapter::import_csv(conn, f, &adapter::load_mapping(&mapping_path)?, None)?;
        imported += 1;
        readings += report["inserted"].as_i64().unwrap_or(0);
        suspect += report["flagged_suspect"].as_i64().unwrap_or(0);
    }
    Ok(json!({"files": imported, "readings": readings, "flagged_suspect": suspect}))
}

/// First start on an empty database: the demo story plus the ISS cabin data.
pub fn first_run(conn: &Connection, base: &Path) -> Result<Value, String> {
    let demo = seed(conn)?;
    let cabin = import_cabin_data(conn, base)?;
    Ok(json!({"demo": demo, "cabin": cabin}))
}

/// Two plain lines for the console, built from what first_run actually loaded.
pub fn first_run_summary(s: &Value) -> String {
    let demo = format!(
        "Demo astronaut: {} (fictional). {} readings loaded from the demo history.",
        s["demo"]["astronaut"].as_str().unwrap_or(DEMO_ASTRONAUT),
        s["demo"]["measurements"]
    );
    let cabin = if s["cabin"]["files"].as_i64().unwrap_or(0) == 0 {
        "ISS cabin data: not available. No prepared files in data/raw/eda (run scripts/load_eda.py).".to_string()
    } else {
        format!(
            "ISS cabin data (NASA OSDR): {} readings from {} mission files, {} of them flagged suspect.",
            s["cabin"]["readings"], s["cabin"]["files"], s["cabin"]["flagged_suspect"]
        )
    };
    format!("{demo}\n{cabin}")
}
