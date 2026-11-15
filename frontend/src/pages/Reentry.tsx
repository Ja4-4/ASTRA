import { useRef, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { Answer, DemoChip, PRIMARY } from '../components/Answer';
import { STATUS } from '../lib/status';
import { XP } from '../lib/gamification';
import { useAstra } from '../store/useAstra';
import { sendReadings } from '../data/live';
import { useNow } from '../store/derived';
import { missionDay } from '../lib/time';
import { LANDING_DAY, POINTS_PER_SESSION, REENTRY_PLAN, readiness, reentryKey as keyFor, sessionsFor, weekProgress, type TrainingSession } from '../demo/newScreens';
import { ExerciseFigure, WorkoutPlayer } from '../components/Workout';
import { Workout3D } from '../three/Workout3D';
import { MissionsCard } from '../components/Missions';


/** Re-entry Readiness: a weighted score of five parts, and the training plan that counts down to landing. Prototype weighting, not a medical clearance. */
export default function Reentry() {
  const day = missionDay(useNow());
  const done = useAstra((s) => s.routineDone);
  const completeRoutine = useAstra((s) => s.completeRoutine);
  const grantBadge = useAstra((s) => s.grantBadge);
  const planRef = useRef<HTMLElement>(null);
  const [playing, setPlaying] = useState<TrainingSession | null>(null);

  const { phase, weekDays, doneThisWeek } = weekProgress(day, done);
  const today = sessionsFor(day);
  const todayLeft = today.filter((s) => !done[keyFor(day, s.id)]);
  const { parts, score, status, first } = readiness(doneThisWeek);
  const S = STATUS[status];
  const daysLeft = Math.max(0, LANDING_DAY - day);

  const finishSession = (id: string, label: string, minutes: number) => {
    void sendReadings(completeRoutine(keyFor(day, id), label, minutes));
    const st = useAstra.getState().routineDone;
    const fullWeek = weekDays.length === 7 && weekDays.every((d) => sessionsFor(d).every((s) => st[keyFor(d, s.id)]));
    if (fullWeek) grantBadge('gravity_week', 'Gravity Ready', 'Every re-entry session for 7 days. See it on Progress.');
  };

  return (
    <div className="mx-auto flex max-w-[1080px] flex-col gap-3 p-3 lg:p-5">
      <PageHeader title="Re-entry readiness" sub={`How ready your body is for gravity again. Landing on Day ${LANDING_DAY}: ${daysLeft} days left.`}><DemoChip /></PageHeader>
      <Answer
        status={status}
        title={`Ready for re-entry: ${score} of 100.`}
        why={`${first.label} is the part to improve first: ${first.score} of 100.`}
        action={<button type="button" className={PRIMARY} onClick={() => planRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>{todayLeft.length ? `Start today’s training (${todayLeft.length} left)` : 'See this week’s training'}</button>}
        aside={`+${XP.routineActivity} points for each session you finish`}
      />

      <MissionsCard />

      <section ref={planRef} className="card scroll-mt-4 p-4" aria-labelledby="plan-h">
        <h2 id="plan-h" className="panel-head">Training plan to landing</h2>
        <ol className="mb-4 grid grid-cols-3 gap-1" aria-label="Plan phases">
          {REENTRY_PLAN.map((p) => {
            const here = p.id === phase.id;
            return (
              <li key={p.id} className={`rounded-sm border px-2.5 py-2 ${here ? 'border-brand' : 'border-line'}`}>
                <p className={`text-sm font-bold ${here ? 'text-brand' : 'text-text'}`}>{p.label}</p>
                <p className="num text-xs text-muted">Day {p.fromDay}–{p.toDay}{here ? ' · now' : ''}</p>
              </li>
            );
          })}
        </ol>
        <p className="text-[15px] text-text"><b>This week:</b> {phase.goal}. {doneThisWeek} {doneThisWeek === 1 ? 'session' : 'sessions'} done so far.</p>

        <h3 className="mt-4 text-sm font-bold text-muted">Today, Day {day}</h3>
        {today.length === 0 ? <p className="mt-1 text-[15px] text-muted">Rest day before landing. Nothing to do.</p> : (
          <ul className="mt-2 flex flex-col gap-2">
            {today.map((s, i) => {
              const isDone = !!done[keyFor(day, s.id)];
              const first = i === 0;
              return (
                <li key={s.id} className="flex flex-wrap items-center gap-3 rounded-sm border border-line p-3">
                  <div className="relative shrink-0 overflow-hidden rounded-sm bg-s2">
                    {first
                      ? <div className="h-[96px] w-[96px]"><Workout3D preview sessionId={s.id} fallback={<ExerciseFigure sessionId={s.id} size={96} />} /></div>
                      : <ExerciseFigure sessionId={s.id} size={72} />}
                    {isDone && <CheckCircle2 size={20} className="absolute -right-1.5 -top-1.5 rounded-full bg-s1 text-text" aria-label="done" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[16px] font-bold">{s.label} <span className="num font-normal text-muted">· {s.minutes} min · {s.device}</span></p>
                    <p className="text-sm text-muted">{s.why}</p>
                  </div>
                  {isDone ? <span className="num text-[15px] text-muted">Done · +{XP.routineActivity}</span> : (
                    <div className="flex items-center gap-2">
                      <button type="button" onClick={() => setPlaying(s)} className={first ? PRIMARY : 'rounded-sm border border-line-strong px-3 py-2 text-[15px] font-bold hover:border-brand'}>Start</button>
                      <button type="button" onClick={() => finishSession(s.id, s.label, s.minutes)} className="px-2 py-2 text-[15px] text-muted underline underline-offset-4 hover:text-text">Already did it</button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <h3 className="mt-4 text-sm font-bold text-muted">This week</h3>
        <ol className="mt-2 grid grid-cols-7 gap-1.5" aria-label="This week’s sessions">
          {weekDays.map((d) => {
            const ss = sessionsFor(d);
            const n = ss.filter((s) => done[keyFor(d, s.id)]).length;
            return (
              <li key={d} className={`rounded-sm border p-2 text-center ${d === day ? 'border-brand' : 'border-line'}`}>
                <p className={`num text-xs ${d === day ? 'font-bold text-brand' : 'text-muted'}`}>Day {d}</p>
                <p className="num mt-1 text-[15px] font-bold">{n}/{ss.length}</p>
                <p className="mt-0.5 text-[11px] leading-tight text-muted">{ss.map((s) => s.label.split(' ')[0]).join(', ') || 'Rest'}</p>
              </li>
            );
          })}
        </ol>
        <p className="mt-3 text-xs text-muted">ASTRA prototype plan. The real plan comes from the crew’s strength and conditioning trainers on the ground. Finished sessions also count toward your exercise number.</p>
      </section>

      <section className="card p-4" aria-labelledby="re-h">
        <h2 id="re-h" className="panel-head">What makes up the score</h2>
        <div className="flex items-end gap-4 pb-4">
          <span className="num font-display text-[64px] font-bold leading-none">{score}</span>
          <span className="pb-2 text-[17px] text-muted">of 100 · <span className="font-bold" style={{ color: S.cssVar }}>{S.label}</span></span>
        </div>
        <ul className="flex flex-col gap-3">
          {parts.map((p) => (
            <li key={p.id} className="grid grid-cols-[180px_minmax(0,1fr)_56px] items-center gap-3">
              <span className="text-[15px] font-bold text-text">{p.label} <span className="num font-normal text-muted">{Math.round(p.weight * 100)}%</span></span>
              <div>
                <div className="h-3 w-full rounded-sm bg-line" role="img" aria-label={`${p.label}: ${p.score} of 100`}>
                  <div className="h-full rounded-sm transition-all duration-500" style={{ width: `${p.score}%`, background: 'var(--text-muted)' }} />
                </div>
                <p className="mt-1 text-sm text-muted">{p.id === 'exercise' && doneThisWeek ? `${p.detail} · +${doneThisWeek * POINTS_PER_SESSION} from this week’s sessions` : p.detail}</p>
              </div>
              <span className="num text-right text-[17px] font-bold">{p.score}</span>
            </li>
          ))}
        </ul>
        <p className="mt-4 border-t border-line pt-3 text-[17px] text-text"><b>Improve first: {first.label.toLowerCase()}.</b> {first.improve}</p>
        <p className="mt-2 text-sm text-muted">ASTRA prototype weighting, not a medical clearance. Score bands (prototype): 80 and up in range, 60 to 79 watch, under 60 act now.</p>
      </section>
      {playing && <WorkoutPlayer session={playing} onClose={() => setPlaying(null)} onFinish={() => { finishSession(playing.id, playing.label, playing.minutes); setPlaying(null); }} />}
    </div>
  );
}
