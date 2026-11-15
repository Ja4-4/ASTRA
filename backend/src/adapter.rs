//! Data adapter: any CSV -> clean, standard records -> SQLite.
//!
//! Standard fields: timestamp (UTC), indicator, value, unit, source, quality. When the official
//! challenge data arrives, write a new mapping JSON in /mappings; the app and dashboard do not change.
use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};
use rusqlite::{params, Connection};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;

const MISSING: &[&str] = &["", "na", "n/a", "nan", "null", "none", "-", "--", "?", "not available", "nd"];

/// Built-in header / indicator aliases (normalised: lower-case, spaces -> "_").
const BUILTIN_ALIASES: &[(&str, &str)] = &[
    ("hr", "heart_rate"), ("heartrate", "heart_rate"), ("heart_rate", "heart_rate"), ("pulse", "heart_rate"),
    ("sbp", "bp_systolic"), ("systolic", "bp_systolic"), ("bp_systolic", "bp_systolic"),
    ("dbp", "bp_diastolic"), ("diastolic", "bp_diastolic"), ("bp_diastolic", "bp_diastolic"),
    ("glucose", "glucose"), ("blood_glucose", "glucose"), ("blood_sugar", "glucose"),
    ("temp", "body_temp"), ("temperature", "body_temp"), ("body_temp", "body_temp"),
    ("spo2", "spo2"), ("oxygen_saturation", "spo2"),
    ("sleep", "sleep_hours"), ("sleep_hours", "sleep_hours"), ("sleep_duration", "sleep_hours"),
    ("mood", "mood"),
    ("exercise_minutes", "exercise_minutes"), ("exercise_min", "exercise_minutes"),
    ("radiation_dose_cumulative", "radiation_dose_cumulative"),
];

// ---------- mapping file ----------

fn d_imported() -> String { "imported".into() }
fn d_long() -> String { "long".into() }
fn d_subject() -> String { "subject_1".into() }
fn d_station() -> String { "station".into() }

#[derive(Debug, Clone, Deserialize)]
pub struct ColSpec {
    pub indicator: String,
    #[serde(default)]
    pub unit: String,
    /// Optional column whose cell says "suspect" for readings that are kept but flagged.
    pub quality_col: Option<String>,
}
#[derive(Debug, Clone, Deserialize)]
pub struct WideSpec {
    pub columns: BTreeMap<String, ColSpec>,
}
#[derive(Debug, Clone, Deserialize)]
pub struct LongSpec {
    pub indicator_col: String,
    pub value_col: String,
    pub unit_col: Option<String>,
    #[serde(default)]
    pub default_unit: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Mapping {
    pub source_name: String,
    #[serde(default = "d_imported")]
    pub source_type: String,
    #[serde(default = "d_long")]
    pub format: String, // "long" | "wide"
    pub target: Option<String>, // "env" => env_readings table
    pub timestamp_col: Option<String>,
    pub date_col: Option<String>,
    pub time_col: Option<String>,
    pub timestamp_format: Option<String>, // chrono format string
    pub timestamp_unit: Option<String>,   // "s" | "ms" (epoch)
    #[serde(default)]
    pub dayfirst: bool,
    pub astronaut_col: Option<String>,
    #[serde(default = "d_subject")]
    pub default_astronaut: String,
    #[serde(default = "d_station")]
    pub mission_setting: String,
    pub delimiter: Option<String>,
    pub default_unit: Option<String>, // env target only
    pub long: Option<LongSpec>,
    pub wide: Option<WideSpec>,
    #[serde(default)]
    pub indicator_aliases: HashMap<String, String>,
}

pub fn load_mapping(path: &Path) -> Result<Mapping, String> {
    let s = std::fs::read_to_string(path).map_err(|e| format!("cannot read mapping {}: {e}", path.display()))?;
    serde_json::from_str(&s).map_err(|e| format!("bad mapping {}: {e}", path.display()))
}

// ---------- small helpers ----------

pub fn norm_header(h: &str) -> String {
    h.trim_start_matches('\u{feff}').split_whitespace().collect::<Vec<_>>().join("_").to_lowercase()
}

pub fn norm_unit(u: &str) -> String {
    let s: String = u.chars().filter(|c| !c.is_whitespace() && *c != '°').collect::<String>().to_lowercase();
    let out: &str = match s.as_str() {
        "bpm" | "beats/min" => "bpm",
        "mmhg" => "mmhg",
        "mg/dl" => "mg/dl",
        "mmol/l" => "mmol/l",
        "c" | "degc" | "celsius" => "c",
        "f" | "degf" | "fahrenheit" => "f",
        "k" => "k",
        "%" | "percent" => "%",
        "h" | "hr" | "hrs" | "hour" | "hours" => "h",
        "min" | "mins" | "minute" | "minutes" => "min",
        "score" | "/5" => "score",
        "msv" => "msv",
        other => other,
    };
    out.to_string()
}

pub fn canon_token(indicator: &str) -> Option<&'static str> {
    Some(match indicator {
        "heart_rate" => "bpm",
        "bp_systolic" | "bp_diastolic" => "mmhg",
        "glucose" => "mg/dl",
        "body_temp" => "c",
        "spo2" => "%",
        "sleep_hours" => "h",
        "mood" => "score",
        "exercise_minutes" => "min",
        "radiation_dose_cumulative" => "msv",
        _ => return None,
    })
}

/// Convert `v` from `unit` (normalised token) to the canonical unit of `indicator`.
pub fn convert(indicator: &str, unit: &str, v: f64) -> Option<f64> {
    match (indicator, unit) {
        ("body_temp", "f") => Some((v - 32.0) * 5.0 / 9.0),
        ("body_temp", "k") => Some(v - 273.15),
        ("glucose", "mmol/l") => Some(v * 18.016),
        ("sleep_hours", "min") => Some(v / 60.0),
        _ => None,
    }
}

fn is_comma_decimal(t: &str) -> bool {
    let t = t.strip_prefix('-').unwrap_or(t);
    let mut p = t.split(',');
    match (p.next(), p.next(), p.next()) {
        (Some(a), Some(b), None) => {
            !a.is_empty() && !b.is_empty() && a.chars().all(|c| c.is_ascii_digit()) && b.chars().all(|c| c.is_ascii_digit())
        }
        _ => false,
    }
}

/// Parse a number; None when the cell is missing / not numeric.
pub fn to_number(s: &str) -> Option<f64> {
    let t = s.trim();
    if MISSING.contains(&t.to_lowercase().as_str()) {
        return None;
    }
    let t2 = if is_comma_decimal(t) { t.replace(',', ".") } else { t.replace(',', "") };
    t2.parse::<f64>().ok().filter(|v| v.is_finite())
}

fn round3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

fn cell<'a>(r: &'a HashMap<String, String>, k: &str) -> &'a str {
    r.get(k).map(String::as_str).unwrap_or("")
}

// ---------- timestamps ----------

fn parse_ts(raw: &str, m: &Mapping) -> Option<DateTime<Utc>> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }
    if let Some(u) = &m.timestamp_unit {
        let x: f64 = s.parse().ok()?;
        return match u.as_str() {
            "s" => DateTime::from_timestamp(x as i64, 0),
            "ms" => DateTime::from_timestamp_millis(x as i64),
            _ => None,
        };
    }
    if let Some(f) = &m.timestamp_format {
        if let Ok(dt) = NaiveDateTime::parse_from_str(s, f) {
            return Some(dt.and_utc());
        }
        if let Ok(d) = NaiveDate::parse_from_str(s, f) {
            return d.and_hms_opt(0, 0, 0).map(|x| x.and_utc());
        }
        return DateTime::parse_from_str(s, f).ok().map(|d| d.with_timezone(&Utc));
    }
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        return Some(dt.with_timezone(&Utc));
    }
    for f in ["%Y-%m-%d %H:%M:%S%:z", "%Y-%m-%d %H:%M:%S%z", "%Y-%m-%dT%H:%M:%S%.f%z"] {
        if let Ok(dt) = DateTime::parse_from_str(s, f) {
            return Some(dt.with_timezone(&Utc));
        }
    }
    let iso_dt = ["%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%dT%H:%M", "%Y/%m/%d %H:%M:%S", "%Y/%m/%d %H:%M"];
    let dmy_dt = ["%d/%m/%Y %H:%M:%S", "%d/%m/%Y %H:%M", "%d-%m-%Y %H:%M:%S", "%d-%m-%Y %H:%M", "%d.%m.%Y %H:%M:%S", "%d.%m.%Y %H:%M"];
    let mdy_dt = ["%m/%d/%Y %H:%M:%S", "%m/%d/%Y %H:%M", "%m-%d-%Y %H:%M:%S", "%m-%d-%Y %H:%M"];
    let iso_d = ["%Y-%m-%d", "%Y/%m/%d"];
    let dmy_d = ["%d/%m/%Y", "%d-%m-%Y", "%d.%m.%Y"];
    let mdy_d = ["%m/%d/%Y", "%m-%d-%Y"];
    let (first_dt, second_dt, first_d, second_d) =
        if m.dayfirst { (&dmy_dt[..], &mdy_dt[..], &dmy_d[..], &mdy_d[..]) } else { (&mdy_dt[..], &dmy_dt[..], &mdy_d[..], &dmy_d[..]) };
    for f in iso_dt.iter().chain(first_dt.iter()).chain(second_dt.iter()) {
        if let Ok(dt) = NaiveDateTime::parse_from_str(s, f) {
            return Some(dt.and_utc());
        }
    }
    for f in iso_d.iter().chain(first_d.iter()).chain(second_d.iter()) {
        if let Ok(d) = NaiveDate::parse_from_str(s, f) {
            return d.and_hms_opt(0, 0, 0).map(|x| x.and_utc());
        }
    }
    None
}

// ---------- reading ----------

pub struct Table {
    pub headers: Vec<String>,
    pub rows: Vec<HashMap<String, String>>,
}

pub fn read_csv(path: &Path, delimiter: Option<&str>) -> Result<Table, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    let text = String::from_utf8_lossy(&bytes);
    let text = text.trim_start_matches('\u{feff}');
    let first = text.lines().next().unwrap_or("");
    let delim = match delimiter {
        Some(d) if d == "\\t" || d == "tab" => b'\t',
        Some(d) if !d.is_empty() => d.as_bytes()[0],
        _ => [b',', b';', b'\t', b'|'].into_iter().max_by_key(|d| first.bytes().filter(|b| b == d).count()).unwrap_or(b','),
    };
    let mut rdr = csv::ReaderBuilder::new().delimiter(delim).flexible(true).from_reader(text.as_bytes());
    let headers: Vec<String> = rdr.headers().map_err(|e| e.to_string())?.iter().map(norm_header).collect();
    let mut rows = Vec::new();
    for rec in rdr.records() {
        let rec = rec.map_err(|e| e.to_string())?;
        if rec.iter().all(|c| c.trim().is_empty()) {
            continue;
        }
        rows.push(headers.iter().cloned().zip(rec.iter().map(|c| c.trim().to_string())).collect());
    }
    Ok(Table { headers, rows })
}

/// Human-readable summary of an unknown CSV, to help write its mapping.
pub fn inspect(path: &Path) -> Result<String, String> {
    let t = read_csv(path, None)?;
    let mut out = format!("{}: {} rows x {} columns\n\n", path.display(), t.rows.len(), t.headers.len());
    for h in &t.headers {
        let vals: Vec<&str> = t.rows.iter().map(|r| cell(r, h)).collect();
        let blank = vals.iter().filter(|v| MISSING.contains(&v.to_lowercase().as_str())).count();
        let nums: Vec<f64> = vals.iter().filter_map(|v| to_number(v)).collect();
        let numeric = !vals.is_empty() && nums.len() as f64 / vals.len() as f64 > 0.8;
        let range = if numeric && !nums.is_empty() {
            let lo = nums.iter().cloned().fold(f64::INFINITY, f64::min);
            let hi = nums.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
            format!(" range {lo}..{hi}")
        } else {
            String::new()
        };
        let sample = vals.iter().filter(|v| !v.is_empty()).take(3).cloned().collect::<Vec<_>>().join(", ");
        out += &format!("- {h:?}: {}, {blank} blank{range} | e.g. {sample}\n", if numeric { "numeric" } else { "text/date" });
    }
    Ok(out)
}

// ---------- cleaning ----------

#[derive(Debug, Clone)]
pub struct Record {
    pub astronaut: String,
    pub indicator: String,
    pub measured_at: String,
    pub value: Option<f64>,
    pub unit: Option<String>, // env target only; health units come from the indicators table
    pub quality: String,
}

fn bump(m: &mut BTreeMap<String, i64>, k: impl Into<String>) {
    *m.entry(k.into()).or_insert(0) += 1;
}

fn timestamps(t: &Table, m: &Mapping) -> Result<Vec<Option<DateTime<Utc>>>, String> {
    let need = |c: &str| -> Result<String, String> {
        let n = norm_header(c);
        if t.headers.contains(&n) {
            Ok(n)
        } else {
            Err(format!("column '{c}' not found in the CSV; available columns: {}", t.headers.join(", ")))
        }
    };
    let (date_c, time_c, single_c) = match (&m.date_col, &m.time_col) {
        (Some(d), Some(tm)) => (Some(need(d)?), Some(need(tm)?), None),
        _ => {
            let c = m.timestamp_col.as_ref().ok_or("mapping needs timestamp_col (or date_col + time_col)")?;
            (None, None, Some(need(c)?))
        }
    };
    Ok(t.rows
        .iter()
        .map(|r| {
            let raw = match (&date_c, &time_c, &single_c) {
                (Some(d), Some(tm), _) => format!("{} {}", cell(r, d), cell(r, tm)),
                (_, _, Some(c)) => cell(r, c).to_string(),
                _ => String::new(),
            };
            parse_ts(&raw, m)
        })
        .collect())
}

/// Clean a table into standard records plus a report. `bounds`: indicator -> (plausible min, max).
pub fn clean(t: &Table, m: &Mapping, bounds: &HashMap<String, (f64, f64)>) -> Result<(Vec<Record>, Value), String> {
    let env = m.target.as_deref() == Some("env");
    let mut aliases: HashMap<String, String> = BUILTIN_ALIASES.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    for (k, v) in &m.indicator_aliases {
        aliases.insert(norm_header(k), v.clone());
    }
    let ts = timestamps(t, m)?;
    let astro_col = m.astronaut_col.as_ref().map(|c| norm_header(c));
    if let Some(c) = &astro_col {
        if !t.headers.contains(c) {
            return Err(format!("astronaut column '{c}' not found; available columns: {}", t.headers.join(", ")));
        }
    }

    let mut rejected: BTreeMap<String, i64> = BTreeMap::new();
    let mut unknown: BTreeMap<String, i64> = BTreeMap::new();
    let (mut n_missing, mut n_converted, mut n_assumed, mut n_flagged, mut cols_not_found) = (0i64, 0i64, 0i64, 0i64, 0i64);

    // Normalise both layouts into (row, indicator, raw name, raw value, raw unit).
    struct Cell { row: usize, indicator: Option<String>, name: String, value: String, unit: String, suspect: bool }
    let mut cells: Vec<Cell> = Vec::new();
    if m.format == "wide" {
        let w = m.wide.as_ref().ok_or("mapping.format is 'wide' but 'wide.columns' is missing")?;
        for (col, spec) in &w.columns {
            let c = norm_header(col);
            if !t.headers.contains(&c) {
                cols_not_found += 1;
                bump(&mut unknown, format!("column:{col}"));
                continue;
            }
            let quality_col = spec.quality_col.as_ref().map(|q| norm_header(q)).filter(|q| t.headers.contains(q));
            for (i, r) in t.rows.iter().enumerate() {
                let suspect = quality_col.as_ref().is_some_and(|q| cell(r, q).eq_ignore_ascii_case("suspect"));
                cells.push(Cell { row: i, indicator: Some(spec.indicator.clone()), name: c.clone(), value: cell(r, &c).to_string(), unit: spec.unit.clone(), suspect });
            }
        }
    } else {
        let l = m.long.as_ref().ok_or("mapping.format is 'long' but 'long' section is missing")?;
        let (ic, vc) = (norm_header(&l.indicator_col), norm_header(&l.value_col));
        let uc = l.unit_col.as_ref().map(|c| norm_header(c));
        for c in [Some(&ic), Some(&vc), uc.as_ref()].into_iter().flatten() {
            if !t.headers.contains(c) {
                return Err(format!("column '{c}' not found in the CSV; available columns: {}", t.headers.join(", ")));
            }
        }
        for (i, r) in t.rows.iter().enumerate() {
            let name = norm_header(cell(r, &ic));
            let indicator = aliases.get(&name).cloned().or_else(|| if env { Some(name.clone()) } else { None });
            let unit = match &uc { Some(u) => cell(r, u).to_string(), None => l.default_unit.clone() };
            cells.push(Cell { row: i, indicator, name, value: cell(r, &vc).to_string(), unit, suspect: false });
        }
    }

    let mut out: Vec<Record> = Vec::new();
    let mut seen: HashSet<(String, String, String)> = HashSet::new();
    for c in cells {
        let Some(t0) = ts[c.row] else { bump(&mut rejected, "bad_timestamp"); continue };
        let Some(indicator) = c.indicator else {
            bump(&mut unknown, c.name);
            bump(&mut rejected, "unknown_indicator");
            continue;
        };
        let measured_at = t0.format("%Y-%m-%dT%H:%M:%SZ").to_string();
        let astro = astro_col
            .as_ref()
            .map(|a| cell(&t.rows[c.row], a).to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| m.default_astronaut.clone());
        if !seen.insert((astro.clone(), indicator.clone(), measured_at.clone())) {
            bump(&mut rejected, "duplicate_in_file");
            continue;
        }
        let value = to_number(&c.value);
        if env {
            let unit = if c.unit.trim().is_empty() { m.default_unit.clone().unwrap_or_default() } else { c.unit.trim().to_string() };
            let quality = if value.is_none() {
                n_missing += 1;
                "missing"
            } else if c.suspect {
                n_flagged += 1;
                "suspect"
            } else {
                "ok"
            };
            out.push(Record { astronaut: astro, indicator, measured_at, value, unit: Some(unit), quality: quality.into() });
            continue;
        }
        let Some(canon) = canon_token(&indicator) else {
            bump(&mut unknown, indicator);
            bump(&mut rejected, "unknown_indicator");
            continue;
        };
        let unit = norm_unit(&c.unit);
        let mut quality = if c.suspect { "suspect" } else { "ok" };
        if c.suspect && value.is_some() {
            n_flagged += 1;
        }
        let value = match value {
            None => {
                quality = "missing";
                n_missing += 1;
                None
            }
            Some(mut v) => {
                if unit.is_empty() {
                    quality = "suspect"; // unit not stated: assume canonical but flag it
                    n_assumed += 1;
                } else if unit != canon {
                    match convert(&indicator, &unit, v) {
                        Some(x) => {
                            v = x;
                            n_converted += 1;
                        }
                        None => {
                            bump(&mut rejected, "unconvertible_unit");
                            bump(&mut unknown, format!("unit:{}", c.unit));
                            continue;
                        }
                    }
                }
                let (lo, hi) = bounds.get(&indicator).copied().unwrap_or((f64::NEG_INFINITY, f64::INFINITY));
                if !(lo <= v && v <= hi) {
                    bump(&mut rejected, "implausible_value");
                    continue;
                }
                Some(round3(v))
            }
        };
        out.push(Record { astronaut: astro, indicator, measured_at, value, unit: None, quality: quality.into() });
    }

    let report = json!({
        "rows_in": t.rows.len(),
        "readings_clean": out.len(),
        "readings_missing_value": n_missing,
        "rejected": rejected,
        "unit_converted": n_converted,
        "unit_assumed_flagged_suspect": n_assumed,
        "flagged_suspect": n_flagged,
        "unrecognised": unknown,
        "configured_columns_not_found": cols_not_found,
    });
    Ok((out, report))
}

// ---------- loading ----------

fn bounds_from_db(conn: &Connection) -> Result<HashMap<String, (f64, f64)>, String> {
    let mut stmt = conn.prepare("SELECT code, plausible_min, plausible_max FROM indicators").map_err(|e| e.to_string())?;
    let it = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, (r.get::<_, f64>(1)?, r.get::<_, f64>(2)?))))
        .map_err(|e| e.to_string())?;
    it.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

/// Insert clean records. Returns (inserted, already_in_database).
pub fn load(conn: &Connection, records: &[Record], m: &Mapping) -> Result<(i64, i64), String> {
    let env = m.target.as_deref() == Some("env");
    let e = |x: rusqlite::Error| x.to_string();
    let tx = conn.unchecked_transaction().map_err(e)?;
    let units: HashMap<String, String> = {
        let mut stmt = tx.prepare("SELECT code, unit FROM indicators").map_err(e)?;
        let it = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).map_err(e)?;
        it.collect::<Result<_, _>>().map_err(e)?
    };
    let mut ids: HashMap<String, i64> = HashMap::new();
    let (mut inserted, mut dup) = (0i64, 0i64);
    for r in records {
        let n = if env {
            // A missing environmental value is "not available": no row is stored (never a NULL placeholder).
            if r.value.is_none() {
                continue;
            }
            tx.execute(
                "INSERT OR IGNORE INTO env_readings (measured_at,parameter,value,unit,source_name,quality) VALUES (?1,?2,?3,?4,?5,?6)",
                params![r.measured_at, r.indicator, r.value, r.unit.clone().unwrap_or_default(), m.source_name, r.quality],
            )
            .map_err(e)?
        } else {
            let aid = match ids.get(&r.astronaut) {
                Some(id) => *id,
                None => {
                    let found: Option<i64> = tx
                        .query_row("SELECT id FROM astronauts WHERE display_name=?1", params![r.astronaut], |x| x.get(0))
                        .ok();
                    let id = match found {
                        Some(id) => id,
                        None => {
                            tx.execute(
                                "INSERT INTO astronauts (display_name,is_synthetic,mission_setting) VALUES (?1,?2,?3)",
                                params![r.astronaut, if m.source_type == "simulated" { 1 } else { 0 }, m.mission_setting],
                            )
                            .map_err(e)?;
                            tx.last_insert_rowid()
                        }
                    };
                    ids.insert(r.astronaut.clone(), id);
                    id
                }
            };
            tx.execute(
                "INSERT OR IGNORE INTO measurements (astronaut_id,indicator_code,value,unit,measured_at,source_type,source_name,quality) \
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                params![aid, r.indicator, r.value, units.get(&r.indicator).cloned().unwrap_or_default(), r.measured_at, m.source_type, m.source_name, r.quality],
            )
            .map_err(e)?
        };
        inserted += n as i64;
        dup += 1 - n as i64;
    }
    tx.commit().map_err(e)?;
    Ok((inserted, dup))
}

fn write_clean_csv(conn: &Connection, records: &[Record], m: &Mapping, csv_path: &Path, dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let stem = csv_path.file_stem().and_then(|s| s.to_str()).unwrap_or("data");
    let mut w = csv::Writer::from_path(dir.join(format!("{stem}.clean.csv"))).map_err(|e| e.to_string())?;
    w.write_record(["astronaut", "indicator", "value", "unit", "measured_at", "source_name", "source_type", "quality"]).map_err(|e| e.to_string())?;
    let mut units: HashMap<String, String> = HashMap::new();
    if let Ok(mut stmt) = conn.prepare("SELECT code, unit FROM indicators") {
        if let Ok(it) = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))) {
            units.extend(it.flatten());
        }
    }
    for r in records {
        let unit = r.unit.clone().or_else(|| units.get(&r.indicator).cloned()).unwrap_or_default();
        w.write_record([
            r.astronaut.as_str(), r.indicator.as_str(), &r.value.map(|v| v.to_string()).unwrap_or_default(), &unit,
            r.measured_at.as_str(), m.source_name.as_str(), m.source_type.as_str(), r.quality.as_str(),
        ])
        .map_err(|e| e.to_string())?;
    }
    w.flush().map_err(|e| e.to_string())
}

/// Clean and report only; writes nothing to the database.
pub fn dry_run(conn: &Connection, csv_path: &Path, m: &Mapping) -> Result<Value, String> {
    let t = read_csv(csv_path, m.delimiter.as_deref())?;
    Ok(clean(&t, m, &bounds_from_db(conn)?)?.1)
}

/// Full pipeline: read -> clean -> load -> write data/clean copy -> log. Returns the report.
pub fn import_csv(conn: &Connection, csv_path: &Path, m: &Mapping, clean_dir: Option<&Path>) -> Result<Value, String> {
    let t = read_csv(csv_path, m.delimiter.as_deref())?;
    let (records, mut report) = clean(&t, m, &bounds_from_db(conn)?)?;
    let (inserted, dup) = load(conn, &records, m)?;
    if let Some(dir) = clean_dir {
        write_clean_csv(conn, &records, m, csv_path, dir)?;
    }
    if let Value::Object(o) = &mut report {
        o.insert("inserted".into(), json!(inserted));
        o.insert("already_in_database".into(), json!(dup));
    }
    conn.execute(
        "INSERT INTO import_log (file, source_name, report_json) VALUES (?1,?2,?3)",
        params![csv_path.file_name().and_then(|f| f.to_str()).unwrap_or(""), m.source_name, report.to_string()],
    )
    .map_err(|e| e.to_string())?;
    let _ = Map::<String, Value>::new();
    Ok(report)
}
