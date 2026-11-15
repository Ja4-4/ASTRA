import { create } from 'zustand';
import { persist, createJSONStorage, type StateStorage } from 'zustand/middleware';
import type { Reading } from '../data/types';
import { BACKEND_ID_PREFIX, loadDemoReadings } from '../data/adapter';
import { DEMO_PROFILE } from '../data/demo/profile';
import { evaluate } from '../lib/rules';
import { CHECKIN_ITEMS, INDICATOR_UNIT, METRICS, type MetricId } from '../lib/indicators';
import { XP, rankFor, type BadgeId, type DayMark } from '../lib/gamification';
import { MISSION_BY_ID, type MissionSettingId } from '../lib/mission';
import { simNow, startUTC } from '../lib/time';
import type { SystemId } from '../lib/systems';
import type { SavedState } from '../data/server';
import { addToHistory, type TiredValues } from '../lib/tired';

export type LoopStage = 'prevent' | 'respond' | 'recover';

export interface FollowUp { id: string; label: string; done: boolean; doneAt?: string }
export interface AstraEvent {
  id: string;
  metric: MetricId;
  ruleId: string;
  explanation: string;
  /** Everyday-language version of the trigger. */
  plain?: string;
  openedAt: string;
  stage: 'respond' | 'recover' | 'closed';
  steps: { remeasure: boolean; symptoms: boolean; flag: boolean };
  symptoms?: string;
  message?: { body: string; sentAt: string; deliverAt: string; delayLabel: string; setting: string };
  followUps: FollowUp[];
  closedAt?: string;
  honestAwarded: boolean;
  /** Id of the matching event on the station server, once it has been mirrored there. */
  backendEventId?: number;
}
export interface Award { id: string; at: string; xp: number; reason: string }
export interface Toast { id: string; title: string; body?: string; kind: 'xp' | 'info' | 'alert' | 'badge' }
/** A full-screen moment for a new rank or badge. One at a time. */
export interface Celebration { id: string; kind: 'rank' | 'badge' | 'mission'; title: string; body: string; xp?: number }

interface State {
  readings: Reading[];
  clockOffsetMin: number;
  mission: MissionSettingId;
  theme: 'dark' | 'light';
  events: AstraEvent[];
  xp: number;
  awards: Award[];
  badges: BadgeId[];
  streak: number;
  streakHistory: DayMark[]; // oldest -> newest, last 30 days excluding today
  routineDone: Record<string, string>; // key -> ISO time
  watchAcks: Record<string, string>;
  orbitClaimedDay?: string;
  /** Daily missions already rewarded: `${missionDay}:${missionId}` -> ISO time. */
  missionsClaimed: Record<string, string>;
  introSeen: boolean;
  /** The astronaut's relaxed face: median expression scores from a 5-second calibration. Kept across demo resets. */
  usualFace: Record<string, number> | null;
  /** Last face reading from a camera scan (never a demo one). Stays on this device; Atlas can mention it. */
  lastFace: { at: string; look: string | null; confidence: string; why: string } | null;
  /** Eye and skin values of the latest good scans (and the first baseline): the usual for tired signs. Stays on this device. */
  tiredHistory: TiredValues[];
  /** Last tired-signs result of a camera scan (never a demo one), for Atlas. Never sent to the station server. */
  lastTired: { at: string; count: number; signs: string[]; learning: number | null } | null;
  // ephemeral
  guideOpen: boolean;
  toasts: Toast[];
  selectedSystem: SystemId | null;
  hoveredSystem: SystemId | null;
  /** Metric whose details sheet is open. */
  metricDetail: MetricId | null;
  celebration: Celebration | null;
  /** Where the numbers come from right now. Not persisted: every launch starts on demo data. */
  dataSource: 'live' | 'demo';
  /** The demo readings set aside while live, so live rows never land in the saved demo. */
  demoReadings: Reading[] | null;
}

interface Actions {
  now: () => Date;
  /** Returns the readings it added, so the caller can send them to the station server. */
  logCheckin: (entries: { metric: MetricId; values: number[]; source?: string }[]) => Reading[];
  completeStep: (eventId: string, step: 'remeasure' | 'symptoms' | 'flag', payload?: string) => void;
  ackWatch: (ruleId: string) => void;
  /** Returns the exercise reading it added, if any. */
  completeRoutine: (key: string, label: string, minutes?: number) => Reading[];
  /** Points for doing a thinking test (once per test per day), never for the score. */
  completeTest: (key: string, label: string) => void;
  grantBadge: (b: BadgeId, label: string, body: string) => void;
  claimMission: (key: string, label: string, xp: number) => void;
  dismissCelebration: () => void;
  demoAdvance: () => void;
  resetDemo: () => void;
  /** Back to the starting story but keep the live/demo mode (used by the live reset after the server was reset). */
  resetLocalOnly: () => void;
  setMission: (m: MissionSettingId) => void;
  setTheme: (t: 'dark' | 'light') => void;
  select: (s: SystemId | null) => void;
  hover: (s: SystemId | null) => void;
  openMetric: (m: MetricId | null) => void;
  toast: (t: Omit<Toast, 'id'>) => void;
  openGuide: () => void;
  closeGuide: () => void;
  dismissToast: (id: string) => void;
  /** Replace the app's own state (points, badges, alert steps, preferences) with what the server saved. */
  applySaved: (st: SavedState) => void;
  /** Show the station server's readings. Local readings not on the server yet are kept. */
  setLive: (serverReadings: Reading[]) => void;
  setUsualFace: (shapes: Record<string, number> | null) => void;
  setLastFace: (r: State['lastFace']) => void;
  addTiredScan: (v: TiredValues) => void;
  setLastTired: (r: State['lastTired']) => void;
  /** Recalibrate: forget the usual face and the usual eye and skin values. */
  resetUsual: () => void;
}

const uid = () => Math.random().toString(36).slice(2, 10);

function seed(): Omit<State, 'toasts' | 'selectedSystem' | 'hoveredSystem' | 'guideOpen' | 'introSeen' | 'usualFace' | 'lastFace' | 'tiredHistory' | 'lastTired' | 'metricDetail' | 'celebration' | 'dataSource' | 'demoReadings'> {
  const hist: DayMark[] = Array.from({ length: 30 }, (_, i) => (i >= 19 ? 'full' : i === 15 ? 'flare' : i === 9 || i === 4 ? 'partial' : 'full'));
  return {
    readings: loadDemoReadings(),
    clockOffsetMin: 0,
    mission: 'iss',
    theme: 'dark',
    events: [],
    xp: 1240,
    awards: [],
    badges: ['orbit_7'],
    streak: 11,
    streakHistory: hist,
    routineDone: {},
    watchAcks: {},
    orbitClaimedDay: undefined,
    missionsClaimed: {},
  };
}

/** localStorage can throw (private mode, blocked storage). Never let that break the app. */
const safeStorage: StateStorage = {
  getItem: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  setItem: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  removeItem: (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

export const BP_FOLLOWUPS = (): FollowUp[] => [
  { id: 'fu1', label: 'Measure blood pressure again 30 minutes after sending', done: false },
  { id: 'fu2', label: 'Measure again next morning, rested', done: false },
  { id: 'fu3', label: 'Number back in the healthy zone', done: false },
];
const GENERIC_FOLLOWUPS = (): FollowUp[] => [
  { id: 'fu1', label: 'Measure again after 30 minutes', done: false },
  { id: 'fu2', label: 'Measure again at the next planned check', done: false },
  { id: 'fu3', label: 'Number back in the healthy zone', done: false },
];

export const useAstra = create<State & Actions>()(
  persist(
    (set, get) => {
      const award = (xp: number, reason: string, title: string) => {
        const at = get().now().toISOString();
        const before = rankFor(get().xp).rank.title;
        set((s) => ({ xp: s.xp + xp, awards: [{ id: uid(), at, xp, reason }, ...s.awards].slice(0, 60) }));
        get().toast({ kind: 'xp', title: `+${xp} · ${title}`, body: reason });
        const after = rankFor(get().xp).rank.title;
        if (after !== before) set({ celebration: { id: uid(), kind: 'rank', title: `New rank: ${after}`, body: 'Earned by showing up and reporting honestly, never by having good numbers.', xp: get().xp } });
      };
      /** Badges are added quietly unless `announce` (keeps the demo to one toast per moment). */
      const giveBadge = (b: BadgeId, label: string, announce = false) => {
        if (get().badges.includes(b)) return;
        set((s) => ({ badges: [...s.badges, b] }));
        if (announce) get().toast({ kind: 'badge', title: `Badge: ${label}`, body: 'Every follow-up check done. See it on Progress.' });
      };

      /** Re-evaluate open events against the latest readings (follow-ups tick from real readings only). */
      const progressEvents = () => {
        const now = get().now();
        const events = get().events.map((e) => {
          if (e.stage === 'closed') return e;
          const res = evaluate(e.metric, get().readings, now, DEMO_PROFILE);
          const after = (iso: string) => get().readings.filter((r) => MetricIndicators[e.metric].includes(r.indicator) && r.timestamp > iso);
          let ev = { ...e, followUps: e.followUps.map((f) => ({ ...f })) };
          if (ev.stage === 'recover' && ev.message) {
            const later = after(ev.message.sentAt);
            const times = [...new Set(later.map((r) => r.timestamp))].sort();
            if (times[0] && !ev.followUps[0].done) ev.followUps[0] = { ...ev.followUps[0], done: true, doneAt: times[0] };
            const nextDay = times.find((t) => startUTC(new Date(t)).getTime() > startUTC(new Date(ev.message!.sentAt)).getTime());
            if (nextDay && !ev.followUps[1].done) ev.followUps[1] = { ...ev.followUps[1], done: true, doneAt: nextDay };
            if (res.status === 'ok' && ev.followUps[0].done && !ev.followUps[2].done) ev.followUps[2] = { ...ev.followUps[2], done: true, doneAt: now.toISOString() };
            if (ev.followUps.every((f) => f.done)) ev = { ...ev, stage: 'closed', closedAt: now.toISOString() };
          }
          return ev;
        });
        const newlyClosed = events.filter((e, i) => e.stage === 'closed' && get().events[i].stage !== 'closed');
        set({ events });
        if (newlyClosed.length) giveBadge('back_in_orbit', 'Back in Orbit', true);
      };

      return {
        ...seed(),
        introSeen: false,
        usualFace: null,
        lastFace: null,
        tiredHistory: [],
        lastTired: null,
        guideOpen: false,
        toasts: [],
        selectedSystem: null,
        hoveredSystem: null,
        metricDetail: null,
        celebration: null,
        dataSource: 'demo',
        demoReadings: null,

        now: () => simNow(get().clockOffsetMin),

        logCheckin: (entries) => {
          if (entries.length === 0) return [];
          const now = get().now();
          const ts = now.toISOString();
          const before = Object.fromEntries(entries.map((e) => [e.metric, evaluate(e.metric, get().readings, now, DEMO_PROFILE).status]));
          const added: Reading[] = [];
          for (const e of entries) {
            const group = uid();
            MetricIndicators[e.metric].forEach((ind, i) => {
              added.push({ id: uid(), timestamp: ts, indicator: ind, value: e.values[i], unit: INDICATOR_UNIT[ind], source: e.source ?? 'manual', provenance: 'real', quality: 'good', group });
            });
          }
          // advance the simulated clock a minute so consecutive entries order correctly
          set((s) => ({ readings: [...s.readings, ...added], clockOffsetMin: s.clockOffsetMin + 1 }));

          // XP: per item logged (behaviour), never for the value
          const dayKey = startUTC(now).toISOString();
          award(XP.checkinItem * entries.length, `You logged ${entries.length} number${entries.length > 1 ? 's' : ''}. Points are for logging, never for the value.`, 'Check-in');
          const today = get().readings.filter((r) => startUTC(new Date(r.timestamp)).toISOString() === dayKey);
          const doneItems = CHECKIN_ITEMS.filter((m) => MetricIndicators[m].every((ind) => today.some((r) => r.indicator === ind)));
          if (doneItems.length === CHECKIN_ITEMS.length && get().orbitClaimedDay !== dayKey) {
            set({ orbitClaimedDay: dayKey });
            award(XP.fullOrbit, 'All 5 daily numbers logged. Today’s orbit is complete.', 'Orbit complete');
          }

          // A new reading for an open alert counts as its "measure again" step.
          set((st) => ({ events: st.events.map((ev) => (ev.stage === 'respond' && !ev.steps.remeasure && ev.openedAt < ts && entries.some((x) => x.metric === ev.metric) ? { ...ev, steps: { ...ev.steps, remeasure: true } } : ev)) }));

          // Status changes: open an event for any Act reading
          const after = get().now();
          for (const e of entries) {
            const res = evaluate(e.metric, get().readings, after, DEMO_PROFILE);
            if (res.status === 'act') {
              const open = get().events.find((x) => x.metric === e.metric && x.stage !== 'closed');
              if (!open) {
                const ev: AstraEvent = {
                  id: uid(), metric: e.metric, ruleId: res.ruleId, explanation: res.explanation, plain: res.plain, openedAt: ts, stage: 'respond',
                  steps: { remeasure: false, symptoms: false, flag: false }, followUps: e.metric === 'bp' ? BP_FOLLOWUPS() : GENERIC_FOLLOWUPS(), honestAwarded: false,
                };
                set((s) => ({ events: [ev, ...s.events] }));
              }
              get().toast({ kind: 'alert', title: `Act now · ${METRICS[e.metric].short}`, body: `${res.plain} Open Alerts for 3 simple steps.` });
            } else if (res.status === 'watch' && before[e.metric] !== 'watch') {
              get().toast({ kind: 'alert', title: `Watch · ${METRICS[e.metric].short}`, body: `${res.plain} Measure again later.` });
            }
          }
          progressEvents();
          return added;
        },

        completeStep: (eventId, step, payload) => {
          const ev = get().events.find((e) => e.id === eventId);
          if (!ev || ev.steps[step]) return;
          const now = get().now();
          let patch: Partial<AstraEvent> = { steps: { ...ev.steps, [step]: true } };
          if (step === 'symptoms') patch.symptoms = payload;
          if (step === 'flag') {
            const m = MISSION_BY_ID[get().mission];
            patch = {
              ...patch, stage: 'recover',
              message: { body: payload ?? '', sentAt: now.toISOString(), deliverAt: new Date(now.getTime() + m.delaySec * 1000).toISOString(), delayLabel: m.delayLabel, setting: m.label },
            };
          }
          set((s) => ({ events: s.events.map((e) => (e.id === eventId ? { ...e, ...patch } : e)) }));
          if (step === 'flag') {
            giveBadge('first_flag', 'Clear Signal');
            const cur = get().events.find((e) => e.id === eventId)!;
            if (!cur.honestAwarded) {
              set((s) => ({ events: s.events.map((e) => (e.id === eventId ? { ...e, honestAwarded: true } : e)) }));
              award(XP.honestReporter, 'You sent an off reading to the doctor instead of hiding it.', 'Honest Reporter');
              giveBadge('honest_reporter', 'Honest Reporter');
            }
          }
          progressEvents();
        },

        ackWatch: (ruleId) => {
          const key = `${startUTC(get().now()).toISOString()}:${ruleId}`;
          if (get().watchAcks[key]) return;
          set((s) => ({ watchAcks: { ...s.watchAcks, [key]: get().now().toISOString() } }));
          award(XP.honestReporter, 'You measured again and followed the advice.', 'Honest Reporter');
          giveBadge('honest_reporter', 'Honest Reporter');
        },

        completeRoutine: (key, label, minutes) => {
          if (get().routineDone[key]) return [];
          const now = get().now();
          set((s) => ({ routineDone: { ...s.routineDone, [key]: now.toISOString() } }));
          const added: Reading[] = minutes ? [{ id: uid(), timestamp: now.toISOString(), indicator: 'exercise_min', value: minutes, unit: 'min', source: 'routine check-off', provenance: 'real', quality: 'good' }] : [];
          if (added.length) set((s) => ({ readings: [...s.readings, ...added] }));
          award(XP.routineActivity, `You completed "${label}" as prescribed.`, 'Routine');
          return added;
        },

        completeTest: (key, label) => {
          if (get().routineDone[key]) return;
          set((s) => ({ routineDone: { ...s.routineDone, [key]: get().now().toISOString() } }));
          award(XP.thinkingTest, `You did the ${label}. Points are for doing it, not for the score.`, 'Thinking test');
        },

        grantBadge: (b, label, body) => {
          if (get().badges.includes(b)) return;
          set((s) => ({ badges: [...s.badges, b], celebration: { id: uid(), kind: 'badge', title: `Badge: ${label}`, body } }));
        },

        claimMission: (key, label, xp) => {
          if (get().missionsClaimed[key]) return;
          set((s) => ({ missionsClaimed: { ...s.missionsClaimed, [key]: get().now().toISOString() } }));
          award(xp, `Daily mission done: ${label}.`, 'Mission');
        },

        dismissCelebration: () => set({ celebration: null }),

        demoAdvance: () => {
          const s = get();
          const ev = s.events.find((e) => e.stage !== 'closed');
          const push = (minutes: number, entries: { metric: MetricId; values: number[] }[], msg: string) => {
            set((st) => ({ clockOffsetMin: st.clockOffsetMin + minutes }));
            get().toast({ kind: 'info', title: 'Demo clock', body: msg });
            if (entries.length) {
              // demo follow-ups are simulated readings
              const ts = get().now().toISOString();
              const added: Reading[] = [];
              entries.forEach((e) => { const g = uid(); MetricIndicators[e.metric].forEach((ind, i) => added.push({ id: uid(), timestamp: ts, indicator: ind, value: e.values[i], unit: INDICATOR_UNIT[ind], source: 'demo follow-up', provenance: 'simulated', quality: 'good', group: g })); });
              set((st) => ({ readings: [...st.readings, ...added] }));
            }
            progressEvents();
          };
          if (!ev) { push(60, [], 'Clock +60 min. No open alert.'); return; }
          if (ev.stage === 'respond') { push(5, [], 'Clock +5 min. Finish the 3 steps, then send to the doctor.'); return; }
          if (!ev.followUps[0].done) {
            push(30, ev.metric === 'bp' ? [{ metric: 'bp', values: [148, 94] }] : [], 'Clock +30 min. Follow-up reading logged (simulated).');
            return;
          }
          // jump to the next morning 07:40
          const now = get().now();
          const next = new Date(startUTC(now).getTime() + 86_400_000 + (7 * 60 + 40) * 60_000);
          const mins = Math.round((next.getTime() - now.getTime()) / 60_000);
          push(mins, ev.metric === 'bp' ? [{ metric: 'bp', values: [124, 78] }] : [], 'Next morning 07:40. Follow-up reading logged (simulated).');
        },

        resetDemo: () => {
          if (get().dataSource === 'live') {
            // live: the server holds the numbers and the saved state, so it is reset there too, then everything is read again
            void import('../data/live').then((m) => m.resetLive()).then(
              () => get().toast({ kind: 'info', title: 'Demo reset', body: 'The server and this screen are back at the start of the story.' }),
              (e) => get().toast({ kind: 'info', title: 'Reset failed', body: e instanceof Error ? e.message : String(e) }),
            );
            return;
          }
          set({ ...seed(), theme: get().theme, toasts: [], selectedSystem: null, hoveredSystem: null, guideOpen: false, metricDetail: null, celebration: null, dataSource: 'demo', demoReadings: null });
          get().toast({ kind: 'info', title: 'Demo reset', body: 'Synthetic history restored to Mission Day 142, 08:45.' });
        },

        setUsualFace: (shapes) => set({ usualFace: shapes }),
        setLastFace: (r) => set({ lastFace: r }),
        addTiredScan: (v) => set((s) => ({ tiredHistory: addToHistory(s.tiredHistory, v) })),
        setLastTired: (r) => set({ lastTired: r }),
        resetUsual: () => set({ usualFace: null, tiredHistory: [], lastTired: null }),
        setMission: (m) => set({ mission: m }),
        setTheme: (t) => set({ theme: t }),
        select: (sel) => set({ selectedSystem: sel }),
        hover: (h) => set({ hoveredSystem: h }),
        openMetric: (m) => set({ metricDetail: m }),
        toast: (t) => {
          const id = uid();
          set((s) => ({ toasts: [...s.toasts, { ...t, id }].slice(-4) }));
          setTimeout(() => get().dismissToast(id), t.kind === 'alert' ? 7000 : 5000);
        },
        openGuide: () => set({ guideOpen: true }),
        closeGuide: () => set({ guideOpen: false, introSeen: true }),
        dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

        resetLocalOnly: () => set((s) => ({ ...seed(), readings: s.readings, theme: s.theme, toasts: [], selectedSystem: null, hoveredSystem: null, guideOpen: false, metricDetail: null, celebration: null, dataSource: s.dataSource, demoReadings: s.demoReadings })),

        applySaved: (st) => set((s) => ({
          clockOffsetMin: st.clockOffsetMin ?? s.clockOffsetMin,
          mission: (st.mission as MissionSettingId | undefined) ?? s.mission,
          theme: st.theme ?? s.theme,
          events: (st.events as AstraEvent[] | undefined) ?? s.events,
          xp: st.xp ?? s.xp,
          awards: (st.awards as Award[] | undefined) ?? s.awards,
          badges: (st.badges as BadgeId[] | undefined) ?? s.badges,
          streak: st.streak ?? s.streak,
          streakHistory: (st.streakHistory as DayMark[] | undefined) ?? s.streakHistory,
          routineDone: st.routineDone ?? s.routineDone,
          watchAcks: st.watchAcks ?? s.watchAcks,
          missionsClaimed: st.missionsClaimed ?? s.missionsClaimed,
          orbitClaimedDay: st.orbitClaimedDay,
          introSeen: st.introSeen ?? s.introSeen,
        })),

        setLive: (serverReadings) => set((s) => {
          // A local reading the server now holds is dropped, so it is not shown twice.
          const onServer = new Set(serverReadings.map((r) => `${r.indicator}|${r.timestamp}|${r.value}`));
          const localOnly = s.dataSource === 'live'
            ? s.readings.filter((r) => !r.id.startsWith(BACKEND_ID_PREFIX) && !onServer.has(`${r.indicator}|${r.timestamp}|${r.value}`))
            : [];
          return { readings: [...serverReadings, ...localOnly], dataSource: 'live', demoReadings: s.demoReadings ?? s.readings };
        }),
      };
    },
    {
      name: 'astra-demo-v3',
      storage: createJSONStorage(() => safeStorage),
      partialize: ({ toasts, selectedSystem, hoveredSystem, guideOpen, metricDetail, celebration, dataSource, demoReadings, ...rest }) => {
        void toasts; void selectedSystem; void hoveredSystem; void guideOpen; void metricDetail; void celebration;
        // Live numbers stay on the server: the saved slot keeps the demo readings for the next offline launch.
        return dataSource === 'live' ? { ...rest, readings: demoReadings ?? loadDemoReadings() } : rest;
      },
    },
  ),
);

const MetricIndicators = Object.fromEntries(Object.values(METRICS).map((m) => [m.id, m.indicators])) as Record<MetricId, Reading['indicator'][]>;

export function loopStage(events: AstraEvent[]): LoopStage {
  if (events.some((e) => e.stage === 'respond')) return 'respond';
  if (events.some((e) => e.stage === 'recover')) return 'recover';
  return 'prevent';
}
