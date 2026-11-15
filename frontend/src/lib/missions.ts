/**
 * Three daily missions. Each rewards doing something, never a good value: logging numbers honestly,
 * training for landing, and checking how sharp you are. Completing one gives a one-time bonus that day.
 */
import { useAstra } from '../store/useAstra';
import { useDerived } from '../store/derived';
import { CHECKIN_ITEMS } from './indicators';
import { missionDay } from './time';
import { reentryKey, sessionsFor } from '../demo/newScreens';

export interface Mission { id: 'report' | 'train' | 'mind'; label: string; detail: string; done: number; total: number; xp: number; to: string }

export const MISSION_XP = 20;

export function useMissions(): { day: number; missions: Mission[]; complete: number } {
  const { orbitDone, now } = useDerived();
  const routineDone = useAstra((s) => s.routineDone);
  const day = missionDay(now);
  const sessions = sessionsFor(day);
  const trained = sessions.filter((s) => routineDone[reentryKey(day, s.id)]).length;
  const tests = ['reaction', 'memory'].filter((t) => routineDone[`test:${day}:${t}`]).length;
  const missions: Mission[] = [
    { id: 'report', label: 'Honest report', detail: 'Log all 5 daily numbers, good or not', done: orbitDone.length, total: CHECKIN_ITEMS.length, xp: MISSION_XP, to: '/log' },
    { id: 'train', label: 'Train for landing', detail: `Finish today’s ${sessions.length} training session${sessions.length > 1 ? 's' : ''}`, done: trained, total: sessions.length, xp: MISSION_XP, to: '/reentry' },
    { id: 'mind', label: 'Sharp mind', detail: 'Do one thinking test', done: Math.min(1, tests), total: 1, xp: MISSION_XP, to: '/tests' },
  ].filter((m) => m.total > 0) as Mission[]; // a rest day has no training mission, so nothing is given for free
  return { day, missions, complete: missions.filter((m) => m.done >= m.total).length };
}
