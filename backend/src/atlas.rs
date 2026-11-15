//! ASTRA "atlas": the action-capable assistant.
//!
//! The fine-tuned Atlas model (Qwen2.5-0.5B + LoRA) answers with ONE JSON object:
//!   {"reply": str, "lang": "ar"|"en"|"both", "action": null | {"name": str, "args": {..}}}
//! This module turns such an action into a real backend call, safely:
//!
//!   * The model never touches the database or the network. Its action is only a *proposal*.
//!   * Every proposal is validated against the registry (ai/atlas_actions.json): known action, exact argument
//!     names, enum values from the list, numbers parsed, file names plain, text bounded. Argument values are
//!     treated as untrusted user text.
//!   * Only actions that are in the registry can run, and only through the same router the normal API uses
//!     (`api::internal_router`), so Atlas can do exactly what the API already allows and nothing else.
//!   * kind=read   runs at once.
//!     kind=write  is parked behind a one-time confirmation token (2 minutes). Nothing is written until the
//!                 user confirms with POST /api/atlas/confirm.
//!     kind=ui     is handed back to the frontend as an instruction ({"op": ...}); the backend changes nothing.
//!   * The astronaut id always comes from the request, never from the model, and actions on a numbered alert,
//!     routine or event check that the row belongs to that astronaut.
//!   * Every executed or confirmed action is appended to data/atlas_audit.jsonl.
//!
//! Endpoints (under /api):
//!   GET  /atlas/status    registry + model server status
//!   GET  /atlas/actions   what Atlas can do (for the frontend)
//!   POST /atlas/command   {message, astronaut_id?}  -> reply + (result | confirm | ui)
//!   POST /atlas/confirm   {token, approve?}         -> runs or cancels a parked write
//!
//! Env: ASTRA_ATLAS_REGISTRY (default <base>/ai/atlas_actions.json); the model server is configured like the
//! `ai` module (ASTRA_AI_PROVIDER / ASTRA_AI_URL / ASTRA_AI_MODEL).
use crate::{
    ai::{self, AiConfig, Msg},
    api::{self, Shared},
    logic,
};
use axum::{
    body::Body,
    extract::State,
    http::{Request, StatusCode},
    routing::{get, post},
    Json, Router,
};
use rusqlite::params;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::hash::{BuildHasher, Hasher};
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tower::ServiceExt;

pub const RULES: &str = "You are Atlas (أطلس), a bilingual Arabic-English assistant. \
Reply in the language the user writes in, unless the user asks for Arabic, English, or both. \
Output exactly one JSON object and nothing else: {\"reply\": string, \"lang\": \"ar\" | \"en\" | \"both\", \
\"action\": null | {\"name\": string, \"args\": object}}. \
Set action only when the user asks for something in the available actions list, copying text arguments from the user; \
if a required argument is missing, ask for it and set action to null; \
if the request is not in the list, say you cannot do it and set action to null. \
For health questions give general information only, explain uncertainty, never diagnose or prescribe personal doses, \
and send urgent symptoms to emergency care.";

const DISCLAIMER: &str = "Small local model (Qwen2.5-0.5B). It can be wrong, so every change to data needs your confirmation. Not a diagnosis.";
const MAX_CANDIDATES: usize = 5;
const CONFIRM_TTL: Duration = Duration::from_secs(120);
const MAX_PENDING: usize = 100;
const MAX_MESSAGE_CHARS: usize = 500;
const MAX_TEXT_ARG: usize = 120;
const MAX_RESULT_BYTES: usize = 4 * 1024 * 1024;
const NEVER_PATHS: [&str; 3] = ["/api/atlas", "/api/ai", "/api/eye/analyze"];

// ======================================================================= registry

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind {
    Read,
    Write,
    Ui,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Kind::Read => "read",
            Kind::Write => "write",
            Kind::Ui => "ui",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ArgType {
    Plain,
    Number,
    Int,
    Filename,
}

#[derive(Clone, Debug)]
pub enum ArgKind {
    Enum(Vec<String>),
    Text(ArgType),
}

#[derive(Clone, Debug)]
pub struct Action {
    pub name: String,
    pub kind: Kind,
    pub description: String,
    pub args: Vec<(String, ArgKind)>,
    pub exec: Option<Value>,
    pub ui: Option<Value>,
    keywords: Vec<String>, // normalised phrases
    vocab: HashSet<String>,
    /// per enum argument: each allowed value with the surface forms (both languages) a user would say for it
    enum_forms: Vec<(String, Vec<(String, Vec<String>)>)>,
    /// number / whole-number arguments, whose value must appear in the user's own words
    numeric_args: Vec<String>,
}

/// Why a proposed argument was not accepted as coming from what the user said.
#[derive(Debug, Clone, PartialEq)]
pub struct Ungrounded {
    pub arg: String,
    pub reason: &'static str, // "conflict" | "number"
    pub options: Vec<String>, // what the user did say (surface forms) for "conflict"
}

#[derive(Clone, Debug)]
pub struct Registry {
    pub version: i64,
    pub actions: Vec<Action>,
    idf: HashMap<String, f64>,
}

pub fn registry_path(base: &Path) -> std::path::PathBuf {
    match std::env::var("ASTRA_ATLAS_REGISTRY").ok().filter(|v| !v.trim().is_empty()) {
        Some(p) => p.into(),
        None => base.join("ai/atlas_actions.json"),
    }
}

pub fn load_registry(path: &Path) -> Result<Registry, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    parse_registry(&text)
}

pub fn parse_registry(text: &str) -> Result<Registry, String> {
    let root: Value = serde_json::from_str(text).map_err(|e| format!("registry is not valid JSON: {e}"))?;
    let list = root["actions"].as_array().ok_or("registry has no 'actions' list")?;
    let mut actions = Vec::new();
    for a in list {
        actions.push(parse_action(a)?);
    }
    let mut names = HashSet::new();
    if let Some(dup) = actions.iter().find(|a| !names.insert(a.name.clone())) {
        return Err(format!("duplicate action name '{}'", dup.name));
    }
    // inverse document frequency of each vocabulary token across actions
    let mut df: HashMap<String, usize> = HashMap::new();
    for a in &actions {
        for t in &a.vocab {
            *df.entry(t.clone()).or_default() += 1;
        }
    }
    let n = actions.len().max(1) as f64;
    let idf = df.into_iter().map(|(t, c)| (t, (1.0 + n / c as f64).ln())).collect();
    Ok(Registry { version: root["version"].as_i64().unwrap_or(0), actions, idf })
}

fn parse_action(a: &Value) -> Result<Action, String> {
    let name = a["name"].as_str().filter(|n| !n.is_empty()).ok_or("an action has no name")?.to_string();
    let bad = |m: &str| format!("action '{name}': {m}");
    let kind = match a["kind"].as_str() {
        Some("read") => Kind::Read,
        Some("write") => Kind::Write,
        Some("ui") => Kind::Ui,
        _ => return Err(bad("kind must be read, write or ui")),
    };
    let mut args = Vec::new();
    for (an, spec) in a["args"].as_object().ok_or_else(|| bad("args must be an object"))? {
        let k = match spec["kind"].as_str() {
            Some("enum") => {
                let vals: Vec<String> = spec["values"].as_object().ok_or_else(|| bad("enum without values"))?.keys().cloned().collect();
                if vals.is_empty() {
                    return Err(bad("enum without values"));
                }
                ArgKind::Enum(vals)
            }
            Some("text") => ArgKind::Text(match spec["type"].as_str() {
                None => ArgType::Plain,
                Some("number") => ArgType::Number,
                Some("int") => ArgType::Int,
                Some("filename") => ArgType::Filename,
                Some(t) => return Err(bad(&format!("unknown arg type '{t}'"))),
            }),
            _ => return Err(bad("arg kind must be enum or text")),
        };
        args.push((an.clone(), k));
    }
    let exec = a.get("exec").cloned();
    let ui = a.get("ui").cloned();
    match kind {
        Kind::Ui => {
            if ui.is_none() {
                return Err(bad("a ui action needs a 'ui' block"));
            }
        }
        Kind::Read | Kind::Write => {
            let e = exec.as_ref().ok_or_else(|| bad("needs an 'exec' block"))?;
            let method = e["method"].as_str().unwrap_or("");
            if kind == Kind::Write && method != "POST" {
                return Err(bad("a write action must use POST"));
            }
            if kind == Kind::Read && method != "GET" {
                return Err(bad("a read action must use GET"));
            }
            let path = e["path"].as_str().unwrap_or("");
            if !path.starts_with("/api/") || path.contains("..") || NEVER_PATHS.iter().any(|p| path.starts_with(p)) {
                return Err(bad("exec.path is not allowed"));
            }
            let known: HashSet<&str> = args.iter().map(|(n, _)| n.as_str()).collect();
            let mut texts: Vec<&str> = vec![path];
            for key in ["query", "body"] {
                if let Some(o) = e[key].as_object() {
                    texts.extend(o.values().filter_map(Value::as_str));
                }
            }
            for t in texts {
                for p in placeholders(t) {
                    if !(p == "$astronaut" || known.contains(p.as_str())) {
                        return Err(bad(&format!("placeholder {{{p}}} is not an argument")));
                    }
                }
            }
        }
    }
    // retrieval vocabulary: description, templates, enum surface forms, missing phrases and keywords
    let mut vocab = HashSet::new();
    let mut phrases = Vec::new();
    let feed = |s: &str, vocab: &mut HashSet<String>| {
        for t in tokens(&strip_placeholders(s)) {
            vocab.insert(t);
        }
    };
    feed(a["description"].as_str().unwrap_or(""), &mut vocab);
    for list in a["templates"].as_object().into_iter().flat_map(|m| m.values()).filter_map(Value::as_array) {
        for s in list.iter().filter_map(Value::as_str) {
            feed(s, &mut vocab);
        }
    }
    for spec in a["args"].as_object().into_iter().flat_map(|m| m.values()) {
        for forms in spec["values"].as_object().into_iter().flat_map(|m| m.values()) {
            for list in forms.as_object().into_iter().flat_map(|m| m.values()).filter_map(Value::as_array) {
                for s in list.iter().filter_map(Value::as_str) {
                    feed(s, &mut vocab);
                }
            }
        }
    }
    for list in a["missing"].as_object().into_iter().flat_map(|m| m.values()).filter_map(Value::as_array) {
        for s in list.iter().filter_map(Value::as_str) {
            feed(s, &mut vocab);
        }
    }
    for list in a["keywords"].as_object().into_iter().flat_map(|m| m.values()).filter_map(Value::as_array) {
        for s in list.iter().filter_map(Value::as_str) {
            feed(s, &mut vocab);
            phrases.push(norm(s));
        }
    }
    // numbers say nothing about which action is meant
    vocab.retain(|t| !t.chars().all(|c| c.is_ascii_digit()));
    let mut enum_forms = Vec::new();
    for (an, spec) in a["args"].as_object().into_iter().flatten() {
        if spec["kind"].as_str() != Some("enum") {
            continue;
        }
        let mut values = Vec::new();
        for (val, forms) in spec["values"].as_object().into_iter().flatten() {
            let list: Vec<String> = forms
                .as_object()
                .into_iter()
                .flat_map(|m| m.values())
                .filter_map(Value::as_array)
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect();
            values.push((val.clone(), list));
        }
        enum_forms.push((an.clone(), values));
    }
    let numeric_args = args.iter().filter(|(_, k)| matches!(k, ArgKind::Text(ArgType::Number | ArgType::Int))).map(|(n, _)| n.clone()).collect();
    Ok(Action { name, kind, description: a["description"].as_str().unwrap_or("").to_string(), args, exec, ui, keywords: phrases, vocab, enum_forms, numeric_args })
}

fn placeholders(t: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = t;
    while let Some(i) = rest.find('{') {
        let Some(j) = rest[i..].find('}') else { break };
        out.push(rest[i + 1..i + j].to_string());
        rest = &rest[i + j + 1..];
    }
    out
}

fn strip_placeholders(t: &str) -> String {
    let mut out = String::new();
    let mut depth = 0;
    for c in t.chars() {
        match c {
            '{' => depth += 1,
            '}' if depth > 0 => depth -= 1,
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    out
}

// ======================================================================= prompt (port of atlas_common.py)

fn signature(k: &ArgKind) -> String {
    match k {
        ArgKind::Enum(v) => v.join("|"),
        ArgKind::Text(_) => "text".into(),
    }
}

pub fn action_line(a: &Action) -> String {
    let args: Vec<String> = a.args.iter().map(|(n, k)| format!("{n}: {}", signature(k))).collect();
    format!("- {}({}): {}", a.name, args.join(", "), a.description)
}

pub fn build_system(actions: &[&Action]) -> String {
    let lines = if actions.is_empty() { "- (none)".to_string() } else { actions.iter().map(|a| action_line(a)).collect::<Vec<_>>().join("\n") };
    format!("{RULES}\nAvailable actions:\n{lines}")
}

// ======================================================================= reply parsing (port of parse_reply)

#[derive(Debug, Clone, PartialEq)]
pub struct Parsed {
    pub reply: String,
    pub lang: String,
    pub action: Option<(String, Map<String, Value>)>,
}

/// Parse and validate a model reply. `offered` are the actions that were in the prompt: anything else is refused.
pub fn parse_reply(text: &str, offered: &[&Action]) -> Result<Parsed, String> {
    let start = text.find('{').ok_or("no JSON object")?;
    let data: Value = match serde_json::Deserializer::from_str(&text[start..]).into_iter::<Value>().next() {
        Some(Ok(v)) => v,
        Some(Err(e)) => return Err(format!("invalid JSON: {e}")),
        None => return Err("no JSON object".into()),
    };
    let obj = data.as_object().ok_or("wrong keys")?;
    let keys: HashSet<&str> = obj.keys().map(String::as_str).collect();
    if keys != HashSet::from(["reply", "lang", "action"]) {
        return Err("wrong keys".into());
    }
    let (Some(reply), Some(lang)) = (obj["reply"].as_str(), obj["lang"].as_str()) else { return Err("wrong reply/lang".into()) };
    if !["ar", "en", "both"].contains(&lang) {
        return Err("wrong reply/lang".into());
    }
    let action = match &obj["action"] {
        Value::Null => None,
        Value::Object(a) => {
            let keys: HashSet<&str> = a.keys().map(String::as_str).collect();
            if keys != HashSet::from(["name", "args"]) {
                return Err("malformed action".into());
            }
            let (Some(name), Some(args)) = (a["name"].as_str(), a["args"].as_object()) else { return Err("malformed action".into()) };
            let spec = offered.iter().find(|s| s.name == name).ok_or_else(|| format!("unknown or unoffered action {name:?}"))?;
            let want: HashSet<&str> = spec.args.iter().map(|(n, _)| n.as_str()).collect();
            let got: HashSet<&str> = args.keys().map(String::as_str).collect();
            if want != got {
                return Err("wrong argument names".into());
            }
            for (an, k) in &spec.args {
                match (k, &args[an]) {
                    (ArgKind::Enum(vals), Value::String(v)) if vals.contains(v) => {}
                    (ArgKind::Text(_), Value::String(v)) if !v.trim().is_empty() => {}
                    (ArgKind::Enum(_), _) => return Err(format!("bad value for {an}")),
                    (ArgKind::Text(_), _) => return Err(format!("empty text for {an}")),
                }
            }
            Some((name.to_string(), args.clone()))
        }
        _ => return Err("malformed action".into()),
    };
    Ok(Parsed { reply: reply.to_string(), lang: lang.to_string(), action })
}

// ======================================================================= retrieval: which actions to show the model

/// Lower-case, hamza/ya/ta-marbuta folded, diacritics removed, punctuation to spaces.
pub fn norm(s: &str) -> String {
    s.chars()
        .filter(|c| !matches!(*c, '\u{064B}'..='\u{0652}' | '\u{0640}'))
        .map(|c| match c {
            'أ' | 'إ' | 'آ' => 'ا',
            'ى' => 'ي',
            'ة' => 'ه',
            _ => c,
        })
        .flat_map(char::to_lowercase)
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn tokens(s: &str) -> HashSet<String> {
    let mut out = HashSet::new();
    for t in norm(s).split(' ').filter(|t| !t.is_empty()) {
        let n = t.chars().count();
        if n < 2 {
            continue;
        }
        out.insert(t.to_string());
        if n > 4 {
            if let Some(r) = t.strip_prefix("ال") {
                out.insert(r.to_string());
            }
        }
        if n > 3 {
            for p in ['و', 'ب', 'ل'] {
                if let Some(r) = t.strip_prefix(p) {
                    out.insert(r.to_string());
                }
            }
        }
    }
    out
}

impl Registry {
    pub fn get(&self, name: &str) -> Option<&Action> {
        self.actions.iter().find(|a| a.name == name)
    }

    /// The model was trained with only a handful of actions in its prompt, so it is shown the best few,
    /// ranked by how much of the request's vocabulary each action shares (idf weighted) plus keyword phrases.
    pub fn candidates(&self, text: &str) -> Vec<&Action> {
        let user = tokens(text);
        let phrase_text = format!(" {} ", norm(text));
        let mut scored: Vec<(f64, usize)> = Vec::new();
        for (i, a) in self.actions.iter().enumerate() {
            let mut score: f64 = a.vocab.iter().filter(|t| user.contains(*t)).map(|t| self.idf.get(t).copied().unwrap_or(1.0)).sum();
            for p in &a.keywords {
                if !p.is_empty() && phrase_text.contains(&format!(" {p} ")) {
                    score += 2.0;
                }
            }
            if score > 0.0 {
                scored.push((score, i));
            }
        }
        scored.sort_by(|x, y| y.0.partial_cmp(&x.0).unwrap_or(std::cmp::Ordering::Equal).then(x.1.cmp(&y.1)));
        scored.into_iter().take(MAX_CANDIDATES).map(|(_, i)| &self.actions[i]).collect()
    }
}

// ======================================================================= argument grounding

/// Does the user's text say this surface form? Every word of the form must be there (Arabic "ال"/و/ب/ل prefixes tolerated).
fn says_form(user: &HashSet<String>, form: &str) -> bool {
    let words: Vec<String> = norm(form).split(' ').filter(|w| !w.is_empty()).map(str::to_string).collect();
    !words.is_empty() && words.iter().all(|w| !tokens(w).is_disjoint(user) || user.contains(w))
}

/// Every number written in the text, Arabic-Indic digits included.
fn numbers_in(text: &str) -> Vec<f64> {
    let t: Vec<char> = ascii_digits(text).chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < t.len() {
        if t[i].is_ascii_digit() {
            let mut s = String::new();
            while i < t.len() && (t[i].is_ascii_digit() || (matches!(t[i], '.' | ',') && i + 1 < t.len() && t[i + 1].is_ascii_digit() && !s.is_empty())) {
                s.push(if t[i] == ',' { '.' } else { t[i] });
                i += 1;
            }
            if let Ok(f) = s.parse::<f64>() {
                out.push(f);
            }
        } else {
            i += 1;
        }
    }
    out
}

impl Action {
    /// The model may pick the action, but the *values* must come from the user's own words. Checks that
    /// (1) an enum value is not contradicted by another value the user named, and (2) a number the model
    /// proposes is a number the user said. A value the user never named at all is left alone (synonyms).
    pub fn grounded(&self, text: &str, args: &Map<String, Value>) -> Result<(), Ungrounded> {
        let user = tokens(text);
        for (arg, values) in &self.enum_forms {
            let chosen = args.get(arg).and_then(Value::as_str).unwrap_or("");
            let mut said: Vec<(&str, &str)> = Vec::new(); // (value, form the user said)
            for (val, forms) in values {
                if let Some(f) = forms.iter().find(|f| says_form(&user, f)) {
                    said.push((val.as_str(), f.as_str()));
                }
            }
            if !said.is_empty() && !said.iter().any(|(v, _)| *v == chosen) {
                return Err(Ungrounded { arg: arg.clone(), reason: "conflict", options: said.iter().map(|(_, f)| f.to_string()).collect() });
            }
        }
        let nums = numbers_in(text);
        for arg in &self.numeric_args {
            let v = args.get(arg).and_then(Value::as_f64).unwrap_or(f64::NAN);
            if !nums.iter().any(|n| (n - v).abs() < 1e-9) {
                return Err(Ungrounded { arg: arg.clone(), reason: "number", options: vec![] });
            }
        }
        Ok(())
    }
}

// ======================================================================= argument validation

fn ascii_digits(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '٠'..='٩' => char::from(b'0' + (c as u32 - '٠' as u32) as u8),
            '۰'..='۹' => char::from(b'0' + (c as u32 - '۰' as u32) as u8),
            '٫' | '،' => '.',
            _ => c,
        })
        .collect()
}

/// Canonical typed value of one argument, or a short reason it cannot be used.
fn clean_arg(name: &str, kind: &ArgKind, v: &Value) -> Result<Value, String> {
    let s = v.as_str().unwrap_or("").trim();
    match kind {
        ArgKind::Enum(_) => Ok(Value::String(s.to_string())),
        ArgKind::Text(t) => {
            if s.is_empty() || s.chars().count() > MAX_TEXT_ARG || s.chars().any(char::is_control) {
                return Err(format!("{name}: empty, too long or contains control characters"));
            }
            match t {
                ArgType::Plain => Ok(Value::String(s.to_string())),
                ArgType::Number => {
                    let mut t = ascii_digits(s).replace(',', ".");
                    let dots = t.matches('.').count();
                    if dots > 1 {
                        t = t.replacen('.', "", dots - 1);
                    }
                    let f: f64 = t.parse().map_err(|_| format!("{name}: '{s}' is not a number"))?;
                    if !f.is_finite() {
                        return Err(format!("{name}: '{s}' is not a finite number"));
                    }
                    Ok(json!(f))
                }
                ArgType::Int => {
                    let n: i64 = ascii_digits(s).parse().map_err(|_| format!("{name}: '{s}' is not a whole number"))?;
                    if n < 0 {
                        return Err(format!("{name}: must not be negative"));
                    }
                    Ok(json!(n))
                }
                ArgType::Filename => {
                    let ok = s.len() <= 80 && !s.contains("..") && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
                    if ok { Ok(Value::String(s.to_string())) } else { Err(format!("{name}: '{s}' is not a plain file name")) }
                }
            }
        }
    }
}

pub fn clean_args(action: &Action, args: &Map<String, Value>) -> Result<Map<String, Value>, String> {
    let mut out = Map::new();
    for (n, k) in &action.args {
        out.insert(n.clone(), clean_arg(n, k, args.get(n).unwrap_or(&Value::Null))?);
    }
    Ok(out)
}

// ======================================================================= building the internal request

#[derive(Debug)]
pub enum ExecErr {
    NeedAstronaut,
    Invalid(String),
}

#[derive(Debug, Clone)]
pub struct Prepared {
    pub method: &'static str,
    pub uri: String,
    pub body: Option<Value>,
}

fn pct(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

struct Ctx<'a> {
    args: &'a Map<String, Value>,
    maps: &'a Value,
    astronaut: Option<i64>,
    unit: Option<String>,
}

impl Ctx<'_> {
    fn arg_text(&self, name: &str) -> Result<String, ExecErr> {
        let v = self.args.get(name).ok_or_else(|| ExecErr::Invalid(format!("missing argument {name}")))?;
        let raw = match v {
            Value::String(s) => s.clone(),
            Value::Number(n) => n.to_string(),
            _ => return Err(ExecErr::Invalid(format!("bad argument {name}"))),
        };
        Ok(self.maps[name][&raw].as_str().map(String::from).unwrap_or(raw))
    }

    fn fill(&self, tpl: &str, encode: bool) -> Result<String, ExecErr> {
        let mut out = String::new();
        let mut rest = tpl;
        while let Some(i) = rest.find('{') {
            out.push_str(&rest[..i]);
            let j = rest[i..].find('}').ok_or_else(|| ExecErr::Invalid("unclosed placeholder".into()))?;
            let key = &rest[i + 1..i + j];
            let val = if key == "$astronaut" { self.astronaut.ok_or(ExecErr::NeedAstronaut)?.to_string() } else { self.arg_text(key)? };
            out.push_str(&if encode { pct(&val) } else { val });
            rest = &rest[i + j + 1..];
        }
        out.push_str(rest);
        Ok(out)
    }

    fn value(&self, tpl: &str) -> Result<Value, ExecErr> {
        match tpl {
            "$astronaut" => return Ok(json!(self.astronaut.ok_or(ExecErr::NeedAstronaut)?)),
            "$indicator_unit" => return Ok(json!(self.unit.clone().unwrap_or_default())),
            _ => {}
        }
        if let Some(key) = tpl.strip_prefix('{').and_then(|t| t.strip_suffix('}')) {
            if let Some(v) = self.args.get(key) {
                if v.is_number() {
                    return Ok(v.clone());
                }
            }
            return Ok(json!(self.arg_text(key)?));
        }
        Ok(json!(self.fill(tpl, false)?))
    }
}

/// Look up one row's owner. Only these tables, only by integer id.
fn owner_of(state: &Shared, table: &str, id: i64) -> Result<Option<i64>, ExecErr> {
    let sql = match table {
        "alerts" => "SELECT astronaut_id FROM alerts WHERE id=?1",
        "routines" => "SELECT astronaut_id FROM routines WHERE id=?1",
        "events" => "SELECT astronaut_id FROM events WHERE id=?1",
        _ => return Err(ExecErr::Invalid("ownership check on an unknown table".into())),
    };
    let c = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    match c.query_row(sql, params![id], |r| r.get::<_, i64>(0)) {
        Ok(v) => Ok(Some(v)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(ExecErr::Invalid(e.to_string())),
    }
}

/// A clock reading the front end may send along (its demo/mission clock). Anything that is not a UTC ISO-8601 time is ignored.
pub fn clean_clock(at: &Option<String>) -> Option<String> {
    let t = at.as_deref()?.trim();
    chrono::DateTime::parse_from_rfc3339(t).ok().map(|d| d.with_timezone(&chrono::Utc).format("%Y-%m-%dT%H:%M:%SZ").to_string())
}

pub fn prepare(state: &Shared, action: &Action, args: &Map<String, Value>, astronaut: Option<i64>, at: Option<&str>) -> Result<Prepared, ExecErr> {
    let e = action.exec.as_ref().ok_or_else(|| ExecErr::Invalid("this action has no exec block".into()))?;
    if let Some(o) = e.get("owns") {
        let table = o["table"].as_str().unwrap_or("");
        let id = args.get(o["arg"].as_str().unwrap_or("")).and_then(Value::as_i64).ok_or_else(|| ExecErr::Invalid("missing id".into()))?;
        let who = astronaut.ok_or(ExecErr::NeedAstronaut)?;
        match owner_of(state, table, id)? {
            None => return Err(ExecErr::Invalid(format!("{table} {id} not found"))),
            Some(owner) if owner != who => return Err(ExecErr::Invalid(format!("{table} {id} belongs to another astronaut"))),
            Some(_) => {}
        }
    }
    let uses_unit = e["body"].as_object().is_some_and(|b| b.values().any(|v| v.as_str() == Some("$indicator_unit")));
    let unit = if uses_unit {
        let code = args.get("indicator").and_then(Value::as_str).unwrap_or("");
        let c = state.conn.lock().unwrap_or_else(|e| e.into_inner());
        c.query_row("SELECT unit FROM indicators WHERE code=?1", params![code], |r| r.get::<_, String>(0)).ok()
    } else {
        None
    };
    let none = Value::Null;
    let ctx = Ctx { args, maps: e.get("map").unwrap_or(&none), astronaut, unit };
    let mut uri = ctx.fill(e["path"].as_str().unwrap_or(""), true)?;
    if let Some(q) = e["query"].as_object() {
        let mut parts = Vec::new();
        for (k, v) in q {
            let val = match ctx.value(v.as_str().unwrap_or(""))? {
                Value::String(s) => s,
                other => other.to_string(),
            };
            parts.push(format!("{}={}", pct(k), pct(&val)));
        }
        if !parts.is_empty() {
            uri.push('?');
            uri.push_str(&parts.join("&"));
        }
    }
    let body = match e["body"].as_object() {
        Some(b) => {
            let mut m = Map::new();
            for (k, v) in b {
                m.insert(k.clone(), ctx.value(v.as_str().unwrap_or(""))?);
            }
            Some(Value::Object(m))
        }
        None => None,
    };
    // actions that record "when" (exec.clock names the body field) use the app's clock when it sent one
    let mut body = body;
    if let (Some(field), Some(t), Some(Value::Object(m))) = (e["clock"].as_str(), at, body.as_mut()) {
        m.insert(field.to_string(), json!(t));
    }
    let method = if e["method"].as_str() == Some("POST") { "POST" } else { "GET" };
    Ok(Prepared { method, uri, body })
}

/// Run a prepared request through the normal API router, in-process.
pub async fn execute(state: &Shared, p: &Prepared) -> (u16, Value) {
    let mut req = Request::builder().method(p.method).uri(&p.uri);
    let body = match &p.body {
        Some(b) => {
            req = req.header("content-type", "application/json");
            Body::from(b.to_string())
        }
        None => Body::empty(),
    };
    let Ok(req) = req.body(body) else { return (500, json!({"detail": "could not build the internal request"})) };
    let resp = match api::internal_router(state.clone()).oneshot(req).await {
        Ok(r) => r,
        Err(never) => match never {},
    };
    let status = resp.status().as_u16();
    let bytes = axum::body::to_bytes(resp.into_body(), MAX_RESULT_BYTES).await.unwrap_or_default();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

// ======================================================================= confirmations

struct Pending {
    action: String,
    args: Map<String, Value>,
    astronaut: Option<i64>,
    lang: String,
    at: Option<String>,
    created: Instant,
}

fn store() -> &'static Mutex<HashMap<String, Pending>> {
    static S: OnceLock<Mutex<HashMap<String, Pending>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 128 random bits from the OS-seeded SipHash keys, hex encoded. One-time, short-lived, local use.
fn new_token() -> String {
    static N: OnceLock<Mutex<u64>> = OnceLock::new();
    let mut n = N.get_or_init(|| Mutex::new(0)).lock().unwrap_or_else(|e| e.into_inner());
    *n += 1;
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let mut out = String::new();
    for salt in 0..2u8 {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u64(*n);
        h.write_u128(nanos);
        h.write_u8(salt);
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

fn park(action: &str, args: &Map<String, Value>, astronaut: Option<i64>, lang: &str, at: Option<String>) -> String {
    let mut s = store().lock().unwrap_or_else(|e| e.into_inner());
    s.retain(|_, p| p.created.elapsed() < CONFIRM_TTL);
    if s.len() >= MAX_PENDING {
        if let Some(oldest) = s.iter().min_by_key(|(_, p)| p.created).map(|(k, _)| k.clone()) {
            s.remove(&oldest);
        }
    }
    let token = new_token();
    s.insert(token.clone(), Pending { action: action.into(), args: args.clone(), astronaut, lang: lang.into(), at, created: Instant::now() });
    token
}

pub fn pending_count() -> usize {
    let mut s = store().lock().unwrap_or_else(|e| e.into_inner());
    s.retain(|_, p| p.created.elapsed() < CONFIRM_TTL);
    s.len()
}

// ======================================================================= audit trail

fn audit(state: &Shared, astronaut: Option<i64>, action: &str, args: &Map<String, Value>, status: &str, http: u16) {
    let dir = state.base.join("data");
    let _ = std::fs::create_dir_all(&dir);
    let line = json!({"at": logic::now_iso(), "astronaut_id": astronaut, "action": action, "args": args, "status": status, "http": http});
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("atlas_audit.jsonl")) {
        use std::io::Write;
        let _ = writeln!(f, "{line}");
    }
}

// ======================================================================= command flow

#[derive(Deserialize)]
pub struct CommandIn {
    pub message: String,
    pub astronaut_id: Option<i64>,
    /// The app's clock (UTC ISO-8601). Used as the time of a new measurement or event; default: the server's clock.
    #[serde(default)]
    pub at: Option<String>,
}

#[derive(Deserialize)]
pub struct ConfirmIn {
    pub token: String,
    #[serde(default = "yes")]
    pub approve: bool,
}
fn yes() -> bool {
    true
}

fn is_arabic(text: &str) -> bool {
    let ar = text.chars().filter(|c| ('\u{0600}'..='\u{06FF}').contains(c)).count();
    let en = text.chars().filter(|c| c.is_ascii_alphabetic()).count();
    ar >= en && ar > 0
}

fn say(ar: bool, a: &str, e: &str) -> String {
    (if ar { a } else { e }).to_string()
}

fn trunc(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

fn ui_instruction(state: &Shared, action: &Action, args: &Map<String, Value>) -> Result<Value, String> {
    let ui = action.ui.as_ref().ok_or("no ui block")?;
    let mut out = json!({"op": ui["op"], "args": args});
    if let Some(routes) = ui["routes"].as_object() {
        if let Some(route) = args.get("page").and_then(Value::as_str).and_then(|p| routes.get(p)) {
            out["route"] = route.clone();
        }
    }
    if ui["resolve"].as_str() == Some("astronaut") {
        let name = args.get("name").and_then(Value::as_str).unwrap_or("");
        let like = format!("%{}%", name.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
        let c = state.conn.lock().unwrap_or_else(|e| e.into_inner());
        let found = c
            .query_row("SELECT id, display_name FROM astronauts WHERE display_name LIKE ?1 ESCAPE '\\' ORDER BY id LIMIT 1", params![like], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(|_| format!("no astronaut named '{name}'"))?;
        out["astronaut_id"] = json!(found.0);
        out["display_name"] = json!(found.1);
    }
    Ok(out)
}

fn exec_error(e: ExecErr, ar: bool) -> (StatusCode, Value, String) {
    match e {
        ExecErr::NeedAstronaut => (
            StatusCode::UNPROCESSABLE_ENTITY,
            json!("astronaut_id is required for this action"),
            say(ar, "اختر رائداً أولاً ثم أعد الطلب.", "Please select an astronaut first, then ask again."),
        ),
        ExecErr::Invalid(m) => (StatusCode::UNPROCESSABLE_ENTITY, json!(m.clone()), say(ar, &format!("لا أستطيع تنفيذ ذلك: {m}"), &format!("I can't do that: {m}"))),
    }
}

/// One user request: model -> validated proposal -> (answer | result | confirmation | ui instruction).
pub async fn run_command(state: &Shared, cfg: &AiConfig, input: &CommandIn) -> (StatusCode, Value) {
    let text = input.message.trim();
    let ar = is_arabic(text);
    let fail = |code: StatusCode, msg: String| {
        (code, json!({"status": "error", "error": msg, "reply": say(ar, "تعذّر تنفيذ الطلب.", "I couldn't process that request."), "disclaimer": DISCLAIMER}))
    };
    if text.is_empty() || text.chars().count() > MAX_MESSAGE_CHARS {
        return fail(StatusCode::UNPROCESSABLE_ENTITY, format!("send a message of 1-{MAX_MESSAGE_CHARS} characters"));
    }
    if let Some(aid) = input.astronaut_id {
        let exists = {
            let c = state.conn.lock().unwrap_or_else(|e| e.into_inner());
            c.query_row("SELECT 1 FROM astronauts WHERE id=?1", params![aid], |_| Ok(())).is_ok()
        };
        if !exists {
            return fail(StatusCode::NOT_FOUND, format!("astronaut {aid} not found"));
        }
    }
    let registry = match load_registry(&registry_path(&state.base)) {
        Ok(r) => r,
        Err(e) => return fail(StatusCode::INTERNAL_SERVER_ERROR, e),
    };
    let offered = registry.candidates(text);
    let prompt = [Msg { role: "system".into(), content: build_system(&offered) }, Msg { role: "user".into(), content: text.to_string() }];
    let started = Instant::now();
    let raw = match ai::complete(cfg, &prompt, 0.0, 220).await {
        Ok(r) => r,
        Err(e) => return fail(StatusCode::SERVICE_UNAVAILABLE, e.detail().to_string()),
    };
    let ms = started.elapsed().as_millis() as u64;
    let offered_names: Vec<&str> = offered.iter().map(|a| a.name.as_str()).collect();
    let parsed = match parse_reply(&raw, &offered) {
        Ok(p) => p,
        Err(why) => {
            return (
                StatusCode::OK,
                json!({"status": "error", "error": format!("the model's answer was not valid: {why}"), "raw": trunc(&raw, 400),
                       "reply": say(ar, "عذراً، لم أفهم الطلب. هل يمكنك إعادته؟", "Sorry, I didn't understand that. Could you say it again?"),
                       "candidates": offered_names, "elapsed_ms": ms, "disclaimer": DISCLAIMER}),
            )
        }
    };
    let mut out = Map::new();
    out.insert("status".into(), json!("chat"));
    out.insert("reply".into(), json!(parsed.reply));
    out.insert("lang".into(), json!(parsed.lang));
    out.insert("disclaimer".into(), json!(DISCLAIMER));
    out.insert("candidates".into(), json!(offered_names));
    out.insert("elapsed_ms".into(), json!(ms));
    out.insert("model".into(), json!(cfg.model));
    out.insert("astronaut_id".into(), json!(input.astronaut_id));
    let Some((name, raw_args)) = parsed.action else { return (StatusCode::OK, Value::Object(out)) };
    let action = registry.get(&name).expect("parse_reply only accepts registry actions");
    out.insert("action".into(), json!({"name": name, "args": raw_args}));
    out.insert("kind".into(), json!(action.kind.name()));
    let args = match clean_args(action, &raw_args) {
        Ok(a) => a,
        Err(why) => {
            out.insert("status".into(), json!("needs_clarification"));
            out.insert("error".into(), json!(why.clone()));
            out.insert("reply".into(), json!(say(ar, &format!("لم أفهم القيمة: {why}"), &format!("I couldn't use that value: {why}"))));
            return (StatusCode::OK, Value::Object(out));
        }
    };
    out.insert("action".into(), json!({"name": name, "args": args}));
    if let Err(g) = action.grounded(text, &args) {
        let reply = if g.reason == "conflict" {
            let said = g.options.join(" / ");
            say(ar, &format!("لم أتأكد من «{}». ذكرتَ: {said}. هل تقصد ذلك؟", g.arg), &format!("I'm not sure about \"{}\". You mentioned: {said}. Is that what you mean?", g.arg))
        } else {
            say(ar, &format!("لم أجد القيمة «{}» في كلامك. كم هي؟", g.arg), &format!("I couldn't find the value for \"{}\" in what you said. What is it?", g.arg))
        };
        out.insert("status".into(), json!("needs_clarification"));
        out.insert("error".into(), json!(format!("{}: {} is not grounded in the request", g.arg, g.reason)));
        out.insert("reply".into(), json!(reply));
        return (StatusCode::OK, Value::Object(out));
    }
    match action.kind {
        Kind::Ui => match ui_instruction(state, action, &args) {
            Ok(ui) => {
                out.insert("status".into(), json!("ui"));
                out.insert("ui".into(), ui);
            }
            Err(why) => {
                out.insert("status".into(), json!("error"));
                out.insert("error".into(), json!(why.clone()));
                out.insert("reply".into(), json!(say(ar, &format!("لم أجد: {why}"), &format!("Not found: {why}"))));
            }
        },
        Kind::Read | Kind::Write => {
            let prepared = match prepare(state, action, &args, input.astronaut_id, clean_clock(&input.at).as_deref()) {
                Ok(p) => p,
                Err(e) => {
                    let (_, detail, reply) = exec_error(e, ar);
                    out.insert("status".into(), json!("error"));
                    out.insert("error".into(), detail);
                    out.insert("reply".into(), json!(reply));
                    return (StatusCode::OK, Value::Object(out));
                }
            };
            if action.kind == Kind::Write {
                let token = park(&name, &args, input.astronaut_id, &parsed.lang, clean_clock(&input.at));
                out.insert("status".into(), json!("needs_confirmation"));
                out.insert(
                    "confirm".into(),
                    json!({"token": token, "expires_in_s": CONFIRM_TTL.as_secs(), "summary": {"action": name, "description": action.description, "args": args,
                           "request": format!("{} {}", prepared.method, prepared.uri.split('?').next().unwrap_or(""))}}),
                );
            } else {
                let (code, result) = execute(state, &prepared).await;
                audit(state, input.astronaut_id, &name, &args, if code < 400 { "executed" } else { "failed" }, code);
                out.insert("status".into(), json!(if code < 400 { "executed" } else { "error" }));
                out.insert("http_status".into(), json!(code));
                if code < 400 {
                    out.insert("result".into(), result);
                } else {
                    let detail = result["detail"].as_str().unwrap_or("the request failed").to_string();
                    out.insert("reply".into(), json!(say(ar, &format!("لم يكتمل الطلب: {detail}"), &format!("It didn't work: {detail}"))));
                    out.insert("error".into(), json!(detail));
                }
            }
        }
    }
    (StatusCode::OK, Value::Object(out))
}

/// Run (approve) or discard (decline) a parked write. A token works once.
pub async fn run_confirm(state: &Shared, input: &ConfirmIn) -> (StatusCode, Value) {
    let pending = {
        let mut s = store().lock().unwrap_or_else(|e| e.into_inner());
        s.retain(|_, p| p.created.elapsed() < CONFIRM_TTL);
        s.remove(input.token.trim())
    };
    let Some(p) = pending else {
        return (StatusCode::NOT_FOUND, json!({"status": "error", "error": "unknown, used or expired confirmation token"}));
    };
    let ar = p.lang == "ar";
    if !input.approve {
        audit(state, p.astronaut, &p.action, &p.args, "declined", 0);
        return (StatusCode::OK, json!({"status": "cancelled", "reply": say(ar, "تم الإلغاء، لم يتغير شيء.", "Cancelled, nothing was changed.")}));
    }
    let registry = match load_registry(&registry_path(&state.base)) {
        Ok(r) => r,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, json!({"status": "error", "error": e})),
    };
    let Some(action) = registry.get(&p.action).filter(|a| a.kind == Kind::Write) else {
        return (StatusCode::CONFLICT, json!({"status": "error", "error": "the action is no longer in the registry"}));
    };
    let prepared = match prepare(state, action, &p.args, p.astronaut, p.at.as_deref()) {
        Ok(x) => x,
        Err(e) => {
            let (code, detail, reply) = exec_error(e, ar);
            return (code, json!({"status": "error", "error": detail, "reply": reply}));
        }
    };
    let (code, result) = execute(state, &prepared).await;
    audit(state, p.astronaut, &p.action, &p.args, if code < 400 { "confirmed" } else { "failed" }, code);
    if code < 400 {
        (StatusCode::OK, json!({"status": "executed", "action": {"name": p.action, "args": p.args}, "http_status": code, "result": result,
                                "reply": say(ar, "تم التنفيذ.", "Done.")}))
    } else {
        let detail = result["detail"].as_str().unwrap_or("the request failed").to_string();
        (StatusCode::OK, json!({"status": "error", "http_status": code, "error": detail, "reply": say(ar, &format!("لم يكتمل الطلب: {detail}"), &format!("It didn't work: {detail}"))}))
    }
}

// ======================================================================= HTTP

fn arg_description(a: &Action) -> Value {
    let mut m = Map::new();
    for (n, k) in &a.args {
        m.insert(
            n.clone(),
            match k {
                ArgKind::Enum(v) => json!({"kind": "enum", "values": v}),
                ArgKind::Text(t) => json!({"kind": "text", "type": match t { ArgType::Plain => "text", ArgType::Number => "number", ArgType::Int => "int", ArgType::Filename => "filename" }}),
            },
        );
    }
    Value::Object(m)
}

async fn actions_route(State(s): State<Shared>) -> (StatusCode, Json<Value>) {
    match load_registry(&registry_path(&s.base)) {
        Ok(r) => {
            let list: Vec<Value> = r
                .actions
                .iter()
                .map(|a| json!({"name": a.name, "kind": a.kind.name(), "description": a.description, "args": arg_description(a),
                                "requires_confirmation": a.kind == Kind::Write, "ui": a.ui}))
                .collect();
            (StatusCode::OK, Json(json!({"version": r.version, "actions": list})))
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"detail": e}))),
    }
}

async fn status_route(State(s): State<Shared>) -> Json<Value> {
    let model = ai::status(&AiConfig::from_env()).await;
    let reg = match load_registry(&registry_path(&s.base)) {
        Ok(r) => {
            let count = |k: Kind| r.actions.iter().filter(|a| a.kind == k).count();
            json!({"ok": true, "version": r.version, "actions": r.actions.len(), "read": count(Kind::Read), "write": count(Kind::Write), "ui": count(Kind::Ui)})
        }
        Err(e) => json!({"ok": false, "error": e}),
    };
    Json(json!({"registry": reg, "model": model, "pending_confirmations": pending_count()}))
}

async fn command_route(State(s): State<Shared>, Json(inp): Json<CommandIn>) -> (StatusCode, Json<Value>) {
    let (code, body) = run_command(&s, &AiConfig::from_env(), &inp).await;
    (code, Json(body))
}

async fn confirm_route(State(s): State<Shared>, Json(inp): Json<ConfirmIn>) -> (StatusCode, Json<Value>) {
    let (code, body) = run_confirm(&s, &inp).await;
    (code, Json(body))
}

/// Mounted under /api by the main router.
pub fn api_routes() -> Router<Shared> {
    Router::new()
        .route("/atlas/status", get(status_route))
        .route("/atlas/actions", get(actions_route))
        .route("/atlas/command", post(command_route))
        .route("/atlas/confirm", post(confirm_route))
}
