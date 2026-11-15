//! Integration tests: same behaviours as the Python suite. Run: cargo test
use astra_rs::{adapter, api, db, seed};
use axum::{body::Body, http::{Request, StatusCode}, Router};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tower::ServiceExt;

fn tmp_dir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("astra-test-{}-{}", std::process::id(), name));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn seeded_app() -> Router {
    let conn = db::open(":memory:").unwrap();
    seed::seed(&conn).unwrap();
    // One folder per app: tests run in parallel, and a shared folder races on remove/create (Windows).
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let base = tmp_dir(&format!("app-{}", NEXT.fetch_add(1, Ordering::Relaxed)));
    api::router(Arc::new(api::AppState { conn: Mutex::new(conn), base }))
}

async fn call(app: &Router, method: &str, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
    let mut req = Request::builder().method(method).uri(uri);
    let body = match body {
        Some(b) => {
            req = req.header("content-type", "application/json");
            Body::from(b.to_string())
        }
        None => Body::empty(),
    };
    let resp = app.clone().oneshot(req.body(body).unwrap()).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

const MESSY_CSV: &str = "\u{feff}Timestamp, Subject ,HR (bpm),Glucose mmol/L,Temp F,Sleep (min)\n\
2026-10-01 08:00,S1,66,5.1,98.6,420\n\
2026-10-02 08:00,S1,N/A,\"5,3\",99.5,400\n\
2026-10-02 08:00,S1,70,5.0,98.6,410\n\
not-a-date,S1,70,5,98,400\n\
2026-10-03 08:00,S1,999,5.0,98.6,420\n";

fn messy_mapping() -> adapter::Mapping {
    serde_json::from_value(json!({
        "source_name": "test file", "source_type": "imported", "format": "wide",
        "timestamp_col": "Timestamp", "astronaut_col": "Subject",
        "wide": {"columns": {
            "HR (bpm)": {"indicator": "heart_rate", "unit": "bpm"},
            "Glucose mmol/L": {"indicator": "glucose", "unit": "mmol/L"},
            "Temp F": {"indicator": "body_temp", "unit": "F"},
            "Sleep (min)": {"indicator": "sleep_hours", "unit": "min"}}}
    }))
    .unwrap()
}

#[test]
fn messy_csv_is_cleaned() {
    let conn = db::open(":memory:").unwrap();
    let dir = tmp_dir("messy");
    let f = dir.join("messy.csv");
    std::fs::write(&f, MESSY_CSV).unwrap();
    let m = messy_mapping();
    let rep = adapter::import_csv(&conn, &f, &m, Some(&dir.join("clean"))).unwrap();
    assert_eq!(rep["rows_in"], 5);
    assert_eq!(rep["readings_clean"], 11);
    assert_eq!(rep["rejected"], json!({"bad_timestamp": 4, "duplicate_in_file": 4, "implausible_value": 1}));
    assert_eq!(rep["readings_missing_value"], 1);
    assert_eq!(rep["unit_converted"], 9);
    assert_eq!(rep["inserted"], 11);
    let glu: f64 = conn.query_row("SELECT value FROM measurements WHERE indicator_code='glucose' ORDER BY measured_at", [], |r| r.get(0)).unwrap();
    assert!((glu - 91.882).abs() < 0.01, "5.1 mmol/L -> mg/dL, got {glu}");
    let unit: String = conn.query_row("SELECT unit FROM measurements WHERE indicator_code='glucose' LIMIT 1", [], |r| r.get(0)).unwrap();
    assert_eq!(unit, "mg/dL");
    let temp: f64 = conn.query_row("SELECT value FROM measurements WHERE indicator_code='body_temp' ORDER BY measured_at", [], |r| r.get(0)).unwrap();
    assert_eq!(temp, 37.0); // 98.6 F
    let (v, q): (Option<f64>, String) = conn
        .query_row("SELECT value, quality FROM measurements WHERE indicator_code='heart_rate' AND value IS NULL", [], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap();
    assert!(v.is_none() && q == "missing", "missing stays missing, never invented");
    assert!(dir.join("clean/messy.clean.csv").exists());
    // importing the same file again adds nothing
    let rep2 = adapter::import_csv(&conn, &f, &m, None).unwrap();
    assert_eq!(rep2["inserted"], 0);
    assert_eq!(rep2["already_in_database"], 11);
}

#[tokio::test]
async fn overview_labels_source_and_missing() {
    let app = seeded_app();
    let (st, o) = call(&app, "GET", "/api/overview/1", None).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(o["demo_data"], true);
    let hr = o["cards"].as_array().unwrap().iter().find(|c| c["indicator"] == "heart_rate").unwrap();
    assert_eq!(hr["unit"], "bpm");
    assert_eq!(hr["source_type"], "simulated");
    assert!(hr["measured_at"].is_string());
    assert_eq!(call(&app, "GET", "/api/health", None).await.1["status"], "ok");
}

#[tokio::test]
async fn seeded_episode_triggers_explained_alerts() {
    let app = seeded_app();
    let (_, al) = call(&app, "GET", "/api/alerts?astronaut_id=1", None).await;
    let al = al.as_array().unwrap();
    assert!(!al.is_empty(), "the short-sleep days in the demo history should raise alerts");
    for a in al {
        let e = a["explanation"].as_str().unwrap();
        assert!(e.contains("Rule:") && e.contains("not a diagnosis"));
    }
    assert!(al.iter().any(|a| a["explanation"].as_str().unwrap().contains("personal baseline")));
}

#[tokio::test]
async fn trend_returns_baseline_and_gaps() {
    let app = seeded_app();
    let (_, t) = call(&app, "GET", "/api/trends?astronaut_id=1&indicator_code=sleep_hours&days=30", None).await;
    assert_eq!(t["baseline"]["n"], 14);
    assert_eq!(t["points"].as_array().unwrap().len(), 30);
    // The demo history has no body temperature after 10 Nov: those days stay missing, never filled.
    let (_, t) = call(&app, "GET", "/api/trends?astronaut_id=1&indicator_code=body_temp&days=30", None).await;
    let points = t["points"].as_array().unwrap();
    assert_eq!(points.len(), 27);
    assert_eq!(points.last().unwrap()["day"], "2026-11-10");
}

#[tokio::test]
async fn post_measurement_converts_validates_and_alerts() {
    let app = seeded_app();
    let body = json!({"astronaut_id": 1, "indicator_code": "body_temp", "value": 101.5, "unit": "F", "measured_at": "2026-11-01T08:00:00Z"});
    let (st, m) = call(&app, "POST", "/api/measurements", Some(body.clone())).await;
    assert_eq!(st, StatusCode::CREATED);
    assert_eq!(m["measurement"]["unit"], "°C");
    assert_eq!((m["measurement"]["value"].as_f64().unwrap() * 10.0).round() / 10.0, 38.6);
    assert!(m["alerts"].as_array().unwrap().iter().any(|a| a["explanation"].as_str().unwrap().contains("above 38")));
    let (st, _) = call(&app, "POST", "/api/measurements", Some(json!({"astronaut_id": 1, "indicator_code": "heart_rate", "value": 999}))).await;
    assert_eq!(st, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(call(&app, "POST", "/api/measurements", Some(body)).await.0, StatusCode::CONFLICT);
    let (st, _) = call(&app, "POST", "/api/measurements", Some(json!({"astronaut_id": 99, "indicator_code": "mood", "value": 3}))).await;
    assert_eq!(st, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn event_and_recovery_flow() {
    let app = seeded_app();
    let (_, a) = call(&app, "POST", "/api/measurements",
        Some(json!({"astronaut_id": 1, "indicator_code": "heart_rate", "value": 120, "measured_at": "2026-11-01T09:00:00Z"}))).await;
    let alert_id = a["alerts"][0]["id"].as_i64().unwrap();
    let (_, ev) = call(&app, "POST", "/api/events", Some(json!({"astronaut_id": 1, "alert_id": alert_id, "title": "High heart rate",
        "follow_up_indicators": ["heart_rate"], "follow_up_after_hours": [6]}))).await;
    let fid = ev["follow_ups"][0]["id"].as_i64().unwrap();
    let (_, f) = call(&app, "POST", "/api/measurements",
        Some(json!({"astronaut_id": 1, "indicator_code": "heart_rate", "value": 68, "measured_at": "2026-11-01T15:00:00Z"}))).await;
    let mid = f["measurement"]["id"].as_i64().unwrap();
    let (_, done) = call(&app, "POST", &format!("/api/follow-ups/{fid}/complete"), Some(json!({"measurement_id": mid}))).await;
    assert_eq!(done["follow_ups"][0]["toward_baseline"], true);
    assert_eq!(done["event"]["status"], "closed");
}

#[tokio::test]
async fn routines_and_evidence() {
    let app = seeded_app();
    let (_, r) = call(&app, "GET", "/api/routines?astronaut_id=1", None).await;
    let r = r.as_array().unwrap();
    assert_eq!(r.len(), 4);
    assert!(r.iter().all(|x| x["due"] == true));
    let rid = r[0]["id"].as_i64().unwrap();
    assert_eq!(call(&app, "POST", &format!("/api/routines/{rid}/complete"), None).await.0, StatusCode::OK);
    let (_, r2) = call(&app, "GET", "/api/routines?astronaut_id=1", None).await;
    assert_eq!(r2.as_array().unwrap().iter().find(|x| x["id"] == rid).unwrap()["due"], false);
    assert_eq!(call(&app, "GET", "/api/evidence", None).await.1.as_array().unwrap().len(), 5);
}

#[tokio::test]
async fn import_endpoint_rejects_paths() {
    let app = seeded_app();
    let (st, _) = call(&app, "POST", "/api/import?csv_file=../../etc/passwd&mapping=x.json", None).await;
    assert_eq!(st, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn static_html_front_end_is_served() {
    let conn = db::open(":memory:").unwrap();
    let base = tmp_dir("static");
    std::fs::create_dir_all(base.join("static")).unwrap();
    std::fs::write(base.join("static/index.html"), "<!doctype html><title>my front end</title>").unwrap();
    std::fs::write(base.join("static/app.js"), "console.log('hi')").unwrap();
    let app = api::router(Arc::new(api::AppState { conn: Mutex::new(conn), base }));
    for (uri, needle) in [("/", "my front end"), ("/index.html", "my front end"), ("/app.js", "console.log")] {
        let resp = app.clone().oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK, "{uri}");
        let b = resp.into_body().collect().await.unwrap().to_bytes();
        assert!(String::from_utf8_lossy(&b).contains(needle), "{uri}");
    }
    let resp = app.clone().oneshot(Request::builder().uri("/api/health").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK); // the API still works next to the front end
}

#[tokio::test]
async fn env_model_explains_which_rule_fired() {
    let base = tmp_dir("model");
    std::fs::create_dir_all(base.join("models")).unwrap();
    let model = json!({"trained_on": "test", "disclaimer": "not a safety limit", "parameters": {"co2": {
        "n": 100, "median": 2500.0, "mad": 400.0, "unit": "ppm",
        "watch_low": 1000.0, "watch_high": 6000.0, "alert_low": 500.0, "alert_high": 8000.0}}});
    std::fs::write(base.join("models/env_baseline.json"), model.to_string()).unwrap();
    let conn = db::open(":memory:").unwrap();
    let app = api::router(Arc::new(api::AppState { conn: Mutex::new(conn), base }));
    for (v, want) in [(2600.0, "typical"), (7000.0, "watch"), (9000.0, "attention"), (300.0, "attention")] {
        let (st, j) = call(&app, "GET", &format!("/api/environment/assess?parameter=co2&value={v}"), None).await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(j["status"], want, "value {v}");
        assert!(j["rule_fired"].as_str().unwrap().contains("percentile band"));
    }
    let (st, _) = call(&app, "GET", "/api/environment/assess?parameter=nope&value=1", None).await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    let (st, m) = call(&app, "GET", "/api/environment/model", None).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(m["trained_on"], "test");
    // no model file -> clear "not available", not a made-up answer
    let app2 = seeded_app();
    let (st, e) = call(&app2, "GET", "/api/environment/assess?parameter=co2&value=1", None).await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    assert!(e["detail"].as_str().unwrap().contains("not available"));
}

#[tokio::test]
async fn seed_reproduces_the_frontend_demo_history() {
    let demo = seed::demo_rows().unwrap();
    assert_eq!(demo.len(), 265);
    assert!(demo.iter().all(|r| r.source_type == "simulated"), "the demo history is labelled simulated");

    let app = seeded_app();
    let (_, people) = call(&app, "GET", "/api/astronauts", None).await;
    assert_eq!(people[0]["display_name"], seed::DEMO_ASTRONAUT);
    assert_eq!(people[0]["is_synthetic"], 1);

    let (_, stored) = call(&app, "GET", "/api/measurements?astronaut_id=1&limit=2000", None).await;
    let stored = stored.as_array().unwrap();
    assert_eq!(stored.len(), demo.len());
    for r in &demo {
        let hit = stored.iter().find(|m| m["indicator_code"] == r.indicator && m["measured_at"] == r.measured_at.as_str());
        let m = hit.unwrap_or_else(|| panic!("{} at {} is missing", r.indicator, r.measured_at));
        assert_eq!(m["value"].as_f64(), Some(r.value), "{} at {}", r.indicator, r.measured_at);
        assert_eq!(m["source_name"], r.source_name.as_str());
        assert_eq!(m["source_type"], "simulated");
    }
    // first row of history.raw.json: HR_REST 63 bpm, wrist sensor, 2026-10-15T07:30:00.000Z
    assert_eq!(demo[0], seed::DemoRow {
        indicator: "heart_rate", measured_at: "2026-10-15T07:30:00Z".into(), value: 63.0,
        source_name: "wrist sensor".into(), source_type: "simulated".into(),
    });
}

#[test]
fn seeding_twice_keeps_one_copy_and_the_astronauts_own_readings() {
    let conn = db::open(":memory:").unwrap();
    seed::seed(&conn).unwrap();
    conn.execute(
        "INSERT INTO measurements (astronaut_id,indicator_code,value,unit,measured_at,source_type,source_name) \
         VALUES (1,'mood',4,'score','2026-11-13T21:00:00Z','real','check-in')",
        [],
    )
    .unwrap();
    let again = seed::seed(&conn).unwrap();
    assert_eq!(again["measurements"], 265);
    let (people, total): (i64, i64) = conn
        .query_row("SELECT (SELECT COUNT(*) FROM astronauts), (SELECT COUNT(*) FROM measurements)", [], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap();
    assert_eq!((people, total), (1, 266));
}

#[tokio::test]
async fn metric_codes_match_the_frontend_and_the_indicator_table() {
    let app = seeded_app();
    let (_, ind) = call(&app, "GET", "/api/indicators", None).await;
    let codes: Vec<&str> = ind.as_array().unwrap().iter().filter_map(|i| i["code"].as_str()).collect();
    assert_eq!(codes.len(), 10);
    for (metric, code) in seed::METRIC_CODES {
        assert!(codes.contains(&code), "{metric} -> {code} is not in /api/indicators");
        assert_eq!(seed::indicator_for(metric), Some(code));
    }
    assert_eq!(seed::indicator_for("SPO2"), None);

    // The frontend files are the source of truth for metric names and the demo astronaut.
    let frontend = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../frontend/src/data");
    let adapter_ts = std::fs::read_to_string(frontend.join("adapter.ts")).expect("frontend/src/data/adapter.ts");
    for (metric, _) in seed::METRIC_CODES {
        assert!(adapter_ts.contains(&format!("{metric}:")), "{metric} is not a metric in adapter.ts");
    }
    let profile_ts = std::fs::read_to_string(frontend.join("demo/profile.ts")).expect("frontend/src/data/demo/profile.ts");
    assert!(profile_ts.contains(&format!("name: '{}'", seed::DEMO_ASTRONAUT)));
}

#[tokio::test]
async fn exercise_radiation_and_mood_can_be_logged_in_frontend_units() {
    let app = seeded_app();
    for (code, value, unit, stored_unit) in
        [("exercise_minutes", 45.0, "min", "min"), ("radiation_dose_cumulative", 68.7, "mSv", "mSv"), ("mood", 4.0, "/5", "score")]
    {
        let body = json!({"astronaut_id": 1, "indicator_code": code, "value": value, "unit": unit,
                          "measured_at": "2026-11-13T22:00:00Z", "source_type": "real", "source_name": "check-in"});
        let (st, m) = call(&app, "POST", "/api/measurements", Some(body)).await;
        assert_eq!(st, StatusCode::CREATED, "{code}");
        assert_eq!(m["measurement"]["unit"], stored_unit);
        assert_eq!(m["measurement"]["source_type"], "real");
    }
    let (st, _) = call(&app, "POST", "/api/measurements",
        Some(json!({"astronaut_id": 1, "indicator_code": "exercise_minutes", "value": 2000, "unit": "min"}))).await;
    assert_eq!(st, StatusCode::UNPROCESSABLE_ENTITY);
}

const CABIN_CSV: &str = "time_utc,temperature_iss_c,humidity_iss_pct,co2_iss_ppm,co2_iss_ppm_quality\n\
2018-07-01T00:00:00Z,22.5,41,2500,\n\
2018-07-01T00:01:00Z,22.6,41,250,suspect\n\
2018-07-01T00:02:00Z,22.6,,,\n";

fn cabin_base(name: &str) -> PathBuf {
    let base = tmp_dir(name);
    std::fs::create_dir_all(base.join("data/raw/eda")).unwrap();
    std::fs::create_dir_all(base.join("mappings/eda")).unwrap();
    std::fs::write(base.join("data/raw/eda/RR-7_telemetry.csv"), CABIN_CSV).unwrap();
    let mapping = json!({"target": "env", "source_name": "NASA OSDR Environmental Data App (ISS) - RR-7", "source_type": "imported",
        "format": "wide", "timestamp_col": "time_utc", "wide": {"columns": {
            "temperature_iss_c": {"indicator": "cabin_temp", "unit": "°C"},
            "humidity_iss_pct": {"indicator": "humidity", "unit": "%"},
            "co2_iss_ppm": {"indicator": "co2", "unit": "ppm", "quality_col": "co2_iss_ppm_quality"}}}});
    std::fs::write(base.join("mappings/eda/RR-7_telemetry.json"), mapping.to_string()).unwrap();
    base
}

#[tokio::test]
async fn first_start_loads_demo_and_cabin_data_and_flags_suspect_co2() {
    let base = cabin_base("first-run");
    let conn = db::open(":memory:").unwrap();
    assert!(seed::is_empty(&conn).unwrap());
    let summary = seed::first_run(&conn, &base).unwrap();
    assert!(!seed::is_empty(&conn).unwrap());
    assert_eq!(summary["demo"]["measurements"], 265);
    assert_eq!(summary["cabin"], json!({"files": 1, "readings": 7, "flagged_suspect": 1}));
    let text = seed::first_run_summary(&summary);
    assert!(text.contains("265 readings") && text.contains("7 readings from 1 mission files, 1 of them flagged suspect"), "{text}");

    let app = api::router(Arc::new(api::AppState { conn: Mutex::new(conn), base }));
    let (_, co2) = call(&app, "GET", "/api/environment?parameter=co2", None).await;
    let co2 = co2.as_array().unwrap();
    assert_eq!(co2.len(), 2, "the blank CO2 cell is not stored");
    let quality_of = |v: f64| co2.iter().find(|r| r["value"].as_f64() == Some(v)).unwrap()["quality"].clone();
    assert_eq!(quality_of(250.0), "suspect");
    assert_eq!(quality_of(2500.0), "ok");
    let (_, temp) = call(&app, "GET", "/api/environment?parameter=cabin_temp", None).await;
    assert!(temp.as_array().unwrap().iter().all(|r| r["quality"] == "ok"));
}

#[test]
fn first_start_without_cabin_files_says_not_available() {
    let conn = db::open(":memory:").unwrap();
    let summary = seed::first_run(&conn, &tmp_dir("no-cabin")).unwrap();
    assert_eq!(summary["cabin"]["files"], 0);
    assert!(seed::first_run_summary(&summary).contains("ISS cabin data: not available"));
}

#[test]
fn older_databases_get_the_cabin_quality_column() {
    let path = tmp_dir("migrate").join("astra.db");
    {
        let old = rusqlite::Connection::open(&path).unwrap();
        old.execute_batch(
            "CREATE TABLE env_readings (id INTEGER PRIMARY KEY AUTOINCREMENT, measured_at TEXT NOT NULL, parameter TEXT NOT NULL, \
             value REAL, unit TEXT NOT NULL, source_name TEXT NOT NULL, UNIQUE (measured_at, parameter, source_name)); \
             INSERT INTO env_readings (measured_at,parameter,value,unit,source_name) VALUES ('2018-07-01T00:00:00Z','co2',2500,'ppm','old');",
        )
        .unwrap();
    }
    let conn = db::open(path.to_str().unwrap()).unwrap();
    let quality: String = conn.query_row("SELECT quality FROM env_readings", [], |r| r.get(0)).unwrap();
    assert_eq!(quality, "ok");
    db::open(path.to_str().unwrap()).unwrap(); // opening again does not try to add the column twice
}

// ---------- what the web front end needs (state, close, clock, reset, app routes) ----------

#[tokio::test]
async fn app_state_round_trips_and_is_validated() {
    let app = seeded_app();
    let (st, j) = call(&app, "GET", "/api/astronauts/1/state", None).await;
    assert_eq!((st, j["state"].is_null()), (StatusCode::OK, true));
    let state = json!({"xp": 1300, "badges": ["orbit_7"], "events": [{"id": "e1", "steps": {"remeasure": true}}]});
    let (st, put) = call(&app, "PUT", "/api/astronauts/1/state", Some(json!({"state": state}))).await;
    assert_eq!(st, StatusCode::OK, "{put}");
    let (_, j) = call(&app, "GET", "/api/astronauts/1/state", None).await;
    assert_eq!(j["state"], state);
    // replaced, not merged
    call(&app, "PUT", "/api/astronauts/1/state", Some(json!({"state": {"xp": 5}}))).await;
    let (_, j) = call(&app, "GET", "/api/astronauts/1/state", None).await;
    assert_eq!(j["state"], json!({"xp": 5}));
    // only a JSON object, and only for an astronaut that exists
    assert_eq!(call(&app, "PUT", "/api/astronauts/1/state", Some(json!({"state": [1, 2]}))).await.0, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(call(&app, "PUT", "/api/astronauts/1/state", Some(json!({"state": "x"}))).await.0, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(call(&app, "PUT", "/api/astronauts/99/state", Some(json!({"state": {}}))).await.0, StatusCode::NOT_FOUND);
    assert_eq!(call(&app, "GET", "/api/astronauts/99/state", None).await.0, StatusCode::NOT_FOUND);
    let big = json!({"state": {"blob": "x".repeat(600 * 1024)}});
    assert!(matches!(call(&app, "PUT", "/api/astronauts/1/state", Some(big)).await.0, StatusCode::PAYLOAD_TOO_LARGE | StatusCode::UNPROCESSABLE_ENTITY));
}

#[tokio::test]
async fn an_event_can_be_closed_by_the_front_end() {
    let app = seeded_app();
    let (st, ev) = call(&app, "POST", "/api/events", Some(json!({"astronaut_id": 1, "title": "BP check", "follow_up_indicators": ["bp_systolic"]}))).await;
    assert_eq!(st, StatusCode::CREATED, "{ev}");
    let id = ev["event"]["id"].as_i64().or(ev["id"].as_i64()).expect("event id");
    let (st, closed) = call(&app, "POST", &format!("/api/events/{id}/close"), None).await;
    assert_eq!(st, StatusCode::OK, "{closed}");
    let (_, list) = call(&app, "GET", "/api/events?astronaut_id=1", None).await;
    assert_eq!(list.as_array().unwrap().iter().find(|e| e["id"] == json!(id)).unwrap()["status"], "closed");
    assert_eq!(call(&app, "POST", &format!("/api/events/{id}/close"), None).await.0, StatusCode::OK); // idempotent
    assert_eq!(call(&app, "POST", "/api/events/9999/close", None).await.0, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn app_routes_open_the_front_end_but_unknown_api_paths_stay_404() {
    let conn = db::open(":memory:").unwrap();
    let base = tmp_dir("spa");
    std::fs::create_dir_all(base.join("static")).unwrap();
    std::fs::write(base.join("static/index.html"), "<!doctype html><title>the app</title>").unwrap();
    let app = api::router(Arc::new(api::AppState { conn: Mutex::new(conn), base }));
    for uri in ["/log", "/events", "/evidence/deep/link"] {
        let resp = app.clone().oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK, "{uri}");
        let b = resp.into_body().collect().await.unwrap().to_bytes();
        assert!(String::from_utf8_lossy(&b).contains("the app"), "{uri}");
    }
    let resp = app.clone().oneshot(Request::builder().uri("/api/nope").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    let b = resp.into_body().collect().await.unwrap().to_bytes();
    assert!(String::from_utf8_lossy(&b).contains("no such API route"));
}

#[tokio::test]
async fn demo_reset_puts_the_story_back_and_an_event_can_carry_the_mission_clock() {
    let app = seeded_app();

    // what a person does on screen: log a number, open an event with the mission clock, tick a routine, save app state
    let (st, m) = call(&app, "POST", "/api/measurements", Some(json!({"astronaut_id": 1, "indicator_code": "heart_rate", "value": 71.0, "unit": "bpm", "measured_at": "2026-11-13T09:00:00Z", "source_type": "real", "source_name": "ASTRA web app · check-in"}))).await;
    assert_eq!(st, StatusCode::CREATED, "{m}");
    let (st, ev) = call(&app, "POST", "/api/events", Some(json!({"astronaut_id": 1, "title": "BP", "follow_up_indicators": ["bp_systolic"], "opened_at": "2026-11-13T08:45:00.000Z"}))).await;
    assert_eq!(st, StatusCode::CREATED, "{ev}");
    assert_eq!(ev["event"]["opened_at"], "2026-11-13T08:45:00Z");
    assert_eq!(ev["follow_ups"][0]["due_at"], "2026-11-13T14:45:00Z");
    assert_eq!(call(&app, "POST", "/api/events", Some(json!({"astronaut_id": 1, "title": "x", "opened_at": "yesterday"}))).await.0, StatusCode::UNPROCESSABLE_ENTITY);
    call(&app, "POST", "/api/routines/1/complete", None).await;
    call(&app, "PUT", "/api/astronauts/1/state", Some(json!({"state": {"xp": 9}}))).await;

    let (st, r) = call(&app, "POST", "/api/demo/reset", None).await;
    assert_eq!(st, StatusCode::OK, "{r}");
    assert_eq!(r["measurements"], 265);
    let (_, ms) = call(&app, "GET", "/api/measurements?astronaut_id=1&limit=2000", None).await;
    assert_eq!(ms.as_array().unwrap().len(), 265);
    let (_, evs) = call(&app, "GET", "/api/events?astronaut_id=1", None).await;
    assert!(evs.as_array().unwrap().is_empty());
    let (_, rs) = call(&app, "GET", "/api/routines?astronaut_id=1", None).await;
    assert!(rs.as_array().unwrap().iter().all(|x| x["last_completed_at"].is_null()));
    let (_, s) = call(&app, "GET", "/api/astronauts/1/state", None).await;
    assert!(s["state"].is_null());
}

#[tokio::test]
async fn measurement_times_are_stored_in_one_format() {
    let app = seeded_app();
    let post = |t: &str, v: f64| json!({"astronaut_id": 1, "indicator_code": "glucose", "value": v, "unit": "mg/dL", "measured_at": t});
    let (st, m) = call(&app, "POST", "/api/measurements", Some(post("2026-11-13T08:45:00.000Z", 95.0))).await;
    assert_eq!((st, m["measurement"]["measured_at"].as_str()), (StatusCode::CREATED, Some("2026-11-13T08:45:00Z")), "{m}");
    // an offset is converted to UTC; the same instant sent again is a duplicate
    let (st, m) = call(&app, "POST", "/api/measurements", Some(post("2026-11-13T10:45:00+02:00", 95.0))).await;
    assert_eq!(st, StatusCode::CONFLICT, "{m}");
    let (st, _) = call(&app, "POST", "/api/measurements", Some(post("last tuesday", 95.0))).await;
    assert_eq!(st, StatusCode::UNPROCESSABLE_ENTITY);
}
