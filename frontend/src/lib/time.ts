import { differenceInMinutes } from 'date-fns';

/** The demo runs on a simulated mission clock so the story is reproducible. */
export const DEMO_ANCHOR = '2026-11-13T08:45:00Z';
export const MISSION_DAY_AT_ANCHOR = 142;

export function simNow(offsetMin: number): Date {
  return new Date(new Date(DEMO_ANCHOR).getTime() + offsetMin * 60_000);
}
export function missionDay(now: Date): number {
  return MISSION_DAY_AT_ANCHOR + Math.round((startUTC(now).getTime() - startUTC(new Date(DEMO_ANCHOR)).getTime()) / 86_400_000);
}
export function hhmm(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
export function dayLabel(iso: string, now: Date): string {
  const d = new Date(iso);
  const days = Math.floor((startUTC(now).getTime() - startUTC(d).getTime()) / 86_400_000);
  if (days === 0) return `today ${hhmm(d)}`;
  if (days === 1) return `yesterday ${hhmm(d)}`;
  return `${days} days ago`;
}
export function startUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
export function ago(iso: string, now: Date): string {
  const m = differenceInMinutes(now, new Date(iso));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}
export const utcStamp = (iso: string) => new Date(iso).toISOString().slice(0, 10) + ' ' + hhmm(iso) + ' UTC';

/** Mission Elapsed Time as DDD:HH:MM. Launch is 00:00 UTC on Mission Day 1 in this demo. */
export function met(now: Date): string {
  const d = missionDay(now) - 1;
  return `${String(d).padStart(3, '0')}:${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
}
/** Flight-ops GMT: day-of-year then HH:MM, e.g. 317/08:45. */
export function gmtDoy(now: Date): string {
  const doy = Math.floor((startUTC(now).getTime() - Date.UTC(now.getUTCFullYear(), 0, 1)) / 86_400_000) + 1;
  return `${String(doy).padStart(3, '0')}/${hhmm(now)}`;
}
