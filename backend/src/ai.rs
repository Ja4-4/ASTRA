//! ASTRA "ai" — the local assistant, backed by Qwen2.5-0.5B served on this machine.
//!
//! The model is NOT embedded in the binary: it runs in Ollama or LM Studio (both already hold the
//! downloaded weights) and this module talks to that local server over HTTP. Nothing leaves the
//! computer. The model is registered under the name `ai` (see ai/Modelfile), so the code and the
//! config only ever say "ai".
//!
//! Endpoints (mounted under /api):
//!   GET  /ai/status   is the model server reachable, is the model installed
//!   POST /ai/chat     {message | messages[], astronaut_id?, temperature?, max_tokens?} -> {reply, ...}
//!
//! Guide rules kept: missing data is "not available" (the prompt forbids inventing values), the
//! astronaut context is read from the database and labelled with its source type, and every reply
//! carries a disclaimer. A 0.5B model is small and WILL make mistakes: it explains the data it is
//! given, it never diagnoses, and the numbers on screen remain the source of truth.
//!
//! Config (environment, all optional):
//!   ASTRA_AI_PROVIDER   ollama (default) | openai   (openai = LM Studio or any OpenAI-compatible server)
//!   ASTRA_AI_URL        ollama: http://127.0.0.1:11434   openai: http://127.0.0.1:1234/v1
//!   ASTRA_AI_MODEL      default "ai"
//!   ASTRA_AI_TIMEOUT_S  default 120
use crate::{api::Shared, db::rows};
use axum::{
    extract::State,
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use rusqlite::{params, Connection};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::{Duration, Instant};

pub const DEFAULT_MODEL: &str = "ai";
const DISCLAIMER: &str = "Small local model (Qwen2.5-0.5B). It can be wrong. Not a diagnosis and not a substitute for the flight surgeon.";
const MAX_MESSAGES: usize = 20;
const MAX_CHARS: usize = 4000;
const SYSTEM_PROMPT: &str = "You are ASTRA's assistant for astronaut health monitoring (demo project). \
Reply in the same language the user writes in (Arabic or English), briefly and clearly. \
Use ONLY the data given in the CONTEXT block. If a value is not there, say \"not available\" and never invent numbers. \
You are not a doctor: do not diagnose and do not prescribe. For anything that looks urgent, tell the user to contact the flight surgeon.";

#[derive(Clone, Debug, PartialEq)]
pub enum Provider {
    Ollama,
    OpenAi,
}

#[derive(Clone, Debug)]
pub struct AiConfig {
    pub provider: Provider,
    pub url: String,
    pub model: String,
    pub timeout: Duration,
}

impl AiConfig {
    pub fn from_env() -> Self {
        let get = |k: &str| std::env::var(k).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        let provider = match get("ASTRA_AI_PROVIDER").map(|p| p.to_lowercase()).as_deref() {
            Some("openai") | Some("lmstudio") | Some("lm-studio") => Provider::OpenAi,
            _ => Provider::Ollama,
        };
        let default_url = match provider {
            Provider::Ollama => "http://127.0.0.1:11434",
            Provider::OpenAi => "http://127.0.0.1:1234/v1",
        };
        AiConfig {
            provider,
            url: get("ASTRA_AI_URL").unwrap_or_else(|| default_url.into()).trim_end_matches('/').to_string(),
            model: get("ASTRA_AI_MODEL").unwrap_or_else(|| DEFAULT_MODEL.into()),
            timeout: Duration::from_secs(get("ASTRA_AI_TIMEOUT_S").and_then(|v| v.parse().ok()).unwrap_or(120)),
        }
    }

    pub fn provider_name(&self) -> &'static str {
        match self.provider {
            Provider::Ollama => "ollama",
            Provider::OpenAi => "openai-compatible (LM Studio)",
        }
    }

    fn models_url(&self) -> String {
        match self.provider {
            Provider::Ollama => format!("{}/api/tags", self.url),
            Provider::OpenAi => format!("{}/models", self.url),
        }
    }

    fn chat_url(&self) -> String {
        match self.provider {
            Provider::Ollama => format!("{}/api/chat", self.url),
            Provider::OpenAi => format!("{}/chat/completions", self.url),
        }
    }
}

#[derive(Deserialize, Clone, Debug)]
pub struct Msg {
    pub role: String,
    pub content: String,
}

#[derive(Deserialize)]
struct ChatIn {
    message: Option<String>,
    #[serde(default)]
    messages: Vec<Msg>,
    astronaut_id: Option<i64>,
    temperature: Option<f64>,
    max_tokens: Option<u32>,
}

pub struct AiError(StatusCode, String);
impl axum::response::IntoResponse for AiError {
    fn into_response(self) -> axum::response::Response {
        (self.0, Json(json!({ "detail": self.1 }))).into_response()
    }
}
impl AiError {
    pub fn detail(&self) -> &str {
        &self.1
    }
}
fn err(code: StatusCode, msg: impl Into<String>) -> AiError {
    AiError(code, msg.into())
}

// ---------- conversation + context ----------

/// Keep only user/assistant turns (a client may not inject its own system prompt), bounded in count and size.
pub fn clean_messages(message: Option<&str>, messages: &[Msg]) -> Result<Vec<Msg>, String> {
    let mut out: Vec<Msg> = messages
        .iter()
        .filter(|m| m.role == "user" || m.role == "assistant")
        .map(|m| Msg { role: m.role.clone(), content: m.content.trim().to_string() })
        .filter(|m| !m.content.is_empty())
        .collect();
    if let Some(m) = message.map(str::trim).filter(|m| !m.is_empty()) {
        out.push(Msg { role: "user".into(), content: m.to_string() });
    }
    if out.last().map(|m| m.role.as_str()) != Some("user") {
        return Err("send a non-empty 'message' (or a 'messages' list that ends with a user turn)".into());
    }
    if out.len() > MAX_MESSAGES {
        out.drain(..out.len() - MAX_MESSAGES);
    }
    if out.iter().any(|m| m.content.chars().count() > MAX_CHARS) {
        return Err(format!("a message is longer than {MAX_CHARS} characters"));
    }
    Ok(out)
}

/// Latest value per indicator + open alerts for one astronaut, as plain text for the prompt.
/// Returns None when the astronaut does not exist.
pub fn astronaut_context(conn: &Connection, aid: i64) -> rusqlite::Result<Option<String>> {
    let a = rows(conn, "SELECT display_name, mission_setting, is_synthetic FROM astronauts WHERE id=?1", params![aid])?;
    let Some(a) = a.into_iter().next() else { return Ok(None) };
    let mut s = format!(
        "Astronaut: {} (mission setting: {}, {})\n",
        a["display_name"].as_str().unwrap_or("?"),
        a["mission_setting"].as_str().unwrap_or("?"),
        if a["is_synthetic"].as_i64() == Some(1) { "synthetic demo data" } else { "data source: see each line" }
    );
    let latest = rows(
        conn,
        "SELECT i.name AS name, m.value AS value, m.unit AS unit, m.measured_at AS at, m.source_type AS src \
         FROM measurements m JOIN indicators i ON i.code = m.indicator_code \
         WHERE m.astronaut_id=?1 AND m.value IS NOT NULL \
           AND m.measured_at = (SELECT MAX(measured_at) FROM measurements \
                                WHERE astronaut_id=m.astronaut_id AND indicator_code=m.indicator_code AND value IS NOT NULL) \
         GROUP BY m.indicator_code ORDER BY i.category, i.code",
        params![aid],
    )?;
    if latest.is_empty() {
        s.push_str("Latest measurements: not available\n");
    } else {
        s.push_str("Latest measurements:\n");
        for r in &latest {
            s.push_str(&format!(
                "- {}: {} {} (at {}, source: {})\n",
                r["name"].as_str().unwrap_or("?"),
                r["value"],
                r["unit"].as_str().unwrap_or(""),
                r["at"].as_str().unwrap_or("?"),
                r["src"].as_str().unwrap_or("?")
            ));
        }
    }
    let alerts = rows(
        conn,
        "SELECT severity, explanation, triggered_at FROM alerts WHERE astronaut_id=?1 AND status='open' ORDER BY triggered_at DESC LIMIT 5",
        params![aid],
    )?;
    if alerts.is_empty() {
        s.push_str("Open alerts: none\n");
    } else {
        s.push_str("Open alerts:\n");
        for r in &alerts {
            s.push_str(&format!(
                "- [{}] {} ({})\n",
                r["severity"].as_str().unwrap_or("?"),
                r["explanation"].as_str().unwrap_or("?"),
                r["triggered_at"].as_str().unwrap_or("?")
            ));
        }
    }
    Ok(Some(s))
}

/// System prompt (+ CONTEXT block when there is one) followed by the conversation.
pub fn build_prompt(context: Option<&str>, turns: &[Msg]) -> Vec<Msg> {
    let system = match context {
        Some(c) => format!("{SYSTEM_PROMPT}\n\nCONTEXT:\n{c}"),
        None => format!("{SYSTEM_PROMPT}\n\nCONTEXT:\nno astronaut selected; no data available"),
    };
    let mut v = vec![Msg { role: "system".into(), content: system }];
    v.extend(turns.iter().cloned());
    v
}

// ---------- talking to the local model server ----------

fn client(cfg: &AiConfig) -> Result<reqwest::Client, AiError> {
    reqwest::Client::builder()
        .timeout(cfg.timeout)
        .connect_timeout(Duration::from_secs(3))
        .build()
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

fn unreachable(cfg: &AiConfig, e: &reqwest::Error) -> AiError {
    let how = match cfg.provider {
        Provider::Ollama => "start Ollama (it listens on port 11434) and run: ollama create ai -f ai/Modelfile",
        Provider::OpenAi => "start the LM Studio local server (Developer tab) and load the model with identifier \"ai\"",
    };
    err(
        StatusCode::SERVICE_UNAVAILABLE,
        format!("the AI model server at {} is not reachable ({e}). To fix: {how}", cfg.url),
    )
}

/// Model names the server reports. Ollama may add a ":latest" tag, which is ignored when matching.
pub fn extract_model_names(provider: &Provider, body: &Value) -> Vec<String> {
    let list = match provider {
        Provider::Ollama => body["models"].as_array().map(|a| a.iter().filter_map(|m| m["name"].as_str()).collect::<Vec<_>>()),
        Provider::OpenAi => body["data"].as_array().map(|a| a.iter().filter_map(|m| m["id"].as_str()).collect::<Vec<_>>()),
    };
    list.unwrap_or_default().into_iter().map(String::from).collect()
}

pub fn model_installed(names: &[String], wanted: &str) -> bool {
    names.iter().any(|n| n == wanted || n.strip_suffix(":latest") == Some(wanted))
}

pub async fn status(cfg: &AiConfig) -> Value {
    let mut out = json!({"provider": cfg.provider_name(), "url": cfg.url, "model": cfg.model, "name": DEFAULT_MODEL,
                         "base_model": "Qwen2.5-0.5B", "reachable": false, "model_installed": false, "models": []});
    let Ok(c) = client(cfg) else { return out };
    match c.get(cfg.models_url()).send().await {
        Ok(r) if r.status().is_success() => {
            let body: Value = r.json().await.unwrap_or(Value::Null);
            let names = extract_model_names(&cfg.provider, &body);
            let installed = model_installed(&names, &cfg.model);
            out["reachable"] = json!(true);
            out["model_installed"] = json!(installed);
            if !installed {
                out["hint"] = json!(format!("model '{0}' not found on the server; Ollama: ollama create {0} -f ai/Modelfile", cfg.model));
            }
            out["models"] = json!(names);
        }
        Ok(r) => out["hint"] = json!(format!("server answered HTTP {}", r.status())),
        Err(e) => out["hint"] = json!(unreachable(cfg, &e).1),
    }
    out
}

/// One non-streaming chat completion. Returns the reply text.
pub async fn complete(cfg: &AiConfig, prompt: &[Msg], temperature: f64, max_tokens: u32) -> Result<String, AiError> {
    let msgs: Vec<Value> = prompt.iter().map(|m| json!({"role": m.role, "content": m.content})).collect();
    let body = match cfg.provider {
        Provider::Ollama => json!({"model": cfg.model, "messages": msgs, "stream": false,
                                   "options": {"temperature": temperature, "num_predict": max_tokens}}),
        Provider::OpenAi => json!({"model": cfg.model, "messages": msgs, "stream": false,
                                   "temperature": temperature, "max_tokens": max_tokens}),
    };
    let resp = client(cfg)?.post(cfg.chat_url()).json(&body).send().await.map_err(|e| unreachable(cfg, &e))?;
    let status = resp.status();
    let v: Value = resp.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        let why = v["error"]["message"].as_str().or_else(|| v["error"].as_str()).unwrap_or("no details");
        return Err(err(StatusCode::BAD_GATEWAY, format!("model server returned HTTP {status}: {why}")));
    }
    let reply = match cfg.provider {
        Provider::Ollama => v["message"]["content"].as_str(),
        Provider::OpenAi => v["choices"][0]["message"]["content"].as_str(),
    };
    reply
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .ok_or_else(|| err(StatusCode::BAD_GATEWAY, "model server returned an empty reply"))
}

// ---------- HTTP ----------

async fn status_route() -> Json<Value> {
    Json(status(&AiConfig::from_env()).await)
}

async fn chat_route(State(s): State<Shared>, Json(inp): Json<ChatIn>) -> Result<Json<Value>, AiError> {
    let cfg = AiConfig::from_env();
    let turns = clean_messages(inp.message.as_deref(), &inp.messages).map_err(|m| err(StatusCode::UNPROCESSABLE_ENTITY, m))?;
    // Build the context in a short sync block: the DB guard must not be held across an await.
    let context = match inp.astronaut_id {
        None => None,
        Some(aid) => {
            let c = s.conn.lock().unwrap_or_else(|e| e.into_inner());
            Some(
                astronaut_context(&c, aid)
                    .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
                    .ok_or_else(|| err(StatusCode::NOT_FOUND, format!("astronaut {aid} not found")))?,
            )
        }
    };
    let prompt = build_prompt(context.as_deref(), &turns);
    let t0 = Instant::now();
    let reply = complete(&cfg, &prompt, inp.temperature.unwrap_or(0.3).clamp(0.0, 1.5), inp.max_tokens.unwrap_or(400).clamp(16, 2048)).await?;
    Ok(Json(json!({
        "reply": reply, "model": cfg.model, "provider": cfg.provider_name(),
        "astronaut_id": inp.astronaut_id, "context_used": context.is_some(),
        "elapsed_ms": t0.elapsed().as_millis() as u64, "disclaimer": DISCLAIMER,
    })))
}

/// Mounted under /api by the main router.
pub fn api_routes() -> Router<Shared> {
    Router::new().route("/ai/status", get(status_route)).route("/ai/chat", post(chat_route))
}
