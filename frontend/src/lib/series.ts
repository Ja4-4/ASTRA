import type { IndicatorId, Reading } from '../data/types';

export function seriesOf(readings: Reading[], ind: IndicatorId, now: Date, days: number): Reading[] {
  const from = now.getTime() - days * 86_400_000;
  return readings
    .filter((r) => r.indicator === ind && new Date(r.timestamp).getTime() > from && new Date(r.timestamp).getTime() <= now.getTime())
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

/** Daily totals of exercise as adherence % of prescription (capped at 100 per day: no credit for exceeding). */
export function dailyExercisePct(readings: Reading[], now: Date, days: number, prescribed: number) {
  const map = new Map<string, number>();
  seriesOf(readings, 'exercise_min', now, days).forEach((r) => {
    const k = r.timestamp.slice(0, 10);
    map.set(k, (map.get(k) ?? 0) + r.value);
  });
  return [...map.entries()].map(([k, v]) => ({ day: k, pct: Math.min(100, Math.round((v / prescribed) * 100)) }));
}
