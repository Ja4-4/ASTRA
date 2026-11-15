export type Provenance = 'real' | 'imported' | 'simulated';
export type IndicatorId = 'hr' | 'bp_sys' | 'bp_dia' | 'glucose' | 'temp' | 'sleep' | 'mood' | 'exercise_min' | 'rad_dose';

export interface Reading {
  id: string;
  timestamp: string; // ISO 8601, UTC
  indicator: IndicatorId;
  value: number;
  unit: string;
  source: string;
  provenance: Provenance;
  quality?: 'good' | 'questionable';
  /** Readings logged together (e.g. a BP pair) share a group id. */
  group?: string;
}

export interface Profile {
  name: string;
  callsign: string;
  role: string;
  missionDay: number;
  synthetic: true;
  /** Preflight personal baseline (demo). Replaced by the 14-day median once 14 days of in-mission data exist. */
  baseline: Partial<Record<IndicatorId, number>>;
  prescribedExerciseMinPerDay: number;
}
