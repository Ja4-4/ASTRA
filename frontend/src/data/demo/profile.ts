import type { Profile } from '../types';

/** Fictional astronaut. Any resemblance to a real person is unintended. */
export const DEMO_PROFILE: Profile = {
  name: 'Cmdr. Layla Haddad',
  callsign: 'HADDAD',
  role: 'Commander · synthetic profile',
  missionDay: 142,
  synthetic: true,
  baseline: { hr: 62, bp_sys: 116, bp_dia: 74, glucose: 94, temp: 37.0, sleep: 7.4, mood: 4 },
  prescribedExerciseMinPerDay: 90,
};

/** Crew for the cooperative patch. Only check-in completion is shared, never health values. */
export const DEMO_CREW = [
  { callsign: 'HADDAD', role: 'CDR', checkinsThisWeek: 6 },
  { callsign: 'OKAFOR', role: 'PLT', checkinsThisWeek: 7 },
  { callsign: 'LINDQVIST', role: 'MS1', checkinsThisWeek: 5 },
  { callsign: 'TANAKA', role: 'MS2', checkinsThisWeek: 6 },
];
