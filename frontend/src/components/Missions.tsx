import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Circle } from 'lucide-react';
import { useAstra } from '../store/useAstra';
import { useMissions } from '../lib/missions';

/** Gives each daily mission's bonus once, the moment it is complete. Mounted once in App. */
export function MissionWatcher() {
  const { day, missions, complete } = useMissions();
  const claimed = useAstra((s) => s.missionsClaimed);
  const claim = useAstra((s) => s.claimMission);
  const grant = useAstra((s) => s.grantBadge);
  useEffect(() => {
    missions.forEach((m) => { if (m.done >= m.total && !claimed[`${day}:${m.id}`]) claim(`${day}:${m.id}`, m.label, m.xp); });
    if (complete === missions.length && missions.length > 0 && !claimed[`${day}:all`]) {
      claim(`${day}:all`, 'all of today’s missions', 30);
      useAstra.setState({ celebration: { id: `${day}-all`, kind: 'mission', title: 'All missions done today', body: 'Honest report, training and a thinking test. See you tomorrow.' } });
      if (missions.length === 3) grant('full_day', 'Full Day', 'Every daily mission done in one day.');
    }
  }, [day, missions, complete, claimed, claim, grant]);
  return null;
}

/** Today's three missions with progress. Points come from doing them, never from the values. */
export function MissionsCard({ compact = false }: { compact?: boolean }) {
  const { missions, complete } = useMissions();
  return (
    <section className="card p-4" aria-labelledby="missions-h">
      <h2 id="missions-h" className="panel-head">Today’s missions <span className="num ml-auto text-sm font-normal text-muted">{complete} of {missions.length} done</span></h2>
      <ul className={`grid gap-2 ${compact ? '' : 'sm:grid-cols-3'}`}>
        {missions.map((m) => {
          const done = m.done >= m.total;
          return (
            <li key={m.id}>
              <Link to={m.to} className={`flex h-full flex-col gap-2 rounded-sm border p-3 hover:border-brand ${done ? 'border-line-strong bg-s2' : 'border-line'}`}>
                <span className="flex items-center gap-2">
                  {done ? <CheckCircle2 size={18} className="text-text" aria-label="done" /> : <Circle size={18} className="text-muted" aria-label="not done" />}
                  <span className="text-[15px] font-bold">{m.label}</span>
                  <span className="num ml-auto text-sm text-muted">+{m.xp}</span>
                </span>
                <span className="text-sm text-muted">{m.detail}</span>
                <span className="mt-auto h-1.5 w-full rounded-sm bg-line" role="progressbar" aria-label={`${m.label} progress`} aria-valuemin={0} aria-valuemax={m.total} aria-valuenow={Math.min(m.done, m.total)}>
                  <span className="block h-full rounded-sm bg-brand transition-all duration-500" style={{ width: `${(Math.min(m.done, m.total) / m.total) * 100}%` }} />
                </span>
                <span className="num text-xs text-muted">{Math.min(m.done, m.total)} / {m.total}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
