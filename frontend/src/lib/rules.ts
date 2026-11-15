/**
 * ASTRA alert rules, kept as data so the research partner can audit them in one place.
 *
 * DEMO · PENDING VALIDATION. These thresholds are demo rules for synthetic data. They loosely
 * follow general adult reference ranges and are NOT clinical criteria.
 *
 * Every evaluation returns { status, ruleId, explanation, inputs[] } and the explanation names the
 * exact threshold, the value, the time it was logged and the source.
 */
import type { IndicatorId, Profile, Reading } from '../data/types';
import type { StatusKey } from './status';
import { METRICS, type MetricId } from './indicators';
import { hhmm, startUTC } from './time';

export const RULES_VALIDATION_STATE = 'Demo rules, pending medical validation.';

export interface RuleResult {
  metric: MetricId;
  status: StatusKey;
  ruleId: string;
  explanation: string;
  /** The same finding in everyday words, for the crew member. */
  plain: string;
  inputs: Reading[];
  /** Display value, e.g. "142/92" */
  display: string;
  unit: string;
}

/** Human-readable rule table for the rule panel and the Evidence page. Order: Act, Watch, Nominal. */
export const RULE_TABLE: Record<MetricId, { nominal: string; watch: string; act: string; stale: string }> = {
  hr: { nominal: '50 to 90 bpm, and near your usual', watch: '40 to 49 or 91 to 120 bpm, or 15% away from your usual', act: 'Under 40 or over 120 bpm', stale: 'Nothing logged in 48 h' },
  bp: { nominal: 'Top number under 130 and bottom under 80', watch: 'Top 130 to 159, or bottom 80 to 99', act: 'Top 160 or more, bottom 100 or more, or top under 90', stale: 'Nothing logged in 48 h' },
  glucose: { nominal: '70 to 125 mg/dL', watch: '54 to 69, or 126 to 180 mg/dL', act: 'Under 54 or over 180 mg/dL', stale: 'Nothing logged in 48 h' },
  temp: { nominal: 'Within 0.5 °C of your usual', watch: '0.5 to 1 °C above your usual, or more than 0.5 °C below', act: 'More than 1 °C above your usual, or 38.5 °C and up', stale: 'Nothing logged in 48 h' },
  sleep: { nominal: '7 h or more, or close to your usual', watch: 'Under 7 h and below your usual, or 2 short nights in a row', act: 'Under 5 h for 3 nights in a row', stale: 'Nothing logged in 36 h' },
  mood: { nominal: '3 or more out of 5', watch: 'A 2 out of 5', act: 'A 1, or 2 or lower for 3 days in a row', stale: 'Nothing logged in 36 h' },
  exercise: { nominal: '85% or more of planned minutes this week', watch: '60% to 84%', act: 'Under 60%', stale: 'No workout logged in 7 days' },
};

const H = 3600_000;

function byIndicator(readings: Reading[], id: IndicatorId): Reading[] {
  return readings.filter((r) => r.indicator === id && r.quality !== 'questionable').sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}
function latest(readings: Reading[], id: IndicatorId): Reading | undefined {
  const l = byIndicator(readings, id);
  return l[l.length - 1];
}
function srcText(r: Reading) {
  return `logged ${hhmm(r.timestamp)}, ${r.source}`;
}
/** Latest value per UTC day, most recent last. */
function dailyLatest(readings: Reading[], id: IndicatorId): Reading[] {
  const map = new Map<number, Reading>();
  for (const r of byIndicator(readings, id)) map.set(startUTC(new Date(r.timestamp)).getTime(), r);
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
}
function consecutiveDays(list: Reading[]): boolean {
  for (let i = 1; i < list.length; i++) {
    const d = (startUTC(new Date(list[i].timestamp)).getTime() - startUTC(new Date(list[i - 1].timestamp)).getTime()) / 86_400_000;
    if (d !== 1) return false;
  }
  return true;
}

export function baselineFor(profile: Profile, readings: Reading[], id: IndicatorId): number | undefined {
  // Demo: the profile's preflight value. Otherwise the median of the first 14 days of readings.
  if (profile.baseline[id] !== undefined) return profile.baseline[id];
  const list = byIndicator(readings, id);
  if (list.length === 0) return undefined;
  const cutoff = new Date(list[0].timestamp).getTime() + 14 * 86_400_000;
  const w = list.filter((r) => new Date(r.timestamp).getTime() < cutoff).map((r) => r.value).sort((x, y) => x - y);
  return w[Math.floor(w.length / 2)];
}

function nodata(metric: MetricId, now: Date, last?: Reading): RuleResult {
  const m = METRICS[metric];
  const window = m.cadenceHours >= 168 ? '7 days' : `${m.cadenceHours} h`;
  const age = last ? Math.round((now.getTime() - new Date(last.timestamp).getTime()) / H) : 0;
  return {
    metric, status: 'nodata', ruleId: `${metric}.stale`,
    explanation: last
      ? `Last ${m.label.toLowerCase()} logged ${age >= 48 ? Math.floor(age / 24) + ' days' : age + ' h'} ago (${last.source}), older than the ${window} window. Not available until re-measured.`
      : `No ${m.label.toLowerCase()} logged in the ${window} window. Not available.`,
    plain: last
      ? `No ${m.short.toLowerCase()} logged in the last ${age >= 48 ? Math.floor(age / 24) + ' days' : age + ' hours'}. ASTRA needs one at least ${m.cadenceHours >= 168 ? 'once a week' : `every ${m.cadenceHours} hours`}, so it shows no status.`
      : `No ${m.short.toLowerCase()} logged yet, so ASTRA shows no status.`,
    inputs: last ? [last] : [], display: '—', unit: m.unit,
  };
}

function stale(r: Reading | undefined, metric: MetricId, now: Date) {
  return !r || now.getTime() - new Date(r.timestamp).getTime() > METRICS[metric].cadenceHours * H;
}

type Evaluator = (readings: Reading[], now: Date, profile: Profile) => RuleResult;

const evaluators: Record<MetricId, Evaluator> = {
  hr(readings, now, profile) {
    const r = latest(readings, 'hr');
    if (stale(r, 'hr', now)) return nodata('hr', now, r);
    const v = r!.value; const base = baselineFor(profile, readings, 'hr') ?? 62;
    const dev = Math.abs(v - base) / base;
    const out = (status: StatusKey, ruleId: string, explanation: string, plain: string): RuleResult => ({ metric: 'hr', status, ruleId, explanation, plain, inputs: [r!], display: `${v}`, unit: 'bpm' });
    if (v < 40) return out('act', 'hr.act.low', `Resting HR ${v} bpm < 40 Act threshold (${srcText(r!)})`, `Your resting heart rate is ${v}. Under 40 is too slow.`);
    if (v > 120) return out('act', 'hr.act.high', `Resting HR ${v} bpm > 120 Act threshold (${srcText(r!)})`, `Your resting heart rate is ${v}. Over 120 is too fast.`);
    if (v < 50) return out('watch', 'hr.watch.low', `Resting HR ${v} bpm in 40–49 Watch range (${srcText(r!)})`, `Your resting heart rate is ${v}, a little slow (under 50).`);
    if (v > 90) return out('watch', 'hr.watch.high', `Resting HR ${v} bpm in 91–120 Watch range (${srcText(r!)})`, `Your resting heart rate is ${v}, a little fast (over 90).`);
    if (dev > 0.15) return out('watch', 'hr.watch.baseline', `Resting HR ${v} bpm is ${Math.round(dev * 100)}% from baseline ${base} bpm, >15% Watch threshold (${srcText(r!)})`, `Your resting heart rate is ${v}, which is ${Math.round(dev * 100)}% away from your usual ${base}.`);
    return out('ok', 'hr.ok', `Resting HR ${v} bpm within 50–90 and ${Math.round(dev * 100)}% of baseline ${base} bpm (${srcText(r!)})`, `Your resting heart rate is ${v}, close to your usual ${base}.`);
  },
  bp(readings, now) {
    const s = latest(readings, 'bp_sys');
    const d = latest(readings, 'bp_dia');
    if (stale(s, 'bp', now) || stale(d, 'bp', now)) return nodata('bp', now, s);
    const sv = s!.value, dv = d!.value;
    const out = (status: StatusKey, ruleId: string, explanation: string, plain: string): RuleResult => ({ metric: 'bp', status, ruleId, explanation, plain, inputs: [s!, d!], display: `${sv}/${dv}`, unit: 'mmHg' });
    if (sv >= 160) return out('act', 'bp.act.sys', `Systolic ${sv} mmHg ≥ 160 Act threshold (${srcText(s!)})`, `Your blood pressure is ${sv}/${dv}. A top number of 160 or more is too high.`);
    if (dv >= 100) return out('act', 'bp.act.dia', `Diastolic ${dv} mmHg ≥ 100 Act threshold (${srcText(d!)})`, `Your blood pressure is ${sv}/${dv}. A bottom number of 100 or more is too high.`);
    if (sv < 90) return out('act', 'bp.act.low', `Systolic ${sv} mmHg < 90 Act threshold (${srcText(s!)})`, `Your blood pressure is ${sv}/${dv}. A top number under 90 is too low.`);
    if (sv >= 130) return out('watch', 'bp.watch.sys', `Systolic ${sv} mmHg ≥ 130 Watch threshold (${srcText(s!)})`, `Your blood pressure is ${sv}/${dv}, a bit high (top number 130 or more).`);
    if (dv >= 80) return out('watch', 'bp.watch.dia', `Diastolic ${dv} mmHg ≥ 80 Watch threshold (${srcText(d!)})`, `Your blood pressure is ${sv}/${dv}, a bit high (bottom number 80 or more).`);
    return out('ok', 'bp.ok', `BP ${sv}/${dv} mmHg below 130/80 (${srcText(s!)})`, `Your blood pressure is ${sv}/${dv}, in the healthy zone (under 130/80).`);
  },
  glucose(readings, now) {
    const r = latest(readings, 'glucose');
    if (stale(r, 'glucose', now)) return nodata('glucose', now, r);
    const v = r!.value;
    const out = (status: StatusKey, ruleId: string, explanation: string, plain: string): RuleResult => ({ metric: 'glucose', status, ruleId, explanation, plain, inputs: [r!], display: `${v}`, unit: 'mg/dL' });
    if (v < 54) return out('act', 'glucose.act.low', `Glucose ${v} mg/dL < 54 Act threshold (${srcText(r!)})`, `Your blood sugar is ${v}. Under 54 is too low.`);
    if (v > 180) return out('act', 'glucose.act.high', `Glucose ${v} mg/dL > 180 Act threshold (${srcText(r!)})`, `Your blood sugar is ${v}. Over 180 is too high.`);
    if (v < 70) return out('watch', 'glucose.watch.low', `Glucose ${v} mg/dL in 54–69 Watch range (${srcText(r!)})`, `Your blood sugar is ${v}, a little low (under 70).`);
    if (v > 125) return out('watch', 'glucose.watch.high', `Glucose ${v} mg/dL in 126–180 Watch range (${srcText(r!)})`, `Your blood sugar is ${v}, a little high (over 125).`);
    return out('ok', 'glucose.ok', `Glucose ${v} mg/dL within 70–125 (${srcText(r!)})`, `Your blood sugar is ${v}, in the healthy zone (70 to 125).`);
  },
  temp(readings, now, profile) {
    const r = latest(readings, 'temp');
    if (stale(r, 'temp', now)) return nodata('temp', now, r);
    const v = r!.value; const base = baselineFor(profile, readings, 'temp') ?? 37.0;
    const delta = +(v - base).toFixed(1);
    const sd = (delta > 0 ? '+' : '') + delta.toFixed(1);
    const out = (status: StatusKey, ruleId: string, explanation: string, plain: string): RuleResult => ({ metric: 'temp', status, ruleId, explanation, plain, inputs: [r!], display: v.toFixed(1), unit: '°C' });
    if (v >= 38.5) return out('act', 'temp.act.abs', `Temperature ${v.toFixed(1)} °C ≥ 38.5 Act threshold (${srcText(r!)})`, `Your temperature is ${v.toFixed(1)} °C. 38.5 °C or more is a fever.`);
    if (delta > 1.0) return out('act', 'temp.act.baseline', `Temperature ${sd} °C vs baseline ${base.toFixed(1)}, > +1.0 Act threshold (${srcText(r!)})`, `Your temperature is ${v.toFixed(1)} °C, more than 1 °C above your usual ${base.toFixed(1)} °C. This can be a fever.`);
    if (Math.abs(delta) > 0.5) return out('watch', 'temp.watch.baseline', `Temperature ${sd} °C vs baseline ${base.toFixed(1)}, outside ±0.5 Nominal band (${srcText(r!)})`, `Your temperature is ${v.toFixed(1)} °C, more than half a degree away from your usual ${base.toFixed(1)} °C.`);
    return out('ok', 'temp.ok', `Temperature ${sd} °C vs baseline ${base.toFixed(1)}, within ±0.5 (${srcText(r!)})`, `Your temperature is ${v.toFixed(1)} °C, close to your usual ${base.toFixed(1)} °C.`);
  },
  sleep(readings, now, profile) {
    const r = latest(readings, 'sleep');
    if (stale(r, 'sleep', now)) return nodata('sleep', now, r);
    const v = r!.value; const base = baselineFor(profile, readings, 'sleep') ?? 7.4;
    const days = dailyLatest(readings, 'sleep');
    const last3 = days.slice(-3); const last2 = days.slice(-2);
    const out = (status: StatusKey, ruleId: string, explanation: string, plain: string, inputs: Reading[] = [r!]): RuleResult => ({ metric: 'sleep', status, ruleId, explanation, plain, inputs, display: v.toFixed(1), unit: 'h' });
    if (last3.length === 3 && consecutiveDays(last3) && last3.every((x) => x.value < 5))
      return out('act', 'sleep.act.3nights', `Sleep <5 h for 3 consecutive nights (${last3.map((x) => x.value.toFixed(1)).join(', ')} h; latest ${srcText(r!)})`, `You slept under 5 hours for 3 nights in a row.`, last3);
    if (last2.length === 2 && consecutiveDays(last2) && last2.every((x) => x.value < base - 1))
      return out('watch', 'sleep.watch.2nights', `Sleep ${last2.map((x) => x.value.toFixed(1)).join(' h, ')} h: 2 consecutive nights >1 h below baseline ${base.toFixed(1)} h (${srcText(r!)})`, `You slept more than 1 hour less than your usual for 2 nights in a row.`, last2);
    if (v >= 7 || v >= base - 0.5) return out('ok', 'sleep.ok', `Sleep ${v.toFixed(1)} h, at or near baseline ${base.toFixed(1)} h (${srcText(r!)})`, `You slept ${v.toFixed(1)} hours, about your usual.`);
    return out('watch', 'sleep.watch.short', `Sleep ${v.toFixed(1)} h < 7 h and below baseline −0.5 h (${srcText(r!)})`, `You slept ${v.toFixed(1)} hours, less than 7 and less than your usual.`);
  },
  mood(readings, now) {
    const r = latest(readings, 'mood');
    if (stale(r, 'mood', now)) return nodata('mood', now, r);
    const v = r!.value;
    const days = dailyLatest(readings, 'mood'); const last3 = days.slice(-3);
    const out = (status: StatusKey, ruleId: string, explanation: string, plain: string, inputs: Reading[] = [r!]): RuleResult => ({ metric: 'mood', status, ruleId, explanation, plain, inputs, display: `${v}`, unit: '/5' });
    if (v <= 1) return out('act', 'mood.act.one', `Mood ${v}/5: any 1 is an Act threshold (${srcText(r!)})`, `You rated your mood 1 out of 5, the lowest score.`);
    if (last3.length === 3 && consecutiveDays(last3) && last3.every((x) => x.value <= 2))
      return out('act', 'mood.act.3days', `Mood ≤2 for 3 consecutive days (${last3.map((x) => x.value).join(', ')}; ${srcText(r!)})`, `Your mood has been 2 or lower for 3 days in a row.`, last3);
    if (v <= 2) return out('watch', 'mood.watch.two', `Mood ${v}/5 ≤ 2 Watch threshold (${srcText(r!)})`, `You rated your mood 2 out of 5, lower than usual.`);
    return out('ok', 'mood.ok', `Mood ${v}/5 ≥ 3 (${srcText(r!)})`, `You rated your mood ${v} out of 5.`);
  },
  exercise(readings, now, profile) {
    const since = now.getTime() - 7 * 86_400_000;
    const list = byIndicator(readings, 'exercise_min').filter((r) => new Date(r.timestamp).getTime() > since && new Date(r.timestamp).getTime() <= now.getTime());
    if (list.length === 0) return nodata('exercise', now, latest(readings, 'exercise_min'));
    const done = list.reduce((a, r) => a + Math.min(r.value, profile.prescribedExerciseMinPerDay), 0);
    const pct = Math.round((done / (profile.prescribedExerciseMinPerDay * 7)) * 100);
    const lastR = list[list.length - 1];
    const explain = `${done} of ${profile.prescribedExerciseMinPerDay * 7} prescribed min in 7 days`;
    const out = (status: StatusKey, ruleId: string, explanation: string, plain: string): RuleResult => ({ metric: 'exercise', status, ruleId, explanation, plain, inputs: list, display: `${pct}`, unit: '%' });
    if (pct < 60) return out('act', 'exercise.act', `Adherence ${pct}% < 60% Act threshold (${explain}; last ${srcText(lastR)})`, `You did ${pct}% of your planned exercise this week. Under 60% is too little to protect bones and muscles.`);
    if (pct < 85) return out('watch', 'exercise.watch', `Adherence ${pct}% in 60–84% Watch range (${explain}; last ${srcText(lastR)})`, `You did ${pct}% of your planned exercise this week. Aim for 85% or more.`);
    return out('ok', 'exercise.ok', `Adherence ${pct}% ≥ 85% (${explain})`, `You did ${pct}% of your planned exercise this week. On track.`);
  },
};

export function evaluate(metric: MetricId, readings: Reading[], now: Date, profile: Profile): RuleResult {
  // Only readings at or before the simulated clock count.
  const visible = readings.filter((r) => new Date(r.timestamp).getTime() <= now.getTime());
  return evaluators[metric](visible, now, profile);
}

export function evaluateAll(readings: Reading[], now: Date, profile: Profile): Record<MetricId, RuleResult> {
  const out = {} as Record<MetricId, RuleResult>;
  (Object.keys(evaluators) as MetricId[]).forEach((m) => (out[m] = evaluate(m, readings, now, profile)));
  return out;
}

/** Threshold lines for trend charts. */
export const CHART_THRESHOLDS: Partial<Record<IndicatorId, { value: number; status: 'watch' | 'act'; label: string }[]>> = {
  hr: [{ value: 90, status: 'watch', label: 'Watch 91' }, { value: 120, status: 'act', label: 'Act 120' }, { value: 50, status: 'watch', label: 'Watch <50' }],
  bp_sys: [{ value: 130, status: 'watch', label: 'Watch 130' }, { value: 160, status: 'act', label: 'Act 160' }],
  bp_dia: [{ value: 80, status: 'watch', label: 'Watch 80' }, { value: 100, status: 'act', label: 'Act 100' }],
  glucose: [{ value: 125, status: 'watch', label: 'Watch 126' }, { value: 180, status: 'act', label: 'Act 180' }, { value: 70, status: 'watch', label: 'Watch <70' }, { value: 54, status: 'act', label: 'Act <54' }],
  temp: [{ value: 38.5, status: 'act', label: 'Act 38.5' }],
  sleep: [{ value: 7, status: 'watch', label: 'Watch <7' }, { value: 5, status: 'act', label: 'Act <5 ×3' }],
  mood: [{ value: 2, status: 'watch', label: 'Watch ≤2' }],
};
