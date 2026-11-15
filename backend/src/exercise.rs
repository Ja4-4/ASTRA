//! Camera-verified exercise sessions (squats counted by MediaPipe Pose in the browser).
//!
//! The browser sends one summary per session, never video. A session with at least one valid rep
//! also becomes an `exercise_min` measurement, so the "Muscles & bones" system and /api/overview
//! see measured minutes instead of self-reported ones.
//!
//! The checks below are physical or logical limits (angles live in 0-180 deg, a session cannot end
//! in the future, valid reps cannot exceed reps). None of them is a clinical threshold.
use crate::{
    api::Shared,
    db::{one, rows},
    logic,
};
use axum::{
    extract::{Query, State},
    http::StatusCode,
    routing::get,
    Json, Router,
};
use chrono::{DateTime, Duration, Utc};
use rusqlite::{params, Connection};
use serde::Deserialize;
use serde_json::{json, Value};

pub const KIND: &str = "squat";
pub const SOURCE: &str = "camera-verified";
pub const SOURCE_NAME: &str = "camera-verified (MediaPipe pose, squat)";
const MAX_DURATION_S: f64 = 86_400.0; // one day: a single session cannot be longer
const CLOCK_SKEW_S: i64 = 60; // browser and server clocks may disagree slightly
const TS: &str = "%Y-%m-%dT%H:%M:%SZ";

/// The indicator row is added here (not in db.rs) so this feature stays in one file.
/// plausible_max 1440 = minutes in a day, a physical bound for one reading.
const SCHEMA: &str = "INSERT OR IGNORE INTO indicators (code,name,unit,category,plausible_min,plausible_max)
    VALUES ('exercise_min','Exercise','min','musculoskeletal',0,1440);
CREATE TABLE IF NOT EXISTS exercise_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    astronaut_id INTEGER NOT NULL REFERENCES astronauts(id),
    kind TEXT NOT NULL CHECK (kind IN ('squat')),
    started_at TEXT NOT NULL,
    duration_s REAL NOT NULL,
    reps INTEGER NOT NULL,
    reps_valid INTEGER NOT NULL,
    depth_deg_median REAL,
    symmetry_diff_deg_median REAL,
    source TEXT NOT NULL,
    measurement_id INTEGER REFERENCES measurements(id),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    UNIQUE (astronaut_id, kind, started_at)
);
CREATE INDEX IF NOT EXISTS idx_exercise_lookup ON exercise_sessions (astronaut_id, started_at);";

#[derive(Deserialize)]
pub struct SessionIn {
    pub astronaut_id: i64,
    pub kind: String,
    pub started_at: String,
    pub duration_s: f64,
    pub reps: u32,
    pub reps_valid: u32,
    /// Median of the lowest knee angle per valid rep. Required when reps_valid > 0.
    pub depth_deg_median: Option<f64>,
    /// Median left/right depth difference. Optional: in a side view the far leg is hidden.
    pub symmetry_diff_deg_median: Option<f64>,
    pub source: String,
}

fn angle_ok(v: f64) -> bool {
    v.is_finite() && (0.0..=180.0).contains(&v)
}

/// Returns the start time normalised to UTC "YYYY-MM-DDTHH:MM:SSZ".
pub fn validate(s: &SessionIn, now: DateTime<Utc>) -> Result<String, String> {
    if s.kind != KIND {
        return Err(format!("kind must be '{KIND}'"));
    }
    if s.source != SOURCE {
        return Err(format!("source must be '{SOURCE}'"));
    }
    let start = DateTime::parse_from_rfc3339(&s.started_at)
        .map_err(|_| "started_at must be an ISO-8601 time with a zone, e.g. 2026-11-14T08:00:00Z".to_string())?
        .with_timezone(&Utc);
    if !(s.duration_s.is_finite() && s.duration_s > 0.0 && s.duration_s <= MAX_DURATION_S) {
        return Err(format!("duration_s must be above 0 and at most {MAX_DURATION_S}"));
    }
    if start + Duration::milliseconds((s.duration_s * 1000.0) as i64) > now + Duration::seconds(CLOCK_SKEW_S) {
        return Err("the session cannot end in the future".into());
    }
    if s.reps_valid > s.reps {
        return Err("reps_valid cannot be larger than reps".into());
    }
    if s.reps_valid == 0 {
        if s.depth_deg_median.is_some() || s.symmetry_diff_deg_median.is_some() {
            return Err("depth and symmetry must be null when there are no valid reps".into());
        }
    } else {
        match s.depth_deg_median {
            Some(d) if angle_ok(d) => {}
            Some(_) => return Err("depth_deg_median must be between 0 and 180 degrees".into()),
            None => return Err("depth_deg_median is required when reps_valid > 0".into()),
        }
    }
    if let Some(d) = s.symmetry_diff_deg_median {
        if !angle_ok(d) {
            return Err("symmetry_diff_deg_median must be between 0 and 180 degrees".into());
        }
    }
    Ok(start.format(TS).to_string())
}

// ---------- HTTP ----------
type Fail = (StatusCode, Json<Value>);

fn fail(code: StatusCode, msg: impl Into<String>) -> Fail {
    (code, Json(json!({ "detail": msg.into() })))
}

fn internal(e: rusqlite::Error) -> Fail {
    fail(StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}

fn require_astronaut(conn: &Connection, id: i64) -> Result<(), Fail> {
    match one(conn, "SELECT id FROM astronauts WHERE id=?1", params![id]).map_err(internal)? {
        Some(_) => Ok(()),
        None => Err(fail(StatusCode::NOT_FOUND, format!("astronaut {id} not found"))),
    }
}

async fn add_session(State(st): State<Shared>, Json(s): Json<SessionIn>) -> Result<(StatusCode, Json<Value>), Fail> {
    let conn = st.conn.lock().unwrap_or_else(|e| e.into_inner());
    conn.execute_batch(SCHEMA).map_err(internal)?;
    require_astronaut(&conn, s.astronaut_id)?;
    let started = validate(&s, Utc::now()).map_err(|m| fail(StatusCode::UNPROCESSABLE_ENTITY, m))?;

    let tx = conn.unchecked_transaction().map_err(internal)?;
    let n = tx
        .execute(
            "INSERT OR IGNORE INTO exercise_sessions \
             (astronaut_id,kind,started_at,duration_s,reps,reps_valid,depth_deg_median,symmetry_diff_deg_median,source) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![s.astronaut_id, s.kind, started, s.duration_s, s.reps, s.reps_valid,
                    s.depth_deg_median, s.symmetry_diff_deg_median, s.source],
        )
        .map_err(internal)?;
    if n == 0 {
        return Err(fail(StatusCode::CONFLICT, "a session for this astronaut and start time already exists"));
    }
    let sid = tx.last_insert_rowid();
    // No valid rep means nothing was verified, so no exercise minutes are recorded.
    let mid = if s.reps_valid > 0 {
        let minutes = (s.duration_s / 60.0 * 1000.0).round() / 1000.0;
        tx.execute(
            "INSERT INTO measurements (astronaut_id,indicator_code,value,unit,measured_at,source_type,source_name,quality) \
             VALUES (?1,'exercise_min',?2,'min',?3,'real',?4,'ok')",
            params![s.astronaut_id, minutes, started, SOURCE_NAME],
        )
        .map_err(internal)?;
        let mid = tx.last_insert_rowid();
        tx.execute("UPDATE exercise_sessions SET measurement_id=?1 WHERE id=?2", params![mid, sid]).map_err(internal)?;
        Some(mid)
    } else {
        None
    };
    tx.commit().map_err(internal)?;

    let alerts = match mid {
        Some(id) => logic::evaluate_measurement(&conn, id).map_err(internal)?,
        None => vec![],
    };
    let session = one(&conn, "SELECT * FROM exercise_sessions WHERE id=?1", params![sid]).map_err(internal)?;
    let measurement = match mid {
        Some(id) => one(&conn, "SELECT * FROM measurements WHERE id=?1", params![id]).map_err(internal)?,
        None => None,
    };
    Ok((StatusCode::CREATED, Json(json!({ "session": session, "measurement": measurement, "alerts": alerts }))))
}

#[derive(Deserialize)]
struct ListQ {
    astronaut_id: i64,
    limit: Option<i64>,
}

async fn list_sessions(State(st): State<Shared>, Query(q): Query<ListQ>) -> Result<Json<Value>, Fail> {
    let conn = st.conn.lock().unwrap_or_else(|e| e.into_inner());
    conn.execute_batch(SCHEMA).map_err(internal)?;
    require_astronaut(&conn, q.astronaut_id)?;
    let r = rows(
        &conn,
        "SELECT * FROM exercise_sessions WHERE astronaut_id=?1 ORDER BY started_at DESC LIMIT ?2",
        params![q.astronaut_id, q.limit.unwrap_or(100).clamp(1, 1000)],
    )
    .map_err(internal)?;
    Ok(Json(json!(r)))
}

/// Mounted under /api by the main router.
pub fn api_routes() -> Router<Shared> {
    Router::new().route("/exercise/sessions", get(list_sessions).post(add_session))
}
