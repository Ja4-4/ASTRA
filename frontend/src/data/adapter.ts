/**
 * The ONLY file that knows source column names. The backend partner swaps this file (or adds a
 * mapper) when the official challenge dataset arrives; UI code only ever sees Reading[].
 */
import type { IndicatorId, Provenance, Reading } from './types';
import rawDemo from './demo/history.raw.json';
import type { BackendSourceType, MeasurementIn, MeasurementRow } from './api';
import type { StatusKey } from '../lib/status';

export interface RawRow {
  time_utc: string;
  metric: string;
  value: number;
  unit: string;
  source: string;
  provenance: string;
}

const METRIC_MAP: Record<string, IndicatorId> = {
  HR_REST: 'hr', BP_SYS: 'bp_sys', BP_DIA: 'bp_dia', GLU: 'glucose', TEMP: 'temp',
  SLEEP: 'sleep', MOOD: 'mood', EX_MIN: 'exercise_min', RAD_CUM: 'rad_dose',
};

function toProvenance(p: string): Provenance {
  if (p === 'real' || p === 'imported' || p === 'simulated') return p;
  throw new Error(`adapter: unknown provenance "${p}"`);
}

export function mapRows(rows: RawRow[]): Reading[] {
  return rows.map((r, i) => {
    const indicator = METRIC_MAP[r.metric];
    if (!indicator) throw new Error(`adapter: unknown metric column "${r.metric}"`);
    return {
      id: `seed-${i}`,
      timestamp: new Date(r.time_utc).toISOString(),
      indicator,
      value: Number(r.value),
      unit: r.unit,
      source: r.source,
      provenance: toProvenance(r.provenance),
      quality: 'good',
      group: r.metric.startsWith('BP_') ? `seed-bp-${r.time_utc}` : undefined,
    };
  });
}

export function loadDemoReadings(): Reading[] {
  return mapRows(rawDemo as RawRow[]);
}

// ---------- station server (backend/) ----------
// Contract: "Frontend integration (pending)" in backend/README.md.

/** Backend indicator_code -> frontend IndicatorId. `spo2` exists only on the backend and is skipped. */
const CODE_MAP: Record<string, IndicatorId> = {
  heart_rate: 'hr', bp_systolic: 'bp_sys', bp_diastolic: 'bp_dia', glucose: 'glucose', body_temp: 'temp',
  sleep_hours: 'sleep', mood: 'mood', exercise_minutes: 'exercise_min', radiation_dose_cumulative: 'rad_dose',
};
const BACKEND_ONLY = new Set(['spo2']);
const ID_TO_CODE = Object.fromEntries(Object.entries(CODE_MAP).map(([code, id]) => [id, code])) as Record<IndicatorId, string>;
/** Read-only alias: backend/src/exercise.rs writes squat minutes under its own `exercise_min` indicator. */
const READ_ALIAS: Record<string, IndicatorId> = { exercise_min: 'exercise_min' };

/** `manual` is the astronaut's own entry, shown like any reading they typed in. */
function fromSourceType(t: BackendSourceType): Provenance {
  return t === 'manual' ? 'real' : t;
}

/** Ids of readings that came from the station server start with this. */
export const BACKEND_ID_PREFIX = 'db-';

/**
 * GET /api/measurements rows -> Reading[]. A row with value null has no number: it is left out, so
 * the metric shows "no recent number" and never 0. Blood pressure pairs share `group` by identical measured_at.
 */
export function fromBackend(rows: MeasurementRow[]): Reading[] {
  const out: Reading[] = [];
  for (const r of rows) {
    const indicator = CODE_MAP[r.indicator_code] ?? READ_ALIAS[r.indicator_code];
    if (!indicator) {
      if (!BACKEND_ONLY.has(r.indicator_code)) console.warn(`[api] unknown indicator_code "${r.indicator_code}" skipped`);
      continue;
    }
    if (r.value === null) continue;
    const timestamp = new Date(r.measured_at).toISOString();
    out.push({
      id: `${BACKEND_ID_PREFIX}${r.id}`,
      timestamp,
      indicator,
      value: r.value,
      unit: r.unit === 'score' ? '/5' : r.unit,
      source: r.source_name,
      provenance: fromSourceType(r.source_type),
      quality: r.quality === 'suspect' ? 'questionable' : 'good',
      group: indicator === 'bp_sys' || indicator === 'bp_dia' ? `db-bp-${timestamp}` : undefined,
    });
  }
  return out.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

/** The backend stores UTC as 2026-10-15T07:30:00Z (no fraction of a second). */
const backendTime = (iso: string) => new Date(iso).toISOString().slice(0, 19) + 'Z';

/** Reading -> body of POST /api/measurements. The backend accepts "/5" for mood and stores it as `score`. */
export function toBackend(r: Reading, astronautId: number, source: { type: BackendSourceType; name: string }): MeasurementIn {
  return {
    astronaut_id: astronautId,
    indicator_code: ID_TO_CODE[r.indicator],
    value: r.value,
    unit: r.unit,
    measured_at: backendTime(r.timestamp),
    source_type: source.type,
    source_name: source.name,
  };
}

/** Backend status words (cabin model, eye scan) -> UI status. Missing or unknown -> nodata. */
export function mapStatus(value: string | null | undefined): StatusKey {
  if (value === 'ok' || value === 'typical') return 'ok';
  if (value === 'watch') return 'watch';
  if (value === 'attention') return 'act';
  if (value === null || value === undefined || value === 'not available') return 'nodata';
  console.warn(`[api] unknown status "${value}", shown as not available`);
  return 'nodata';
}

/**
 * Severity of a backend alert (its older alert_rules: normal / info / review / urgent) -> UI status.
 * Not in the README status table; used only to label server alerts on the Alerts page.
 */
export function mapAlertSeverity(severity: string): StatusKey {
  if (severity === 'urgent') return 'act';
  if (severity === 'review') return 'watch';
  if (severity === 'info' || severity === 'normal') return 'ok';
  console.warn(`[api] unknown alert severity "${severity}", shown as not available`);
  return 'nodata';
}

/**
 * How a reading made in the app is labelled on the station server. A demo camera scan is never sent:
 * it is not a measurement.
 */
export function backendSource(r: Reading): { type: BackendSourceType; name: string } | null {
  if (r.source === 'camera scan (demo)') return null;
  if (r.source === 'camera scan (estimate)') return { type: 'real', name: 'camera estimate (rPPG)' };
  return { type: 'manual', name: 'ASTRA check-in' };
}
