import { useState } from 'react';
import { Area, Bar, BarChart, Cell, CartesianGrid, ComposedChart, Line, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useDerived } from '../store/derived';
import { SYSTEMS, type SystemId } from '../lib/systems';
import { METRICS, type MetricId } from '../lib/indicators';
import { CHART_THRESHOLDS } from '../lib/rules';
import { seriesOf, dailyExercisePct } from '../lib/series';
import { DEMO_PROFILE } from '../data/demo/profile';
import { missionDay, utcStamp } from '../lib/time';
import type { IndicatorId, Reading } from '../data/types';
import { PageHeader } from '../components/PageHeader';
import { StatusPill } from '../components/Status';

const BAND: Partial<Record<IndicatorId, number>> = { hr: 0.15, bp_sys: 0.08, bp_dia: 0.08, glucose: 0.1 };

function bandFor(ind: IndicatorId): [number, number] | null {
  const b = DEMO_PROFILE.baseline[ind];
  if (b === undefined) return null;
  if (ind === 'temp') return [b - 0.5, b + 0.5];
  if (ind === 'sleep') return [b - 0.5, b + 0.5];
  if (ind === 'mood') return [3, 5];
  return [b * (1 - (BAND[ind] ?? 0.1)), b * (1 + (BAND[ind] ?? 0.1))];
}

/** One calm hue per number, so each chart is recognisable at a glance. Status colours (green, orange, red) are used only for status. */
const SERIES: Record<MetricId, { main: string; second?: string }> = {
  bp: { main: 'var(--c-bp)', second: 'var(--c-bp2)' }, hr: { main: 'var(--c-hr)' }, sleep: { main: 'var(--c-sleep)' }, mood: { main: 'var(--c-mood)' },
  glucose: { main: 'var(--c-glucose)' }, temp: { main: 'var(--c-temp)' }, exercise: { main: 'var(--c-ex)' },
};
const LOW = (label: string) => label.includes('<') || label.includes('≤');
/** A dot is orange or red when that reading crossed a Watch or Act line; otherwise it keeps the chart's own colour. */
function dotColour(ind: IndicatorId, v: number, base: string): string {
  const th = CHART_THRESHOLDS[ind] ?? [];
  const crossed = (status: 'act' | 'watch') => th.some((t) => t.status === status && (LOW(t.label) ? v < t.value : v > t.value));
  if (crossed('act')) return 'var(--act)';
  if (crossed('watch')) return 'var(--watch)';
  return base;
}

const axis = { fill: 'var(--text-muted)', fontSize: 10.5, fontFamily: 'Atkinson Hyperlegible, sans-serif' };

/** Round axis bounds to a 1/2/2.5/5 x 10^n step so ticks read like an instrument scale. */
function niceScale(lo: number, hi: number, target = 4): { domain: [number, number]; ticks: number[] } {
  const raw = (hi - lo) / target || 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((st) => st >= raw) ?? 10 * mag;
  const a = Math.floor(lo / step) * step, b = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let v = a; v <= b + step / 2; v += step) ticks.push(+v.toFixed(4));
  return { domain: [a, b], ticks };
}

function TipBox({ active, payload }: { active?: boolean; payload?: { payload: Record<string, unknown> }[] }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload as { r?: Reading; r2?: Reading; day?: string; pct?: number };
  if (p.pct !== undefined) return <div className="card-raised num p-2 text-xs">{p.day} · {p.pct}% of prescribed</div>;
  const r = p.r!;
  return (
    <div className="card-raised num p-2 text-xs">
      <div className="text-text">{p.r2 ? `${r.value}/${p.r2.value}` : r.value} {r.unit}</div>
      <div className="text-muted">{utcStamp(r.timestamp)} · {r.source} · {r.provenance.toUpperCase()}</div>
    </div>
  );
}

function MetricChart({ metric, days }: { metric: MetricId; days: number }) {
  const { visible, now, results } = useDerived();
  const meta = METRICS[metric];
  const res = results[metric];
  const fmtX = (t: number) => `MD${missionDay(new Date(t))}`;
  let chart: JSX.Element;
  if (metric === 'exercise') {
    const data = dailyExercisePct(visible, now, days, DEMO_PROFILE.prescribedExerciseMinPerDay);
    chart = (
      <BarChart data={data} margin={{ top: 6, right: 62, bottom: 0, left: -10 }}>
        <CartesianGrid stroke="var(--line)" strokeDasharray="2 4" vertical={false} />
        <XAxis dataKey="day" tick={axis} tickFormatter={(d: string) => d.slice(5)} stroke="var(--line)" tickLine={false} minTickGap={16} />
        <YAxis domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tick={axis} stroke="var(--line)" tickLine={false} width={44} unit="%" />
        <ReferenceLine y={85} stroke="var(--watch)" strokeDasharray="4 4" label={{ value: 'Watch <85', position: 'right', fill: 'var(--text-muted)', fontSize: 10 }} />
        <ReferenceLine y={60} stroke="var(--act)" strokeDasharray="4 4" label={{ value: 'Act <60', position: 'right', fill: 'var(--text-muted)', fontSize: 10 }} />
        <Tooltip content={<TipBox />} cursor={{ fill: 'var(--brand-soft)' }} />
        <Bar dataKey="pct" radius={[3, 3, 0, 0]} isAnimationActive={false}>
          {data.map((d) => <Cell key={d.day} fill={d.pct < 60 ? 'var(--act)' : d.pct < 85 ? 'var(--watch)' : 'var(--c-ex)'} fillOpacity={0.8} />)}
        </Bar>
      </BarChart>
    );
  } else {
    const ind = meta.indicators[0];
    const list = seriesOf(visible, ind, now, days);
    const second = meta.indicators[1] ? seriesOf(visible, meta.indicators[1], now, days) : [];
    const data = list.map((r) => {
      const r2 = second.find((x) => x.timestamp === r.timestamp);
      return { t: new Date(r.timestamp).getTime(), v: r.value, v2: r2?.value, r, r2 };
    });
    const band = bandFor(ind);
    const band2 = meta.indicators[1] ? bandFor(meta.indicators[1]) : null;
    const th = [...(CHART_THRESHOLDS[ind] ?? []), ...(meta.indicators[1] ? CHART_THRESHOLDS[meta.indicators[1]] ?? [] : [])];
    const vals = [...data.map((d) => d.v), ...data.map((d) => d.v2 ?? d.v), ...(band ?? []), ...(band2 ?? [])];
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const pad = (hi - lo) * 0.12 || 1;
    const { domain, ticks } = niceScale(lo - pad, hi + pad);
    chart = (
      <ComposedChart data={data} margin={{ top: 6, right: 62, bottom: 0, left: -10 }}>
        <defs>
          <linearGradient id={`fill-${metric}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={SERIES[metric].main} stopOpacity={0.32} />
            <stop offset="100%" stopColor={SERIES[metric].main} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="var(--line)" strokeDasharray="2 4" />
        <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} scale="time" tick={axis} tickFormatter={fmtX} stroke="var(--line)" tickLine={false} minTickGap={24} />
        <YAxis domain={domain} ticks={ticks} tick={axis} stroke="var(--line)" tickLine={false} width={44} allowDecimals={ind === 'temp' || ind === 'sleep'} />
        {band && <ReferenceArea y1={band[0]} y2={band[1]} fill="var(--ok)" fillOpacity={0.13} stroke="none" ifOverflow="hidden" />}
        {band2 && <ReferenceArea y1={band2[0]} y2={band2[1]} fill="var(--ok)" fillOpacity={0.09} stroke="none" ifOverflow="hidden" />}
        {th.filter((t) => t.value >= domain[0] && t.value <= domain[1]).map((t) => (
          <ReferenceLine key={t.label} y={t.value} stroke={t.status === 'act' ? 'var(--act)' : 'var(--watch)'} strokeDasharray="4 4" label={{ value: t.label, position: 'right', fill: t.status === 'act' ? 'var(--act)' : 'var(--watch)', fontSize: 9.5, fontFamily: 'Atkinson Hyperlegible, sans-serif' }} />
        ))}
        <Tooltip content={<TipBox />} />
        <Area type="monotone" dataKey="v" stroke="none" fill={`url(#fill-${metric})`} isAnimationActive={false} activeDot={false} legendType="none" tooltipType="none" />
        <Line type="monotone" dataKey="v" stroke={SERIES[metric].main} strokeWidth={2.25} isAnimationActive={false}
          dot={(p: { cx?: number; cy?: number; payload?: { v: number }; index?: number }) => <circle key={`d${p.index}`} cx={p.cx} cy={p.cy} r={3.2} fill={dotColour(ind, p.payload?.v ?? 0, SERIES[metric].main)} stroke="var(--surface-1)" strokeWidth={1} />} />
        {meta.indicators[1] && <Line type="monotone" dataKey="v2" stroke={SERIES[metric].second} strokeWidth={2.25} isAnimationActive={false}
          dot={(p: { cx?: number; cy?: number; payload?: { v2?: number }; index?: number }) => <circle key={`e${p.index}`} cx={p.cx} cy={p.cy} r={3.2} fill={dotColour(meta.indicators[1], p.payload?.v2 ?? 0, SERIES[metric].second ?? SERIES[metric].main)} stroke="var(--surface-1)" strokeWidth={1} />} />}
      </ComposedChart>
    );
  }
  return (
    <section className="card flex min-h-0 min-w-0 flex-col p-3" aria-label={`${meta.label} trend, last ${days} days`}>
      <div className="panel-head">
        <h2 className="min-w-0 truncate"><span aria-hidden="true" className="mr-1.5 inline-block h-2.5 w-2.5 rounded-full align-middle" style={{ background: SERIES[metric].main }} /><span className="text-text">{meta.label}</span> <span className="normal-case tracking-normal">({meta.unit === '%' ? '% of plan, per day' : meta.unit})</span></h2>
        <span className="ml-auto normal-case tracking-normal"><StatusPill status={res.status} small /></span>
      </div>
      {metric === 'bp' && <p className="-mt-1 mb-1 text-[11px] text-muted"><span style={{ color: SERIES.bp.main }}>━</span> top number · <span style={{ color: SERIES.bp.second }}>━</span> bottom number</p>}
      <div className="h-44 min-h-0 lg:h-auto lg:flex-1">
        <ResponsiveContainer width="100%" height="100%">{chart}</ResponsiveContainer>
      </div>
    </section>
  );
}

function ChartKey() {
  const dot = (c: string) => <span aria-hidden="true" className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: c }} />;
  return (
    <section className="card flex min-h-0 flex-col gap-2.5 p-3 text-xs text-muted" aria-label="How to read these charts">
      <div className="panel-head">How to read these charts</div>
      <p className="flex items-center gap-2"><span aria-hidden="true" className="inline-block h-3 w-6 shrink-0 rounded-sm" style={{ background: 'color-mix(in srgb, var(--ok) 22%, transparent)' }} />Green band: your usual range (from before launch)</p>
      <p className="flex items-center gap-2"><span aria-hidden="true" className="flex w-6 shrink-0 items-center"><span className="h-0.5 flex-1" style={{ background: 'var(--c-bp)' }} /><span className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--c-bp)' }} /></span>Each chart has its own colour. A dot is a number you logged.</p>
      <p className="flex items-center gap-2">{dot('var(--watch)')}Orange dot: that number went past the Watch line</p>
      <p className="flex items-center gap-2">{dot('var(--act)')}Red dot: that number went past the Act now line</p>
      <p className="flex items-center gap-2"><span aria-hidden="true" className="w-6 shrink-0 border-t-2 border-dashed" style={{ borderColor: 'var(--watch)' }} />Dashed orange / red lines: where Watch and Act now start</p>
      <p className="mt-auto border-t border-line pt-2">Bottom axis: mission day (MD 142 = day 142 in space). Point at a dot to see when and how it was measured.</p>
    </section>
  );
}

export default function Trends() {
  const [days, setDays] = useState(30);
  const [sys, setSys] = useState<SystemId | 'all'>('all');
  const metrics: MetricId[] = sys === 'all' ? ['bp', 'hr', 'sleep', 'mood', 'glucose', 'temp', 'exercise'] : SYSTEMS.find((s) => s.id === sys)!.metrics;
  return (
    <div className="mx-auto flex max-w-[1800px] flex-col gap-3 p-3 lg:h-full">
      <PageHeader code="05" title="History" sub="Your numbers over time. The green band is your usual; dashed lines show where Watch (orange) and Act now (red) start.">
        <div role="group" aria-label="Time range" className="flex rounded border border-line p-0.5">
          {[7, 30].map((d) => (
            <button key={d} type="button" aria-pressed={days === d} onClick={() => setDays(d)} className={`num rounded-sm px-3 py-1 text-sm ${days === d ? 'bg-brand-soft text-brand' : 'text-muted hover:text-text'}`}>{d} days</button>
          ))}
        </div>
        <label className="text-sm text-muted">Show{' '}
          <select aria-label="Filter by system" value={sys} onChange={(e) => setSys(e.target.value as SystemId | 'all')} className="rounded border border-line bg-s2 px-2 py-1 text-sm text-text">
            <option value="all">Everything</option>
            {SYSTEMS.filter((s) => s.tracked).map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
      </PageHeader>
      <div className={`grid min-h-0 flex-1 gap-3 sm:grid-cols-2 ${metrics.length > 4 ? 'lg:grid-cols-4 lg:grid-rows-2' : metrics.length > 2 ? 'lg:grid-cols-2 lg:grid-rows-2' : (metrics.length === 2 ? 'lg:grid-cols-2 lg:grid-rows-1' : 'lg:grid-cols-1 lg:grid-rows-1')}`}>
        {metrics.map((m) => <MetricChart key={m} metric={m} days={days} />)}
        {metrics.length === 7 && <ChartKey />}
      </div>
    </div>
  );
}
