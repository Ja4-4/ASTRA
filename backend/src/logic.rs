//! Baselines, alert rules and recovery logic.
//!
//! Rules from the ASTRA guide: every alert states which rule fired and on which measurement;
//! wording only recommends review / discussion with the flight surgeon (never a diagnosis, never
//! an instruction to stop treatment); missing data stays missing.
use crate::db::{one, rows};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

/// Explain where a cabin reading sits relative to the trained ISS reference model
/// (models/env_baseline.json, produced by scripts/train_env_model.py from real EDA data).
/// The result always says which rule fired; it is a statistical comparison, not a safety limit.
pub fn assess_env(model: &Value, parameter: &str, value: f64) -> Option<Value> {
    let p = model.get("parameters")?.get(parameter)?;
    let g = |k: &str| p.get(k).and_then(Value::as_f64);
    let (wl, wh, al, ah) = (g("watch_low")?, g("watch_high")?, g("alert_low")?, g("alert_high")?);
    let (median, mad) = (g("median")?, g("mad")?);
    let unit = p.get("unit").and_then(Value::as_str).unwrap_or("");
    let (status, rule) = if value < al || value > ah {
        ("attention", format!("outside the 0.1-99.9 percentile band [{al}, {ah}] {unit} of past ISS missions"))
    } else if value < wl || value > wh {
        ("watch", format!("outside the 1-99 percentile band [{wl}, {wh}] {unit} of past ISS missions"))
    } else {
        ("typical", format!("inside the 1-99 percentile band [{wl}, {wh}] {unit} of past ISS missions"))
    };
    let robust_z = if mad > 0.0 { Some(((value - median) / (1.4826 * mad) * 100.0).round() / 100.0) } else { None };
    Some(json!({
        "parameter": parameter, "value": value, "unit": unit, "status": status,
        "rule_fired": rule, "reference_median": median, "robust_z": robust_z,
        "n_training_readings": p.get("n"), "source": model.get("trained_on"),
        "source_type": "imported", "note": model.get("disclaimer"),
    }))
}

pub const BASELINE_MIN_N: usize = 5; // need at least this many readings for a personal baseline
pub const BASELINE_WINDOW: i64 = 14; // baseline = the astronaut's first N valid readings

pub const DISCLAIMER: &str = "ASTRA supports self-assessment and follow-up; it is not a diagnosis. \
Follow the mission's approved medical procedures.";

pub fn escalation_text(e: &str) -> &'static str {
    match e {
        "self" => "Suggested next step: repeat the measurement and add it to your log.",
        "crew" => "Suggested next step: let a crew member check in with you and repeat the measurement.",
        _ => "Suggested next step: discuss this result with the flight surgeon.",
    }
}

pub fn now_iso() -> String {
    Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

#[derive(Clone, Copy, Debug)]
pub struct Baseline {
    pub mean: f64,
    pub sd: f64,
    pub n: i64,
}

impl Baseline {
    pub fn to_json(&self, astronaut_id: i64, code: &str) -> Value {
        json!({"astronaut_id": astronaut_id, "indicator_code": code, "mean": self.mean, "sd": self.sd, "n": self.n})
    }
}

pub fn compute_baseline(conn: &Connection, aid: i64, code: &str) -> rusqlite::Result<Option<Baseline>> {
    let mut stmt = conn.prepare(
        "SELECT value FROM measurements WHERE astronaut_id=?1 AND indicator_code=?2 AND value IS NOT NULL \
         AND quality != 'missing' ORDER BY measured_at LIMIT ?3",
    )?;
    let vals: Vec<f64> = stmt
        .query_map(params![aid, code, BASELINE_WINDOW], |r| r.get::<_, f64>(0))?
        .collect::<Result<_, _>>()?;
    if vals.len() < BASELINE_MIN_N {
        return Ok(None);
    }
    let n = vals.len() as f64;
    let mean = vals.iter().sum::<f64>() / n;
    let sd = (vals.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / n).sqrt(); // population sd
    conn.execute(
        "INSERT INTO baselines (astronaut_id,indicator_code,mean,sd,n,computed_at) VALUES (?1,?2,?3,?4,?5,?6) \
         ON CONFLICT(astronaut_id,indicator_code) DO UPDATE SET mean=excluded.mean, sd=excluded.sd, \
         n=excluded.n, computed_at=excluded.computed_at",
        params![aid, code, mean, sd, vals.len() as i64, now_iso()],
    )?;
    Ok(Some(Baseline { mean, sd, n: vals.len() as i64 }))
}

/// Stored baseline when complete (n == window); otherwise (re)compute so a young database
/// does not freeze a baseline built from only a few readings.
pub fn get_baseline(conn: &Connection, aid: i64, code: &str) -> rusqlite::Result<Option<Baseline>> {
    let stored = conn
        .query_row(
            "SELECT mean,sd,n FROM baselines WHERE astronaut_id=?1 AND indicator_code=?2",
            params![aid, code],
            |r| Ok(Baseline { mean: r.get(0)?, sd: r.get(1)?, n: r.get(2)? }),
        )
        .optional()?;
    match stored {
        Some(b) if b.n >= BASELINE_WINDOW => Ok(Some(b)),
        _ => Ok(compute_baseline(conn, aid, code)?.or(stored)),
    }
}

fn rule_text(rule: &Value, unit: &str, baseline: Option<&Baseline>) -> String {
    let p = rule["param"].as_f64().unwrap_or(0.0);
    match rule["rule_type"].as_str().unwrap_or("") {
        "threshold_high" => format!("value above {p} {unit}"),
        "threshold_low" => format!("value below {p} {unit}"),
        _ => {
            let b = baseline.expect("baseline rule without baseline");
            format!(
                "value differs from personal baseline ({:.1} {unit}, n={}) by at least {p} standard deviations",
                b.mean, b.n
            )
        }
    }
}

/// Run every rule for one measurement. Returns the alerts that were created.
pub fn evaluate_measurement(conn: &Connection, mid: i64) -> rusqlite::Result<Vec<Value>> {
    let Some(m) = one(conn, "SELECT * FROM measurements WHERE id=?1", params![mid])? else { return Ok(vec![]) };
    let Some(value) = m["value"].as_f64() else { return Ok(vec![]) };
    let code = m["indicator_code"].as_str().unwrap_or("").to_string();
    let aid = m["astronaut_id"].as_i64().unwrap_or(0);
    let when = m["measured_at"].as_str().unwrap_or("").to_string();
    let Some(ind) = one(conn, "SELECT * FROM indicators WHERE code=?1", params![code])? else { return Ok(vec![]) };
    let ind_name = ind["name"].as_str().unwrap_or("").to_string();
    let mut created = Vec::new();

    for rule in rows(conn, "SELECT * FROM alert_rules WHERE indicator_code=?1", params![code])? {
        let p = rule["param"].as_f64().unwrap_or(0.0);
        let mut baseline = None;
        let hit = match rule["rule_type"].as_str().unwrap_or("") {
            "threshold_high" => value > p,
            "threshold_low" => value < p,
            _ => {
                baseline = get_baseline(conn, aid, &code)?;
                match baseline {
                    // flat baselines are skipped, and so are the readings that formed the baseline itself
                    Some(b) if b.sd > 1e-9 => {
                        let upto: i64 = conn.query_row(
                            "SELECT COUNT(*) FROM measurements WHERE astronaut_id=?1 AND indicator_code=?2 \
                             AND value IS NOT NULL AND measured_at <= ?3",
                            params![aid, code, when],
                            |r| r.get(0),
                        )?;
                        upto > b.n && (value - b.mean).abs() / b.sd >= p
                    }
                    _ => false,
                }
            }
        };
        if !hit {
            continue;
        }
        let escalation = rule["escalation"].as_str().unwrap_or("self");
        let unvalidated = if rule["reviewed"].as_i64().unwrap_or(0) == 0 {
            "[Threshold not yet validated by the research partner.] "
        } else {
            ""
        };
        let explanation = format!(
            "{ind_name} was {value} {unit} on {when} (source: {src}, {stype}). Rule: {rt}. {msg} {esc} {unvalidated}{DISCLAIMER}",
            unit = m["unit"].as_str().unwrap_or(""),
            src = m["source_name"].as_str().unwrap_or(""),
            stype = m["source_type"].as_str().unwrap_or(""),
            rt = rule_text(&rule, ind["unit"].as_str().unwrap_or(""), baseline.as_ref()),
            msg = rule["message"].as_str().unwrap_or(""),
            esc = escalation_text(escalation),
        );
        let n = conn.execute(
            "INSERT OR IGNORE INTO alerts (astronaut_id,rule_id,measurement_id,triggered_at,severity,escalation,explanation) \
             VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![aid, rule["id"].as_i64(), mid, when, rule["severity"].as_str(), escalation, explanation],
        )?;
        if n > 0 {
            let id = conn.last_insert_rowid();
            if let Some(a) = one(conn, "SELECT * FROM alerts WHERE id=?1", params![id])? {
                created.push(a);
            }
        }
    }
    Ok(created)
}

/// Re-run the rules over every stored measurement (used after a bulk import).
pub fn evaluate_all(conn: &Connection) -> rusqlite::Result<usize> {
    let ids: Vec<i64> = {
        let mut stmt = conn.prepare("SELECT id FROM measurements WHERE value IS NOT NULL ORDER BY measured_at, id")?;
        let it = stmt.query_map([], |r| r.get::<_, i64>(0))?;
        it.collect::<Result<_, _>>()?
    };
    let mut n = 0;
    for id in ids {
        n += evaluate_measurement(conn, id)?.len();
    }
    Ok(n)
}

/// Overall status label for one indicator from its open alerts' severities.
pub fn status_for(severities: &[&str]) -> &'static str {
    let rank = |s: &str| match s {
        "info" => 1,
        "review" => 2,
        "urgent" => 3,
        _ => 0,
    };
    match severities.iter().map(|s| rank(s)).max() {
        None | Some(0) => "normal",
        Some(1) => "info",
        Some(2) => "review",
        _ => "urgent",
    }
}

pub fn recovery_summary(conn: &Connection, event_id: i64) -> rusqlite::Result<Option<Value>> {
    let Some(ev) = one(conn, "SELECT * FROM events WHERE id=?1", params![event_id])? else { return Ok(None) };
    let aid = ev["astronaut_id"].as_i64().unwrap_or(0);
    let trigger = match ev["alert_id"].as_i64() {
        Some(a) => one(
            conn,
            "SELECT m.* FROM alerts a JOIN measurements m ON m.id=a.measurement_id WHERE a.id=?1",
            params![a],
        )?,
        None => None,
    };
    let mut fus = Vec::new();
    for mut f in rows(conn, "SELECT * FROM follow_ups WHERE event_id=?1 ORDER BY due_at, id", params![event_id])? {
        f["result"] = Value::Null;
        f["toward_baseline"] = Value::Null;
        if let Some(rid) = f["result_measurement_id"].as_i64() {
            let r = one(conn, "SELECT value, unit, measured_at FROM measurements WHERE id=?1", params![rid])?;
            if let Some(r) = &r {
                let code = f["indicator_code"].as_str().unwrap_or("").to_string();
                let b = get_baseline(conn, aid, &code)?;
                if let (Some(rv), Some(t), Some(b)) = (
                    r["value"].as_f64(),
                    trigger.as_ref().and_then(|t| t["value"].as_f64()),
                    b,
                ) {
                    f["toward_baseline"] = json!((rv - b.mean).abs() < (t - b.mean).abs());
                }
            }
            f["result"] = r.unwrap_or(Value::Null);
        }
        fus.push(f);
    }
    Ok(Some(json!({"event": ev, "trigger_measurement": trigger, "follow_ups": fus})))
}
