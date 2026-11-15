//! ASTRA command line: serve | seed | import | inspect
use astra_rs::{adapter, api, db, logic, seed};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const USAGE: &str = "ASTRA backend (Rust)

USAGE (run from the project folder):
  astra-rs serve [--port 8000] [--host 127.0.0.1]   start the API (/api) and the HTML front end (./static)
  astra-rs seed                                     load the demo story (history.raw.json, labelled simulated)
  astra-rs inspect <file.csv>                       show columns / types / blanks of a CSV
  astra-rs import <file.csv> <mapping.json> [--dry-run]
                                                    clean a CSV and load it (--dry-run: report only)

Env: ASTRA_DB (default data/astra.db), PORT, ASTRA_HOST";

fn db_path() -> String {
    std::env::var("ASTRA_DB").unwrap_or_else(|_| "data/astra.db".into())
}

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn die(msg: impl std::fmt::Display) -> ! {
    eprintln!("error: {msg}");
    std::process::exit(1)
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("serve") | None => {
            let conn = db::open(&db_path()).unwrap_or_else(|e| die(e));
            if seed::is_empty(&conn).unwrap_or_else(|e| die(e)) {
                println!("First start: loading the demo story and the ISS cabin data. This runs once.");
                let s = seed::first_run(&conn, Path::new(".")).unwrap_or_else(|e| die(e));
                println!("{}", seed::first_run_summary(&s));
            }
            let state = Arc::new(api::AppState { conn: Mutex::new(conn), base: PathBuf::from(".") });
            let host = flag(&args, "--host").or_else(|| std::env::var("ASTRA_HOST").ok()).unwrap_or_else(|| "127.0.0.1".into());
            let port = flag(&args, "--port").or_else(|| std::env::var("PORT").ok()).unwrap_or_else(|| "8000".into());
            let listener = tokio::net::TcpListener::bind(format!("{host}:{port}")).await.unwrap_or_else(|e| die(e));
            println!("ASTRA on http://{host}:{port}   API: /api/health   front end: ./static");
            axum::serve(listener, api::router(state)).await.unwrap_or_else(|e| die(e));
        }
        Some("seed") => {
            let conn = db::open(&db_path()).unwrap_or_else(|e| die(e));
            println!("{}", seed::seed(&conn).unwrap_or_else(|e| die(e)));
        }
        Some("inspect") => {
            let f = args.get(1).unwrap_or_else(|| die("usage: astra-rs inspect <file.csv>"));
            print!("{}", adapter::inspect(Path::new(f)).unwrap_or_else(|e| die(e)));
        }
        Some("import") => {
            let (csv, map) = match (args.get(1), args.get(2)) {
                (Some(c), Some(m)) => (c, m),
                _ => die("usage: astra-rs import <file.csv> <mapping.json> [--dry-run]"),
            };
            let conn = db::open(&db_path()).unwrap_or_else(|e| die(e));
            let mapping = adapter::load_mapping(Path::new(map)).unwrap_or_else(|e| die(e));
            let report = if args.iter().any(|a| a == "--dry-run") {
                adapter::dry_run(&conn, Path::new(csv), &mapping).unwrap_or_else(|e| die(e))
            } else {
                let mut r = adapter::import_csv(&conn, Path::new(csv), &mapping, Some(Path::new("data/clean"))).unwrap_or_else(|e| die(e));
                r["new_alerts"] = serde_json::json!(logic::evaluate_all(&conn).unwrap_or_else(|e| die(e)));
                r
            };
            println!("{}", serde_json::to_string_pretty(&report).unwrap_or_default());
        }
        _ => println!("{USAGE}"),
    }
}
