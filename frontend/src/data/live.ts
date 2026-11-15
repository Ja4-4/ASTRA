/**
 * Live data: when the station server answers, its readings replace the demo readings in the store,
 * and new numbers are sent to it. When it does not answer, nothing changes: the app stays on demo data.
 */
import type { Reading } from './types';
import { activeAstronaut, currentAstronaut, getMeasurements, postMeasurement, probe, setActiveAstronaut } from './api';
import * as server from './server';
import { backendSource, fromBackend, toBackend } from './adapter';
import { useAstra } from '../store/useAstra';
import { closedOnServer } from '../store/serverEvents';

const LIMIT = 2000;
let starting: Promise<void> | null = null;

async function load(): Promise<boolean> {
  const astronaut = await activeAstronaut();
  if (!astronaut) return false;
  const rows = await getMeasurements(astronaut.id, { limit: LIMIT });
  if (!rows) return false;
  useAstra.getState().setLive(fromBackend(rows));
  return true;
}

/** What the server saved for this astronaut (points, badges, alert steps, preferences) wins over this browser's copy. */
async function restoreState(): Promise<void> {
  const a = currentAstronaut();
  if (!a) return;
  try {
    const { state } = await server.getState(a.id);
    if (state) {
      // events the server saved as closed are already closed there: do not close them again
      (state.events as { stage?: string; backendEventId?: number }[]).forEach((e) => { if (e.stage === 'closed' && e.backendEventId !== undefined) closedOnServer.add(e.backendEventId); });
      useAstra.getState().applySaved(state);
    }
  } catch (e) {
    console.warn('[live] could not read the saved state', e);
  }
}

/** Once per launch: switch to live data if the station server is on. */
export function startLive(): Promise<void> {
  starting ??= (async () => {
    if ((await probe()).online && (await load())) await restoreState();
  })();
  return starting;
}

/** Read the readings again (after Atlas or the server wrote something). Never throws. */
export async function reloadLive(): Promise<boolean> {
  try { return await load(); } catch { return false; }
}

/** Show another astronaut: their readings and their saved state. */
export async function switchAstronaut(id: number): Promise<boolean> {
  const list = await server.serverAstronauts();
  const a = list.find((x) => x.id === id);
  if (!a) return false;
  setActiveAstronaut({ id: a.id, display_name: a.display_name, is_synthetic: a.is_synthetic, mission_setting: a.mission_setting ?? '', created_at: '' });
  if (!(await load())) return false;
  await restoreState();
  return true;
}

/** Put the demo back to its first minute: the server forgets what the app wrote, and the app starts again from it. */
export async function resetLive(): Promise<void> {
  await server.resetServerDemo();
  useAstra.getState().resetLocalOnly();
  await load();
}

/**
 * Send new readings to the station server, then reload from it. Does nothing on demo data. If a number
 * does not reach the server it stays in the app, and one plain line says so.
 */
export async function sendReadings(readings: Reading[]): Promise<void> {
  const st = useAstra.getState();
  if (st.dataSource !== 'live' || readings.length === 0) return;
  const astronaut = await activeAstronaut();
  let failed = !astronaut;
  if (astronaut) {
    for (const r of readings) {
      const source = backendSource(r);
      if (!source) continue;
      if (!(await postMeasurement(toBackend(r, astronaut.id, source)))) failed = true;
    }
  }
  if (failed) st.toast({ kind: 'info', title: 'Saved on this device. It will not reach the station server.' });
  if (astronaut) await load();
}
