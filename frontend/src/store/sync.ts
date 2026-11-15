/**
 * Keeps the station server in step with what happens on screen (live data only; nothing runs on demo data):
 *  - saves the app's own state (points, badges, alert steps, preferences) to the server, debounced, and once more when the page closes,
 *  - mirrors alert events to the server and closes them there when they close here,
 *  - re-reads the readings now and then, so numbers Atlas or the server's rules produce show up.
 * Readings the person logs are sent by the pages themselves (data/live.ts sendReadings).
 */
import { useAstra, type AstraEvent } from './useAstra';
import { currentAstronaut, BASE } from '../data/api';
import * as server from '../data/server';
import { reloadLive } from '../data/live';
import { METRICS } from '../lib/indicators';
import { closedOnServer as closing } from './serverEvents';

const STATE_DELAY_MS = 800;
const RETRY_MS = 5000;
const POLL_MS = 30000;
/** Backend indicator code for the first indicator of each metric (used for the event's follow-up). */
const CODE: Record<string, string> = {
  hr: 'heart_rate', bp_sys: 'bp_systolic', bp_dia: 'bp_diastolic', glucose: 'glucose', temp: 'body_temp', sleep: 'sleep_hours', mood: 'mood',
  exercise_min: 'exercise_minutes', rad_dose: 'radiation_dose_cumulative',
};

const savable = (s: ReturnType<typeof useAstra.getState>): server.SavedState => ({
  v: 1, clockOffsetMin: s.clockOffsetMin, mission: s.mission, theme: s.theme, events: s.events, xp: s.xp, awards: s.awards, badges: s.badges,
  streak: s.streak, streakHistory: s.streakHistory, routineDone: s.routineDone, watchAcks: s.watchAcks, missionsClaimed: s.missionsClaimed,
  orbitClaimedDay: s.orbitClaimedDay, introSeen: s.introSeen,
});

export function startSync(): () => void {
  const opening = new Set<string>();
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let lastSaved = '';

  const aid = () => (useAstra.getState().dataSource === 'live' ? currentAstronaut()?.id ?? null : null);

  const mirrorEvents = (events: AstraEvent[]) => {
    const id = aid();
    if (id === null) return;
    for (const ev of events) {
      if (ev.backendEventId === undefined && !opening.has(ev.id)) {
        opening.add(ev.id);
        const m = METRICS[ev.metric];
        const code = CODE[m.indicators[0]] ?? 'heart_rate';
        server.openServerEvent(id, `${m.short}: act-now reading (${ev.ruleId})`, [code], ev.openedAt)
          .then((backendId) => useAstra.setState((s) => ({ events: s.events.map((e) => (e.id === ev.id ? { ...e, backendEventId: backendId } : e)) })))
          .catch(() => { /* tried again on the next change */ })
          .finally(() => opening.delete(ev.id));
      }
      if (ev.stage === 'closed' && ev.backendEventId !== undefined && !closing.has(ev.backendEventId)) {
        const backendId = ev.backendEventId;
        closing.add(backendId);
        server.closeServerEvent(backendId).catch(() => closing.delete(backendId));
      }
    }
  };

  const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const id = aid();
      if (id === null) return;
      const state = savable(useAstra.getState());
      const text = JSON.stringify(state);
      if (text === lastSaved) return;
      try { await server.putState(id, state); lastSaved = text; } catch { saveTimer = setTimeout(scheduleSave, RETRY_MS); }
    }, STATE_DELAY_MS);
  };

  const unsub = useAstra.subscribe((state, prev) => {
    if (state.dataSource !== 'live') return;
    if (prev.dataSource !== 'live') {
      // just went live: what was loaded is already on the server
      lastSaved = JSON.stringify(savable(state));
      state.events.forEach((e) => { if (e.stage === 'closed' && e.backendEventId !== undefined) closing.add(e.backendEventId); });
      mirrorEvents(state.events);
      return;
    }
    if (state.events !== prev.events) mirrorEvents(state.events);
    if (state.clockOffsetMin !== prev.clockOffsetMin || state.mission !== prev.mission || state.theme !== prev.theme || state.events !== prev.events || state.xp !== prev.xp
      || state.awards !== prev.awards || state.badges !== prev.badges || state.streak !== prev.streak || state.streakHistory !== prev.streakHistory || state.routineDone !== prev.routineDone
      || state.watchAcks !== prev.watchAcks || state.missionsClaimed !== prev.missionsClaimed || state.orbitClaimedDay !== prev.orbitClaimedDay || state.introSeen !== prev.introSeen) scheduleSave();
  });

  const poll = setInterval(() => { if (aid() !== null && !document.hidden) void reloadLive(); }, POLL_MS);
  const flushBeforeLeaving = () => {
    const id = aid();
    if (id === null) return;
    try { void fetch(`${BASE}/astronauts/${id}/state`, { method: 'PUT', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state: savable(useAstra.getState()) }) }); } catch { /* best effort */ }
  };
  window.addEventListener('pagehide', flushBeforeLeaving);

  return () => { unsub(); clearInterval(poll); clearTimeout(saveTimer); window.removeEventListener('pagehide', flushBeforeLeaving); };
}
