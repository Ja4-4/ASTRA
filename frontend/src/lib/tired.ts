/**
 * Tired signs from the eyes and the skin, always against the astronaut's OWN usual face, never a population number.
 *
 * Source: Sundelin T, Lekander M, Kecklund G, Van Someren EJW, Olsson A, Axelsson J. "Cues of fatigue: effects of
 * sleep deprivation on facial appearance." Sleep 2013;36(9):1355-1360, doi:10.5665/sleep.2964. After 31 h awake,
 * photos were rated as having more hanging eyelids, redder and more swollen eyes, darker circles under the eyes,
 * paler skin and droopier mouth corners. These are cues other people see, not a diagnosis, so ASTRA counts signs
 * against the astronaut's own usual and never gives a score on its own.
 */
export const TIRED_SOURCE = 'Sundelin et al. 2013, “Cues of fatigue: effects of sleep deprivation on facial appearance”, Sleep 36(9):1355-1360, doi:10.5665/sleep.2964.';

/** One scan's values (null = not measured this time). */
export interface TiredValues {
  /** Median eye openness (eye aspect ratio, both eyes) over the good frames. */
  eyeOpen: number | null;
  /** Mean brightness under the eyes divided by the cheeks' (room light cancels out). */
  underEye: number | null;
  /** Cheek redness: mean R / (R + G + B) of the cheek skin. */
  redness: number | null;
  /** Share of the scan with the eyes closed, percent. */
  closedPct: number | null;
  blinksPerMin: number | null;
  kind: 'baseline' | 'scan';
}

/** PROVISIONAL until calibrated on camera: how far from the usual each value must be to count as a sign. */
export const TIRED_LIMITS = {
  /** Eye openness at least 12% lower than usual. */
  lidsLower: 0.12,
  /** Under-eye / cheek brightness at least 6% lower than usual. */
  underEyeDarker: 0.06,
  /** Cheek redness at least 5% lower than usual. */
  paler: 0.05,
  /** Eyes closed share and blinks per minute: at least 1.5x the usual AND at least 5 more (percent points, blinks). */
  aboveRatio: 1.5,
  abovePlus: 5,
};
/** Below this many scans the result says it is compared with the first scan. */
export const LEARN_SCANS = 3;
/** The usual is the median of this many latest good scans, so one bad night does not become the new usual. */
export const HISTORY_SCANS = 7;

type Key = 'eyeOpen' | 'underEye' | 'redness' | 'closedPct' | 'blinksPerMin';
type SignId = 'lids' | 'underEye' | 'pale' | 'closed' | 'blinks';
export interface TiredSign { id: SignId; label: string; now: number | null; usual: number | null; diffPct: number | null; measured: boolean; on: boolean }
export interface TiredResult {
  signs: TiredSign[];
  count: number;
  /** 1 only on the very first scan, when there is no usual at all yet (this scan becomes the usual); otherwise null. */
  learning: number | null;
  /** True while the usual rests on fewer than LEARN_SCANS scans (the relaxed baseline or the first scans). */
  early: boolean;
  /** Signs from the eyes (lids, under-eye, closed, blinks): 2 or more make the face reading "Tired". */
  eyeSigns: number;
  closedHigh: boolean;
}

const SIGNS: { id: SignId; key: Key; label: string; said: string; on: (now: number, usual: number) => boolean }[] = [
  { id: 'lids', key: 'eyeOpen', label: 'eyelids lower', said: 'your eyelids were lower', on: (n, u) => n <= u * (1 - TIRED_LIMITS.lidsLower) },
  { id: 'underEye', key: 'underEye', label: 'darker under the eyes', said: 'it was darker under your eyes', on: (n, u) => n <= u * (1 - TIRED_LIMITS.underEyeDarker) },
  { id: 'pale', key: 'redness', label: 'paler skin', said: 'your skin was paler', on: (n, u) => n <= u * (1 - TIRED_LIMITS.paler) },
  { id: 'closed', key: 'closedPct', label: 'eyes closed more of the time', said: 'your eyes were closed more of the time', on: (n, u) => n >= Math.max(u * TIRED_LIMITS.aboveRatio, u + TIRED_LIMITS.abovePlus) },
  { id: 'blinks', key: 'blinksPerMin', label: 'more blinks', said: 'you blinked more', on: (n, u) => n >= Math.max(u * TIRED_LIMITS.aboveRatio, u + TIRED_LIMITS.abovePlus) },
];
const EYE_SIGNS: SignId[] = ['lids', 'underEye', 'closed', 'blinks'];

const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };

/** Median of each value over the history (only the entries that measured it). */
export function usualOf(history: TiredValues[]): Record<Key, number | null> {
  const of = (k: Key) => median(history.map((h) => h[k]).filter((v): v is number => v !== null));
  return { eyeOpen: of('eyeOpen'), underEye: of('underEye'), redness: of('redness'), closedPct: of('closedPct'), blinksPerMin: of('blinksPerMin') };
}

/** Signs for this scan against the usual from the earlier scans (the history before this one). */
export function tiredSigns(now: TiredValues, history: TiredValues[]): TiredResult {
  const usual = usualOf(history);
  const scansBefore = history.filter((h) => h.kind === 'scan').length;
  // Signs from the first comparison on: the relaxed baseline (or the first scan) is the usual right away.
  const learning = history.length === 0 ? 1 : null;
  const early = scansBefore < LEARN_SCANS;
  const signs = SIGNS.map((s) => {
    const n = now[s.key], u = usual[s.key];
    const measured = n !== null && u !== null && u > 0;
    return { id: s.id, label: s.label, now: n, usual: u, measured, diffPct: measured ? Math.round(((n - u) / u) * 1000) / 10 : null, on: measured && learning === null && s.on(n, u) };
  });
  const on = signs.filter((s) => s.on);
  return { signs, count: on.length, learning, early, eyeSigns: on.filter((s) => EYE_SIGNS.includes(s.id)).length, closedHigh: on.some((s) => s.id === 'closed') };
}

/** Adds a good scan (or the first baseline) and keeps the latest HISTORY_SCANS. */
export const addToHistory = (history: TiredValues[], v: TiredValues) => [...history, v].slice(-HISTORY_SCANS);

const list = (parts: string[]) => (parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0] ?? '');
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Eyelids lower and darker under the eyes than your usual." */
export function signsLine(ids: SignId[]): string {
  return ids.length ? `${cap(list(SIGNS.filter((s) => ids.includes(s.id)).map((s) => s.label)))} than your usual.` : '';
}

/** "Your eyelids were lower and it was darker under your eyes than your usual in today's scan." (Atlas) */
export function signsSaid(ids: string[]): string {
  return `${cap(list(SIGNS.filter((s) => ids.includes(s.id)).map((s) => s.said)))} than your usual in today’s scan.`;
}
