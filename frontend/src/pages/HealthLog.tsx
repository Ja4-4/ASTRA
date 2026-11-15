import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Check, CheckCircle2 } from 'lucide-react';
import { useAstra } from '../store/useAstra';
import { sendReadings } from '../data/live';
import { useDerived } from '../store/derived';
import { CHECKIN_ITEMS, INDICATOR_UNIT, METRICS, type MetricId } from '../lib/indicators';
import { STATUS } from '../lib/status';
import { METRIC_ICON } from '../lib/icons';
import { evaluate, type RuleResult } from '../lib/rules';
import { DEMO_PROFILE } from '../data/demo/profile';
import { USUAL } from '../components/MetricSheet';
import { startUTC, utcStamp } from '../lib/time';
import type { IndicatorId, Reading } from '../data/types';

type Part = { key: string; label: string; min: number; max: number; step: number; example: string };
const PARTS: Record<MetricId, Part[]> = {
  sleep: [{ key: 'v', label: 'Hours', min: 0, max: 16, step: 0.1, example: '7.5' }],
  hr: [{ key: 'v', label: 'Beats in 1 minute', min: 25, max: 220, step: 1, example: '62' }],
  temp: [{ key: 'v', label: '°C', min: 34, max: 42, step: 0.1, example: '37.0' }],
  bp: [{ key: 'sys', label: 'Top number', min: 60, max: 260, step: 1, example: '118' }, { key: 'dia', label: 'Bottom number', min: 30, max: 160, step: 1, example: '76' }],
  glucose: [{ key: 'v', label: 'mg/dL', min: 20, max: 600, step: 1, example: '94' }],
  mood: [{ key: 'v', label: 'Mood', min: 1, max: 5, step: 1, example: '4' }],
  exercise: [{ key: 'v', label: 'Minutes', min: 0, max: 300, step: 5, example: '60' }],
};
/** One plain question per screen, in the order the morning runs. */
const QUESTION: Record<MetricId, string> = {
  sleep: 'How long did you sleep?',
  hr: 'What is your heart rate?',
  temp: 'What is your temperature?',
  bp: 'What is your blood pressure?',
  glucose: 'What is your blood sugar?',
  mood: 'How do you feel today?',
  exercise: 'How long did you exercise?',
};
const STEPS: MetricId[] = ['sleep', 'hr', 'temp', 'bp', 'glucose', 'mood', 'exercise'];
const MOODS = ['Very bad', 'Bad', 'OK', 'Good', 'Great'];
const IND_LABEL: Record<IndicatorId, string> = { hr: 'Heart rate', bp_sys: 'Blood pressure, top', bp_dia: 'Blood pressure, bottom', glucose: 'Blood sugar', temp: 'Temperature', sleep: 'Sleep', mood: 'Mood', exercise_min: 'Exercise', rad_dose: 'Radiation (total)' };
const MetricInd = Object.fromEntries(Object.values(METRICS).map((m) => [m.id, m.indicators])) as Record<MetricId, IndicatorId[]>;
const big = 'btn-cut flex w-full items-center justify-center gap-2 rounded-sm bg-brand px-5 py-4 text-[18px] font-bold text-on-brand hover:opacity-90 disabled:opacity-40';

type Vals = Record<string, string>;
type Parsed = { ok: true; values: number[] } | { ok: false; error: string } | null;

function parse(metric: MetricId, vals: Vals): Parsed {
  const parts = PARTS[metric];
  const raw = parts.map((p) => vals[p.key]?.trim() ?? '');
  if (raw.every((r) => r === '')) return null;
  if (raw.some((r) => r === '')) return { ok: false, error: 'Type both numbers.' };
  const nums = raw.map(Number);
  for (let i = 0; i < nums.length; i++) {
    const p = parts[i];
    if (!Number.isFinite(nums[i]) || nums[i] < p.min || nums[i] > p.max) return { ok: false, error: `That number looks wrong. It should be between ${p.min} and ${p.max}.` };
  }
  if (metric === 'bp' && nums[1] >= nums[0]) return { ok: false, error: 'The bottom number should be smaller than the top number.' };
  return { ok: true, values: nums };
}
const sourceFor = (metric: MetricId, source: string) => ((metric === 'sleep' || metric === 'mood') && source === 'manual' ? 'self-report' : source);

/** Measure: one question, one box, one big button. Each number saves on its own. */
export default function HealthLog() {
  const [params] = useSearchParams();
  const focus = params.get('focus') as MetricId | null;
  const logCheckin = useAstra((s) => s.logCheckin);
  const readings = useAstra((s) => s.readings);
  const { visible, now } = useDerived();
  const [vals, setVals] = useState<Vals>({});
  const [source, setSource] = useState('manual');
  const [saved, setSaved] = useState<RuleResult | null>(null);

  const day = startUTC(now).getTime();
  const loggedToday = (m: MetricId) => visible.some((x) => MetricInd[m].includes(x.indicator) && startUTC(new Date(x.timestamp)).getTime() === day);
  const nextTodo = (after = -1) => {
    const i = STEPS.findIndex((m, idx) => idx > after && CHECKIN_ITEMS.includes(m) && !loggedToday(m));
    return i < 0 ? null : i;
  };
  const start = () => (focus && STEPS.includes(focus) ? STEPS.indexOf(focus) : nextTodo() ?? 0);
  const [step, setStep] = useState<number>(start);
  useEffect(() => { setStep(start()); setSaved(null); setVals({}); }, [focus]); // eslint-disable-line react-hooks/exhaustive-deps

  const m = STEPS[step];
  const parsed = useMemo(() => parse(m, vals), [m, vals]);
  const preview = useMemo<RuleResult | null>(() => {
    if (!parsed || !parsed.ok) return null;
    const ts = now.toISOString();
    const hyp: Reading[] = MetricInd[m].map((ind, i) => ({ id: `hyp-${ind}`, timestamp: ts, indicator: ind, value: parsed.values[i], unit: INDICATOR_UNIT[ind], source: sourceFor(m, source), provenance: 'real', quality: 'good' }));
    return evaluate(m, [...readings, ...hyp], now, DEMO_PROFILE);
  }, [parsed, m, readings, now, source]);

  const go = (i: number) => { setStep(i); setVals({}); setSaved(null); };
  const save = () => {
    if (!parsed || !parsed.ok) return;
    void sendReadings(logCheckin([{ metric: m, values: parsed.values, source: sourceFor(m, source) }]));
    const st = useAstra.getState();
    setSaved(evaluate(m, st.readings, st.now(), DEMO_PROFILE));
    setVals({});
  };

  return (
    <div className="mx-auto flex max-w-[720px] flex-col gap-4 p-3 lg:p-6">
      <h1 className="sr-only">Measure</h1>
      <Steps step={step} go={go} done={loggedToday} />
      {saved ? (
        <Saved r={saved} next={nextTodo(step)} go={go} />
      ) : (
        <Ask m={m} vals={vals} setVals={setVals} parsed={parsed} preview={preview} save={save} skip={() => go((step + 1) % STEPS.length)} />
      )}
      <details className="card p-4 text-sm">
        <summary className="cursor-pointer text-muted hover:text-text">More: all your past numbers, and what you measured with</summary>
        <label className="mt-3 flex flex-wrap items-center gap-2 text-muted">
          Measured with
          <select value={source} onChange={(e) => setSource(e.target.value)} className="rounded border border-line bg-s2 px-2 py-1 text-text">
            <option value="manual">by hand</option>
            <option value="wrist sensor">wrist sensor</option>
            <option value="glucometer">blood sugar meter</option>
            <option value="actigraphy">sleep tracker</option>
          </select>
        </label>
        <Readings />
      </details>
    </div>
  );
}

function Steps({ step, go, done }: { step: number; go: (i: number) => void; done: (m: MetricId) => boolean }) {
  return (
    <ol className="flex justify-between gap-1" aria-label="What to measure">
      {STEPS.map((x, i) => {
        const Icon = METRIC_ICON[x];
        const cur = i === step;
        const d = done(x);
        return (
          <li key={x} className="flex-1">
            <button type="button" onClick={() => go(i)} aria-current={cur ? 'step' : undefined} aria-label={`${METRICS[x].short}${d ? ', done today' : ''}`}
              className={`relative flex w-full flex-col items-center gap-1 rounded-sm border-2 py-2 text-[11px] ${cur ? 'border-brand bg-brand-soft text-text' : 'border-transparent text-muted hover:text-text'}`}>
              <Icon size={22} aria-hidden="true" />
              <span className="hidden sm:block">{METRICS[x].short}</span>
              {d && <Check size={14} aria-hidden="true" className="absolute right-1 top-1 text-[color:var(--ok)]" />}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function Ask({ m, vals, setVals, parsed, preview, save, skip }: {
  m: MetricId; vals: Vals; setVals: (f: (v: Vals) => Vals) => void; parsed: Parsed; preview: RuleResult | null; save: () => void; skip: () => void;
}) {
  const Icon = METRIC_ICON[m];
  const meta = METRICS[m];
  const first = useRef<HTMLInputElement | HTMLButtonElement | null>(null);
  useEffect(() => { first.current?.focus(); }, [m]);
  const set = (k: string, v: string) => setVals((x) => ({ ...x, [k]: v }));
  const S = preview ? STATUS[preview.status] : null;
  return (
    <form className="card p-6" noValidate onSubmit={(e) => { e.preventDefault(); save(); }}>
      <Icon size={40} className="text-brand" aria-hidden="true" />
      <h2 className="mt-3 font-display text-[30px] font-bold leading-[34px]">{QUESTION[m]}</h2>
      <p className="mt-2 text-[17px] leading-6">{meta.howTo[0]}</p>
      {meta.howTo.length > 1 && (
        <details className="mt-1 text-[15px]">
          <summary className="cursor-pointer text-muted hover:text-text">How do I measure it?</summary>
          <ol className="mt-2 list-decimal space-y-1 pl-5">{meta.howTo.map((h) => <li key={h}>{h}</li>)}</ol>
        </details>
      )}

      <div className="mt-5">
        {m === 'mood' ? (
          <div className="grid grid-cols-5 gap-2" role="radiogroup" aria-label={QUESTION.mood}>
            {MOODS.map((label, i) => {
              const n = String(i + 1);
              const on = vals.v === n;
              return (
                <button key={n} ref={i === 0 ? (el) => { first.current = el; } : undefined} type="button" role="radio" aria-checked={on} onClick={() => set('v', on ? '' : n)}
                  className={`flex flex-col items-center rounded-sm border-2 py-3 ${on ? 'border-brand bg-brand-soft font-bold' : 'border-line hover:border-line-strong'}`}>
                  <span className="num text-[24px] leading-7">{n}</span>
                  <span className="text-[13px]">{label}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="flex flex-wrap gap-4">
            {PARTS[m].map((p, i) => (
              <label key={p.key} className="flex flex-col gap-1 text-[15px]">
                {p.label}
                <input ref={i === 0 ? (el) => { first.current = el; } : undefined} inputMode="decimal" type="number" step={p.step} min={p.min} max={p.max}
                  placeholder={p.example} value={vals[p.key] ?? ''} onChange={(e) => set(p.key, e.target.value)}
                  className="num w-40 rounded-sm border-2 border-line bg-s1 px-3 py-3 text-[32px] leading-9 text-text placeholder:text-muted/50 focus:border-brand" />
              </label>
            ))}
          </div>
        )}
        {USUAL[m] && <p className="num mt-2 text-[15px] text-muted">Your usual: {USUAL[m]}</p>}
      </div>

      <div className="mt-4 min-h-[56px]" aria-live="polite">
        {parsed && !parsed.ok && <p role="alert" className="text-[16px]" style={{ color: 'var(--watch)' }}>{parsed.error}</p>}
        {S && preview && (
          <p className="flex items-start gap-2 text-[16px]">
            <S.icon size={22} className="mt-0.5 shrink-0" style={{ color: S.cssVar }} aria-hidden="true" />
            <span><b style={{ color: S.cssVar }}>{S.label}.</b> {preview.plain}</span>
          </p>
        )}
      </div>

      <div className="mt-4 flex flex-col gap-3">
        <button type="submit" disabled={!parsed || !parsed.ok} className={big}>Save</button>
        <button type="button" onClick={skip} className="text-[15px] text-muted underline underline-offset-4 hover:text-text">Skip this one</button>
      </div>
    </form>
  );
}

function Saved({ r, next, go }: { r: RuleResult; next: number | null; go: (i: number) => void }) {
  const alert = useAstra((s) => s.events.some((e) => e.stage === 'respond' && e.metric === r.metric));
  const S = STATUS[r.status];
  return (
    <section className="card p-6" style={{ boxShadow: `inset 0 4px 0 ${S.cssVar}` }} aria-live="polite">
      <CheckCircle2 size={40} className="text-[color:var(--ok)]" aria-hidden="true" />
      <h2 className="mt-3 font-display text-[30px] font-bold leading-[34px]">Saved</h2>
      <p className="mt-2 flex items-start gap-2 text-[17px] leading-6">
        <S.icon size={22} className="mt-0.5 shrink-0" style={{ color: S.cssVar }} aria-hidden="true" />
        <span><b style={{ color: S.cssVar }}>{S.label}.</b> {r.plain}</span>
      </p>
      <div className="mt-6 flex flex-col gap-3">
        {alert ? (
          <Link to="/events" className={big}>Start the 3 easy steps</Link>
        ) : next !== null ? (
          <button type="button" onClick={() => go(next)} className={big}>Next: {METRICS[STEPS[next]].short.toLowerCase()}</button>
        ) : (
          <Link to="/" className={big}>All done. Go home</Link>
        )}
        {(alert || next !== null) && <Link to="/" className="text-center text-[15px] text-muted underline underline-offset-4 hover:text-text">Go home</Link>}
      </div>
    </section>
  );
}

function Readings() {
  const { visible } = useDerived();
  const rows = useMemo(() => [...visible].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 40), [visible]);
  return (
    <div className="mt-3 max-h-[50vh] overflow-auto" tabIndex={0} role="region" aria-label="Past numbers, scrollable">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Your 40 most recent numbers</caption>
        <thead className="sticky top-0 bg-s1 text-xs text-muted"><tr><th className="py-2 pr-3 font-medium">When (UTC)</th><th className="pr-3 font-medium">What</th><th className="pr-3 text-right font-medium">Number</th><th className="font-medium">Measured with</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-line">
              <td className="num whitespace-nowrap py-1.5 pr-3 text-muted">{utcStamp(r.timestamp).replace(' UTC', '')}</td>
              <td className="whitespace-nowrap pr-3">{IND_LABEL[r.indicator]}</td>
              <td className="num pr-3 text-right">{r.indicator === 'temp' || r.indicator === 'sleep' || r.indicator === 'rad_dose' ? r.value.toFixed(1) : r.value} <span className="text-muted">{r.unit}</span></td>
              <td className="whitespace-nowrap text-muted">{r.source}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

