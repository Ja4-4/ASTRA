import type { MetricId } from './indicators';
import type { RuleResult } from './rules';
import { worstStatus, type StatusKey } from './status';

export type SystemId = 'cardio' | 'neuro' | 'metabolic' | 'immune' | 'msk' | 'ocular';

export interface SystemDef {
  id: SystemId;
  label: string;
  shortLabel: string;
  /** The medical name, shown small under the plain one. */
  technical: string;
  mesh: string;
  metrics: MetricId[];
  /** Meshes that render for this system, described for the a11y label. */
  anatomy: string;
  relevance: string;
  derivedNote?: string;
  tracked: boolean;
}

/** Each system's status is the WORST status among its indicators. All missing => nodata. */
export const SYSTEMS: SystemDef[] = [
  { id: 'cardio', label: 'Heart & blood flow', shortLabel: 'Heart', technical: 'Cardiovascular', mesh: 'sys_cardio', metrics: ['hr', 'bp'], anatomy: 'heart, aorta, major vessels', relevance: 'Without gravity, body fluids move toward the head and the heart works less, so it can weaken.', tracked: true },
  { id: 'neuro', label: 'Sleep & mood', shortLabel: 'Sleep & mood', technical: 'Neuro-behavioural', mesh: 'sys_neuro', metrics: ['sleep', 'mood'], anatomy: 'brain', relevance: 'Small crew, tight spaces and 16 sunrises a day make sleep and mood harder.', tracked: true },
  { id: 'metabolic', label: 'Blood sugar', shortLabel: 'Sugar', technical: 'Metabolic', mesh: 'sys_metabolic', metrics: ['glucose'], anatomy: 'liver, pancreas', relevance: 'Spaceflight changes how the body handles sugar from food.', tracked: true },
  { id: 'immune', label: 'Temperature & immunity', shortLabel: 'Temperature', technical: 'Thermoregulation & immune', mesh: 'sys_immune', metrics: ['temp'], anatomy: 'skin shell tint, thymus', relevance: 'The immune system weakens in space, and body temperature runs a little higher. A fever can be the first sign of infection.', tracked: true },
  { id: 'msk', label: 'Muscles & bones', shortLabel: 'Muscle & bone', technical: 'Musculoskeletal', mesh: 'sys_msk', metrics: ['exercise'], anatomy: 'pelvis, spine, femurs, tibiae', relevance: 'Without gravity, bones and muscles shrink. Daily exercise is the main protection.', derivedNote: 'from exercise', tracked: true },
  { id: 'ocular', label: 'Eyes', shortLabel: 'Eyes', technical: 'Ocular', mesh: 'sys_ocular', metrics: [], anatomy: 'eyes', relevance: 'Pressure changes in space can change eyesight over a long mission (called SANS).', derivedNote: 'not tracked', tracked: false },
];

export const SYSTEM_BY_ID = Object.fromEntries(SYSTEMS.map((s) => [s.id, s])) as Record<SystemId, SystemDef>;

export interface SystemState {
  def: SystemDef;
  status: StatusKey;
  results: RuleResult[];
  /** The result that set the status (worst one). */
  driver?: RuleResult;
}

export function systemStates(results: Record<MetricId, RuleResult>): SystemState[] {
  return SYSTEMS.map((def) => {
    const rs = def.metrics.map((m) => results[m]);
    const status = worstStatus(rs.map((r) => r.status));
    const driver = rs.find((r) => r.status === status) ?? rs[0];
    return { def, status, results: rs, driver };
  });
}

export const GUIDANCE: Record<StatusKey, { means: string; todo: string[] }> = {
  ok: { means: 'Your latest numbers are where they usually are. Nothing to do.', todo: ['Keep your routine and your daily check-in.'] },
  watch: { means: 'One number is a bit off from your usual. This is a heads-up, not an emergency.', todo: ['Measure again, following the "How to measure" tips.', 'Do today’s planned exercise and routine.', 'If it is still off, ASTRA adds it to the next report for the doctor.'] },
  act: { means: 'One number is clearly outside the safe zone. Follow these steps now.', todo: ['Sit and rest for 5 minutes, then measure again.', 'Write down how you feel (headache, dizziness, anything).', 'Send it to the flight surgeon (the crew doctor on the ground).'] },
  nodata: { means: 'There is no recent number, so ASTRA will not guess how you are.', todo: ['Log a reading to see a status here.'] },
};
