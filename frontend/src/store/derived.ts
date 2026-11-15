import { useMemo } from 'react';
import { useAstra, loopStage } from './useAstra';
import { evaluateAll } from '../lib/rules';
import { systemStates } from '../lib/systems';
import { DEMO_PROFILE } from '../data/demo/profile';
import { CHECKIN_ITEMS, METRICS, METRIC_ORDER } from '../lib/indicators';
import { startUTC } from '../lib/time';

export function useNow() {
  const off = useAstra((s) => s.clockOffsetMin);
  return useMemo(() => useAstra.getState().now(), [off]);
}

export function useDerived() {
  const readings = useAstra((s) => s.readings);
  const events = useAstra((s) => s.events);
  const now = useNow();
  return useMemo(() => {
    const visible = readings.filter((r) => new Date(r.timestamp) <= now);
    const results = evaluateAll(visible, now, DEMO_PROFILE);
    const systems = systemStates(results);
    const alerts = METRIC_ORDER.map((m) => results[m]).filter((r) => r.status === 'watch' || r.status === 'act')
      .sort((a, b) => (a.status === 'act' ? -1 : 0) - (b.status === 'act' ? -1 : 0));
    const dayKey = startUTC(now).getTime();
    const today = visible.filter((r) => startUTC(new Date(r.timestamp)).getTime() === dayKey);
    const orbitDone = CHECKIN_ITEMS.filter((m) => METRICS[m].indicators.every((ind) => today.some((r) => r.indicator === ind)));
    const rad = visible.filter((r) => r.indicator === 'rad_dose').sort((a, b) => a.timestamp.localeCompare(b.timestamp)).pop();
    return { now, visible, results, systems, alerts, orbitDone, stage: loopStage(events), rad };
  }, [readings, events, now]);
}
