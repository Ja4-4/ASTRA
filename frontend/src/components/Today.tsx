import { Link } from 'react-router-dom';
import { CheckCircle2, Dumbbell } from 'lucide-react';
import { useAstra } from '../store/useAstra';
import { useDerived } from '../store/derived';
import { METRICS, type MetricId } from '../lib/indicators';
import { METRIC_ICON } from '../lib/icons';
import { ACTIVITIES, MEASURES } from '../lib/routine';
import { startUTC } from '../lib/time';

export interface Step {
  key: string;
  time: string;
  label: string;
  to: string;
  metric?: MetricId;
  done: boolean;
}

/** Today's measurements and exercise, in time order. */
export function useToday() {
  const { visible, now } = useDerived();
  const routineDone = useAstra((s) => s.routineDone);
  const dayStart = startUTC(now).getTime();
  const dayKey = startUTC(now).toISOString().slice(0, 10);
  const today = visible.filter((r) => startUTC(new Date(r.timestamp)).getTime() === dayStart);
  const steps: Step[] = [
    ...MEASURES.map((m) => ({
      key: `m-${m.metric}-${m.time}`, time: m.time, label: m.label, to: `/log?focus=${m.metric}`, metric: m.metric,
      done: METRICS[m.metric].indicators.every((ind) => today.some((r) => r.indicator === ind)),
    })),
    ...ACTIVITIES.map((a) => ({ key: `a-${a.id}`, time: a.time, label: `${a.label}, ${a.minutes} min`, to: '/routine', done: !!routineDone[`${dayKey}:${a.id}`] })),
  ].sort((a, b) => a.time.localeCompare(b.time));
  return { steps, todo: steps.filter((s) => !s.done), done: steps.filter((s) => s.done) };
}

/** Today in one strip: how much is done, and what is left as tappable chips. */
export function Today() {
  const { todo, done } = useToday();
  const total = todo.length + done.length;
  return (
    <section className="card px-4 py-3" aria-labelledby="today-h">
      <div className="flex items-center gap-3">
        <h2 id="today-h" className="text-sm font-normal text-muted" style={{ fontFamily: 'inherit' }}>Today</h2>
        <div className="flex flex-1 gap-1" role="img" aria-label={`${done.length} of ${total} done`}>
          {Array.from({ length: total }, (_, i) => <span key={i} className="h-1.5 flex-1 rounded-full" style={{ background: i < done.length ? 'var(--ok)' : 'var(--line-strong)' }} />)}
        </div>
        <span className="text-sm text-muted"><span className="num">{done.length} of {total}</span> done</span>
      </div>
      {todo.length === 0 ? (
        <p className="mt-2 flex items-center gap-2 text-[15px]"><CheckCircle2 size={18} className="text-[color:var(--ok)]" aria-hidden="true" />All done. See you tomorrow.</p>
      ) : (
        <ul className="mt-2.5 flex flex-wrap gap-2">
          {todo.map((s) => {
            const Icon = s.metric ? METRIC_ICON[s.metric] : Dumbbell;
            return (
              <li key={s.key}>
                <Link to={s.to} className="flex items-center gap-1.5 rounded-sm border border-line px-2.5 py-1.5 text-sm hover:border-brand">
                  <Icon size={15} className="text-muted" aria-hidden="true" />{s.label}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      <Link to="/routine" className="mt-2 inline-block text-sm text-muted underline underline-offset-4 hover:text-text">See the whole day</Link>
    </section>
  );
}
