import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Circle, OctagonAlert, Send, ShieldCheck } from 'lucide-react';
import { useAstra, type AstraEvent } from '../store/useAstra';
import { useDerived } from '../store/derived';
import { METRICS } from '../lib/indicators';
import { MISSION_BY_ID, deliversIn } from '../lib/mission';
import { dayLabel, hhmm, utcStamp } from '../lib/time';
import { STATUS } from '../lib/status';
import { DEMO_PROFILE } from '../data/demo/profile';
import { USUAL } from '../components/MetricSheet';
import { StatusPill } from '../components/Status';
import { ackAlert, activeAstronaut, getAlerts, type AlertRow } from '../data/api';
import { BACKEND_ID_PREFIX, mapAlertSeverity } from '../data/adapter';
import type { IndicatorId } from '../data/types';

const SYMPTOMS = ['I feel fine', 'Headache', 'Blurry eyes', 'Dizzy', 'Chest hurts', 'Feel sick'];
const big = 'btn-cut flex w-full items-center justify-center gap-2 rounded-sm bg-brand px-5 py-4 text-[18px] font-bold text-on-brand hover:opacity-90';

/** Alerts: one step on screen at a time, one sentence, one big button. */
export default function Events() {
  const events = useAstra((s) => s.events);
  const open = events.find((e) => e.stage !== 'closed');
  const closed = events.filter((e) => e.stage === 'closed');
  return (
    <div className="mx-auto flex max-w-[720px] flex-col gap-4 p-3 lg:p-6">
      <h1 className="sr-only">Alerts</h1>
      {open?.stage === 'respond' && <Respond ev={open} />}
      {open?.stage === 'recover' && <Recover ev={open} />}
      {!open && <Calm last={closed[closed.length - 1]} />}
      <ServerAlerts />
      <p className="text-center text-xs text-muted">ASTRA helps you check yourself. It is not a doctor. If something feels very bad or gets worse, use your mission’s emergency procedure now.</p>
    </div>
  );
}

function Card({ status, children }: { status: 'ok' | 'act' | 'watch'; children: React.ReactNode }) {
  return <section className="card p-6" style={{ boxShadow: `inset 0 4px 0 ${STATUS[status].cssVar}` }}>{children}</section>;
}

function Calm({ last }: { last?: AstraEvent }) {
  return (
    <Card status="ok">
      <ShieldCheck size={48} className="text-[color:var(--ok)]" aria-hidden="true" />
      <h2 className="mt-3 font-display text-[30px] font-bold leading-[34px]">No alerts. You are safe.</h2>
      <p className="mt-2 text-[17px] leading-6">If one of your numbers turns red, ASTRA will show you 3 easy steps right here.</p>
      {last && <p className="mt-3 text-[15px] text-muted">Last alert: {METRICS[last.metric].short.toLowerCase()}, back to your usual {last.closedAt ? utcStamp(last.closedAt) : ''}.</p>}
      <div className="mt-6 flex flex-col gap-3">
        <Link to="/" className={big}>Go home</Link>
        <Link to="/evidence" className="text-center text-[15px] text-muted underline underline-offset-4 hover:text-text">What makes a number red?</Link>
      </div>
    </Card>
  );
}

function Dots({ at }: { at: number }) {
  return (
    <div className="flex items-center gap-3" aria-label={`Step ${at} of 3`}>
      {[1, 2, 3].map((n) => (
        <span key={n} className={`h-2 flex-1 rounded-full ${n < at ? 'bg-[color:var(--ok)]' : n === at ? 'bg-brand' : 'bg-line'}`} />
      ))}
      <span className="num shrink-0 text-sm text-muted">Step {at} of 3</span>
    </div>
  );
}

function Respond({ ev }: { ev: AstraEvent }) {
  const { results, now } = useDerived();
  const completeStep = useAstra((s) => s.completeStep);
  const m = MISSION_BY_ID[useAstra((s) => s.mission)];
  const cur = results[ev.metric];
  const name = METRICS[ev.metric].short.toLowerCase();
  const [sym, setSym] = useState<string[]>([]);
  const defaultMsg = useMemo(() => [
    `From ${DEMO_PROFILE.callsign}, ${utcStamp(ev.openedAt)}.`,
    `${ev.plain ?? ev.explanation}`,
    ev.symptoms ? `How I feel: ${ev.symptoms}.` : 'How I feel: not noted yet.',
    'Please review. ASTRA detail: ' + ev.explanation + ` [${ev.ruleId}]`,
  ].join('\n'), [ev]);
  const [msg, setMsg] = useState<string | null>(null);
  const body = msg ?? defaultMsg;
  const step = !ev.steps.remeasure ? 1 : !ev.steps.symptoms ? 2 : 3;

  return (
    <Card status="act">
      <Dots at={step} />
      <p className="mt-5 text-[15px]" style={{ color: STATUS.act.cssVar }}>
        <OctagonAlert size={18} className="mr-1.5 inline-block align-[-3px]" aria-hidden="true" />Your {name}: <b className="num whitespace-nowrap">{cur.display} {cur.unit}</b>
        {USUAL[ev.metric] && <span className="whitespace-nowrap text-muted"> (usual {USUAL[ev.metric]})</span>}
      </p>

      {step === 1 && (
        <>
          <h2 className="mt-2 font-display text-[30px] font-bold leading-[34px]">Rest 5 minutes. Then measure again.</h2>
          <p className="mt-2 text-[17px] leading-6">One high number can be a mistake. A second number tells us for sure.</p>
          <div className="mt-6 flex flex-col gap-3">
            <Link to={`/log?focus=${ev.metric}`} className={big}>Measure again</Link>
            <button type="button" onClick={() => completeStep(ev.id, 'remeasure')} className="text-[15px] text-muted underline underline-offset-4 hover:text-text">I already did</button>
          </div>
        </>
      )}

      {step === 2 && (
        <>
          <h2 className="mt-2 font-display text-[30px] font-bold leading-[34px]">How do you feel?</h2>
          <p className="mt-2 text-[17px] leading-6">Tap all that are true.</p>
          <div className="mt-4 grid grid-cols-2 gap-2" role="group" aria-label="How do you feel?">
            {SYMPTOMS.map((s) => (
              <button key={s} type="button" aria-pressed={sym.includes(s)} onClick={() => setSym((x) => (x.includes(s) ? x.filter((y) => y !== s) : [...x, s]))}
                className={`rounded-sm border-2 px-3 py-3 text-[16px] ${sym.includes(s) ? 'border-brand bg-brand-soft font-bold' : 'border-line hover:border-line-strong'}`}>{s}</button>
            ))}
          </div>
          <div className="mt-6"><button type="button" onClick={() => completeStep(ev.id, 'symptoms', sym.join('; ') || 'Nothing noted')} className={big}>Next</button></div>
        </>
      )}

      {step === 3 && (
        <>
          <h2 className="mt-2 font-display text-[30px] font-bold leading-[34px]">Tell the doctor</h2>
          <p className="mt-2 text-[17px] leading-6">ASTRA wrote the message for you. {m.delaySec >= 60 ? `${deliversIn(m.delaySec)}. Keep resting while you wait.` : 'It reaches the doctor in about a second.'}</p>
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer text-muted hover:text-text">See or change the message</summary>
            <textarea value={body} onChange={(e) => setMsg(e.target.value)} rows={4} className="mt-2 w-full resize-none rounded border border-line bg-s2 p-2 text-[13px] leading-[18px] text-text" />
          </details>
          <div className="mt-6"><button type="button" onClick={() => completeStep(ev.id, 'flag', body)} className={big}><Send size={18} aria-hidden="true" />Send to the doctor</button></div>
          <p className="num mt-2 text-center text-xs text-muted">{m.delaySec >= 60 ? `Arrives about ${hhmm(new Date(now.getTime() + m.delaySec * 1000))} UTC` : ''}</p>
        </>
      )}
    </Card>
  );
}

function Recover({ ev }: { ev: AstraEvent }) {
  const { now } = useDerived();
  const name = METRICS[ev.metric].short.toLowerCase();
  const next = ev.followUps.find((f) => !f.done);
  const delivered = ev.message && now.getTime() >= new Date(ev.message.deliverAt).getTime();
  return (
    <Card status="watch">
      <h2 className="font-display text-[30px] font-bold leading-[34px]">Getting better</h2>
      <p className="mt-2 text-[17px] leading-6">You did all 3 steps. Now check your {name} a few more times until it is back to your usual.</p>
      {ev.message && <p className="mt-2 text-[15px] text-muted">{delivered ? 'The doctor has your message.' : `Your message is on its way. It arrives about ${hhmm(ev.message.deliverAt)} UTC.`}</p>}
      <ul className="mt-4 space-y-2">
        {ev.followUps.map((f) => (
          <li key={f.id} className={`flex items-center gap-3 text-[16px] ${f.done ? 'text-muted' : ''}`}>
            {f.done ? <CheckCircle2 size={22} className="shrink-0 text-[color:var(--ok)]" aria-label="done" /> : <Circle size={22} className="shrink-0 text-muted" aria-label="to do" />}
            {f.label}
          </li>
        ))}
      </ul>
      <div className="mt-5"><BaselineTracker ev={ev} /></div>
      {next && <div className="mt-6"><Link to={next.id === 'fu3' ? '/' : `/log?focus=${ev.metric}`} className={big}>{next.id === 'fu3' ? 'Go home' : `Check your ${name} again`}</Link></div>}
    </Card>
  );
}

function BaselineTracker({ ev }: { ev: AstraEvent }) {
  const { visible } = useDerived();
  if (ev.metric !== 'bp') return null;
  const since = visible.filter((r) => r.indicator === 'bp_sys' && r.timestamp >= ev.openedAt).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const base = DEMO_PROFILE.baseline.bp_sys!;
  const max = Math.max(172, ...since.map((r) => r.value));
  const min = 100;
  const y = (v: number) => 104 - ((v - min) / (max - min)) * 88;
  return (
    <div>
      <h3 className="text-sm font-bold">Your top number since the alert</h3>
      <svg viewBox="0 0 300 110" className="mt-1 w-full max-w-[300px]" role="img" aria-label={`Systolic readings since the event: ${since.map((r) => r.value).join(', ')} mmHg. Baseline ${base} mmHg.`}>
        <rect x="0" width="300" y={y(base + 6)} height={y(base - 6) - y(base + 6)} fill="var(--brand-soft)" />
        <line x1="0" x2="300" y1={y(130)} y2={y(130)} stroke="var(--watch)" strokeDasharray="4 4" strokeWidth="1" />
        <line x1="0" x2="300" y1={y(160)} y2={y(160)} stroke="var(--act)" strokeDasharray="4 4" strokeWidth="1" />
        <text x="296" y={y(130) - 3} textAnchor="end" fontSize="9" fill="var(--text-muted)" className="num">Watch 130</text>
        <text x="296" y={y(160) - 3} textAnchor="end" fontSize="9" fill="var(--text-muted)" className="num">Act now 160</text>
        <text x="4" y={y(base) + 3} fontSize="9" fill="var(--text-muted)" className="num">your usual {base}</text>
        {since.length > 1 && <polyline fill="none" stroke="var(--starlight)" strokeWidth="1.5" points={since.map((r, i) => `${20 + (i / (since.length - 1)) * 250},${y(r.value)}`).join(' ')} />}
        {since.map((r, i) => (
          <g key={r.id}>
            <circle cx={since.length > 1 ? 20 + (i / (since.length - 1)) * 250 : 150} cy={y(r.value)} r="4" fill={r.value >= 160 ? 'var(--act)' : r.value >= 130 ? 'var(--watch)' : 'var(--ok)'} />
            <text x={since.length > 1 ? 20 + (i / (since.length - 1)) * 250 : 150} y={y(r.value) - 7} fontSize="9" textAnchor="middle" fill="var(--text)" className="num">{r.value}</text>
          </g>
        ))}
      </svg>
      <p className="num mt-1 text-xs text-muted">{since.length ? `Latest ${since[since.length - 1].value} mmHg, ${Math.abs(since[since.length - 1].value - base)} ${since[since.length - 1].value - base >= 0 ? 'above' : 'below'} your usual` : 'No readings yet'}</p>
    </div>
  );
}

const PLAIN_NAME: Record<IndicatorId, string> = {
  hr: 'Heart beats per minute', bp_sys: 'Blood pressure, top number', bp_dia: 'Blood pressure, bottom number', glucose: 'Blood sugar',
  temp: 'Body temperature', sleep: 'Sleep', mood: 'Mood', exercise_min: 'Exercise', rad_dose: 'Radiation dose so far',
};
/** First sentence of a server alert, used only when its reading is not in the app. */
const firstSentence = (t: string) => t.match(/^.*?\.(?=\s|$)/)?.[0] ?? t;

/** Live data only: alerts the station server raised with its own rules, next to ASTRA's. */
function ServerAlerts() {
  const live = useAstra((s) => s.dataSource === 'live');
  const readings = useAstra((s) => s.readings);
  const { now } = useDerived();
  const [rows, setRows] = useState<AlertRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!live) { setRows(null); return; }
    let on = true;
    (async () => {
      const a = await activeAstronaut();
      const list = a ? await getAlerts(a.id) : null;
      if (on) setRows(list ? list.filter((x) => x.status === 'open') : null);
    })();
    return () => { on = false; };
  }, [live, readings]);

  if (!live || !rows || rows.length === 0) return null;
  const line = (a: AlertRow) => {
    const r = readings.find((x) => x.id === `${BACKEND_ID_PREFIX}${a.measurement_id}`);
    return r ? `${PLAIN_NAME[r.indicator]}: ${r.value} ${r.unit}, ${dayLabel(r.timestamp, now)}.` : firstSentence(a.explanation);
  };
  const ack = async (id: number) => {
    const ok = await ackAlert(id);
    setFailed(!ok);
    if (ok) setRows((r) => r?.filter((x) => x.id !== id) ?? null);
  };
  return (
    <details className="card p-4">
      <summary className="cursor-pointer text-[15px] text-text">The station server also flagged {rows.length} number{rows.length > 1 ? 's' : ''}.</summary>
      <ul className="mt-3 flex flex-col gap-3">
        {rows.map((a) => (
          <li key={a.id} className="flex flex-col gap-1.5 border-t border-line pt-3">
            <span className="self-start"><StatusPill status={mapAlertSeverity(a.severity)} small /></span>
            <p className="text-[15px] leading-6">{line(a)}</p>
            <details className="text-sm text-muted">
              <summary className="cursor-pointer hover:text-text">Details for the doctor</summary>
              <p className="mt-1">{a.explanation}</p>
            </details>
            <button type="button" onClick={() => void ack(a.id)} className="self-start rounded border border-line px-3 py-1 text-sm hover:border-brand">I have seen this</button>
          </li>
        ))}
      </ul>
      {failed && <p className="mt-3 text-sm text-muted">Could not reach the station server. Try again in a moment.</p>}
    </details>
  );
}
