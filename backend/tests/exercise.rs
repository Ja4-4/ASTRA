//! POST/GET /api/exercise/sessions. Run: cargo test --test exercise
use astra_rs::{api, db, seed};
use axum::{body::Body, http::{Request, StatusCode}, Router};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tower::ServiceExt;

fn app() -> Router {
    let conn = db::open(":memory:").unwrap();
    seed::seed(&conn).unwrap();
    let base = std::env::temp_dir().join(format!("astra-test-{}-exercise", std::process::id()));
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

async fn first_astronaut(app: &Router) -> i64 {
    let (_, list) = call(app, "GET", "/api/astronauts", None).await;
    list[0]["id"].as_i64().expect("seed creates at least one astronaut")
}

fn session(aid: i64) -> Value {
    json!({
        "astronaut_id": aid, "kind": "squat", "started_at": "2026-11-01T08:00:00Z", "duration_s": 150.0,
        "reps": 12, "reps_valid": 10, "depth_deg_median": 92.5, "symmetry_diff_deg_median": 6.0,
        "source": "camera-verified"
    })
}

#[tokio::test]
async fn valid_session_is_stored_and_becomes_exercise_minutes() {
    let app = app();
    let aid = first_astronaut(&app).await;

    let (st, out) = call(&app, "POST", "/api/exercise/sessions", Some(session(aid))).await;
    assert_eq!(st, StatusCode::CREATED, "{out}");
    assert_eq!(out["session"]["reps_valid"], 10);
    assert_eq!(out["session"]["started_at"], "2026-11-01T08:00:00Z");
    let m = &out["measurement"];
    assert_eq!(m["indicator_code"], "exercise_min");
    assert_eq!(m["value"], 2.5); // 150 s
    assert_eq!(m["unit"], "min");
    assert_eq!(m["source_type"], "real");
    assert_eq!(m["source_name"], "camera-verified (MediaPipe pose, squat)");
    assert_eq!(out["session"]["measurement_id"], m["id"]);

    // the minutes go through the normal measurements table
    let (_, ms) = call(&app, "GET", &format!("/api/measurements?astronaut_id={aid}&indicator_code=exercise_min"), None).await;
    assert_eq!(ms.as_array().unwrap().len(), 1);

    let (st, list) = call(&app, "GET", &format!("/api/exercise/sessions?astronaut_id={aid}"), None).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(list.as_array().unwrap().len(), 1);

    // the same session twice is a conflict, not a second record
    let (st, _) = call(&app, "POST", "/api/exercise/sessions", Some(session(aid))).await;
    assert_eq!(st, StatusCode::CONFLICT);
}

#[tokio::test]
async fn session_without_valid_reps_records_no_minutes() {
    let app = app();
    let aid = first_astronaut(&app).await;
    let mut s = session(aid);
    s["reps_valid"] = json!(0);
    s["depth_deg_median"] = Value::Null;
    s["symmetry_diff_deg_median"] = Value::Null;

    let (st, out) = call(&app, "POST", "/api/exercise/sessions", Some(s)).await;
    assert_eq!(st, StatusCode::CREATED, "{out}");
    assert_eq!(out["measurement"], Value::Null);
    let (_, ms) = call(&app, "GET", &format!("/api/measurements?astronaut_id={aid}&indicator_code=exercise_min"), None).await;
    assert_eq!(ms.as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn invalid_input_is_rejected_and_nothing_is_stored() {
    let app = app();
    let aid = first_astronaut(&app).await;
    let cases: Vec<(&str, Value)> = vec![
        ("kind", json!("pushup")),
        ("source", json!("manual")),
        ("started_at", json!("yesterday")),
        ("started_at", json!("2999-01-01T00:00:00Z")),
        ("duration_s", json!(0)),
        ("duration_s", json!(100_000)),
        ("reps_valid", json!(13)),
        ("depth_deg_median", json!(200)),
        ("depth_deg_median", Value::Null),
        ("symmetry_diff_deg_median", json!(-1)),
        ("reps", json!(-3)),
    ];
    for (field, bad) in cases {
        let mut s = session(aid);
        s[field] = bad.clone();
        let (st, out) = call(&app, "POST", "/api/exercise/sessions", Some(s)).await;
        assert_eq!(st, StatusCode::UNPROCESSABLE_ENTITY, "{field}={bad} -> {out}");
    }
    let (_, list) = call(&app, "GET", &format!("/api/exercise/sessions?astronaut_id={aid}"), None).await;
    assert_eq!(list.as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn unknown_astronaut_is_404() {
    let app = app();
    let (st, out) = call(&app, "POST", "/api/exercise/sessions", Some(session(999_999))).await;
    assert_eq!(st, StatusCode::NOT_FOUND, "{out}");
    let (st, _) = call(&app, "GET", "/api/exercise/sessions?astronaut_id=999999", None).await;
    assert_eq!(st, StatusCode::NOT_FOUND);
}
