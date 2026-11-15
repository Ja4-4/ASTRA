//! HTTP API (axum). JSON under /api/*; every other path is served from the ./static folder,
//! so any HTML/CSS/JS front end dropped there is served as-is (index.html at "/").
use crate::{adapter, db::{one, rows}, logic};
use axum::{
    extract::{DefaultBodyLimit, Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use chrono::{Duration, NaiveDateTime, Utc};
use rusqlite::{params, Connection};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use tower_http::{cors::CorsLayer, services::{ServeDir, ServeFile}};

const NA: &str = "not available"; // the guide: show gaps as "not available", never invent values
const TS: &str = "%Y-%m-%dT%H:%M:%SZ";

pub struct AppState {
    pub conn: Mutex<Connection>,
    /// Project root: holds static/, mappings/ and data/raw, data/clean.
    pub base: PathBuf,
}
pub type Shared = Arc<AppState>;

pub struct ApiError(StatusCode, String);
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "detail": self.1 }))).into_response()
    }
}
impl From<rusqlite::Error> for ApiError {
    fn from(e: rusqlite::Error) -> Self {
        ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
    }
}
fn err(code: u16, msg: impl Into<String>) -> ApiError {
    ApiError(StatusCode::from_u16(code).unwrap_or(StatusCode::BAD_REQUEST), msg.into())
}
type Res = Result<Json<Value>, ApiError>;
type Created = Result<(StatusCode, Json<Value>), ApiError>;

fn db(s: &Shared) -> MutexGuard<'_, Connection> {
    s.conn.lock().unwrap_or_else(|e| e.into_inner())
}

fn require_astronaut(conn: &Connection, id: i64) -> Result<Value, ApiError> {
    one(conn, "SELECT * FROM astronauts WHERE id=?1", params![id])?.ok_or_else(|| err(404, format!("astronaut {id} not found")))
}

fn round3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

// ---------- request bodies / queries ----------

#[derive(Deserialize)]
struct MeasurementIn {
    astronaut_id: i64,
    indicator_code: String,
    value: f64,
    unit: Option<String>,        // converted to the canonical unit when different
    measured_at: Option<String>, // UTC ISO-8601; default = now
    source_type: Option<String>,
    source_name: Option<String>,
}
#[derive(Deserialize)]
struct AstronautIn {
    display_name: String,
    mission_setting: Option<String>,
}
#[derive(Deserialize)]
struct EventIn {
    astronaut_id: i64,
    alert_id: Option<i64>,
    title: String,
    #[serde(default)]
    follow_up_indicators: Vec<String>,
    follow_up_after_hours: Option<Vec<i64>>,
    opened_at: Option<String>, // UTC ISO-8601; default = now (the web app passes its mission clock)
}
#[derive(Deserialize)]
struct FollowUpComplete {
    measurement_id: i64,
}
#[derive(Deserialize)]
struct MeasQ {
    astronaut_id: i64,
    indicator_code: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
}
#[derive(Deserialize)]
struct TrendQ {
    astronaut_id: i64,
    indicator_code: String,
    days: Option<i64>,
}
#[derive(Deserialize)]
struct AlertQ {
    astronaut_id: i64,
    status: Option<String>,
}
#[derive(Deserialize)]
struct AstroQ {
    astronaut_id: i64,
}
#[derive(Deserialize)]
struct EnvQ {
    parameter: Option<String>,
    limit: Option<i64>,
}
#[derive(Deserialize)]
struct ImportQ {
    csv_file: String,
    mapping: String,
}

// ---------- handlers ----------

async fn health() -> Res {
    Ok(Json(json!({"status": "ok", "disclaimer": "Demo data. Not a medical record or a diagnostic device."})))
}

async fn indicators(State(s): State<Shared>) -> Res {
    let c = db(&s);
    Ok(Json(json!(rows(&c, "SELECT code,name,unit,category FROM indicators ORDER BY category,code", params![])?)))
}

async fn astronauts(State(s): State<Shared>) -> Res {
    let c = db(&s);
    Ok(Json(json!(rows(&c, "SELECT * FROM astronauts ORDER BY id", params![])?)))
}

async fn add_astronaut(State(s): State<Shared>, Json(a): Json<AstronautIn>) -> Created {
    let setting = a.mission_setting.unwrap_or_else(|| "station".into());
    if !["spacecraft", "station", "rover", "habitat"].contains(&setting.as_str()) {
        return Err(err(422, "mission_setting must be spacecraft, station, rover or habitat"));
    }
    let c = db(&s);
    c.execute("INSERT INTO astronauts (display_name,is_synthetic,mission_setting) VALUES (?1,1,?2)", params![a.display_name, setting])?;
    Ok((StatusCode::CREATED, Json(require_astronaut(&c, c.last_insert_rowid())?)))
}

async fn add_measurement(State(s): State<Shared>, Json(m): Json<MeasurementIn>) -> Created {
    let c = db(&s);
    require_astronaut(&c, m.astronaut_id)?;
    let ind = one(&c, "SELECT * FROM indicators WHERE code=?1", params![m.indicator_code])?
        .ok_or_else(|| err(422, format!("unknown indicator '{}'", m.indicator_code)))?;
    let src_type = m.source_type.clone().unwrap_or_else(|| "manual".into());
    if !["real", "imported", "simulated", "manual"].contains(&src_type.as_str()) {
        return Err(err(422, "source_type must be real, imported, simulated or manual"));
    }
    let unit = adapter::norm_unit(m.unit.as_deref().unwrap_or(""));
    let canon = adapter::canon_token(&m.indicator_code).ok_or_else(|| err(422, "indicator has no canonical unit"))?;
    let unit_name = ind["unit"].as_str().unwrap_or("");
    let mut value = m.value;
    if !unit.is_empty() && unit != canon {
        value = adapter::convert(&m.indicator_code, &unit, value)
            .ok_or_else(|| err(422, format!("cannot convert unit '{}' to {unit_name}", m.unit.clone().unwrap_or_default())))?;
    }
    let (lo, hi) = (ind["plausible_min"].as_f64().unwrap_or(f64::MIN), ind["plausible_max"].as_f64().unwrap_or(f64::MAX));
    if !(lo <= value && value <= hi) {
        return Err(err(422, format!("{} {value} {unit_name} is outside the physically plausible range ({lo}-{hi})", ind["name"].as_str().unwrap_or(""))));
    }
    // stored in one format (UTC, whole seconds) whatever the client sent, so ordering and day grouping stay correct
    let when = match &m.measured_at {
        None => logic::now_iso(),
        Some(t) => chrono::DateTime::parse_from_rfc3339(t.trim())
            .map(|d| d.with_timezone(&Utc).format(TS).to_string())
            .map_err(|_| err(422, "measured_at must be ISO-8601, e.g. 2026-11-13T08:45:00Z"))?,
    };
    let n = c.execute(
        "INSERT OR IGNORE INTO measurements (astronaut_id,indicator_code,value,unit,measured_at,source_type,source_name,quality) \
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        params![m.astronaut_id, m.indicator_code, round3(value), unit_name, when, src_type,
                m.source_name.clone().unwrap_or_else(|| "manual entry".into()), if unit.is_empty() { "suspect" } else { "ok" }],
    )?;
    if n == 0 {
        return Err(err(409, "a measurement for this astronaut, indicator, time and source already exists"));
    }
    let id = c.last_insert_rowid();
    let alerts = logic::evaluate_measurement(&c, id)?;
    let measurement = one(&c, "SELECT * FROM measurements WHERE id=?1", params![id])?;
    Ok((StatusCode::CREATED, Json(json!({"measurement": measurement, "alerts": alerts}))))
}

async fn list_measurements(State(s): State<Shared>, Query(q): Query<MeasQ>) -> Res {
    let c = db(&s);
    let (limit, offset) = (q.limit.unwrap_or(200).clamp(1, 2000), q.offset.unwrap_or(0).max(0));
    let r = match &q.indicator_code {
        Some(code) => rows(&c, "SELECT * FROM measurements WHERE astronaut_id=?1 AND indicator_code=?2 ORDER BY measured_at DESC LIMIT ?3 OFFSET ?4",
                           params![q.astronaut_id, code, limit, offset])?,
        None => rows(&c, "SELECT * FROM measurements WHERE astronaut_id=?1 ORDER BY measured_at DESC LIMIT ?2 OFFSET ?3",
                     params![q.astronaut_id, limit, offset])?,
    };
    Ok(Json(json!(r)))
}

fn routines_for(c: &Connection, aid: i64) -> Result<Vec<Value>, ApiError> {
    let now = Utc::now();
    let mut out = Vec::new();
    for mut r in rows(c, "SELECT * FROM routines WHERE astronaut_id=?1 AND approved=1 ORDER BY id", params![aid])? {
        let last: Option<String> = c.query_row(
            "SELECT MAX(completed_at) FROM routine_completions WHERE routine_id=?1",
            params![r["id"].as_i64()],
            |x| x.get(0),
        )?;
        let every = r["every_hours"].as_i64().unwrap_or(24);
        let due = match &last {
            None => true,
            Some(l) => NaiveDateTime::parse_from_str(l, TS).map(|t| now - t.and_utc() >= Duration::hours(every)).unwrap_or(true),
        };
        r["last_completed_at"] = json!(last);
        r["due"] = json!(due);
        out.push(r);
    }
    Ok(out)
}

async fn overview(State(s): State<Shared>, Path(aid): Path<i64>) -> Res {
    let c = db(&s);
    let a = require_astronaut(&c, aid)?;
    let mut cards = Vec::new();
    for ind in rows(&c, "SELECT * FROM indicators ORDER BY category,code", params![])? {
        let code = ind["code"].as_str().unwrap_or("").to_string();
        let latest = one(&c, "SELECT * FROM measurements WHERE astronaut_id=?1 AND indicator_code=?2 AND value IS NOT NULL ORDER BY measured_at DESC LIMIT 1",
                         params![aid, code])?;
        match latest {
            None => cards.push(json!({"indicator": code, "name": ind["name"], "value": NA, "unit": ind["unit"], "status": "not_available",
                                      "measured_at": null, "source_type": null, "source_name": null})),
            Some(m) => {
                let al = rows(&c, "SELECT * FROM alerts WHERE measurement_id=?1 AND status!='resolved'", params![m["id"].as_i64()])?;
                let sevs: Vec<&str> = al.iter().filter_map(|x| x["severity"].as_str()).collect();
                cards.push(json!({"indicator": code, "name": ind["name"], "value": m["value"], "unit": m["unit"],
                                  "status": logic::status_for(&sevs), "measured_at": m["measured_at"], "source_type": m["source_type"],
                                  "source_name": m["source_name"], "quality": m["quality"],
                                  "why": al.iter().map(|x| x["explanation"].clone()).collect::<Vec<_>>()}));
            }
        }
    }
    let open_alerts = rows(&c, "SELECT * FROM alerts WHERE astronaut_id=?1 AND status='open' ORDER BY triggered_at DESC LIMIT 20", params![aid])?;
    let due: Vec<Value> = routines_for(&c, aid)?.into_iter().filter(|r| r["due"] == json!(true)).collect();
    Ok(Json(json!({"astronaut": a, "demo_data": a["is_synthetic"].as_i64() == Some(1), "cards": cards,
                   "open_alerts": open_alerts, "routines_due": due})))
}

async fn trends(State(s): State<Shared>, Query(q): Query<TrendQ>) -> Res {
    let c = db(&s);
    require_astronaut(&c, q.astronaut_id)?;
    let days = q.days.unwrap_or(7);
    if !(1..=365).contains(&days) {
        return Err(err(422, "days must be between 1 and 365"));
    }
    let ind = one(&c, "SELECT * FROM indicators WHERE code=?1", params![q.indicator_code])?.ok_or_else(|| err(404, "unknown indicator"))?;
    let last: Option<String> = c.query_row(
        "SELECT MAX(measured_at) FROM measurements WHERE astronaut_id=?1 AND indicator_code=?2 AND value IS NOT NULL",
        params![q.astronaut_id, q.indicator_code],
        |x| x.get(0),
    )?;
    let Some(last) = last else {
        return Ok(Json(json!({"indicator": q.indicator_code, "unit": ind["unit"], "points": [], "baseline": null, "note": NA})));
    };
    let since = NaiveDateTime::parse_from_str(&last, TS).map_err(|e| err(500, e.to_string()))? - Duration::days(days);
    let pts = rows(&c,
        "SELECT substr(measured_at,1,10) day, ROUND(AVG(value),2) avg, MIN(value) min, MAX(value) max, COUNT(*) n, \
         GROUP_CONCAT(DISTINCT source_type) source_types FROM measurements WHERE astronaut_id=?1 AND indicator_code=?2 \
         AND value IS NOT NULL AND measured_at > ?3 GROUP BY day ORDER BY day",
        params![q.astronaut_id, q.indicator_code, since.format(TS).to_string()])?;
    let baseline = logic::get_baseline(&c, q.astronaut_id, &q.indicator_code)?.map(|b| b.to_json(q.astronaut_id, &q.indicator_code));
    Ok(Json(json!({"indicator": q.indicator_code, "unit": ind["unit"], "points": pts, "baseline": baseline})))
}

async fn alerts(State(s): State<Shared>, Query(q): Query<AlertQ>) -> Res {
    let c = db(&s);
    let r = match &q.status {
        Some(st) => rows(&c, "SELECT * FROM alerts WHERE astronaut_id=?1 AND status=?2 ORDER BY triggered_at DESC", params![q.astronaut_id, st])?,
        None => rows(&c, "SELECT * FROM alerts WHERE astronaut_id=?1 ORDER BY triggered_at DESC", params![q.astronaut_id])?,
    };
    Ok(Json(json!(r)))
}

async fn acknowledge(State(s): State<Shared>, Path(id): Path<i64>) -> Res {
    let c = db(&s);
    if c.execute("UPDATE alerts SET status='acknowledged' WHERE id=?1", params![id])? == 0 {
        return Err(err(404, "alert not found"));
    }
    Ok(Json(json!({"id": id, "status": "acknowledged"})))
}

async fn open_event(State(s): State<Shared>, Json(e): Json<EventIn>) -> Created {
    let c = db(&s);
    require_astronaut(&c, e.astronaut_id)?;
    for code in &e.follow_up_indicators {
        if one(&c, "SELECT 1 AS x FROM indicators WHERE code=?1", params![code])?.is_none() {
            return Err(err(422, format!("unknown indicator '{code}'")));
        }
    }
    let opened = match &e.opened_at {
        Some(t) => NaiveDateTime::parse_from_str(t.trim_end_matches('Z').split('.').next().unwrap_or(""), "%Y-%m-%dT%H:%M:%S")
            .map_err(|_| err(422, "opened_at must be UTC ISO-8601, e.g. 2026-11-13T08:45:00Z"))?
            .format(TS).to_string(),
        None => logic::now_iso(),
    };
    c.execute("INSERT INTO events (astronaut_id,alert_id,title,opened_at,status) VALUES (?1,?2,?3,?4,'recovering')",
              params![e.astronaut_id, e.alert_id, e.title, opened])?;
    let id = c.last_insert_rowid();
    let t0 = NaiveDateTime::parse_from_str(&opened, TS).map_err(|x| err(500, x.to_string()))?;
    for code in &e.follow_up_indicators {
        for h in e.follow_up_after_hours.clone().unwrap_or_else(|| vec![6, 24, 72]) {
            c.execute("INSERT INTO follow_ups (event_id,indicator_code,due_at) VALUES (?1,?2,?3)",
                      params![id, code, (t0 + Duration::hours(h)).format(TS).to_string()])?;
        }
    }
    Ok((StatusCode::CREATED, Json(logic::recovery_summary(&c, id)?.unwrap_or(Value::Null))))
}

async fn list_events(State(s): State<Shared>, Query(q): Query<AstroQ>) -> Res {
    let c = db(&s);
    Ok(Json(json!(rows(&c, "SELECT * FROM events WHERE astronaut_id=?1 ORDER BY opened_at DESC", params![q.astronaut_id])?)))
}

async fn event(State(s): State<Shared>, Path(id): Path<i64>) -> Res {
    let c = db(&s);
    Ok(Json(logic::recovery_summary(&c, id)?.ok_or_else(|| err(404, "event not found"))?))
}

async fn complete_follow_up(State(s): State<Shared>, Path(fid): Path<i64>, Json(b): Json<FollowUpComplete>) -> Res {
    let c = db(&s);
    let f = one(&c, "SELECT * FROM follow_ups WHERE id=?1", params![fid])?;
    let m = one(&c, "SELECT * FROM measurements WHERE id=?1", params![b.measurement_id])?;
    let (Some(f), Some(m)) = (f, m) else { return Err(err(404, "follow-up or measurement not found")) };
    if m["indicator_code"] != f["indicator_code"] {
        return Err(err(422, "measurement indicator does not match the follow-up"));
    }
    c.execute("UPDATE follow_ups SET completed_at=?1, result_measurement_id=?2 WHERE id=?3", params![logic::now_iso(), b.measurement_id, fid])?;
    let event_id = f["event_id"].as_i64().unwrap_or(0);
    let open_left: i64 = c.query_row("SELECT COUNT(*) FROM follow_ups WHERE event_id=?1 AND completed_at IS NULL", params![event_id], |x| x.get(0))?;
    if open_left == 0 {
        c.execute("UPDATE events SET status='closed', closed_at=?1 WHERE id=?2", params![logic::now_iso(), event_id])?;
    }
    Ok(Json(logic::recovery_summary(&c, event_id)?.unwrap_or(Value::Null)))
}


/// Put the web app's demo back to its starting story (only demo/web-app rows are touched; imported data stays).
async fn demo_reset(State(s): State<Shared>) -> Res {
    let c = db(&s);
    let r = crate::seed::reset_ui(&c).map_err(|e| err(500, e))?;
    Ok(Json(r))
}

/// The state a front end keeps per astronaut (points, badges, alert steps, preferences). A JSON object, at most 512 KB.
const MAX_STATE_BYTES: usize = 512 * 1024;

async fn get_state(State(s): State<Shared>, Path(aid): Path<i64>) -> Res {
    let c = db(&s);
    require_astronaut(&c, aid)?;
    let r = one(&c, "SELECT state_json, updated_at FROM astronaut_state WHERE astronaut_id=?1", params![aid])?;
    Ok(Json(match r {
        Some(r) => json!({"astronaut_id": aid, "state": serde_json::from_str::<Value>(r["state_json"].as_str().unwrap_or("null")).unwrap_or(Value::Null), "updated_at": r["updated_at"]}),
        None => json!({"astronaut_id": aid, "state": null, "updated_at": null}),
    }))
}

#[derive(Deserialize)]
struct StateIn {
    state: Value,
}

async fn put_state(State(s): State<Shared>, Path(aid): Path<i64>, Json(b): Json<StateIn>) -> Res {
    if !b.state.is_object() {
        return Err(err(422, "state must be a JSON object"));
    }
    let text = b.state.to_string();
    if text.len() > MAX_STATE_BYTES {
        return Err(err(413, format!("state is larger than {MAX_STATE_BYTES} bytes")));
    }
    let c = db(&s);
    require_astronaut(&c, aid)?;
    let now = logic::now_iso();
    c.execute(
        "INSERT INTO astronaut_state (astronaut_id,state_json,updated_at) VALUES (?1,?2,?3) \
         ON CONFLICT(astronaut_id) DO UPDATE SET state_json=excluded.state_json, updated_at=excluded.updated_at",
        params![aid, text, now],
    )?;
    Ok(Json(json!({"astronaut_id": aid, "updated_at": now, "bytes": text.len()})))
}

/// Close an event the front end has finished (its own recovery steps are done). Idempotent.
async fn close_event(State(s): State<Shared>, Path(id): Path<i64>) -> Res {
    let c = db(&s);
    if one(&c, "SELECT 1 AS x FROM events WHERE id=?1", params![id])?.is_none() {
        return Err(err(404, "event not found"));
    }
    c.execute("UPDATE events SET status='closed', closed_at=COALESCE(closed_at,?1) WHERE id=?2", params![logic::now_iso(), id])?;
    Ok(Json(logic::recovery_summary(&c, id)?.unwrap_or(Value::Null)))
}

async fn api_not_found() -> ApiError {
    err(404, "no such API route")
}

async fn routines(State(s): State<Shared>, Query(q): Query<AstroQ>) -> Res {
    let c = db(&s);
    Ok(Json(json!(routines_for(&c, q.astronaut_id)?)))
}

async fn complete_routine(State(s): State<Shared>, Path(rid): Path<i64>) -> Res {
    let c = db(&s);
    if one(&c, "SELECT 1 AS x FROM routines WHERE id=?1", params![rid])?.is_none() {
        return Err(err(404, "routine not found"));
    }
    let when = logic::now_iso();
    c.execute("INSERT INTO routine_completions (routine_id,completed_at) VALUES (?1,?2)", params![rid, when])?;
    Ok(Json(json!({"routine_id": rid, "completed_at": when})))
}

async fn environment(State(s): State<Shared>, Query(q): Query<EnvQ>) -> Res {
    let c = db(&s);
    let limit = q.limit.unwrap_or(500).clamp(1, 5000);
    let r = match &q.parameter {
        Some(p) => rows(&c, "SELECT * FROM env_readings WHERE parameter=?1 ORDER BY measured_at DESC LIMIT ?2", params![p, limit])?,
        None => rows(&c, "SELECT * FROM env_readings ORDER BY measured_at DESC LIMIT ?1", params![limit])?,
    };
    Ok(Json(json!(r)))
}

fn load_env_model(s: &Shared) -> Result<Value, ApiError> {
    let path = s.base.join("models/env_baseline.json");
    let txt = std::fs::read_to_string(&path)
        .map_err(|_| ApiError(StatusCode::NOT_FOUND, format!("model {NA}: run scripts/train_env_model.py first")))?;
    serde_json::from_str(&txt).map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, format!("model file unreadable: {e}")))
}

async fn env_model(State(s): State<Shared>) -> Res {
    Ok(Json(load_env_model(&s)?))
}

#[derive(Deserialize)]
struct AssessQ {
    parameter: String,
    value: f64,
}

async fn env_assess(State(s): State<Shared>, Query(q): Query<AssessQ>) -> Res {
    let model = load_env_model(&s)?;
    match logic::assess_env(&model, &q.parameter, q.value) {
        Some(v) => Ok(Json(v)),
        None => Err(ApiError(StatusCode::NOT_FOUND, format!("no trained reference for parameter '{}'", q.parameter))),
    }
}

async fn evidence(State(s): State<Shared>) -> Res {
    let c = db(&s);
    Ok(Json(json!(rows(&c, "SELECT * FROM evidence_sources ORDER BY id", params![])?)))
}

fn list_dir(dir: PathBuf, ext: &str) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir)
        .map(|rd| rd.flatten().filter_map(|e| e.file_name().into_string().ok()).filter(|n| n.to_lowercase().ends_with(ext)).collect())
        .unwrap_or_default();
    v.sort();
    v
}

async fn import_files(State(s): State<Shared>) -> Res {
    Ok(Json(json!({"raw_csv": list_dir(s.base.join("data/raw"), ".csv"), "mappings": list_dir(s.base.join("mappings"), ".json")})))
}

/// Import data/raw/<csv_file> using mappings/<mapping>. Names only, never paths.
async fn run_import(State(s): State<Shared>, Query(q): Query<ImportQ>) -> Res {
    let base_name = |n: &str| std::path::Path::new(n).file_name().map(|f| f.to_owned()).unwrap_or_default();
    let csv_path = s.base.join("data/raw").join(base_name(&q.csv_file));
    let map_path = s.base.join("mappings").join(base_name(&q.mapping));
    if !csv_path.is_file() || !map_path.is_file() {
        return Err(err(404, "csv file or mapping not found"));
    }
    let mapping = adapter::load_mapping(&map_path).map_err(|e| err(422, e))?;
    let c = db(&s);
    let mut report = adapter::import_csv(&c, &csv_path, &mapping, Some(&s.base.join("data/clean"))).map_err(|e| err(422, e))?;
    report["new_alerts"] = json!(logic::evaluate_all(&c)?);
    Ok(Json(report))
}

async fn import_log(State(s): State<Shared>) -> Res {
    let c = db(&s);
    Ok(Json(json!(rows(&c, "SELECT * FROM import_log ORDER BY id DESC", params![])?)))
}

/// Every data route (no assistant routes). The Atlas executor runs its allow-listed requests through exactly this
/// router, so an action can never reach anything the normal API does not already offer.
pub fn core_routes() -> Router<Shared> {
    Router::new()
        .route("/health", get(health))
        .route("/indicators", get(indicators))
        .route("/astronauts", get(astronauts).post(add_astronaut))
        .route("/measurements", get(list_measurements).post(add_measurement))
        .route("/overview/{id}", get(overview))
        .route("/trends", get(trends))
        .route("/alerts", get(alerts))
        .route("/alerts/{id}/acknowledge", post(acknowledge))
        .route("/events", get(list_events).post(open_event))
        .route("/events/{id}", get(event))
        .route("/events/{id}/close", post(close_event))
        .route("/astronauts/{id}/state", get(get_state).put(put_state).layer(DefaultBodyLimit::max(MAX_STATE_BYTES + 4096)))
        .route("/follow-ups/{id}/complete", post(complete_follow_up))
        .route("/demo/reset", post(demo_reset))
        .route("/routines", get(routines))
        .route("/routines/{id}/complete", post(complete_routine))
        .route("/environment", get(environment))
        .route("/environment/model", get(env_model))
        .route("/environment/assess", get(env_assess))
        .route("/evidence", get(evidence))
        .route("/import/files", get(import_files))
        .route("/import", post(run_import))
        .route("/import/log", get(import_log))
        .merge(crate::exercise::api_routes())
        .merge(crate::eye::api_routes())
}

/// The data API alone, mounted under /api (used in-process by Atlas).
pub fn internal_router(state: Shared) -> Router {
    Router::new().nest("/api", core_routes()).with_state(state)
}

pub fn router(state: Shared) -> Router {
    let api = core_routes().merge(crate::ai::api_routes()).merge(crate::atlas::api_routes());
    let static_dir = state.base.join("static");
    // Client-side routes (/log, /events ...) are not files: answer them with index.html so a page reload or a
    // shared link opens the app. Unknown /api paths stay a JSON 404.
    let files = ServeDir::new(&static_dir).append_index_html_on_directories(true).fallback(ServeFile::new(static_dir.join("index.html")));
    Router::new()
        .nest("/api", api.fallback(api_not_found))
        .merge(crate::eye::page_routes())
        .fallback_service(files)
        .layer(CorsLayer::permissive())
        .with_state(state)
}
