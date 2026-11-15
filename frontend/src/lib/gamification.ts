/** "Orbits": rewards behaviour (consistency, honest reporting, follow-up). Never rewards a reading's value. */
export const XP = {
  checkinItem: 10,
  fullOrbit: 30,
  honestReporter: 40,
  routineActivity: 15,
  thinkingTest: 10,
} as const;

export const RANKS = [
  { title: 'Cadet', min: 0 },
  { title: 'Specialist', min: 500 },
  { title: 'Flight Engineer', min: 1500 },
  { title: 'Commander', min: 3500 },
  { title: 'Falak', min: 7000 },
];

export function rankFor(xp: number) {
  let i = 0;
  RANKS.forEach((r, idx) => { if (xp >= r.min) i = idx; });
  const next = RANKS[i + 1];
  return { rank: RANKS[i], next, progress: next ? (xp - RANKS[i].min) / (next.min - RANKS[i].min) : 1 };
}

export type BadgeId = 'orbit_7' | 'orbit_30' | 'orbit_100' | 'honest_reporter' | 'back_in_orbit' | 'first_flag' | 'gravity_week' | 'sharp_mind' | 'full_day';
export const BADGES: Record<BadgeId, { label: string; how: string }> = {
  orbit_7: { label: '7-Orbit Streak', how: 'A full check-in 7 days in a row' },
  orbit_30: { label: '30-Orbit Streak', how: 'A full check-in 30 days in a row' },
  orbit_100: { label: '100-Orbit Streak', how: 'A full check-in 100 days in a row' },
  honest_reporter: { label: 'Honest Reporter', how: 'Logged an off number and followed the advice' },
  first_flag: { label: 'Clear Signal', how: 'Sent a number to the crew doctor' },
  back_in_orbit: { label: 'Back in Orbit', how: 'Finished every follow-up check after an alert' },
  gravity_week: { label: 'Gravity Ready', how: 'Did every re-entry training session for 7 days' },
  sharp_mind: { label: 'Sharp Mind', how: 'Did both thinking tests on the same day' },
  full_day: { label: 'Full Day', how: 'Every daily mission done in one day' },
};

export type DayMark = 'full' | 'flare' | 'partial' | 'none';
