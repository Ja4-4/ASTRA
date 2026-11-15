//! ASTRA eye screening — ONE Rust file: camera page + analysis + storage + API.
//!
//! How the camera is reached: a server cannot open the user's camera, so the page served at /eye
//! (embedded below) opens it in the browser, runs Google's ready-made MediaPipe FaceLandmarker
//! (small on-device model: face + iris landmarks + blink blendshapes) and posts only compact
//! numbers (+ one still image for sclera colour) to POST /api/eye/analyze. The video never leaves
//! the device. This module does all the analysis in Rust.
//!
//! What it measures (guide rules: show units/source, missing = "not available", explain every
//! rule that fired, never a diagnosis):
//!   * fatigue signs: PERCLOS, blink rate, slow blinks, micro-sleeps (+ the astronaut's own logged sleep)
//!   * visible eye signs: vergence/misalignment index, vertical offset, eyelid asymmetry,
//!     iris-size asymmetry, sclera redness / yellowness compared with the astronaut's OWN baseline
//! What it cannot do: name eye diseases. Cataract, glaucoma, retinopathy or spaceflight
//! neuro-ocular changes need fundus/OCT/clinical exams, not a webcam. Thresholds below are
//! placeholders (reviewed=false) that the clinical partner must validate.
use crate::api::Shared;
use axum::{
    extract::{DefaultBodyLimit, Query, State},
    http::StatusCode,
    response::Html,
    routing::{get, post},
    Json, Router,
};
use chrono::Utc;
use rusqlite::{params, Connection};
use serde::Deserialize;
use serde_json::{json, Value};

// ---------- thresholds (placeholders: reviewed = false) ----------
const CLOSED_T: f64 = 0.8; // blink blendshape >= this counts as "eye closed" (PERCLOS80 style)
const MIN_DURATION_S: f64 = 10.0;
const MIN_FRAMES: usize = 60;
const MIN_COVERAGE: f64 = 0.6; // share of camera frames in which a face was found
const SLOW_BLINK_MS: f64 = 400.0;
const MICROSLEEP_MS: f64 = 1000.0;
const PERCLOS_WATCH: f64 = 0.08;
const PERCLOS_HIGH: f64 = 0.15;
const SLOW_FRAC_HIGH: f64 = 0.30;
const BLINK_RATE_LOW: f64 = 8.0;
const BLINK_RATE_HIGH: f64 = 30.0;
const SLEEP_LOW_H: f64 = 6.0;
const SLEEP_MAX_AGE_H: f64 = 48.0;
const VERGENCE_T: f64 = 0.15;
const VERT_T: f64 = 0.10;
const LID_ASYM_T: f64 = 0.30;
const IRIS_RATIO_LO: f64 = 0.85;
const IRIS_RATIO_HI: f64 = 1.18;
const RED_DELTA_T: f64 = 3.0; // CIELAB a* increase vs own baseline
const YEL_DELTA_T: f64 = 4.0; // CIELAB b* increase vs own baseline
const BASELINE_MIN: usize = 3;
const BASELINE_MAX: usize = 5;
const STATUS_ATTENTION: i64 = 50;
const STATUS_WATCH: i64 = 25;
const DISCLAIMER: &str = "ASTRA eye screening shows visible signs and fatigue indicators from a camera. \
It is not a diagnosis and cannot detect eye diseases; talk to the flight surgeon about anything that worries you.";

const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS eye_screenings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    astronaut_id INTEGER NOT NULL REFERENCES astronauts(id),
    taken_at TEXT NOT NULL,
    duration_s REAL, frames INTEGER, coverage REAL,
    perclos REAL, blink_rate REAL, slow_blink_frac REAL, microsleeps INTEGER,
    vergence REAL, vert_diff REAL, lid_asym REAL, iris_ratio REAL,
    sclera_l REAL, sclera_a REAL, sclera_b REAL,
    fatigue_score INTEGER, status TEXT NOT NULL,
    details TEXT NOT NULL,
    source_type TEXT NOT NULL DEFAULT 'real',
    source_name TEXT NOT NULL DEFAULT 'Browser camera + MediaPipe FaceLandmarker'
);
CREATE INDEX IF NOT EXISTS idx_eye_lookup ON eye_screenings (astronaut_id, taken_at);";

// ---------- input ----------
#[derive(Deserialize, Clone, Debug)]
pub struct Frame {
    pub t: f64,        // ms since capture start
    pub bl: [f64; 2],  // eyeBlink blendshape, 0..1 (two eyes)
    pub pts: Vec<f64>, // 22 points (x,y pixels): eye A (6 contour, iris, 4 ring), eye B (same)
}

#[derive(Deserialize, Clone, Debug)]
pub struct Capture {
    pub astronaut_id: i64,
    pub frames: Vec<Frame>,
    pub attempted: Option<u32>,
    pub fixation_from_ms: Option<f64>,
    pub fixation_to_ms: Option<f64>,
    pub still_jpeg_b64: Option<String>,
    pub still_pts: Option<Vec<f64>>,
}

// ---------- geometry ----------
type P = (f64, f64);
const NPTS: usize = 22;
const A: usize = 0; // eye A starts at point 0: outer=0 inner=3 iris=6 ring=7..=10
const B: usize = 11; // eye B starts at point 11: inner=0 outer=3 iris=6 ring=7..=10

fn dist(a: P, b: P) -> f64 {
    ((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)).sqrt()
}

fn points(p: &[f64]) -> Option<Vec<P>> {
    if p.len() != NPTS * 2 || p.iter().any(|v| !v.is_finite()) {
        return None;
    }
    Some(p.chunks(2).map(|c| (c[0], c[1])).collect())
}

/// Remove head roll: rotate all points so the line between the two outer eye corners is horizontal.
fn derotate(p: &[P]) -> Vec<P> {
    let (a, b) = (p[A], p[B + 3]);
    let th = (b.1 - a.1).atan2(b.0 - a.0);
    let (c, s) = ((-th).cos(), (-th).sin());
    let m = ((a.0 + b.0) / 2.0, (a.1 + b.1) / 2.0);
    p.iter().map(|q| (m.0 + (q.0 - m.0) * c - (q.1 - m.1) * s, m.1 + (q.0 - m.0) * s + (q.1 - m.1) * c)).collect()
}

struct Eye {
    ear: f64,
    nasal: f64,  // 0 = iris at outer corner, 1 = at inner corner
    vert: f64,   // iris vertical offset from eyelid mid-line, in eye widths (image down = +)
    iris_d: f64, // iris diameter in eye widths
}

fn eye(p: &[P], base: usize, outer: usize, inner: usize) -> Option<Eye> {
    let (o, i) = (p[base + outer], p[base + inner]);
    let w = dist(o, i);
    if w < 5.0 {
        return None;
    }
    let ear = (dist(p[base + 1], p[base + 5]) + dist(p[base + 2], p[base + 4])) / (2.0 * w);
    let iris = p[base + 6];
    let ax = ((i.0 - o.0) / w, (i.1 - o.1) / w);
    let nasal = ((iris.0 - o.0) * ax.0 + (iris.1 - o.1) * ax.1) / w;
    let mid_y = (p[base + 1].1 + p[base + 2].1 + p[base + 4].1 + p[base + 5].1) / 4.0;
    let vert = (iris.1 - mid_y) / w;
    let iris_d = 2.0 * (7..=10).map(|k| dist(p[base + k], iris)).sum::<f64>() / 4.0 / w;
    Some(Eye { ear, nasal, vert, iris_d })
}

fn median(v: &mut Vec<f64>) -> Option<f64> {
    v.retain(|x| x.is_finite());
    if v.is_empty() {
        return None;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let n = v.len();
    Some(if n % 2 == 1 { v[n / 2] } else { (v[n / 2 - 1] + v[n / 2]) / 2.0 })
}

fn r(x: f64, d: i32) -> f64 {
    let k = 10f64.powi(d);
    (x * k).round() / k
}

// ---------- metrics from the frame sequence ----------
#[derive(Debug, Default, Clone)]
pub struct Metrics {
    pub duration_s: f64,
    pub frames: usize,
    pub coverage: Option<f64>,
    pub perclos: f64,
    pub blinks: usize,
    pub blink_rate: f64,
    pub slow_frac: Option<f64>,
    pub microsleeps: usize,
    pub vergence: Option<f64>,
    pub vert_diff: Option<f64>,
    pub lid_asym: Option<f64>,
    pub iris_ratio: Option<f64>,
}

pub fn analyze_frames(cap: &Capture) -> Result<Metrics, String> {
    let mut fr: Vec<(f64, f64, Vec<P>)> = cap
        .frames
        .iter()
        .filter(|f| f.t.is_finite() && f.bl.iter().all(|b| b.is_finite()))
        .filter_map(|f| points(&f.pts).map(|p| (f.t, (f.bl[0] + f.bl[1]) / 2.0, derotate(&p))))
        .collect();
    fr.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    let n = fr.len();
    if n < MIN_FRAMES {
        return Err(format!("not available: only {n} usable frames (need {MIN_FRAMES})"));
    }
    let dur = (fr[n - 1].0 - fr[0].0) / 1000.0;
    if dur < MIN_DURATION_S {
        return Err(format!("not available: capture lasted {dur:.1} s (need {MIN_DURATION_S} s)"));
    }
    let coverage = cap.attempted.filter(|a| *a > 0).map(|a| n as f64 / a as f64);
    if let Some(c) = coverage {
        if c < MIN_COVERAGE {
            return Err(format!("not available: face found in only {:.0}% of frames (need {:.0}%)", c * 100.0, MIN_COVERAGE * 100.0));
        }
    }
    let mut dts: Vec<f64> = fr.windows(2).map(|w| w[1].0 - w[0].0).collect();
    let typical_dt = median(&mut dts).unwrap_or(66.0).clamp(10.0, 200.0);
    let dt_of = |i: usize| if i + 1 < n { (fr[i + 1].0 - fr[i].0).clamp(0.0, 200.0) } else { typical_dt };

    // PERCLOS and blink events
    let (mut closed_ms, mut total_ms) = (0.0, 0.0);
    let mut runs: Vec<f64> = vec![]; // durations in ms
    let mut run_start: Option<f64> = None;
    for i in 0..n {
        let dt = dt_of(i);
        total_ms += dt;
        let closed = fr[i].1 >= CLOSED_T;
        if closed {
            closed_ms += dt;
            if run_start.is_none() {
                run_start = Some(fr[i].0);
            }
        }
        let gap = i + 1 < n && fr[i + 1].0 - fr[i].0 > 300.0;
        if let Some(s) = run_start {
            if !closed || gap || i + 1 == n {
                let end = if closed { fr[i].0 + dt } else { fr[i].0 };
                runs.push((end - s).max(dt));
                run_start = None;
            }
        }
    }
    let microsleeps = runs.iter().filter(|d| **d >= MICROSLEEP_MS).count();
    let blinks: Vec<f64> = runs.iter().cloned().filter(|d| *d < MICROSLEEP_MS).collect();
    let slow = blinks.iter().filter(|d| **d > SLOW_BLINK_MS).count();

    // eye geometry on open-eye frames
    let fix_from = cap.fixation_from_ms.unwrap_or(fr[0].0);
    let fix_to = cap.fixation_to_ms.unwrap_or(fr[0].0 + 8000.0);
    let (mut asym, mut verg, mut vert, mut iris) = (vec![], vec![], vec![], vec![]);
    for (t, c, p) in &fr {
        if *c > 0.4 {
            continue;
        }
        let (Some(a), Some(b)) = (eye(p, A, 0, 3), eye(p, B, 3, 0)) else { continue };
        if a.ear > 0.15 && b.ear > 0.15 {
            asym.push((a.ear - b.ear).abs() / a.ear.max(b.ear));
            if *t >= fix_from && *t <= fix_to {
                verg.push(a.nasal + b.nasal - 1.0);
                vert.push(a.vert - b.vert);
                if b.iris_d > 0.0 {
                    iris.push(a.iris_d / b.iris_d);
                }
            }
        }
    }
    Ok(Metrics {
        duration_s: dur,
        frames: n,
        coverage,
        perclos: closed_ms / total_ms.max(1.0),
        blinks: blinks.len(),
        blink_rate: blinks.len() as f64 * 60.0 / dur,
        slow_frac: if blinks.is_empty() { None } else { Some(slow as f64 / blinks.len() as f64) },
        microsleeps,
        vergence: median(&mut verg),
        vert_diff: median(&mut vert),
        lid_asym: median(&mut asym),
        iris_ratio: median(&mut iris),
    })
}

// ---------- sclera colour from the still image ----------
fn srgb_to_lab(r: f64, g: f64, b: f64) -> (f64, f64, f64) {
    let lin = |c: f64| {
        let c = c / 255.0;
        if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
    };
    let (r, g, b) = (lin(r), lin(g), lin(b));
    let x = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
    let y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
    let z = 0.0193339 * r + 0.1191920 * g + 0.9503041 * b;
    let f = |t: f64| if t > 0.008856 { t.cbrt() } else { 7.787 * t + 16.0 / 116.0 };
    let (fx, fy, fz) = (f(x / 0.95047), f(y), f(z / 1.08883));
    (116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz))
}

fn b64(s: &str) -> Option<Vec<u8>> {
    let s = s.split_once(',').map(|x| x.1).unwrap_or(s); // allow a data: URL prefix
    let (mut out, mut acc, mut bits) = (Vec::with_capacity(s.len() * 3 / 4), 0u32, 0);
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' | b'\n' | b'\r' | b' ' => continue,
            _ => return None,
        } as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

/// Median sclera colour (CIELAB) sampled beside the iris of both eyes; None if not enough clean pixels.
pub fn sclera_lab(jpeg: &[u8], pts: &[f64]) -> Option<(f64, f64, f64, usize)> {
    let img = image::load_from_memory_with_format(jpeg, image::ImageFormat::Jpeg).ok()?.to_rgb8();
    let p = points(pts)?;
    let (mut rs, mut gs, mut bs) = (vec![], vec![], vec![]);
    for (base, outer, inner) in [(A, 0usize, 3usize), (B, 3, 0)] {
        let (o, i, c) = (p[base + outer], p[base + inner], p[base + 6]);
        let w = dist(o, i);
        if w < 20.0 {
            continue;
        }
        let ax = ((i.0 - o.0) / w, (i.1 - o.1) / w);
        let nrm = (-ax.1, ax.0);
        let rad = (7..=10).map(|k| dist(p[base + k], c)).sum::<f64>() / 4.0;
        let along_c = (c.0 - o.0) * ax.0 + (c.1 - o.1) * ax.1;
        // outer-side and inner-side stretches between the corner and the iris edge
        for (a0, a1) in [(0.14 * w, along_c - 1.3 * rad), (along_c + 1.3 * rad, 0.86 * w)] {
            if a1 - a0 < 0.4 * rad {
                continue;
            }
            for s in 0..8 {
                let a = a0 + (a1 - a0) * (s as f64 + 0.5) / 8.0;
                for off in [-0.3, 0.0, 0.3] {
                    let (x, y) = (o.0 + ax.0 * a + nrm.0 * off * rad, o.1 + ax.1 * a + nrm.1 * off * rad);
                    if x < 0.0 || y < 0.0 || x >= img.width() as f64 || y >= img.height() as f64 {
                        continue;
                    }
                    let px = img.get_pixel(x as u32, y as u32).0;
                    let luma = 0.2126 * px[0] as f64 + 0.7152 * px[1] as f64 + 0.0722 * px[2] as f64;
                    if (70.0..=245.0).contains(&luma) {
                        rs.push(px[0] as f64);
                        gs.push(px[1] as f64);
                        bs.push(px[2] as f64);
                    }
                }
            }
        }
    }
    let n = rs.len();
    if n < 20 {
        return None;
    }
    let (l, a, b) = srgb_to_lab(median(&mut rs)?, median(&mut gs)?, median(&mut bs)?);
    Some((l, a, b, n))
}

// ---------- scoring: every rule that fires is listed ----------
fn rule(name: &str, measured: String, thr: &str, pts: i64, source: &str) -> Value {
    json!({"rule": name, "measured": measured, "threshold": thr, "points": pts, "source": source, "reviewed": false})
}

fn sign(name: &str, measured: String, thr: &str, action: &str) -> Value {
    json!({"sign": name, "measured": measured, "threshold": thr, "confidence": "low", "suggested_action": action})
}

pub fn score(m: &Metrics, d_a: Option<f64>, sleep: Option<(f64, f64)>) -> (i64, &'static str, Vec<Value>, Vec<Value>) {
    let (mut pts, mut rules, mut signs) = (0i64, vec![], vec![]);
    let cam = "camera";
    if m.perclos >= PERCLOS_HIGH {
        pts += 35;
        rules.push(rule("PERCLOS high", format!("{:.1}% of time eyes closed", m.perclos * 100.0), ">= 15%", 35, cam));
    } else if m.perclos >= PERCLOS_WATCH {
        pts += 15;
        rules.push(rule("PERCLOS raised", format!("{:.1}% of time eyes closed", m.perclos * 100.0), ">= 8%", 15, cam));
    }
    if let Some(f) = m.slow_frac {
        if f >= SLOW_FRAC_HIGH && m.blinks >= 5 {
            pts += 20;
            rules.push(rule("Slow blinks", format!("{:.0}% of {} blinks > {} ms", f * 100.0, m.blinks, SLOW_BLINK_MS), ">= 30%", 20, cam));
        }
    }
    if m.microsleeps > 0 {
        pts += 25;
        rules.push(rule("Micro-sleep", format!("{} eye closure(s) >= {} ms", m.microsleeps, MICROSLEEP_MS), ">= 1", 25, cam));
    }
    if m.blink_rate < BLINK_RATE_LOW || m.blink_rate > BLINK_RATE_HIGH {
        pts += 10;
        rules.push(rule("Unusual blink rate", format!("{:.1} blinks/min", m.blink_rate), "< 8 or > 30 per min", 10, cam));
    }
    if let Some(d) = d_a {
        if d >= RED_DELTA_T {
            pts += 10;
            rules.push(rule("Sclera redder than own baseline", format!("a* +{d:.1}"), ">= +3.0", 10, cam));
        }
    }
    if let Some((h, age_h)) = sleep {
        if age_h <= SLEEP_MAX_AGE_H && h < SLEEP_LOW_H {
            pts += 15;
            rules.push(rule("Low logged sleep", format!("{h:.1} h ({age_h:.0} h ago)"), "< 6 h", 15, "health log"));
        }
    }
    if let Some(v) = m.vergence {
        if v.abs() > VERGENCE_T {
            signs.push(sign("Possible eye misalignment", format!("vergence index {v:+.2}"), "|index| > 0.15",
                "Repeat once with the face straight to the camera; if it persists, tell the flight surgeon."));
        }
    }
    if let Some(v) = m.vert_diff {
        if v.abs() > VERT_T {
            signs.push(sign("Vertical offset between eyes", format!("{v:+.2} eye-widths"), "|offset| > 0.10",
                "Repeat the capture with the head level; if it persists, mention it to the flight surgeon."));
        }
    }
    if let Some(v) = m.lid_asym {
        if v > LID_ASYM_T {
            signs.push(sign("Eyelid opening differs between eyes", format!("{:.0}% difference", v * 100.0), "> 30%",
                "Check lighting and head angle, repeat; a lasting difference should be reviewed by the flight surgeon."));
        }
    }
    if let Some(v) = m.iris_ratio {
        if !(IRIS_RATIO_LO..=IRIS_RATIO_HI).contains(&v) {
            signs.push(sign("Iris size differs between eyes", format!("ratio {v:.2}"), "outside 0.85-1.18",
                "Pupil/iris size depends on light; repeat under even lighting before drawing any conclusion."));
        }
    }
    if let Some(d) = d_a {
        if d >= RED_DELTA_T {
            signs.push(sign("Whites of the eyes redder than usual", format!("a* +{d:.1}"), ">= +3.0",
                "Non-specific (tiredness, dryness, irritation). Repeat later; report if it persists or hurts."));
        }
    }
    let status = if pts >= STATUS_ATTENTION { "attention" } else if pts >= STATUS_WATCH { "watch" } else { "ok" };
    (pts, status, rules, signs)
}

// ---------- storage ----------
fn baseline(conn: &Connection, aid: i64) -> (usize, Option<(f64, f64)>) {
    let mut st = match conn.prepare(
        "SELECT sclera_a, sclera_b FROM eye_screenings WHERE astronaut_id=?1 AND sclera_a IS NOT NULL ORDER BY taken_at LIMIT ?2",
    ) {
        Ok(s) => s,
        Err(_) => return (0, None),
    };
    let rows: Vec<(f64, f64)> = st
        .query_map(params![aid, BASELINE_MAX as i64], |r| Ok((r.get(0)?, r.get(1)?)))
        .map(|it| it.flatten().collect())
        .unwrap_or_default();
    let n = rows.len();
    if n < BASELINE_MIN {
        return (n, None);
    }
    let (mut a, mut b): (Vec<f64>, Vec<f64>) = rows.into_iter().unzip();
    (n, Some((median(&mut a).unwrap(), median(&mut b).unwrap())))
}

fn latest_sleep(conn: &Connection, aid: i64) -> Option<(f64, f64)> {
    let (v, at): (f64, String) = conn
        .query_row(
            "SELECT value, measured_at FROM measurements WHERE astronaut_id=?1 AND indicator_code='sleep_hours' AND value IS NOT NULL ORDER BY measured_at DESC LIMIT 1",
            params![aid],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok()?;
    let t = chrono::DateTime::parse_from_rfc3339(&at).ok()?;
    Some((v, (Utc::now() - t.with_timezone(&Utc)).num_minutes() as f64 / 60.0))
}

type R = Result<Json<Value>, (StatusCode, Json<Value>)>;
fn err(code: StatusCode, msg: impl Into<String>) -> (StatusCode, Json<Value>) {
    (code, Json(json!({ "detail": msg.into() })))
}

/// Full pipeline on one capture: metrics -> sclera colour -> baseline -> score -> store.
pub fn run(conn: &Connection, cap: &Capture) -> Result<Value, (StatusCode, String)> {
    conn.execute_batch(SCHEMA).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let known: i64 = conn.query_row("SELECT COUNT(*) FROM astronauts WHERE id=?1", params![cap.astronaut_id], |r| r.get(0)).unwrap_or(0);
    if known == 0 {
        return Err((StatusCode::NOT_FOUND, format!("astronaut {} not found", cap.astronaut_id)));
    }
    let m = analyze_frames(cap).map_err(|e| (StatusCode::UNPROCESSABLE_ENTITY, e))?;
    let sclera = match (&cap.still_jpeg_b64, &cap.still_pts) {
        (Some(j), Some(p)) => b64(j).and_then(|bytes| sclera_lab(&bytes, p)),
        _ => None,
    };
    let (n_base, base) = baseline(conn, cap.astronaut_id);
    let d_a = match (sclera, base) {
        (Some((_, a, _, _)), Some((ba, _))) => Some(a - ba),
        _ => None,
    };
    let d_b = match (sclera, base) {
        (Some((_, _, b, _)), Some((_, bb))) => Some(b - bb),
        _ => None,
    };
    let sleep = latest_sleep(conn, cap.astronaut_id);
    let (pts, status, rules, mut signs) = score(&m, d_a, sleep);
    if let Some(d) = d_b {
        if d >= YEL_DELTA_T {
            signs.push(sign("Whites of the eyes yellower than usual", format!("b* +{d:.1}"), ">= +4.0",
                "Non-specific and lighting-dependent. Repeat in daylight-like light; report to the flight surgeon if it persists."));
        }
    }
    let taken = Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let metrics = json!({
        "duration_s": r(m.duration_s, 1), "frames": m.frames, "coverage": m.coverage.map(|c| r(c, 2)),
        "perclos": r(m.perclos, 3), "blinks": m.blinks, "blink_rate_per_min": r(m.blink_rate, 1),
        "slow_blink_fraction": m.slow_frac.map(|v| r(v, 2)), "microsleeps": m.microsleeps,
        "vergence_index": m.vergence.map(|v| r(v, 3)), "vertical_offset": m.vert_diff.map(|v| r(v, 3)),
        "eyelid_asymmetry": m.lid_asym.map(|v| r(v, 3)), "iris_size_ratio": m.iris_ratio.map(|v| r(v, 3)),
        "sclera_lab": sclera.map(|(l, a, b, n)| json!({"L": r(l, 1), "a": r(a, 1), "b": r(b, 1), "samples": n}))
            .unwrap_or(json!("not available")),
    });
    let details = json!({"metrics": metrics, "rules_fired": rules, "visible_signs": signs});
    conn.execute(
        "INSERT INTO eye_screenings (astronaut_id,taken_at,duration_s,frames,coverage,perclos,blink_rate,slow_blink_frac,microsleeps,vergence,vert_diff,lid_asym,iris_ratio,sclera_l,sclera_a,sclera_b,fatigue_score,status,details)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)",
        params![cap.astronaut_id, taken, m.duration_s, m.frames as i64, m.coverage, m.perclos, m.blink_rate, m.slow_frac,
            m.microsleeps as i64, m.vergence, m.vert_diff, m.lid_asym, m.iris_ratio,
            sclera.map(|s| s.0), sclera.map(|s| s.1), sclera.map(|s| s.2), pts, status, details.to_string()],
    )
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let id = conn.last_insert_rowid();
    Ok(json!({
        "id": id, "astronaut_id": cap.astronaut_id, "taken_at": taken, "status": status, "fatigue_score": pts,
        "metrics": metrics, "rules_fired": details["rules_fired"], "visible_signs": details["visible_signs"],
        "baseline": match base { Some((a, b)) => json!({"n": n_base, "a": r(a, 1), "b": r(b, 1)}),
            None => json!(format!("not established yet ({n_base}/{BASELINE_MIN} captures with sclera colour)")) },
        "logged_sleep_hours": sleep.map(|s| json!({"hours": s.0, "age_h": r(s.1, 0), "source": "health log"})).unwrap_or(json!("not available")),
        "source": {"type": "real", "name": "Browser camera + MediaPipe FaceLandmarker"},
        "disclaimer": DISCLAIMER,
    }))
}

// ---------- HTTP ----------
async fn analyze_route(State(s): State<Shared>, Json(cap): Json<Capture>) -> R {
    let conn = s.conn.lock().unwrap_or_else(|e| e.into_inner());
    run(&conn, &cap).map(Json).map_err(|(c, m)| err(c, m))
}

#[derive(Deserialize)]
struct HistQ {
    astronaut_id: i64,
    limit: Option<i64>,
}

async fn history_route(State(s): State<Shared>, Query(q): Query<HistQ>) -> R {
    let conn = s.conn.lock().unwrap_or_else(|e| e.into_inner());
    conn.execute_batch(SCHEMA).map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let mut st = conn
        .prepare("SELECT id,taken_at,fatigue_score,status,perclos,blink_rate,details FROM eye_screenings WHERE astronaut_id=?1 ORDER BY taken_at DESC LIMIT ?2")
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let rows: Vec<Value> = st
        .query_map(params![q.astronaut_id, q.limit.unwrap_or(30).clamp(1, 500)], |r| {
            let det: String = r.get(6)?;
            Ok(json!({"id": r.get::<_, i64>(0)?, "taken_at": r.get::<_, String>(1)?, "fatigue_score": r.get::<_, i64>(2)?,
                "status": r.get::<_, String>(3)?, "perclos": r.get::<_, Option<f64>>(4)?, "blink_rate": r.get::<_, Option<f64>>(5)?,
                "details": serde_json::from_str::<Value>(&det).unwrap_or(Value::Null)}))
        })
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .flatten()
        .collect();
    Ok(Json(json!(rows)))
}

async fn model_route() -> Json<Value> {
    Json(json!({
        "landmark_model": "Google MediaPipe FaceLandmarker (ready-made, runs in the browser; face + iris landmarks + blink blendshapes)",
        "analysis": "rule-based, transparent, in Rust (this file)",
        "trained_on_eye_disease_data": false,
        "why_no_disease_names": "Eye diseases need fundus/OCT/clinical exams; a webcam cannot diagnose them. Outputs are fatigue indicators and non-specific visible signs.",
        "thresholds_reviewed": false,
        "thresholds": {"closed_blink_score": CLOSED_T, "perclos_watch": PERCLOS_WATCH, "perclos_high": PERCLOS_HIGH,
            "slow_blink_ms": SLOW_BLINK_MS, "microsleep_ms": MICROSLEEP_MS, "slow_fraction_high": SLOW_FRAC_HIGH,
            "blink_rate_range_per_min": [BLINK_RATE_LOW, BLINK_RATE_HIGH], "low_sleep_hours": SLEEP_LOW_H,
            "vergence": VERGENCE_T, "vertical_offset": VERT_T, "eyelid_asymmetry": LID_ASYM_T,
            "iris_ratio_range": [IRIS_RATIO_LO, IRIS_RATIO_HI], "sclera_red_delta_a": RED_DELTA_T, "sclera_yellow_delta_b": YEL_DELTA_T,
            "status_watch_points": STATUS_WATCH, "status_attention_points": STATUS_ATTENTION},
        "disclaimer": DISCLAIMER,
    }))
}

/// Mounted under /api by the main router.
pub fn api_routes() -> Router<Shared> {
    Router::new()
        .route("/eye/analyze", post(analyze_route).layer(DefaultBodyLimit::max(30 * 1024 * 1024)))
        .route("/eye/history", get(history_route))
        .route("/eye/model", get(model_route))
}

/// Camera page at /eye.
pub fn page_routes() -> Router<Shared> {
    Router::new().route("/eye", get(|| async { Html(PAGE) }))
}

const PAGE: &str = r##"<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ASTRA – فحص العين بالكاميرا</title>
<style>
body{font-family:system-ui,Segoe UI,Tahoma,sans-serif;background:#0b1020;color:#e8ecf5;margin:0;padding:16px;max-width:900px;margin-inline:auto}
h1{font-size:20px} .card{background:#141b34;border:1px solid #26305a;border-radius:12px;padding:14px;margin:12px 0}
video{width:100%;max-width:520px;border-radius:12px;background:#000;transform:scaleX(-1)} button{background:#3b82f6;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-size:16px;cursor:pointer}
button:disabled{opacity:.5} select{padding:8px;border-radius:8px} .ok{color:#34d399}.watch{color:#fbbf24}.attention{color:#f87171}
.small{font-size:13px;color:#9aa6c8} table{border-collapse:collapse;width:100%} td{padding:4px 8px;border-bottom:1px solid #26305a}
.bar{height:8px;background:#26305a;border-radius:4px;overflow:hidden}.bar>div{height:100%;background:#3b82f6;width:0}
</style></head><body>
<h1>ASTRA – فحص العين بالكاميرا <span class="small">(عرض تجريبي · ليس تشخيصاً طبياً)</span></h1>
<div class="card small">الفيديو لا يغادر جهازك: يعمل نموذج Google MediaPipe داخل المتصفح، ويُرسل إلى الخادم أرقام مختصرة وصورة ثابتة واحدة لقياس لون بياض العين.
أفضل نتيجة: إضاءة أمامية متساوية، بدون نظارات، وجهك في منتصف الصورة وعلى مسافة ذراع.</div>
<div class="card"><label>رائد الفضاء: <select id="who"></select></label>
 <button id="go" disabled>جارٍ تحميل النموذج…</button> <span id="msg" class="small"></span>
 <div class="bar" style="margin-top:10px"><div id="prog"></div></div><br><video id="v" autoplay playsinline muted></video><canvas id="c" hidden></canvas></div>
<div id="out"></div>
<script type="module">
import {FaceLandmarker, FilesetResolver} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/vision_bundle.mjs";
const $=id=>document.getElementById(id), DURATION=30000, FIX_MS=8000, STILL_AT=15000, FPS=15;
const IDX=[33,160,158,133,153,144,468,469,470,471,472, 362,385,387,263,373,380,473,474,475,476,477];
let lm=null;
fetch('/api/astronauts').then(r=>r.json()).then(a=>{$('who').innerHTML=a.map(x=>`<option value="${x.id}">${x.display_name}</option>`).join('')});
try{
  const fs=await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/wasm");
  lm=await FaceLandmarker.createFromOptions(fs,{baseOptions:{modelAssetPath:"https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"},runningMode:"VIDEO",numFaces:1,outputFaceBlendshapes:true});
  $('go').disabled=false;$('go').textContent='ابدأ الفحص (30 ثانية)';
}catch(e){$('msg').textContent='تعذّر تحميل النموذج (يحتاج إنترنت): '+e}
function pts(res,W,H){const l=res.faceLandmarks[0];const o=[];for(const i of IDX){o.push(l[i].x*W,l[i].y*H)}return o}
function blink(res){const c=res.faceBlendshapes[0].categories;let a=0,b=0;for(const k of c){if(k.categoryName==='eyeBlinkLeft')a=k.score;if(k.categoryName==='eyeBlinkRight')b=k.score}return [a,b]}
$('go').onclick=async()=>{
  $('go').disabled=true;$('out').innerHTML='';
  const v=$('v');
  try{v.srcObject=await navigator.mediaDevices.getUserMedia({video:{width:1280,height:720,facingMode:'user'},audio:false})}catch(e){$('msg').textContent='لا يمكن فتح الكاميرا: '+e;$('go').disabled=false;return}
  await v.play();const W=v.videoWidth,H=v.videoHeight,frames=[];let attempted=0,still=null,stillPts=null;const t0=performance.now();
  $('msg').textContent='انظر إلى الكاميرا مباشرة ثم رمّش بشكل طبيعي…';
  await new Promise(done=>{const tick=()=>{const t=performance.now()-t0;$('prog').style.width=Math.min(100,t/DURATION*100)+'%';
    if(t>=DURATION){done();return}
    attempted++;
    try{const res=lm.detectForVideo(v,performance.now());
      if(res.faceLandmarks.length&&res.faceBlendshapes.length){const p=pts(res,W,H),b=blink(res);frames.push({t:Math.round(t),bl:b,pts:p});
        if(!still&&t>=STILL_AT&&b[0]<0.2&&b[1]<0.2){const c=$('c');c.width=W;c.height=H;c.getContext('2d').drawImage(v,0,0,W,H);still=c.toDataURL('image/jpeg',0.92);stillPts=p}}
    }catch(e){}
    setTimeout(tick,1000/FPS)};tick()});
  v.srcObject.getTracks().forEach(t=>t.stop());
  $('msg').textContent='جارٍ التحليل…';
  const r=await fetch('/api/eye/analyze',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({astronaut_id:+$('who').value,frames,attempted,fixation_from_ms:0,fixation_to_ms:FIX_MS,still_jpeg_b64:still,still_pts:stillPts})});
  const j=await r.json();$('go').disabled=false;$('msg').textContent='';
  if(!r.ok){$('out').innerHTML=`<div class="card attention">${j.detail}</div>`;return}
  const L={ok:'طبيعي',watch:'يستحق الانتباه',attention:'يحتاج مراجعة'}[j.status];
  const m=j.metrics,f=x=>x==null?'غير متاح':x;
  $('out').innerHTML=`<div class="card"><h2 class="${j.status}">${L} · درجة الإرهاق ${j.fatigue_score}/100</h2>
  <b>القواعد التي انطلقت:</b><ul>${j.rules_fired.map(x=>`<li>${x.rule}: ${x.measured} (الحد ${x.threshold}) +${x.points} <span class="small">[${x.source}]</span></li>`).join('')||'<li>لا شيء</li>'}</ul>
  <b>علامات ظاهرة (ثقة منخفضة):</b><ul>${j.visible_signs.map(x=>`<li>${x.sign}: ${x.measured} – ${x.suggested_action}</li>`).join('')||'<li>لا شيء</li>'}</ul>
  <table><tr><td>PERCLOS</td><td>${(m.perclos*100).toFixed(1)}%</td><td>معدل الرمش</td><td>${m.blink_rate_per_min}/د</td></tr>
  <tr><td>رمشات بطيئة</td><td>${f(m.slow_blink_fraction)}</td><td>غفوات ≥1ث</td><td>${m.microsleeps}</td></tr>
  <tr><td>مؤشر الانحراف (vergence)</td><td>${f(m.vergence_index)}</td><td>فرق ارتفاع العينين</td><td>${f(m.vertical_offset)}</td></tr>
  <tr><td>عدم تماثل الجفنين</td><td>${f(m.eyelid_asymmetry)}</td><td>نسبة حجم القزحية</td><td>${f(m.iris_size_ratio)}</td></tr>
  <tr><td>لون بياض العين (Lab)</td><td colspan="3">${typeof m.sclera_lab==='string'?'غير متاح':`L ${m.sclera_lab.L} · a ${m.sclera_lab.a} · b ${m.sclera_lab.b}`}</td></tr>
  <tr><td>خط الأساس</td><td colspan="3">${typeof j.baseline==='string'?j.baseline:`جاهز (n=${j.baseline.n})`}</td></tr>
  <tr><td>النوم المسجَّل</td><td colspan="3">${typeof j.logged_sleep_hours==='string'?'غير متاح':j.logged_sleep_hours.hours+' س (قبل '+j.logged_sleep_hours.age_h+' س)'}</td></tr></table>
  <p class="small">المصدر: ${j.source.name} (${j.source.type}) · ${j.disclaimer}</p></div>`;
};
</script></body></html>"##;

// ---------- tests ----------
#[cfg(test)]
mod tests {
    use super::*;

    /// Build 22 points for a frontal face: eye width 60 px, given eyelid opening and iris position.
    fn face(open: f64, nasal_a: f64, nasal_b: f64) -> Vec<f64> {
        let w = 60.0;
        let mut p = vec![0.0; NPTS * 2];
        let mut set = |i: usize, x: f64, y: f64| {
            p[2 * i] = x;
            p[2 * i + 1] = y;
        };
        let h = open * w / 2.0; // half height of the lid gap
        // eye A spans x 100..160 (outer left, inner right); eye B spans x 240..300 (inner left, outer right)
        for (base, ox, outer_first) in [(A, 100.0, true), (B, 240.0, false)] {
            let (c_outer, c_inner) = if outer_first { (ox, ox + w) } else { (ox + w, ox) };
            set(base, if outer_first { c_outer } else { c_inner }, 200.0);
            set(base + 3, if outer_first { c_inner } else { c_outer }, 200.0);
            set(base + 1, ox + 0.33 * w, 200.0 - h);
            set(base + 2, ox + 0.66 * w, 200.0 - h);
            set(base + 5, ox + 0.33 * w, 200.0 + h);
            set(base + 4, ox + 0.66 * w, 200.0 + h);
            let nasal = if outer_first { nasal_a } else { nasal_b };
            let ix = c_outer + (c_inner - c_outer) * nasal;
            set(base + 6, ix, 200.0);
            for (k, (dx, dy)) in [(-6.0, 0.0), (6.0, 0.0), (0.0, -6.0), (0.0, 6.0)].iter().enumerate() {
                set(base + 7 + k, ix + dx, 200.0 + dy);
            }
        }
        p
    }

    fn capture(seconds: f64, fps: f64, closed_at: &dyn Fn(f64) -> bool, nasal: (f64, f64)) -> Capture {
        let n = (seconds * fps) as usize;
        let frames = (0..n)
            .map(|i| {
                let t = i as f64 * 1000.0 / fps;
                let c = closed_at(t);
                Frame { t, bl: if c { [0.95, 0.95] } else { [0.05, 0.05] }, pts: face(if c { 0.05 } else { 0.30 }, nasal.0, nasal.1) }
            })
            .collect();
        Capture { astronaut_id: 1, frames, attempted: Some(n as u32), fixation_from_ms: Some(0.0), fixation_to_ms: Some(8000.0), still_jpeg_b64: None, still_pts: None }
    }

    #[test]
    fn normal_blinking_is_ok() {
        // ~100 ms blink every 4 s over 30 s at 15 fps => about 15 blinks/min, PERCLOS a few %
        let c = capture(30.0, 15.0, &|t| (t % 4000.0) < 100.0, (0.5, 0.5));
        let m = analyze_frames(&c).unwrap();
        assert!(m.perclos < 0.05, "perclos {}", m.perclos);
        assert!((12.0..=18.0).contains(&m.blink_rate), "rate {}", m.blink_rate);
        assert_eq!(m.microsleeps, 0);
        let (pts, status, rules, signs) = score(&m, None, None);
        assert_eq!(status, "ok");
        assert!(rules.is_empty() && signs.is_empty(), "{rules:?} {signs:?}");
        assert_eq!(pts, 0);
    }

    #[test]
    fn drowsy_eyes_fire_explained_rules() {
        // 1.2 s closures every 6 s => micro-sleeps, PERCLOS about 20 %
        let c = capture(30.0, 15.0, &|t| (t % 6000.0) < 1200.0, (0.5, 0.5));
        let m = analyze_frames(&c).unwrap();
        assert!(m.perclos >= PERCLOS_HIGH, "perclos {}", m.perclos);
        assert!(m.microsleeps >= 4, "micro {}", m.microsleeps);
        let (_, status, rules, _) = score(&m, None, Some((4.5, 6.0)));
        assert_eq!(status, "attention");
        let names: Vec<String> = rules.iter().map(|r| r["rule"].as_str().unwrap().to_string()).collect();
        assert!(
            names.contains(&"PERCLOS high".to_string()) && names.contains(&"Micro-sleep".to_string()) && names.contains(&"Low logged sleep".to_string()),
            "{names:?}"
        );
        assert!(rules.iter().all(|r| r["reviewed"] == false));
    }

    #[test]
    fn misalignment_is_flagged_but_straight_gaze_is_not() {
        let straight = analyze_frames(&capture(30.0, 15.0, &|_| false, (0.5, 0.5))).unwrap();
        assert!(straight.vergence.unwrap().abs() < 0.02);
        // eye A turned toward the nose, eye B centred => vergence index about +0.30
        let turned = analyze_frames(&capture(30.0, 15.0, &|_| false, (0.8, 0.5))).unwrap();
        assert!((turned.vergence.unwrap() - 0.3).abs() < 0.02, "{:?}", turned.vergence);
        let (_, _, _, signs) = score(&turned, None, None);
        assert_eq!(signs[0]["sign"], "Possible eye misalignment");
        assert_eq!(signs[0]["confidence"], "low");
    }

    #[test]
    fn head_roll_does_not_create_fake_misalignment() {
        let mut c = capture(30.0, 15.0, &|_| false, (0.5, 0.5));
        let th: f64 = 0.35; // about 20 degrees
        for f in c.frames.iter_mut() {
            for k in 0..NPTS {
                let (x, y) = (f.pts[2 * k] - 200.0, f.pts[2 * k + 1] - 200.0);
                f.pts[2 * k] = 200.0 + x * th.cos() - y * th.sin();
                f.pts[2 * k + 1] = 200.0 + x * th.sin() + y * th.cos();
            }
        }
        let m = analyze_frames(&c).unwrap();
        assert!(m.vergence.unwrap().abs() < 0.02 && m.vert_diff.unwrap().abs() < 0.02, "{m:?}");
    }

    #[test]
    fn too_little_data_is_not_available_not_guessed() {
        let c = capture(5.0, 15.0, &|_| false, (0.5, 0.5));
        assert!(analyze_frames(&c).unwrap_err().starts_with("not available"));
        let mut c = capture(30.0, 15.0, &|_| false, (0.5, 0.5));
        c.attempted = Some(2000); // face found in about 22 % of frames
        assert!(analyze_frames(&c).unwrap_err().contains("face found"));
    }

    fn jpeg_of(rgb_sclera: [u8; 3]) -> (Vec<u8>, Vec<f64>) {
        let (w, h) = (400u32, 300u32);
        let mut img = image::RgbImage::from_pixel(w, h, image::Rgb([200, 160, 140])); // skin
        let pts = face(0.30, 0.5, 0.5);
        for x in 100..160 {
            for y in 195..206 {
                img.put_pixel(x, y, image::Rgb(rgb_sclera));
            }
        }
        for x in 240..300 {
            for y in 195..206 {
                img.put_pixel(x, y, image::Rgb(rgb_sclera));
            }
        }
        for cx in [130u32, 270u32] {
            for x in cx - 6..cx + 6 {
                for y in 194..206 {
                    img.put_pixel(x, y, image::Rgb([60, 40, 30]));
                }
            }
        }
        let mut out = vec![];
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 95).encode_image(&img).unwrap();
        (out, pts)
    }

    #[test]
    fn sclera_colour_separates_white_red_and_yellow() {
        let (white, p) = jpeg_of([235, 235, 232]);
        let (red, _) = jpeg_of([235, 190, 190]);
        let (yellow, _) = jpeg_of([235, 225, 150]);
        let w = sclera_lab(&white, &p).unwrap();
        let rd = sclera_lab(&red, &p).unwrap();
        let ye = sclera_lab(&yellow, &p).unwrap();
        assert!(rd.1 - w.1 > 3.0, "a* red {:.1} vs white {:.1}", rd.1, w.1);
        assert!(ye.2 - w.2 > 4.0, "b* yellow {:.1} vs white {:.1}", ye.2, w.2);
        assert!(w.3 >= 20);
    }

    #[test]
    fn base64_roundtrip() {
        assert_eq!(b64("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(b64("data:image/jpeg;base64,aGk=").unwrap(), b"hi");
        assert!(b64("a$b").is_none());
    }
}
