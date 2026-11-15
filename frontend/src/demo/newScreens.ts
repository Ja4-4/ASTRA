/**
 * Simulated values for the demo screens (Scan, Tests, Re-entry).
 * Everything here is DEMO data and is labelled "DEMO · simulated" in the UI.
 * One typed file, so the real backend can replace it without touching the pages.
 * The astronaut's own usual values come from DEMO_PROFILE where one exists.
 */
import { DEMO_PROFILE } from '../data/demo/profile';
import type { StatusKey } from '../lib/status';

export const SCAN_DEMO = {
  seconds: 30,
  /** Heart beats per minute read from the face (simulated). */
  pulse: 66,
  pulseUsual: DEMO_PROFILE.baseline.hr ?? 62,
  eyesClosedLonger: false,
  /** Simulated usual share of time with eyes closed during a scan, in percent (DEMO until real history exists). */
  eyesClosedUsualPct: 5,
  posture: 'upright',
  /** Seconds into the scan when the simulated light check turns good. */
  lightOkAt: 4,
  /** Simulated face reading, always labelled demo and never saved or sent. */
  face: { look: 'Relaxed' as const, why: 'your face was close to your usual face', mood: 4 },
};

/** DEMO rule for thinking tests: compare with the astronaut's own usual, never a population average. */
export const TEST_RULE = { inRangePct: 10, watchPct: 20 };

export const TESTS_DEMO = {
  reaction: { lastAvgMs: 286, usualMs: 270, demoSeconds: 30, fullMinutes: 3, minGapMs: 2000, maxGapMs: 6000, tooSlowMs: 1500 },
  /** Memory span: how many squares in a row you can repeat. Starts at 3, one more after a perfect round, one less after a miss. */
  memory: { size: 4, start: 3, min: 2, max: 9, rounds: 5, showMsPerCell: 600, usualSpan: 5 },
};

export function testStatus(value: number, usual: number): StatusKey {
  const pct = ((value - usual) / usual) * 100;
  if (pct <= TEST_RULE.inRangePct) return 'ok';
  if (pct <= TEST_RULE.watchPct) return 'watch';
  return 'act';
}

/** Memory grid: fewer correct squares than usual is the bad direction. */
export function memoryStatus(correct: number, usual: number): StatusKey {
  const pct = ((usual - correct) / usual) * 100;
  if (pct <= TEST_RULE.inRangePct) return 'ok';
  if (pct <= TEST_RULE.watchPct) return 'watch';
  return 'act';
}

/** ASTRA prototype weighting, not a medical clearance. Part scores are 0 to 100. */
export interface ReentryPart { id: string; label: string; weight: number; score: number; detail: string; canImprove: boolean; improve?: string }

export const REENTRY_PARTS: ReentryPart[] = [
  { id: 'exercise', label: 'Exercise', weight: 0.3, score: 62, detail: '78% of planned exercise this week', canImprove: true, improve: '3 more resistance sessions this week.' },
  { id: 'thinking', label: 'Thinking speed', weight: 0.25, score: 84, detail: 'Reaction 286 ms, your usual 270 ms', canImprove: true, improve: 'Do the reaction test daily so changes show early.' },
  { id: 'time', label: 'Time in space', weight: 0.2, score: 60, detail: 'Day 142. Longer missions need longer recovery', canImprove: false },
  { id: 'heart', label: 'Heart and blood pressure', weight: 0.15, score: 78, detail: 'Blood pressure 142/92, your usual 116/74', canImprove: true, improve: 'Measure blood pressure twice a day this week.' },
  { id: 'sleep', label: 'Sleep', weight: 0.1, score: 78, detail: '5.8 h last night, your usual 7.4 h', canImprove: true, improve: 'Keep sleep periods on schedule.' },
];

/** Prototype bands: 80 and up In range, 60 to 79 Watch, under 60 Act now. */
export function reentryStatus(score: number): StatusKey {
  if (score >= 80) return 'ok';
  if (score >= 60) return 'watch';
  return 'act';
}

/** Landing day for the demo mission. Re-entry training counts down to it. */
export const LANDING_DAY = 180;

export interface TrainingSession { id: string; label: string; device: string; minutes: number; why: string }
export interface TrainingPhase { id: string; label: string; fromDay: number; toDay: number; goal: string; week: Record<number, TrainingSession[]> }

const ARED: TrainingSession = { id: 'ared', label: 'Weight training', device: 'ARED machine', minutes: 60, why: 'Loads bones and leg muscles, which shrink fastest without gravity.' };
const T2: TrainingSession = { id: 't2', label: 'Treadmill with harness', device: 'T2 treadmill', minutes: 30, why: 'Running under load prepares legs and balance for walking on Earth.' };
const CEVIS: TrainingSession = { id: 'cevis', label: 'Exercise bike', device: 'CEVIS', minutes: 30, why: 'Keeps the heart strong for standing up in gravity.' };
const BALANCE: TrainingSession = { id: 'balance', label: 'Balance and head-turn drills', device: 'Handrail, eyes open and closed', minutes: 15, why: 'Wakes up the balance sense the inner ear stops using in space.' };

/**
 * ASTRA prototype plan, DEMO: the real plan comes from the crew's strength and conditioning trainers on the ground.
 * week: weekday index (0 = first day of the plan week) -> sessions.
 */
export const REENTRY_PLAN: TrainingPhase[] = [
  { id: 'build', label: 'Build strength', fromDay: 142, toDay: 162, goal: '6 weight sessions a week',
    week: { 0: [ARED, CEVIS], 1: [ARED, T2], 2: [ARED, CEVIS], 3: [ARED, T2], 4: [ARED, CEVIS], 5: [ARED, T2], 6: [CEVIS] } },
  { id: 'gravity', label: 'Get ready for gravity', fromDay: 163, toDay: 177, goal: 'Add balance drills every day',
    week: { 0: [ARED, BALANCE], 1: [T2, BALANCE], 2: [ARED, BALANCE], 3: [T2, CEVIS, BALANCE], 4: [ARED, BALANCE], 5: [T2, BALANCE], 6: [CEVIS, BALANCE] } },
  { id: 'taper', label: 'Rest before landing', fromDay: 178, toDay: 180, goal: 'Light sessions, save energy for landing',
    week: { 0: [BALANCE, { ...CEVIS, minutes: 20 }], 1: [BALANCE], 2: [] } },
];

export function phaseFor(day: number): TrainingPhase {
  return REENTRY_PLAN.find((p) => day >= p.fromDay && day <= p.toDay) ?? REENTRY_PLAN[REENTRY_PLAN.length - 1];
}

export function sessionsFor(day: number): TrainingSession[] {
  const p = phaseFor(day);
  return p.week[(day - p.fromDay) % 7] ?? [];
}

export const reentryKey = (day: number, id: string) => `reentry:${day}:${id}`;
/** Demo scoring: each finished session this plan week lifts the exercise part by this many points. */
export const POINTS_PER_SESSION = 4;

/** Days of the current plan week and how many sessions were finished in it. */
export function weekProgress(day: number, done: Record<string, string>) {
  const phase = phaseFor(day);
  const weekStart = phase.fromDay + Math.floor((day - phase.fromDay) / 7) * 7;
  const weekDays = Array.from({ length: 7 }, (_, i) => weekStart + i).filter((d) => d <= phase.toDay);
  const doneThisWeek = weekDays.reduce((n, d) => n + sessionsFor(d).filter((s) => done[reentryKey(d, s.id)]).length, 0);
  return { phase, weekDays, doneThisWeek };
}

/** Readiness score from the parts, with this week's finished sessions added to exercise. */
export function readiness(doneThisWeek: number) {
  const parts = REENTRY_PARTS.map((p) => (p.id === 'exercise' ? { ...p, score: Math.min(100, p.score + doneThisWeek * POINTS_PER_SESSION) } : p));
  const score = Math.round(parts.reduce((sum, p) => sum + p.weight * p.score, 0));
  // Improve first: the part that costs the most points and that the astronaut can change.
  const first = parts.filter((p) => p.canImprove).reduce((a, b) => ((100 - b.score) * b.weight > (100 - a.score) * a.weight ? b : a));
  return { parts, score, status: reentryStatus(score), first };
}
