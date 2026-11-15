/**
 * Seeded generator for the synthetic demo astronaut (Cmdr. Layla Haddad, fictional).
 * Output: src/data/demo/history.raw.json in the "raw row" shape that src/data/adapter.ts maps.
 * Run: npm run gen:demo   (same seed => same story)
 *
 * Story (30 days, day 30 = today = Mission Day 142):
 *  - Days 1–20 stable.
 *  - Days 21–27 sleep drifts 7.4 -> 5.8 h, mood dips (one 2 on day 26). Neuro-behavioural -> Watch.
 *  - Day 28 onward BP elevated; today 07:40 manual reading 142/92. Cardiovascular -> Watch.
 *  - Exercise adherence ~78% over the last 7 days. Musculoskeletal -> Watch (adherence-based).
 *  - Glucose normal. Temperature not logged for the last 3 days -> Not available.
 */
import { writeFileSync } from 'node:fs';
import { DEMO_ANCHOR } from '../src/lib/time';

function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(142);
const jitter = (c: number, s: number) => c + (rnd() * 2 - 1) * s;
const r0 = (v: number) => Math.round(v);
const r1 = (v: number) => Math.round(v * 10) / 10;

type Raw = { time_utc: string; metric: string; value: number; unit: string; source: string; provenance: string };
const rows: Raw[] = [];
const anchor = new Date(DEMO_ANCHOR);
const day0 = Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate());
const at = (day: number, h: number, m: number) => new Date(day0 - (30 - day) * 86_400_000 + (h * 60 + m) * 60_000).toISOString();
const push = (day: number, h: number, m: number, metric: string, value: number, unit: string, source: string, provenance = 'simulated') => {
  const t = at(day, h, m);
  if (new Date(t) <= anchor) rows.push({ time_utc: t, metric, value, unit, source, provenance });
};

const exerciseLast7 = [75, 70, 80, 60, 72, 64, 70]; // days 23..29 => 491 / 630 = 78%
const MISSION_START_DAY = 142 - 29; // mission day of history day 1

for (let d = 1; d <= 30; d++) {
  // Resting HR (wrist sensor)
  push(d, 7, 30, 'HR_REST', d === 30 ? 64 : r0(jitter(62, 3)), 'bpm', 'wrist sensor');
  // Blood pressure (manual cuff)
  let sys = r0(jitter(116, 4)), dia = r0(jitter(74, 3));
  if (d === 28) { sys = 138; dia = 88; }
  if (d === 29) { sys = 140; dia = 90; }
  if (d === 30) { sys = 142; dia = 92; }
  push(d, 7, 40, 'BP_SYS', sys, 'mmHg', 'manual');
  push(d, 7, 40, 'BP_DIA', dia, 'mmHg', 'manual');
  // Fasting glucose (finger-stick meter)
  push(d, 8, 0, 'GLU', d === 30 ? 96 : r0(jitter(94, 6)), 'mg/dL', 'glucometer');
  // Temperature: not logged on days 28–30
  if (d <= 27) push(d, 7, 35, 'TEMP', r1(jitter(37.0, 0.15)), '°C', 'oral thermometer');
  // Sleep for the previous night (actigraphy)
  let sleep = r1(jitter(7.4, 0.2));
  if (d >= 21 && d <= 27) sleep = r1(7.4 - ((d - 20) / 7) * 1.6 + jitter(0, 0.05));
  if (d === 28) sleep = 5.9; if (d === 29) sleep = 5.7; if (d === 30) sleep = 5.8;
  push(d, 6, 30, 'SLEEP', sleep, 'h', 'actigraphy');
  // Mood (evening self-report)
  let mood = rnd() > 0.8 ? 5 : 4;
  if (d >= 21) mood = 3; if (d === 26) mood = 2;
  push(d, 21, 0, 'MOOD', mood, '/5', 'self-report');
  // Exercise minutes (prescribed 90/day)
  const ex = d >= 23 && d <= 29 ? exerciseLast7[d - 23] : r0(Math.min(90, jitter(86, 4)));
  push(d, 15, 0, 'EX_MIN', ex, 'min', 'ARED + CEVIS log');
  // Cumulative radiation dose: mission context, simulated (~0.48 mSv/day, ISS-like order of magnitude)
  push(d, 0, 5, 'RAD_CUM', r1((MISSION_START_DAY + d - 1) * 0.48), 'mSv', 'mission dosimetry (simulated)');
}

writeFileSync(new URL('../src/data/demo/history.raw.json', import.meta.url), JSON.stringify(rows, null, 1));
console.log(`wrote ${rows.length} rows`);
