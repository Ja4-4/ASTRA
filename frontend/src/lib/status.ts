import { CircleCheck, CircleDashed, OctagonAlert, TriangleAlert, type LucideIcon } from 'lucide-react';

/** Single source of truth for status language. Colour is never the only signal: every status has icon + label. */
export type StatusKey = 'ok' | 'watch' | 'act' | 'nodata';

export interface StatusDef {
  key: StatusKey;
  label: string;
  cssVar: string;
  icon: LucideIcon;
  meaning: string;
  /** What the person should do, in one short line. Shown in legends and the welcome guide. */
  todo: string;
  severity: number;
}

export const STATUS: Record<StatusKey, StatusDef> = {
  ok: { key: 'ok', label: 'In range', cssVar: 'var(--ok)', icon: CircleCheck, meaning: 'Same as your usual.', todo: 'Nothing to do.', severity: 1 },
  watch: { key: 'watch', label: 'Watch', cssVar: 'var(--watch)', icon: TriangleAlert, meaning: 'A little different from your usual. Not an emergency.', todo: 'Check it again later.', severity: 2 },
  act: { key: 'act', label: 'Act now', cssVar: 'var(--act)', icon: OctagonAlert, meaning: 'Far from your usual. This needs you now.', todo: 'Do the 3 steps and tell the doctor.', severity: 3 },
  nodata: { key: 'nodata', label: 'Not available', cssVar: 'var(--nodata)', icon: CircleDashed, meaning: 'No new number yet, so ASTRA will not guess.', todo: 'Measure it to see how you are.', severity: 0 },
};

/** Worst status wins. If every input is missing the result is nodata. A mix of data and missing data takes the worst known status. */
export function worstStatus(list: StatusKey[]): StatusKey {
  const known = list.filter((s) => s !== 'nodata');
  if (known.length === 0) return 'nodata';
  return known.reduce((a, b) => (STATUS[b].severity > STATUS[a].severity ? b : a));
}

/** Hex values for WebGL (CSS vars are not readable by three.js materials). Keep in sync with index.css. */
export const STATUS_HEX: Record<'dark' | 'light', Record<StatusKey, string>> = {
  dark: { ok: '#3FBF74', watch: '#F0A23B', act: '#FF5A5F', nodata: '#8A8499' },
  light: { ok: '#047857', watch: '#B4440A', act: '#BE123C', nodata: '#475569' },
};
