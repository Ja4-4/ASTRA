//! Tests for the "atlas" module. The model server is a fake HTTP server that returns scripted replies, so no real
//! model is needed. Run: cargo test --test atlas
use astra_rs::ai::{AiConfig, Provider};
use astra_rs::atlas::{self, ArgKind, CommandIn, ConfirmIn, Kind};
use astra_rs::{api, db, seed};
use axum::{extract::State, routing::post, Json, Router};
use serde_json::{json, Map, Value};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const REGISTRY: &str = include_str!("../ai/atlas_actions.json");
const GOLDEN: &str = include_str!("atlas_golden.json");

fn tmp_dir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("atlas-test-{}-{}", std::process::id(), name));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(d.join("ai")).unwrap();
    std::fs::write(d.join("ai/atlas_actions.json"), REGISTRY).unwrap();
    d
}

fn state(name: &str) -> api::Shared {
    let conn = db::open(":memory:").unwrap();
    seed::seed(&conn).unwrap();
    Arc::new(api::AppState { conn: Mutex::new(conn), base: tmp_dir(name) })
}

fn registry() -> atlas::Registry {
    atlas::parse_registry(REGISTRY).unwrap()
}

// ------------------------------------------------------------------ fake model server

type Script = Arc<Mutex<VecDeque<String>>>;
type Seen = Arc<Mutex<Vec<Value>>>;

async fn fake_model(replies: &[&str]) -> (AiConfig, Seen) {
    let script: Script = Arc::new(Mutex::new(replies.iter().map(|s| s.to_string()).collect()));
    let seen: Seen = Arc::new(Mutex::new(Vec::new()));
    let app = Router::new()
        .route(
            "/v1/chat/completions",
            post(|State((script, seen)): State<(Script, Seen)>, Json(b): Json<Value>| async move {
                seen.lock().unwrap().push(b);
                let reply = script.lock().unwrap().pop_front().unwrap_or_else(|| "{}".into());
                Json(json!({"choices": [{"message": {"role": "assistant", "content": reply}}]}))
            }),
        )
        .with_state((script, seen.clone()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (AiConfig { provider: Provider::OpenAi, url: format!("http://{addr}/v1"), model: "ai".into(), timeout: Duration::from_secs(10) }, seen)
}

fn reply(text: &str, lang: &str, action: Value) -> String {
    json!({"reply": text, "lang": lang, "action": action}).to_string()
}

async fn ask(s: &api::Shared, cfg: &AiConfig, message: &str, astronaut: Option<i64>) -> (u16, Value) {
    let (code, body) = atlas::run_command(s, cfg, &CommandIn { message: message.into(), astronaut_id: astronaut, at: None }).await;
    (code.as_u16(), body)
}

fn count(s: &api::Shared, sql: &str) -> i64 {
    s.conn.lock().unwrap().query_row(sql, [], |r| r.get(0)).unwrap()
}

// ------------------------------------------------------------------ registry + parity with the Python contract

#[test]
fn registry_is_valid_and_covers_every_kind() {
    let r = registry();
    assert_eq!(r.version, 2);
    let n = |k: Kind| r.actions.iter().filter(|a| a.kind == k).count();
    assert_eq!((n(Kind::Read), n(Kind::Write), n(Kind::Ui)), (17, 7, 5));
    // every write action must say so in the text the model sees
    for a in r.actions.iter().filter(|a| a.kind == Kind::Write) {
        assert!(a.description.contains("needs confirmation"), "{} should warn the model", a.name);
    }
}

#[test]
fn registry_rejects_unsafe_definitions() {
    let bad = |exec: Value, kind: &str| {
        let doc = json!({"version": 2, "actions": [{"name": "x", "kind": kind, "description": "d", "args": {}, "exec": exec}]});
        atlas::parse_registry(&doc.to_string())
    };
    assert!(bad(json!({"method": "GET", "path": "/api/atlas/command"}), "read").is_err(), "atlas must not call itself");
    assert!(bad(json!({"method": "GET", "path": "/api/ai/chat"}), "read").is_err());
    assert!(bad(json!({"method": "POST", "path": "/api/eye/analyze"}), "write").is_err(), "camera upload is not an action");
    assert!(bad(json!({"method": "GET", "path": "/etc/passwd"}), "read").is_err());
    assert!(bad(json!({"method": "GET", "path": "/api/../secret"}), "read").is_err());
    assert!(bad(json!({"method": "POST", "path": "/api/health"}), "read").is_err(), "a read action cannot POST");
    assert!(bad(json!({"method": "GET", "path": "/api/health"}), "write").is_err(), "a write action must POST");
    assert!(bad(json!({"method": "GET", "path": "/api/measurements", "query": {"a": "{nope}"}}), "read").is_err(), "unknown placeholder");
    assert!(bad(json!({"method": "DELETE", "path": "/api/health"}), "read").is_err());
    assert!(bad(json!({"method": "GET", "path": "/api/health"}), "read").is_ok());
}

#[test]
fn system_prompt_is_identical_to_the_python_one() {
    let g: Value = serde_json::from_str(GOLDEN).unwrap();
    let r = registry();
    for case in g["system"].as_array().unwrap() {
        let acts: Vec<&atlas::Action> = case["names"].as_array().unwrap().iter().map(|n| r.get(n.as_str().unwrap()).unwrap()).collect();
        assert_eq!(atlas::build_system(&acts), case["system"].as_str().unwrap(), "names {}", case["names"]);
    }
}

#[test]
fn reply_validation_matches_the_python_one() {
    let g: Value = serde_json::from_str(GOLDEN).unwrap();
    let r = registry();
    let offered: Vec<&atlas::Action> = g["parse"]["offered"].as_array().unwrap().iter().map(|n| r.get(n.as_str().unwrap()).unwrap()).collect();
    for c in g["parse"]["cases"].as_array().unwrap() {
        let text = c["text"].as_str().unwrap();
        let got = atlas::parse_reply(text, &offered);
        assert_eq!(got.is_ok(), c["ok"].as_bool().unwrap(), "{text} -> {got:?}");
        if let (Ok(p), Value::Object(d)) = (&got, &c["data"]) {
            assert_eq!(&p.reply, d["reply"].as_str().unwrap());
            assert_eq!(&p.lang, d["lang"].as_str().unwrap());
            match (&p.action, &d["action"]) {
                (None, Value::Null) => {}
                (Some((n, a)), Value::Object(x)) => {
                    assert_eq!(n, x["name"].as_str().unwrap());
                    assert_eq!(&Value::Object(a.clone()), &x["args"]);
                }
                other => panic!("action mismatch {other:?}"),
            }
        }
    }
}

#[test]
fn an_action_the_model_was_not_offered_is_refused() {
    let r = registry();
    let offered = vec![r.get("get_latest").unwrap()];
    let text = reply("ok", "en", json!({"name": "add_astronaut", "args": {"name": "X", "setting": "station"}}));
    assert!(atlas::parse_reply(&text, &offered).is_err(), "add_astronaut was not in the prompt");
}

// ------------------------------------------------------------------ retrieval

fn held_out(list: &[Value]) -> Vec<String> {
    let n = list.len();
    let take = (n / 4).max(1);
    list[n - take..].iter().filter_map(Value::as_str).map(String::from).collect()
}

#[test]
fn the_right_action_is_among_the_candidates_for_unseen_phrasing() {
    // Retrieval must work for phrasing it has NOT seen, so its vocabulary is rebuilt from the training share only:
    // the first 3/4 of every template list, the first surface form of each enum value. The held-out rest is the exam.
    // (The hand-written keywords stay: they are part of the registry.)
    let root: Value = serde_json::from_str(REGISTRY).unwrap();
    let mut reduced = root.clone();
    for a in reduced["actions"].as_array_mut().unwrap() {
        for list in a["templates"].as_object_mut().unwrap().values_mut() {
            let l = list.as_array_mut().unwrap();
            let keep = l.len() - (l.len() / 4).max(1).min(l.len());
            l.drain(keep..).for_each(drop);
        }
        for spec in a["args"].as_object_mut().unwrap().values_mut() {
            if spec["kind"] == "enum" {
                for forms in spec["values"].as_object_mut().unwrap().values_mut() {
                    for l in forms.as_object_mut().unwrap().values_mut() {
                        l.as_array_mut().unwrap().drain(1..).for_each(drop);
                    }
                }
            }
        }
    }
    let r = atlas::parse_registry(&reduced.to_string()).unwrap();
    let (mut total, mut hit) = (0, 0);
    let mut misses = Vec::new();
    for a in root["actions"].as_array().unwrap() {
        let name = a["name"].as_str().unwrap();
        for (frame, slot_lang) in [("ar", "ar"), ("en", "en"), ("mixed_ar", "en"), ("mixed_en", "ar")] {
            let Some(tpls) = a["templates"][frame].as_array().filter(|t| !t.is_empty()) else { continue };
            for tpl in held_out(tpls) {
                // fill the placeholders with the held-out surface forms
                let mut text = tpl.clone();
                for (an, spec) in a["args"].as_object().unwrap() {
                    let value = if spec["kind"] == "enum" {
                        let vals = spec["values"].as_object().unwrap();
                        let v = vals.values().last().unwrap();
                        v[slot_lang].as_array().unwrap().last().unwrap().as_str().unwrap().to_string()
                    } else {
                        spec["examples"][slot_lang].as_array().unwrap().last().unwrap().as_str().unwrap().to_string()
                    };
                    text = text.replace(&format!("{{{an}}}"), &value);
                }
                total += 1;
                if r.candidates(&text).iter().any(|c| c.name == name) {
                    hit += 1;
                } else {
                    misses.push(format!("{name}: {text}"));
                }
            }
        }
    }
    let recall = hit as f64 / total as f64;
    println!("candidate recall on held-out phrasing: {hit}/{total} = {recall:.3}");
    for m in &misses {
        println!("  miss {m}");
    }
    assert!(recall >= 0.9, "recall {recall:.3}; misses: {misses:#?}");
}

/// Sentences written by hand, in everyday and Gulf phrasing, none of them in the registry.
#[test]
fn everyday_sentences_find_their_action() {
    let r = registry();
    let cases = [
        ("اطلس وش وضع قلبي الحين", "get_latest"),
        ("كم نبضي", "get_latest"),
        ("what's my pulse right now", "get_latest"),
        ("how has my sleep been this past week", "show_trend"),
        ("وريني كيف كان سكر الدم هالأسبوع", "show_trend"),
        ("any warnings I should know about", "list_alerts"),
        ("في شي تحذيرات", "list_alerts"),
        ("is the air in the cabin okay", "env_latest"),
        ("كم نسبة الرطوبة عندنا", "env_latest"),
        ("record that my blood pressure is 120", "log_measurement"),
        ("ابغى أسجل نبضي 80", "log_measurement"),
        ("I finished my routine 5", "complete_routine"),
        ("who is on the crew", "list_astronauts"),
        ("الوضع الليلي لو سمحت", "set_theme"),
        ("خذني لصفحة الاتجاهات", "navigate"),
        ("go to the alerts page", "navigate"),
        ("be quiet please", "stop_speaking"),
        ("how am I doing overall", "show_overview"),
        ("ملخص حالتي", "show_overview"),
        ("add Mona to the crew on the station", "add_astronaut"),
        ("import the file data.csv with map.json", "import_data"),
        ("اعتمد التنبيه 5", "acknowledge_alert"),
    ];
    let mut misses = Vec::new();
    for (text, want) in cases {
        if !r.candidates(text).iter().any(|c| c.name == want) {
            misses.push(format!("{text} -> wanted {want}, got {:?}", r.candidates(text).iter().map(|c| &c.name).collect::<Vec<_>>()));
        }
    }
    println!("everyday sentences: {}/{} found", cases.len() - misses.len(), cases.len());
    for m in &misses {
        println!("  miss {m}");
    }
    assert!(misses.len() <= 3, "{misses:#?}");
}

#[test]
fn candidates_are_capped_and_small_talk_gets_few() {
    let r = registry();
    assert!(r.candidates("show my alerts and my routines and my events and the crew and the log").len() <= 5);
    assert!(r.candidates("zzzz qqqq").is_empty());
}

// ------------------------------------------------------------------ argument cleaning

#[test]
fn arguments_are_cleaned_and_hostile_values_are_refused() {
    let r = registry();
    let log = r.get("log_measurement").unwrap();
    let mk = |v: &str| {
        let mut m = Map::new();
        m.insert("indicator".into(), json!("heart_rate"));
        m.insert("value".into(), json!(v));
        m
    };
    assert_eq!(atlas::clean_args(log, &mk("٧٢")).unwrap()["value"], json!(72.0), "Arabic-Indic digits");
    assert_eq!(atlas::clean_args(log, &mk("36,6")).unwrap()["value"], json!(36.6), "decimal comma");
    assert_eq!(atlas::clean_args(log, &mk("36٫6")).unwrap()["value"], json!(36.6), "Arabic decimal mark");
    assert!(atlas::clean_args(log, &mk("seventy")).is_err());
    assert!(atlas::clean_args(log, &mk("NaN")).is_err());
    assert!(atlas::clean_args(log, &mk("inf")).is_err());
    assert!(atlas::clean_args(log, &mk("1e999")).is_err());
    let import = r.get("import_data").unwrap();
    let file = |f: &str| {
        let mut m = Map::new();
        m.insert("csv_file".into(), json!(f));
        m.insert("mapping".into(), json!("nasa_map.json"));
        m
    };
    assert!(atlas::clean_args(import, &file("vitals.csv")).is_ok());
    for evil in ["../../etc/passwd", "a/b.csv", "..\\win.csv", "x.csv?y=1", "a b.csv", "x\n.csv", &"a".repeat(90)] {
        assert!(atlas::clean_args(import, &file(evil)).is_err(), "{evil:?} must be refused");
    }
    let id = r.get("acknowledge_alert").unwrap();
    let mut m = Map::new();
    m.insert("alert_id".into(), json!("-5"));
    assert!(atlas::clean_args(id, &m).is_err());
    m.insert("alert_id".into(), json!("12 OR 1=1"));
    assert!(atlas::clean_args(id, &m).is_err());
}

// ------------------------------------------------------------------ every feature is reachable

fn sample_args(a: &atlas::Action) -> Map<String, Value> {
    let mut m = Map::new();
    for (n, k) in &a.args {
        let v = match k {
            ArgKind::Enum(vals) => vals[0].clone(),
            ArgKind::Text(_) => match n.as_str() {
                "value" => "70".into(),
                "csv_file" => "nope.csv".into(),
                "mapping" => "nope.json".into(),
                "name" | "title" => "Test".into(),
                _ => "1".into(),
            },
        };
        m.insert(n.clone(), json!(v));
    }
    atlas::clean_args(a, &m).unwrap()
}

#[tokio::test]
async fn every_read_action_reaches_a_real_route() {
    let s = state("reach");
    let r = registry();
    for a in r.actions.iter().filter(|a| a.kind != Kind::Ui) {
        let p = match atlas::prepare(&s, a, &sample_args(a), Some(1), None) {
            Ok(p) => p,
            // an id-based action checks that the row exists and is the astronaut's own; the demo data has no event 1
            Err(atlas::ExecErr::Invalid(m)) if m.contains("not found") => continue,
            Err(e) => panic!("{}: {e:?}", a.name),
        };
        if a.kind == Kind::Read {
            let (code, body) = atlas::execute(&s, &p).await;
            assert!(code < 500, "{} -> {code} {body}", a.name);
            assert_ne!(code, 405, "{} wrong method", a.name);
        }
    }
    // the unit of a logged measurement is the canonical one, so the quality flag stays "ok"
    let log = r.get("log_measurement").unwrap();
    let p = atlas::prepare(&s, log, &sample_args(log), Some(1), None).unwrap();
    assert_eq!(p.body.as_ref().unwrap()["unit"], json!("bpm"));
    assert_eq!(p.body.as_ref().unwrap()["astronaut_id"], json!(1));
    assert_eq!(p.body.as_ref().unwrap()["value"], json!(70.0));
}

#[test]
fn actions_that_need_an_astronaut_refuse_without_one() {
    let s = state("noastro");
    let r = registry();
    let a = r.get("get_latest").unwrap();
    assert!(matches!(atlas::prepare(&s, a, &sample_args(a), None, None), Err(atlas::ExecErr::NeedAstronaut)));
    let a = r.get("list_astronauts").unwrap();
    assert!(atlas::prepare(&s, a, &sample_args(a), None, None).is_ok(), "the crew list does not need one");
}

// ------------------------------------------------------------------ the full flow with a scripted model

#[tokio::test]
async fn a_read_action_runs_at_once_and_is_audited() {
    let s = state("read");
    let (cfg, seen) = fake_model(&[&reply("Sure, here is the latest heart rate.", "en", json!({"name": "get_latest", "args": {"indicator": "heart_rate"}}))]).await;
    let (code, body) = ask(&s, &cfg, "Atlas what's my latest heart rate", Some(1)).await;
    assert_eq!(code, 200, "{body}");
    assert_eq!(body["status"], "executed", "{body}");
    assert_eq!(body["kind"], "read");
    assert_eq!(body["action"]["name"], "get_latest");
    let rows = body["result"].as_array().expect("measurement list");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["indicator_code"], "heart_rate");
    // the model saw a short action list that contains the right action, never all 29
    let sys = seen.lock().unwrap()[0]["messages"][0]["content"].as_str().unwrap().to_string();
    assert!(sys.contains("- get_latest("), "{sys}");
    assert!(sys.matches("\n- ").count() <= 5);
    // audit trail
    let log = std::fs::read_to_string(s.base.join("data/atlas_audit.jsonl")).unwrap();
    assert!(log.contains("\"get_latest\"") && log.contains("\"executed\""), "{log}");
}

#[tokio::test]
async fn a_write_action_waits_for_confirmation_and_changes_nothing_until_then() {
    let s = state("write");
    let before = count(&s, "SELECT COUNT(*) FROM measurements");
    let (cfg, _) = fake_model(&[&reply("Okay, I'll log heart rate at 70. I need your confirmation.", "en",
                                       json!({"name": "log_measurement", "args": {"indicator": "heart_rate", "value": "70"}}))]).await;
    let (_, body) = ask(&s, &cfg, "log heart rate at 70", Some(1)).await;
    assert_eq!(body["status"], "needs_confirmation", "{body}");
    assert_eq!(body["kind"], "write");
    assert_eq!(count(&s, "SELECT COUNT(*) FROM measurements"), before, "nothing may be written before the user confirms");
    let token = body["confirm"]["token"].as_str().unwrap().to_string();
    assert_eq!(token.len(), 32);
    assert_eq!(body["confirm"]["summary"]["args"]["value"], json!(70.0));

    let (code, done) = atlas::run_confirm(&s, &ConfirmIn { token: token.clone(), approve: true }).await;
    assert_eq!(code.as_u16(), 200, "{done}");
    assert_eq!(done["status"], "executed", "{done}");
    assert_eq!(count(&s, "SELECT COUNT(*) FROM measurements"), before + 1);
    let (q, src, name) = s
        .conn
        .lock()
        .unwrap()
        .query_row("SELECT quality, source_type, source_name FROM measurements ORDER BY id DESC LIMIT 1", [], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))
        .unwrap();
    assert_eq!((q.as_str(), src.as_str(), name.as_str()), ("ok", "manual", "Atlas assistant"));

    // a token works once
    let (again, _) = atlas::run_confirm(&s, &ConfirmIn { token, approve: true }).await;
    assert_eq!(again.as_u16(), 404);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM measurements"), before + 1);
}

#[tokio::test]
async fn declining_discards_the_write() {
    let s = state("decline");
    let before = count(&s, "SELECT COUNT(*) FROM astronauts");
    let (cfg, _) = fake_model(&[&reply("Okay, I'll add astronaut Sara.", "en", json!({"name": "add_astronaut", "args": {"name": "Sara", "setting": "station"}}))]).await;
    let (_, body) = ask(&s, &cfg, "add a new astronaut named Sara in a space station", None).await;
    assert_eq!(body["status"], "needs_confirmation", "{body}");
    let token = body["confirm"]["token"].as_str().unwrap().to_string();
    let (_, no) = atlas::run_confirm(&s, &ConfirmIn { token: token.clone(), approve: false }).await;
    assert_eq!(no["status"], "cancelled");
    assert_eq!(count(&s, "SELECT COUNT(*) FROM astronauts"), before);
    let (code, _) = atlas::run_confirm(&s, &ConfirmIn { token, approve: true }).await;
    assert_eq!(code.as_u16(), 404, "a declined token cannot be reused");
}

#[tokio::test]
async fn a_guessed_token_does_nothing() {
    let s = state("guess");
    let (code, body) = atlas::run_confirm(&s, &ConfirmIn { token: "0".repeat(32), approve: true }).await;
    assert_eq!(code.as_u16(), 404, "{body}");
}

#[tokio::test]
async fn an_astronaut_cannot_touch_another_astronauts_alert() {
    use tower::ServiceExt;
    let s = state("owner");
    {
        let c = s.conn.lock().unwrap();
        c.execute("INSERT INTO astronauts (display_name,is_synthetic,mission_setting) VALUES ('Second',1,'station')", []).unwrap();
    }
    // an out-of-range heart rate for astronaut 1 raises an alert that belongs to astronaut 1
    let req = axum::http::Request::builder()
        .method("POST")
        .uri("/api/measurements")
        .header("content-type", "application/json")
        .body(axum::body::Body::from(json!({"astronaut_id": 1, "indicator_code": "heart_rate", "value": 190, "source_type": "manual"}).to_string()))
        .unwrap();
    let resp = api::router(s.clone()).oneshot(req).await.unwrap();
    assert_eq!(resp.status().as_u16(), 201);
    let alert_id = count(&s, "SELECT id FROM alerts WHERE astronaut_id=1 ORDER BY id LIMIT 1");

    let script = reply("ok", "en", json!({"name": "acknowledge_alert", "args": {"alert_id": alert_id.to_string()}}));
    let (cfg, _) = fake_model(&[&script, &script]).await;
    // as astronaut 2: refused before anything is parked
    let (_, body) = ask(&s, &cfg, &format!("acknowledge alert number {alert_id}"), Some(2)).await;
    assert_eq!(body["status"], "error", "{body}");
    assert!(body["error"].as_str().unwrap().contains("another astronaut"), "{body}");
    assert!(body.get("confirm").is_none());
    // as the owner: parked, then confirmed
    let (_, body) = ask(&s, &cfg, &format!("acknowledge alert number {alert_id}"), Some(1)).await;
    assert_eq!(body["status"], "needs_confirmation", "{body}");
    let token = body["confirm"]["token"].as_str().unwrap().to_string();
    let (_, done) = atlas::run_confirm(&s, &ConfirmIn { token, approve: true }).await;
    assert_eq!(done["status"], "executed", "{done}");
    assert_eq!(count(&s, &format!("SELECT COUNT(*) FROM alerts WHERE id={alert_id} AND status='acknowledged'")), 1);
}

#[tokio::test]
async fn hostile_model_output_is_stopped_before_anything_runs() {
    let s = state("hostile");
    let before = count(&s, "SELECT COUNT(*) FROM import_log");
    let replies = [
        // path traversal in a file name
        reply("ok", "en", json!({"name": "import_data", "args": {"csv_file": "../../etc/passwd", "mapping": "nasa_map.json"}})),
        // an enum value that is not in the list
        reply("ok", "en", json!({"name": "get_latest", "args": {"indicator": "heart_rate; DROP TABLE measurements"}})),
        // an action that exists but was not offered for this request
        reply("ok", "en", json!({"name": "add_astronaut", "args": {"name": "X", "setting": "station"}})),
        // not JSON at all
        "I will now delete everything".to_string(),
        // extra keys
        r#"{"reply":"x","lang":"en","action":null,"run":"rm -rf /"}"#.to_string(),
    ];
    let refs: Vec<&str> = replies.iter().map(String::as_str).collect();
    let (cfg, _) = fake_model(&refs).await;
    let (_, b) = ask(&s, &cfg, "import the file vitals.csv with mapping nasa_map.json", Some(1)).await;
    assert_eq!(b["status"], "needs_clarification", "{b}");
    assert!(b.get("confirm").is_none(), "no confirmation may be offered for a bad file name");
    for text in ["what's my latest heart rate", "show my alerts", "hello", "list the crew"] {
        let (_, b) = ask(&s, &cfg, text, Some(1)).await;
        assert_eq!(b["status"], "error", "{text}: {b}");
        assert!(b["reply"].as_str().unwrap().len() > 5);
        assert!(b.get("result").is_none() && b.get("confirm").is_none());
    }
    assert_eq!(count(&s, "SELECT COUNT(*) FROM measurements WHERE indicator_code LIKE '%DROP%'"), 0);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM import_log"), before);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM astronauts"), 1);
}

#[tokio::test]
async fn ui_actions_become_frontend_instructions() {
    let s = state("ui");
    {
        let c = s.conn.lock().unwrap();
        c.execute("INSERT INTO astronauts (display_name,is_synthetic,mission_setting) VALUES ('Sara Demo',1,'habitat')", []).unwrap();
    }
    let (cfg, _) = fake_model(&[
        &reply("Sure, opening the measurements page.", "en", json!({"name": "navigate", "args": {"page": "log"}})),
        &reply("Done, switching to dark mode.", "en", json!({"name": "set_theme", "args": {"mode": "dark"}})),
        &reply("Okay, switching to Sara.", "en", json!({"name": "select_astronaut", "args": {"name": "Sara"}})),
        &reply("Okay, switching to Nobody.", "en", json!({"name": "select_astronaut", "args": {"name": "Nobody"}})),
    ])
    .await;
    let (_, b) = ask(&s, &cfg, "take me to the measurements page", Some(1)).await;
    assert_eq!((b["status"].as_str(), b["ui"]["op"].as_str(), b["ui"]["route"].as_str()), (Some("ui"), Some("navigate"), Some("/log")), "{b}");
    let (_, b) = ask(&s, &cfg, "switch to dark mode", None).await;
    assert_eq!((b["status"].as_str(), b["ui"]["op"].as_str(), b["ui"]["args"]["mode"].as_str()), (Some("ui"), Some("set_theme"), Some("dark")), "{b}");
    let (_, b) = ask(&s, &cfg, "switch to astronaut Sara", Some(1)).await;
    assert_eq!(b["status"], "ui", "{b}");
    assert_eq!((b["ui"]["astronaut_id"].as_i64(), b["ui"]["display_name"].as_str()), (Some(2), Some("Sara Demo")));
    let (_, b) = ask(&s, &cfg, "switch to astronaut Nobody", Some(1)).await;
    assert_eq!(b["status"], "error", "{b}");
}

#[tokio::test]
async fn chat_without_an_action_is_just_an_answer() {
    let s = state("chat");
    let (cfg, _) = fake_model(&[&reply("أنا أطلس، كيف أساعدك؟", "ar", Value::Null)]).await;
    let (code, b) = ask(&s, &cfg, "أطلس من أنت؟", None).await;
    assert_eq!((code, b["status"].as_str(), b["reply"].as_str()), (200, Some("chat"), Some("أنا أطلس، كيف أساعدك؟")));
    assert!(b.get("result").is_none() && b.get("confirm").is_none() && b.get("ui").is_none());
}

#[tokio::test]
async fn a_missing_astronaut_gets_a_clear_message_in_the_users_language() {
    let s = state("noaid");
    let (cfg, _) = fake_model(&[&reply("حسناً", "ar", json!({"name": "get_latest", "args": {"indicator": "heart_rate"}}))]).await;
    let (_, b) = ask(&s, &cfg, "كم آخر قراءة لمعدل ضربات القلب", None).await;
    assert_eq!(b["status"], "error", "{b}");
    assert!(b["reply"].as_str().unwrap().contains("رائداً"), "{b}");
    let (code, b) = ask(&s, &cfg, "hello", Some(999)).await;
    assert_eq!(code, 404, "{b}");
}

#[tokio::test]
async fn model_server_down_is_reported_not_swallowed() {
    let s = state("down");
    let cfg = AiConfig { provider: Provider::OpenAi, url: "http://127.0.0.1:9/v1".into(), model: "ai".into(), timeout: Duration::from_secs(2) };
    let (code, b) = ask(&s, &cfg, "hello", None).await;
    assert_eq!(code, 503, "{b}");
    assert_eq!(b["status"], "error");
}

#[tokio::test]
async fn input_limits() {
    let s = state("limits");
    let (cfg, _) = fake_model(&[]).await;
    assert_eq!(ask(&s, &cfg, "   ", None).await.0, 422);
    assert_eq!(ask(&s, &cfg, &"x".repeat(501), None).await.0, 422);
}

#[tokio::test]
async fn http_routes_exist() {
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use tower::ServiceExt;
    let s = state("http");
    let app = api::router(s);
    let get = |uri: &str| Request::builder().uri(uri.to_string()).body(Body::empty()).unwrap();
    let resp = app.clone().oneshot(get("/api/atlas/actions")).await.unwrap();
    assert_eq!(resp.status().as_u16(), 200);
    let v: Value = serde_json::from_slice(&resp.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(v["actions"].as_array().unwrap().len(), 29);
    assert!(v["actions"][0].get("templates").is_none(), "training material must not leak to the frontend");
    let write = v["actions"].as_array().unwrap().iter().find(|a| a["name"] == "log_measurement").unwrap();
    assert_eq!(write["requires_confirmation"], true);
    let resp = app
        .oneshot(Request::builder().method("POST").uri("/api/atlas/confirm").header("content-type", "application/json").body(Body::from(r#"{"token":"nope"}"#)).unwrap())
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 404);
}

// ------------------------------------------------------------------ values must come from the user's words

fn args_of(v: Value) -> Map<String, Value> {
    v.as_object().unwrap().clone()
}

#[test]
fn an_indicator_the_user_did_not_say_is_not_accepted() {
    let r = registry();
    let a = r.get("get_latest").unwrap();
    // the real v2 mistakes seen in evaluation: spo2 asked, glucose answered; systolic asked, diastolic answered
    let e = a.grounded("حلّل اتجاه الأكسجين في الدم", &args_of(json!({"indicator": "glucose"}))).unwrap_err();
    assert_eq!((e.arg.as_str(), e.reason), ("indicator", "conflict"));
    assert!(e.options.iter().any(|o| o.contains("الأكسجين")), "{e:?}");
    assert!(a.grounded("ابغى أعرف ضغط الدم الانقباضي الأخير", &args_of(json!({"indicator": "bp_diastolic"}))).is_err());
    assert!(a.grounded("what's my latest oxygen saturation", &args_of(json!({"indicator": "heart_rate"}))).is_err());
    // the right value passes, in both languages, with Arabic prefixes
    assert!(a.grounded("ابغى أعرف ضغط الدم الانقباضي الأخير", &args_of(json!({"indicator": "bp_systolic"}))).is_ok());
    assert!(a.grounded("كم آخر قراءة لسكر الدم", &args_of(json!({"indicator": "glucose"}))).is_ok());
    assert!(a.grounded("what's my latest blood sugar", &args_of(json!({"indicator": "glucose"}))).is_ok());
}

#[test]
fn a_synonym_the_registry_does_not_know_is_left_alone() {
    let r = registry();
    let a = r.get("get_latest").unwrap();
    // the user named no known form, so there is nothing to contradict
    assert!(a.grounded("how is my ticker doing", &args_of(json!({"indicator": "heart_rate"}))).is_ok());
}

#[test]
fn a_number_the_model_invented_is_refused() {
    let r = registry();
    let a = r.get("log_measurement").unwrap();
    let ok = |t: &str, v: Value| a.grounded(t, &args_of(json!({"indicator": "heart_rate", "value": v})));
    assert!(ok("log heart rate at 70", json!(70.0)).is_ok());
    assert!(ok("سجّل النبض ٧٢", json!(72.0)).is_ok()); // Arabic-Indic digits
    assert!(ok("سجّل النبض 36,6", json!(36.6)).is_ok());
    let e = ok("log heart rate", json!(70.0)).unwrap_err();
    assert_eq!(e.reason, "number");
    assert!(ok("log heart rate at 70", json!(72.0)).is_err());
    let c = r.get("complete_routine").unwrap();
    assert!(c.grounded("تم الروتين رقم 90", &args_of(json!({"routine_id": 90}))).is_ok());
    assert!(c.grounded("تم الروتين رقم 90", &args_of(json!({"routine_id": 9}))).is_err());
}

#[tokio::test]
async fn an_ungrounded_value_becomes_a_question_not_an_action() {
    let s = state("grounded");
    let before = count(&s, "SELECT COUNT(*) FROM measurements");
    let (cfg, _) = fake_model(&[
        &reply("Okay, I'll log heart rate at 99. I need your confirmation.", "en", json!({"name": "log_measurement", "args": {"indicator": "heart_rate", "value": "99"}})),
        &reply("Here is the trend.", "en", json!({"name": "show_trend", "args": {"indicator": "glucose", "period": "week"}})),
    ])
    .await;
    // the number 99 was never said
    let (_, b) = ask(&s, &cfg, "log my heart rate at 70", Some(1)).await;
    assert_eq!(b["status"], "needs_clarification", "{b}");
    assert!(b.get("confirm").is_none(), "no confirmation may be offered for an invented number");
    assert_eq!(count(&s, "SELECT COUNT(*) FROM measurements"), before);
    // blood oxygen asked, blood sugar proposed
    let (_, b) = ask(&s, &cfg, "plot my oxygen saturation over the last week", Some(1)).await;
    assert_eq!(b["status"], "needs_clarification", "{b}");
    assert!(b.get("result").is_none());
}

/// Optional: ATLAS_TEST_JSONL=path/to/atlas_test_v2.jsonl measures how often the grounding check would refuse a
/// CORRECT proposal (the expected answers of the held-out set). It must be rare, because each one costs a question.
#[test]
fn grounding_rarely_refuses_a_correct_proposal() {
    let Some(path) = std::env::var("ATLAS_TEST_JSONL").ok() else { return };
    let r = registry();
    let (mut n, mut refused) = (0, Vec::new());
    for line in std::fs::read_to_string(path).unwrap().lines() {
        let row: Value = serde_json::from_str(line).unwrap();
        if row["kind"] != "action" {
            continue;
        }
        let out: Value = serde_json::from_str(row["assistant"].as_str().unwrap()).unwrap();
        let Some(name) = out["action"]["name"].as_str() else { continue };
        let Some(a) = r.get(name) else { continue };
        let Ok(args) = atlas::clean_args(a, out["action"]["args"].as_object().unwrap()) else { continue };
        n += 1;
        if let Err(e) = a.grounded(row["user"].as_str().unwrap(), &args) {
            refused.push(format!("{} | {name} {} | {e:?}", row["user"].as_str().unwrap(), Value::Object(args)));
        }
    }
    println!("checked {n} correct proposals, refused {}", refused.len());
    for l in refused.iter().take(40) {
        println!("  REFUSED: {l}");
    }
    assert!(refused.len() * 20 <= n, "grounding refuses more than 5% of correct proposals");
}

/// Optional: ATLAS_EVAL_JSON=path/to/atlas_eval_v2.json replays the model's real mistakes from the evaluation and
/// reports how many of the ones that carry a wrong action the grounding check stops.
#[test]
fn grounding_stops_real_model_mistakes() {
    let Some(path) = std::env::var("ATLAS_EVAL_JSON").ok() else { return };
    let r = registry();
    let eval: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let (mut wrong, mut stopped) = (0, 0);
    for f in eval["synthetic"]["failures"].as_array().unwrap() {
        let out: Value = serde_json::from_str(f["output"].as_str().unwrap_or("{}")).unwrap_or(Value::Null);
        let exp: Value = serde_json::from_str(f["expected"].as_str().unwrap_or("{}")).unwrap_or(Value::Null);
        let Some(name) = out["action"]["name"].as_str() else { continue };
        if out["action"] == exp["action"] {
            continue; // right action, wrong language label or wording
        }
        let Some(a) = r.get(name) else { continue };
        wrong += 1;
        let verdict = match atlas::clean_args(a, out["action"]["args"].as_object().unwrap()) {
            Err(_) => "refused by clean_args".to_string(),
            Ok(args) => match a.grounded(f["user"].as_str().unwrap(), &args) {
                Err(e) => format!("stopped: {} {}", e.arg, e.reason),
                Ok(()) => "NOT stopped".to_string(),
            },
        };
        if !verdict.starts_with("NOT") {
            stopped += 1;
        }
        println!("{verdict} | {} | wanted {} got {}", f["user"].as_str().unwrap(), exp["action"], out["action"]);
    }
    println!("wrong proposals in the failure list: {wrong}, stopped before running: {stopped}");
}

#[tokio::test]
async fn a_confirmed_write_uses_the_apps_clock_when_the_app_sent_one() {
    let s = state("clock");
    let (cfg, _) = fake_model(&[
        &reply("ok", "en", json!({"name": "log_measurement", "args": {"indicator": "heart_rate", "value": "70"}})),
        &reply("ok", "en", json!({"name": "log_measurement", "args": {"indicator": "heart_rate", "value": "71"}})),
        &reply("ok", "en", json!({"name": "log_measurement", "args": {"indicator": "glucose", "value": "90"}})),
    ]).await;
    let when = |v: &str| -> String {
        let (code, num) = if v == "90" { ("glucose", 90.0) } else { ("heart_rate", v.parse::<f64>().unwrap()) };
        s.conn.lock().unwrap().query_row("SELECT measured_at FROM measurements WHERE astronaut_id=1 AND indicator_code=?1 AND value=?2", rusqlite::params![code, num], |r| r.get(0)).unwrap()
    };
    // with a clock: the measurement is stamped with it (offset forms are normalised to UTC)
    let (code, body) = atlas::run_command(&s, &cfg, &CommandIn { message: "log heart rate at 70".into(), astronaut_id: Some(1), at: Some("2026-11-13T08:46:00.000Z".into()) }).await;
    assert_eq!(code.as_u16(), 200, "{body}");
    let token = body["confirm"]["token"].as_str().unwrap().to_string();
    let (_, done) = atlas::run_confirm(&s, &ConfirmIn { token, approve: true }).await;
    assert_eq!(done["status"], "executed", "{done}");
    assert_eq!(when("70"), "2026-11-13T08:46:00Z");
    // garbage is ignored, not trusted: the server's own clock is used
    let (_, body) = atlas::run_command(&s, &cfg, &CommandIn { message: "log heart rate at 71".into(), astronaut_id: Some(1), at: Some("yesterday; DROP TABLE".into()) }).await;
    let token = body["confirm"]["token"].as_str().unwrap().to_string();
    atlas::run_confirm(&s, &ConfirmIn { token, approve: true }).await;
    assert!(when("71").as_str() >= "2026-11-15", "{}", when("71"));
    // no clock at all: same
    let (_, body) = atlas::run_command(&s, &cfg, &CommandIn { message: "log glucose at 90".into(), astronaut_id: Some(1), at: None }).await;
    let token = body["confirm"]["token"].as_str().unwrap().to_string();
    atlas::run_confirm(&s, &ConfirmIn { token, approve: true }).await;
    assert!(when("90").as_str() >= "2026-11-15");
}
