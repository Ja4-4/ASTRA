import { Link } from 'react-router-dom';
import { Bell, BellOff, CheckCircle2, Circle, Dumbbell, ServerCog, Stethoscope } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { currentAstronaut } from '../data/api';
import * as server from '../data/server';
import { useAstra } from '../store/useAstra';
import { sendReadings } from '../data/live';
import { useDerived } from '../store/derived';
import { METRICS, type MetricId } from '../lib/indicators';
import { startUTC, hhmm } from '../lib/time';
import { StatusPill } from '../components/Status';
import { PageHeader } from '../components/PageHeader';
import { XP } from '../lib/gamification';
import { ACTIVITIES, MEASURES } from '../lib/routine';

/** Live data only: the mission plan the station server holds for this astronaut. Ticking here is saved there. */
function ServerPlan() {
  const live = useAstra((s) => s.dataSource === 'live');
  const astronaut = currentAstronaut()?.id;
  const [rows, setRows] = useState<server.ServerRoutine[] | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    if (!astronaut) return;
    try { setRows(await server.serverRoutines(astronaut)); setFailed(false); } catch (err) { console.warn('server plan', err); setFailed(true); }
  }, [astronaut]);
  useEffect(() => { if (live) void load(); }, [live, load]);
  if (!live) return null;
  const tick = async (id: number) => {
    try { await server.completeServerRoutine(id); await load(); } catch (err) { console.warn('server plan tick', err); setFailed(true); }
  };
  return (
    <section className="card p-4 lg:col-span-2" aria-labelledby="srv-plan" data-testid="server-plan">
      <h2 id="srv-plan" className="panel-head"><ServerCog size={13} aria-hidden="true" />Mission plan on the station server</h2>
      <ul className="divide-y divide-line">
        {(rows ?? []).map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-3 py-2 text-sm" data-testid="server-routine">
            {r.due ? <Circle size={18} className="text-muted" aria-label="due" /> : <CheckCircle2 size={18} className="text-brand" aria-label="done" />}
            <span className="flex-1">{r.title}<span className="block text-xs text-muted">every {r.every_hours} h{r.last_completed_at ? ` · last done ${r.last_completed_at.slice(0, 16).replace('T', ' ')} UTC` : ' · not done yet'}</span></span>
            <button type="button" onClick={() => void tick(r.id)} aria-label={`${r.due ? 'Mark as done' : 'Done again'}: ${r.title}`} className="rounded border border-line px-3 py-1 text-sm hover:border-brand">{r.due ? 'Mark as done' : 'Done again'}</button>
          </li>
        ))}
        {rows && rows.length === 0 && <li className="py-2 text-sm text-muted">No routines on the server.</li>}
      </ul>
      {failed && <p className="mt-2 text-sm text-muted">Could not reach the station server. Try again in a moment.</p>}
    </section>
  );
}

export default function Routine() {
  const { visible, now, results } = useDerived();
  const routineDone = useAstra((s) => s.routineDone);
  const complete = useAstra((s) => s.completeRoutine);
  const [reminders, setReminders] = useState(true);
  const day = startUTC(now).getTime();
  const todayKey = new Date(day).toISOString().slice(0, 10);
  const loggedToday = (m: MetricId) => METRICS[m].indicators.every((ind) => visible.some((r) => r.indicator === ind && startUTC(new Date(r.timestamp)).getTime() === day));
  const nowHM = hhmm(now);
  return (
    <div className="mx-auto flex max-w-[1500px] flex-col gap-3 p-3 lg:h-full">
      <PageHeader code="04" title="Today’s plan" sub="What to measure and which exercise to do today. Tick things off as you go.">
        <button type="button" onClick={() => setReminders(!reminders)} aria-pressed={reminders} className="flex items-center gap-1.5 rounded border border-line px-3 py-1.5 text-sm text-muted hover:text-text">
          {reminders ? <Bell size={14} aria-hidden="true" /> : <BellOff size={14} aria-hidden="true" />} Reminders {reminders ? 'on' : 'off'}
        </button>
      </PageHeader>
      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-2">
      <section className="card p-4" aria-labelledby="m-h">
        <h2 id="m-h" className="panel-head"><Stethoscope size={13} aria-hidden="true" className="text-brand" />Numbers to measure today (UTC times)</h2>
        <ul className="divide-y divide-line">
          {MEASURES.map((m) => {
            const done = loggedToday(m.metric);
            const due = !done && m.time <= nowHM;
            return (
              <li key={m.metric} className="flex flex-wrap items-center gap-3 py-2.5">
                <span className="num w-12 text-sm text-muted">{m.time}</span>
                {done ? <CheckCircle2 size={18} className="text-brand" aria-label="done" /> : <Circle size={18} className="text-muted" aria-label="not done" />}
                <span className="flex-1 text-sm">{m.label}</span>
                {done ? <StatusPill status={results[m.metric].status} small /> : due ? (
                  <Link to={`/log?focus=${m.metric}`} className="rounded border border-brand px-2.5 py-1 text-xs text-brand">Due now · log it</Link>
                ) : <span className="text-xs text-muted">{reminders ? 'Reminder set' : 'Upcoming'}</span>}
              </li>
            );
          })}
        </ul>
      </section>
      <div className="flex min-h-0 flex-col gap-3">
      <section className="card p-4" aria-labelledby="a-h">
        <h2 id="a-h" className="panel-head"><Dumbbell size={13} aria-hidden="true" className="text-brand" />Exercise</h2>
        <p className="text-xs text-muted">Each finished session earns +{XP.routineActivity} points. Doing more than planned earns nothing extra, so don’t overdo it.</p>
        <ul className="mt-3 divide-y divide-line">
          {ACTIVITIES.map((a) => {
            const key = `${todayKey}:${a.id}`;
            const done = !!routineDone[key];
            return (
              <li key={a.id} className="flex flex-wrap items-center gap-3 py-2">
                <span className="num w-12 text-sm text-muted">{a.time}</span>
                {done ? <CheckCircle2 size={18} className="text-brand" aria-label="done" /> : <Circle size={18} className="text-muted" aria-label="not done" />}
                <span className="flex-1 text-sm">{a.label} <span className="num text-muted">· {a.minutes} min · {a.device}</span><span className="block text-xs text-muted">{a.note}</span></span>
                <button type="button" disabled={done} onClick={() => void sendReadings(complete(key, a.label, a.minutes))} className="rounded border border-line px-3 py-1 text-sm hover:border-brand disabled:opacity-50">
                  {done ? `Done ${hhmm(routineDone[key])}` : 'Mark as done'}
                </button>
              </li>
            );
          })}
        </ul>
      </section>
      <section className="card flex-1 p-4">
        <h2 className="panel-head">Exercise this week</h2>
        <div className="flex flex-wrap items-center gap-3">
          <span className="num text-[28px]">{results.exercise.display}<span className="text-sm text-muted"> %</span></span>
          <StatusPill status={results.exercise.status} small />
        </div>
        <p className="mt-1 text-sm text-text">{results.exercise.plain}</p>
        <p className="mt-1 text-xs text-muted">The “Muscles &amp; bones” colour is based on exercise done, not on bone or muscle scans.</p>
      </section>
      <ServerPlan />
      </div>
      </div>
    </div>
  );
}
