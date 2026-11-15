/**
 * Calls to the station server that api.ts (which never throws and hides the HTTP status) does not cover:
 * saved app state, events (open / close), demo reset, the Atlas assistant, the ISS cabin data, imports,
 * sources and eye screenings. Every call here can fail; callers catch and say so.
 */
import { BASE } from './api';

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function http<T>(method: string, path: string, body?: unknown, timeoutMs = 6000): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body === undefined ? { 'ngrok-skip-browser-warning': '1' } : { 'content-type': 'application/json', 'ngrok-skip-browser-warning': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
    });
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON (an HTML page from a static host) */ }
    if (!res.ok) throw new ApiError(res.status, (json as { detail?: string } | null)?.detail ?? `HTTP ${res.status}`);
    if (json === null && text) throw new ApiError(res.status, 'the server did not answer with JSON');
    return json as T;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- what the app keeps per astronaut (points, badges, alert steps, preferences) ----------

export interface SavedState {
  v: 1;
  clockOffsetMin: number;
  mission: string;
  theme: 'dark' | 'light';
  events: unknown[];
  xp: number;
  awards: unknown[];
  badges: string[];
  streak: number;
  streakHistory: string[];
  routineDone: Record<string, string>;
  watchAcks: Record<string, string>;
  missionsClaimed: Record<string, string>;
  orbitClaimedDay?: string;
  introSeen: boolean;
}
export const getState = (aid: number) => http<{ state: SavedState | null }>('GET', `/astronauts/${aid}/state`);
export const putState = (aid: number, state: SavedState) => http('PUT', `/astronauts/${aid}/state`, { state }, 10000);

// ---------- events and routines ----------

export interface ServerEvent { id: number; astronaut_id: number; alert_id: number | null; title: string; opened_at: string; closed_at: string | null; status: string }
export interface ServerRoutine { id: number; astronaut_id: number; title: string; indicator_code: string | null; every_hours: number; due: boolean; last_completed_at: string | null }

export async function openServerEvent(aid: number, title: string, indicators: string[], openedAt: string): Promise<number> {
  const r = await http<{ event: ServerEvent }>('POST', '/events', { astronaut_id: aid, title, follow_up_indicators: indicators, opened_at: openedAt });
  return r.event.id;
}
export const closeServerEvent = (id: number) => http('POST', `/events/${id}/close`);
export const serverEvents = (aid: number) => http<ServerEvent[]>('GET', `/events?astronaut_id=${aid}`);
export const serverRoutines = (aid: number) => http<ServerRoutine[]>('GET', `/routines?astronaut_id=${aid}`);
export const completeServerRoutine = (id: number) => http('POST', `/routines/${id}/complete`);
export const resetServerDemo = () => http<{ measurements: number }>('POST', '/demo/reset', undefined, 15000);

export interface ServerAstronaut { id: number; display_name: string; is_synthetic: number; mission_setting: string | null }
export const serverAstronauts = () => http<ServerAstronaut[]>('GET', '/astronauts');

// ---------- Atlas (the voice/text assistant) ----------

export interface AtlasUi { op: string; route?: string; args?: Record<string, unknown>; astronaut_id?: number; display_name?: string }
export interface AtlasConfirm { token: string; expires_in_s?: number; summary: { action: string; description?: string; args?: Record<string, unknown>; request?: string } }
export interface AtlasReply {
  status: 'chat' | 'executed' | 'needs_confirmation' | 'ui' | 'needs_clarification' | 'cancelled' | 'error' | string;
  reply?: string;
  lang?: string;
  action?: { name: string; args?: Record<string, unknown> };
  result?: unknown;
  error?: string;
  ui?: AtlasUi;
  confirm?: AtlasConfirm;
  disclaimer?: string;
}
export interface AtlasStatus { registry: { actions: number }; model: { reachable: boolean; model_installed: boolean; hint?: string; provider?: string } }
export const atlasStatus = () => http<AtlasStatus>('GET', '/atlas/status', undefined, 4000);
/** `at` is the app's clock: numbers Atlas records get that time, so they line up with the rest of the demo timeline. */
export const atlasCommand = (message: string, astronautId: number, at: string) => http<AtlasReply>('POST', '/atlas/command', { message, astronaut_id: astronautId, at }, 130000);
export const atlasConfirm = (token: string, approve: boolean) => http<AtlasReply>('POST', '/atlas/confirm', { token, approve }, 20000);

// ---------- cabin environment, data import, sources, eye screenings ----------

export interface EnvReading { id: number; measured_at: string; parameter: string; value: number | null; unit: string; source_name: string }
export interface EnvAssessment { parameter: string; value: number; unit: string; status: string; rule_fired: string; reference_median: number; robust_z: number; n_training_readings: number; source: string; note: string }
export interface EnvModel { disclaimer: string; trained_on: string; parameters: Record<string, { n: number; median: number; watch_low: number; watch_high: number; alert_low: number; alert_high: number; unit: string; missions: string[] }> }
export interface ImportFiles { raw_csv: string[]; mappings: string[] }
export interface ImportLogRow { id: number; file: string; source_name: string; imported_at: string; report_json: string }
export interface EvidenceSource { id: number; title: string; url: string; license: string | null; note: string }
export interface EyeRow { id: number; taken_at: string; fatigue_score: number | null; status: string; perclos: number | null; blink_rate: number | null }

export const envReadings = (parameter: string, limit = 240) => http<EnvReading[]>('GET', `/environment?parameter=${encodeURIComponent(parameter)}&limit=${limit}`);
export const envModel = () => http<EnvModel>('GET', '/environment/model');
export const envAssess = (parameter: string, value: number) => http<EnvAssessment>('GET', `/environment/assess?parameter=${encodeURIComponent(parameter)}&value=${value}`);
export const importFiles = () => http<ImportFiles>('GET', '/import/files');
export const importLog = () => http<ImportLogRow[]>('GET', '/import/log');
export const runImport = (csv: string, mapping: string) => http<Record<string, unknown>>('POST', `/import?csv_file=${encodeURIComponent(csv)}&mapping=${encodeURIComponent(mapping)}`, undefined, 120000);
export const evidenceSources = () => http<EvidenceSource[]>('GET', '/evidence');
export const eyeHistory = (aid: number) => http<EyeRow[]>('GET', `/eye/history?astronaut_id=${aid}`);
