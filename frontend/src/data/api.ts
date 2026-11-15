/**
 * Talks to the station server (backend/, Rust + SQLite). Every function returns null when the
 * server is off or answers with an error, and never throws: the app then keeps its demo data.
 * Shapes follow backend/src/api.rs, backend/src/ai.rs and the "Frontend integration" section of
 * backend/README.md. The artifact build never makes a request.
 */

export const BASE: string = import.meta.env.VITE_API_BASE ?? '/api';
const OFFLINE_BUILD = import.meta.env.MODE === 'artifact';

/** Backend `source_type`. */
export type BackendSourceType = 'real' | 'imported' | 'simulated' | 'manual';

/** Row of GET /api/measurements. `value` is null when the number is not available. */
export interface MeasurementRow {
  id: number;
  astronaut_id: number;
  indicator_code: string;
  value: number | null;
  unit: string;
  measured_at: string;
  source_type: BackendSourceType;
  source_name: string;
  quality: 'ok' | 'suspect' | 'missing';
}

/** Body of POST /api/measurements. */
export interface MeasurementIn {
  astronaut_id: number;
  indicator_code: string;
  value: number;
  unit: string;
  measured_at: string;
  source_type: BackendSourceType;
  source_name: string;
}

export interface Astronaut {
  id: number;
  display_name: string;
  is_synthetic: number;
  mission_setting: string;
  created_at: string;
}

/** Row of GET /api/alerts (backend alert_rules: normal / info / review / urgent). */
export interface AlertRow {
  id: number;
  astronaut_id: number;
  measurement_id: number;
  rule_id: number;
  severity: string;
  status: 'open' | 'acknowledged' | 'resolved';
  escalation: string;
  explanation: string;
  triggered_at: string;
}

/** Row of GET /api/events?astronaut_id= (the backend requires astronaut_id). */
export interface EventRow {
  id: number;
  astronaut_id: number;
  alert_id: number | null;
  title: string;
  opened_at: string;
  closed_at: string | null;
  status: 'open' | 'recovering' | 'closed';
}

export interface AiStatus {
  reachable: boolean;
  model_installed: boolean;
  model: string;
  provider: string;
  hint?: string;
}

export interface AiReply {
  reply: string;
  model: string;
  provider: string;
  astronaut_id: number | null;
  context_used: boolean;
  elapsed_ms: number;
  disclaimer: string;
}

async function request<T>(path: string, init: RequestInit = {}, timeoutMs = 8000): Promise<T | null> {
  if (OFFLINE_BUILD) return null;
  const ctl = new AbortController();
  const timer = window.setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, { ...init, signal: ctl.signal, headers: { 'Content-Type': 'application/json', ...init.headers } });
    if (!res.ok) {
      console.warn(`[api] ${init.method ?? 'GET'} ${path} answered HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.warn(`[api] ${init.method ?? 'GET'} ${path} failed`, err);
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

const PROBE_TTL_MS = 30_000;
let probed: { at: number; online: boolean } | null = null;

/** Is the station server up? 1.5 s timeout, cached 30 s, never throws, silent when off. */
export async function probe(): Promise<{ online: boolean }> {
  if (OFFLINE_BUILD) return { online: false };
  if (probed && Date.now() - probed.at < PROBE_TTL_MS) return { online: probed.online };
  const ctl = new AbortController();
  const timer = window.setTimeout(() => ctl.abort(), 1500);
  let online = false;
  try {
    const res = await fetch(`${BASE}/health`, { signal: ctl.signal });
    online = res.ok && ((await res.json()) as { status?: string }).status === 'ok';
  } catch {
    online = false; // server off or not answering: demo data, by design
  } finally {
    window.clearTimeout(timer);
  }
  probed = { at: Date.now(), online };
  return { online };
}

export const getAstronauts = () => request<Astronaut[]>('/astronauts');

let active: Astronaut | null = null;
/** Switch which astronaut the app shows (Atlas "select astronaut", or after one was added). */
export function setActiveAstronaut(a: Astronaut | null) { active = a; }
export function currentAstronaut(): Astronaut | null { return active; }
/** The astronaut this app shows: the first one on the server (the seeded Cmdr. Layla Haddad, id 1). */
export async function activeAstronaut(): Promise<Astronaut | null> {
  if (active) return active;
  const list = await getAstronauts();
  active = list?.[0] ?? null;
  return active;
}

export function getMeasurements(astronautId: number, opts: { indicatorCode?: string; limit?: number } = {}) {
  const q = new URLSearchParams({ astronaut_id: String(astronautId) });
  if (opts.indicatorCode) q.set('indicator_code', opts.indicatorCode);
  if (opts.limit) q.set('limit', String(opts.limit));
  return request<MeasurementRow[]>(`/measurements?${q}`);
}

export const postMeasurement = (m: MeasurementIn) =>
  request<{ measurement: MeasurementRow; alerts: unknown[] }>('/measurements', { method: 'POST', body: JSON.stringify(m) });

export const getAlerts = (astronautId: number) => request<AlertRow[]>(`/alerts?astronaut_id=${astronautId}`);

export const ackAlert = (id: number) => request<{ id: number; status: 'acknowledged' }>(`/alerts/${id}/acknowledge`, { method: 'POST' });

export const getEvents = (astronautId: number) => request<EventRow[]>(`/events?astronaut_id=${astronautId}`);

export const getAiStatus = () => request<AiStatus>('/ai/status', {}, 5000);

export const aiChat = (message: string, astronautId: number) =>
  request<AiReply>('/ai/chat', { method: 'POST', body: JSON.stringify({ message, astronaut_id: astronautId }) }, 25_000);
