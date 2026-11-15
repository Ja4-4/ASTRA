import { Award, Flame, Lock, Sun } from 'lucide-react';
import { useAstra } from '../store/useAstra';
import { useDerived } from '../store/derived';
import { BADGES, RANKS, rankFor, type BadgeId } from '../lib/gamification';
import { DEMO_CREW } from '../data/demo/profile';
import { CHECKIN_ITEMS } from '../lib/indicators';
import { Term } from '../components/Term';
import { PageHeader } from '../components/PageHeader';
import { MissionsCard } from '../components/Missions';
import { missionDay, utcStamp } from '../lib/time';

export default function Crew() {
  const xp = useAstra((s) => s.xp);
  const badges = useAstra((s) => s.badges);
  const streak = useAstra((s) => s.streak);
  const hist = useAstra((s) => s.streakHistory);
  const awards = useAstra((s) => s.awards);
  const { orbitDone, now } = useDerived();
  const { rank, next, progress } = rankFor(xp);
  const crewTotal = DEMO_CREW.reduce((a, c) => a + c.checkinsThisWeek, 0) - DEMO_CREW[0].checkinsThisWeek + (DEMO_CREW[0].checkinsThisWeek + (orbitDone.length === CHECKIN_ITEMS.length ? 1 : 0));
  const crewGoal = DEMO_CREW.length * 7;
  const pieces = 8;
  const filled = Math.min(pieces, Math.floor((crewTotal / crewGoal) * pieces));
  const today = missionDay(now);
  return (
    <div className="mx-auto flex max-w-[1500px] flex-col gap-3 p-3 lg:h-full">
      <PageHeader code="07" title="Progress" sub="Points reward showing up and being honest, never whether a number is “good”." />
      <MissionsCard />
      <div className="grid gap-3 lg:grid-cols-3">
        <section className="card p-4" aria-labelledby="rank-h">
          <h2 id="rank-h" className="panel-head">Your rank</h2>
          <p className="mt-1 text-2xl font-semibold">{rank.title}</p>
          <p className="num text-sm text-muted">{xp} <Term k="xp">XP</Term>{next ? ` · ${next.min - xp} to ${next.title}` : ''}</p>
          <div className="mt-3 h-2 rounded-full bg-s2" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} aria-label="Progress to next rank">
            <div className="h-2 rounded-full bg-brand transition-all duration-500" style={{ width: `${progress * 100}%` }} />
          </div>
          <ol className="num mt-3 flex flex-wrap gap-x-2 text-[11px] text-muted">
            {RANKS.map((r, i) => <li key={r.title} className={r.title === rank.title ? 'text-brand' : ''}>{r.title}{i < RANKS.length - 1 ? ' →' : ''}</li>)}
          </ol>
        </section>
        <section className="card p-4" aria-labelledby="streak-h">
          <h2 id="streak-h" className="panel-head">Check-in streak</h2>
          <p className="mt-1 flex items-center gap-2 text-2xl font-semibold"><Flame size={20} className="text-brand" aria-hidden="true" />{streak} days</p>
          <p className="text-xs text-muted">One solar-flare grace day per 14 days. Logging a difficult value never costs the streak.</p>
          <ul className="mt-3 grid grid-cols-[repeat(15,minmax(0,1fr))] gap-1" aria-label="Last 30 days">
            {hist.map((d, i) => {
              const md = today - (hist.length - i);
              return (
                <li key={i} title={`MD ${md}: ${d === 'full' ? 'complete orbit' : d === 'flare' ? 'solar flare grace day' : d === 'partial' ? 'partial check-in' : 'no check-in'}`}
                  className="flex aspect-square items-center justify-center rounded"
                  style={{ background: d === 'full' ? 'var(--brand)' : d === 'partial' ? 'var(--brand-soft)' : 'transparent', border: '1px solid var(--line)' }}>
                  {d === 'flare' && <Sun size={10} className="text-brand" aria-hidden="true" />}
                  <span className="sr-only">MD {md} {d}</span>
                </li>
              );
            })}
          </ul>
          <p className="num mt-2 text-[11px] text-muted">Today: <Term k="orbit">orbit</Term> {orbitDone.length}/{CHECKIN_ITEMS.length} numbers logged</p>
        </section>
        <section className="card p-4" aria-labelledby="patch-h">
          <h2 id="patch-h" className="panel-head">Crew check-ins this week</h2>
          <div className="mt-2 flex items-center gap-4">
            <svg width="120" height="120" viewBox="0 0 120 120" role="img" aria-label={`Crew patch ${filled} of ${pieces} pieces assembled`}>
              {Array.from({ length: pieces }, (_, i) => {
                const a0 = (i / pieces) * Math.PI * 2 - Math.PI / 2, a1 = ((i + 1) / pieces) * Math.PI * 2 - Math.PI / 2 - 0.06;
                const R = 56, r = 38;
                const p = (a: number, rr: number) => `${60 + Math.cos(a) * rr},${60 + Math.sin(a) * rr}`;
                return <path key={i} d={`M${p(a0, r)} L${p(a0, R)} A${R} ${R} 0 0 1 ${p(a1, R)} L${p(a1, r)} A${r} ${r} 0 0 0 ${p(a0, r)} Z`} fill={i < filled ? 'var(--brand)' : 'var(--surface-2)'} stroke="var(--line)" />;
              })}
              <ellipse cx="60" cy="60" rx="28" ry="11" fill="none" stroke="var(--starlight)" strokeWidth="1.5" transform="rotate(-20 60 60)" />
              <circle cx="60" cy="60" r="6" fill="var(--starlight)" />
            </svg>
            <div className="text-sm">
              <p className="num">{crewTotal}/{crewGoal} crew check-ins</p>
              <ul className="num mt-2 space-y-0.5 text-xs text-muted">{DEMO_CREW.map((c) => <li key={c.callsign}>{c.role} {c.callsign}</li>)}</ul>
            </div>
          </div>
          <p className="mt-2 text-xs text-muted">Cooperative goal. Only check-in completion is shared with the crew: no health values, no leaderboard.</p>
        </section>
      </div>
      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-3">
      <section className="card p-4 lg:col-span-2" aria-labelledby="badges-h">
        <h2 id="badges-h" className="panel-head">Badges</h2>
        <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {(Object.keys(BADGES) as BadgeId[]).map((b) => {
            const has = badges.includes(b);
            return (
              <li key={b} className={`flex items-start gap-2.5 rounded border p-2.5 ${has ? 'border-brand bg-brand-soft' : 'border-dashed border-line'}`}>
                {has ? <Award size={20} className="text-brand" aria-hidden="true" /> : <Lock size={18} className="text-muted" aria-hidden="true" />}
                <div><p className="text-sm font-medium">{BADGES[b].label} <span className="sr-only">{has ? 'earned' : 'locked'}</span></p><p className="text-xs text-muted">{BADGES[b].how}</p></div>
              </li>
            );
          })}
        </ul>
      </section>
      <section className="card flex min-h-0 flex-col p-4" aria-labelledby="xp-h">
        <h2 id="xp-h" className="panel-head">How you earned points</h2>
        {awards.length === 0 ? <p className="text-sm text-muted">No points yet in this session. Do a check-in to start.</p> : (
          <ul className="min-h-0 flex-1 divide-y divide-line overflow-y-auto">
            {awards.slice(0, 12).map((a) => (
              <li key={a.id} className="num flex gap-3 py-1.5 text-sm"><span className="w-12 text-brand">+{a.xp}</span><span className="flex-1 font-sans">{a.reason}</span><span className="text-xs text-muted">{utcStamp(a.at)}</span></li>
            ))}
          </ul>
        )}
        <p className="mt-auto border-t border-line pt-2 text-xs text-muted">Logging a Watch or Act reading and following its guidance is the largest single reward.</p>
      </section>
      </div>
    </div>
  );
}
