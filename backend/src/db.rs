//! SQLite schema, connection helpers and a generic row -> JSON mapper.
use rusqlite::{types::ValueRef, Connection};
use serde_json::{json, Map, Value};
use std::path::Path;

pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS indicators (
    code          TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    unit          TEXT NOT NULL,          -- canonical unit; every stored value uses it
    category      TEXT NOT NULL,
    plausible_min REAL,                   -- cleaning only: outside => rejected as impossible
    plausible_max REAL
);
CREATE TABLE IF NOT EXISTS astronaut_state (
    astronaut_id INTEGER PRIMARY KEY REFERENCES astronauts(id),
    state_json   TEXT NOT NULL,                   -- app state the front end keeps per astronaut (points, badges, alert steps)
    updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS astronauts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    display_name    TEXT NOT NULL,
    is_synthetic    INTEGER NOT NULL DEFAULT 1,   -- never store real personal health data
    mission_setting TEXT NOT NULL DEFAULT 'station'
        CHECK (mission_setting IN ('spacecraft','station','rover','habitat')),
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS measurements (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    astronaut_id  INTEGER NOT NULL REFERENCES astronauts(id),
    indicator_code TEXT NOT NULL REFERENCES indicators(code),
    value         REAL,                           -- NULL => shown as "not available"
    unit          TEXT NOT NULL,
    measured_at   TEXT NOT NULL,                  -- UTC ISO-8601
    source_type   TEXT NOT NULL CHECK (source_type IN ('real','imported','simulated','manual')),
    source_name   TEXT NOT NULL,
    quality       TEXT NOT NULL DEFAULT 'ok' CHECK (quality IN ('ok','suspect','missing')),
    UNIQUE (astronaut_id, indicator_code, measured_at, source_name)
);
CREATE INDEX IF NOT EXISTS idx_meas_lookup
    ON measurements (astronaut_id, indicator_code, measured_at);

CREATE TABLE IF NOT EXISTS baselines (
    astronaut_id   INTEGER NOT NULL REFERENCES astronauts(id),
    indicator_code TEXT NOT NULL REFERENCES indicators(code),
    mean           REAL NOT NULL,
    sd             REAL NOT NULL,
    n              INTEGER NOT NULL,
    computed_at    TEXT NOT NULL,
    PRIMARY KEY (astronaut_id, indicator_code)
);

CREATE TABLE IF NOT EXISTS alert_rules (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    indicator_code TEXT NOT NULL REFERENCES indicators(code),
    rule_type      TEXT NOT NULL CHECK (rule_type IN ('threshold_high','threshold_low','baseline_deviation')),
    param          REAL NOT NULL,                 -- threshold value, or z-score for baseline_deviation
    severity       TEXT NOT NULL CHECK (severity IN ('info','review','urgent')),
    escalation     TEXT NOT NULL CHECK (escalation IN ('self','crew','flight_surgeon')),
    message        TEXT NOT NULL,
    reviewed       INTEGER NOT NULL DEFAULT 0,    -- 0 until the research/testing partner validates it
    reviewed_by    TEXT
);

CREATE TABLE IF NOT EXISTS alerts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    astronaut_id   INTEGER NOT NULL REFERENCES astronauts(id),
    rule_id        INTEGER NOT NULL REFERENCES alert_rules(id),
    measurement_id INTEGER NOT NULL REFERENCES measurements(id),
    triggered_at   TEXT NOT NULL,
    severity       TEXT NOT NULL,
    escalation     TEXT NOT NULL,
    explanation    TEXT NOT NULL,                 -- always states which rule fired and on what value
    status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved')),
    UNIQUE (rule_id, measurement_id)
);

CREATE TABLE IF NOT EXISTS events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    astronaut_id INTEGER NOT NULL REFERENCES astronauts(id),
    alert_id     INTEGER REFERENCES alerts(id),
    title        TEXT NOT NULL,
    opened_at    TEXT NOT NULL,
    closed_at    TEXT,
    status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','recovering','closed'))
);

CREATE TABLE IF NOT EXISTS follow_ups (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id              INTEGER NOT NULL REFERENCES events(id),
    indicator_code        TEXT NOT NULL REFERENCES indicators(code),
    due_at                TEXT NOT NULL,
    completed_at          TEXT,
    result_measurement_id INTEGER REFERENCES measurements(id)
);

CREATE TABLE IF NOT EXISTS routines (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    astronaut_id   INTEGER NOT NULL REFERENCES astronauts(id),
    title          TEXT NOT NULL,
    indicator_code TEXT REFERENCES indicators(code),
    every_hours    INTEGER NOT NULL DEFAULT 24,
    approved       INTEGER NOT NULL DEFAULT 1     -- only mission-approved activities
);

CREATE TABLE IF NOT EXISTS routine_completions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    routine_id   INTEGER NOT NULL REFERENCES routines(id),
    completed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS env_readings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    measured_at TEXT NOT NULL,
    parameter   TEXT NOT NULL,                    -- e.g. cabin_temp, co2, humidity, radiation_dose
    value       REAL,
    unit        TEXT NOT NULL,
    source_name TEXT NOT NULL,
    quality     TEXT NOT NULL DEFAULT 'ok' CHECK (quality IN ('ok','suspect')),  -- suspect: kept and shown, but flagged
    UNIQUE (measured_at, parameter, source_name)
);

CREATE TABLE IF NOT EXISTS evidence_sources (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    title   TEXT NOT NULL,
    url     TEXT NOT NULL,
    license TEXT,                                 -- recorded for the legal checklist
    note    TEXT
);

CREATE TABLE IF NOT EXISTS import_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    file        TEXT NOT NULL,
    source_name TEXT NOT NULL,
    imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    report_json TEXT NOT NULL
);
"#;

/// Canonical indicators. plausible_* are physical-possibility bounds used only to reject
/// corrupt data; they are NOT clinical thresholds.
pub const INDICATORS: [(&str, &str, &str, &str, f64, f64); 10] = [
    ("heart_rate", "Heart rate", "bpm", "cardiovascular", 20.0, 250.0),
    ("bp_systolic", "Systolic BP", "mmHg", "cardiovascular", 50.0, 280.0),
    ("bp_diastolic", "Diastolic BP", "mmHg", "cardiovascular", 25.0, 180.0),
    ("glucose", "Blood glucose", "mg/dL", "metabolic", 20.0, 700.0),
    ("body_temp", "Body temperature", "°C", "physiological", 30.0, 43.0),
    ("spo2", "Blood oxygen (SpO2)", "%", "respiratory", 50.0, 100.0),
    ("sleep_hours", "Sleep duration", "h", "sleep", 0.0, 24.0),
    ("mood", "Mood (1-5 scale)", "score", "behavioural", 1.0, 5.0),
    ("exercise_minutes", "Exercise duration", "min", "musculoskeletal", 0.0, 1440.0),
    ("radiation_dose_cumulative", "Cumulative radiation dose", "mSv", "radiation", 0.0, 10000.0),
];

/// Open (and create/migrate) the database. Use ":memory:" for tests.
pub fn open(path: &str) -> rusqlite::Result<Connection> {
    if path != ":memory:" {
        if let Some(parent) = Path::new(path).parent() {
            if !parent.as_os_str().is_empty() {
                let _ = std::fs::create_dir_all(parent);
            }
        }
    }
    let conn = Connection::open(path)?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    conn.execute_batch(SCHEMA)?;
    // Migration: databases created before env_readings had a quality flag get the column once.
    let has_quality = conn.prepare("SELECT 1 FROM pragma_table_info('env_readings') WHERE name='quality'")?.exists([])?;
    if !has_quality {
        conn.execute_batch("ALTER TABLE env_readings ADD COLUMN quality TEXT NOT NULL DEFAULT 'ok' CHECK (quality IN ('ok','suspect'));")?;
    }
    for (code, name, unit, cat, lo, hi) in INDICATORS {
        conn.execute(
            "INSERT OR IGNORE INTO indicators (code,name,unit,category,plausible_min,plausible_max) VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params![code, name, unit, cat, lo, hi],
        )?;
    }
    Ok(conn)
}

/// Run a query and return every row as a JSON object keyed by column name.
pub fn rows(conn: &Connection, sql: &str, args: &[&dyn rusqlite::ToSql]) -> rusqlite::Result<Vec<Value>> {
    let mut stmt = conn.prepare(sql)?;
    let names: Vec<String> = stmt.column_names().map(|s| s.to_string()).collect();
    let mut out = Vec::new();
    let mut r = stmt.query(args)?;
    while let Some(row) = r.next()? {
        let mut m = Map::new();
        for (i, n) in names.iter().enumerate() {
            let v = match row.get_ref(i)? {
                ValueRef::Null | ValueRef::Blob(_) => Value::Null,
                ValueRef::Integer(x) => json!(x),
                ValueRef::Real(x) => json!(x),
                ValueRef::Text(t) => json!(String::from_utf8_lossy(t)),
            };
            m.insert(n.clone(), v);
        }
        out.push(Value::Object(m));
    }
    Ok(out)
}

pub fn one(conn: &Connection, sql: &str, args: &[&dyn rusqlite::ToSql]) -> rusqlite::Result<Option<Value>> {
    Ok(rows(conn, sql, args)?.into_iter().next())
}
