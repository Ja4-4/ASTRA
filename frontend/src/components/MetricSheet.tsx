import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Clock, ClipboardPlus, Info, ListChecks, Repeat, Stethoscope, Target, X } from 'lucide-react';
import { useAstra } from '../store/useAstra';
import { useDerived } from '../store/derived';
import { METRICS, type MetricId } from '../lib/indicators';
import { METRIC_ICON, SYSTEM_ICON, SYSTEM_OF_METRIC } from '../lib/icons';
import { STATUS } from '../lib/status';
import { RULE_TABLE, RULES_VALIDATION_STATE } from '../lib/rules';
import { seriesOf } from '../lib/series';
import { dayLabel } from '../lib/time';
import { DEMO_PROFILE } from '../data/demo/profile';
import { StatusIcon, StatusPill } from './Status';
import { ProvenanceBadge } from './Provenance';
import { Sparkline } from './Sparkline';

const B = DEMO_PROFILE.baseline;
/** The astronaut's own pre-flight value, as shown next to today's number. */
export const USUAL: Partial<Record<MetricId, string>> = {
  hr: `${B.hr}`, bp: `${B.bp_sys}/${B.bp_dia}`, sleep: `${B.sleep} h`, glucose: `${B.glucose}`, temp: `${B.temp?.toFixed(1)} °C`,
};

export function bandFor(metric: MetricId): [number, number] | undefined {
  const ind = METRICS[metric].indicators[0];
  const base = B[ind];
  if (base === undefined) return undefined;
  return ind === 'temp' || ind === 'sleep' ? [base - 0.5, base + 0.5] : [base * 0.9, base * 1.1];
}

/** Everything about one number, opened by clicking it anywhere on Home. */
export function MetricSheet() {
  const metric = useAstra((s) => s.metricDetail);
  const open = useAstra((s) => s.openMetric);
  const reduce = useReducedMotion();
  return (
    <AnimatePresence>
      {metric && (
        <motion.div
          key="sheet"
          className="fixed inset-0 z-50 flex justify-end"
          initial={reduce ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
        >
          <button type="button" aria-label="Close details" tabIndex={-1} className="absolute inset-0 cursor-default bg-black/50" onClick={() => open(null)} />
          <motion.aside
            initial={reduce ? false : { x: 40 }}
            animate={{ x: 0 }}
            exit={{ x: 40 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="relative flex h-full w-full max-w-[400px] flex-col border-l border-line-strong bg-s1 shadow-2xl"
          >
            <Body metric={metric} close={() => open(null)} />
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Body({ metric, close }: { metric: MetricId; close: () => void }) {
  const { results, visible, now } = useDerived();
  const select = useAstra((s) => s.select);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const res = results[metric];
  const meta = METRICS[metric];
  const S = STATUS[res.status];
  const Icon = METRIC_ICON[metric];
  const sys = SYSTEM_OF_METRIC[metric];
  const SysIcon = SYSTEM_ICON[sys];
  const ind = meta.indicators[0];
  const series = seriesOf(visible, ind, now, 14).map((r) => r.value);
  const latest = res.inputs[res.inputs.length - 1] ?? [...visible].reverse().find((r) => r.indicator === ind);
  const rules = RULE_TABLE[metric];
  const color = res.status === 'nodata' ? 'var(--nodata-text)' : S.cssVar;

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    closeBtn.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') useAstra.getState().openMetric(null); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, []);

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="ms-h" className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2.5 border-b border-line px-4 py-3" style={{ boxShadow: `inset 0 2px 0 ${color}` }}>
        <Icon size={18} className="shrink-0" style={{ color }} aria-hidden="true" />
        <h2 id="ms-h" className="min-w-0 flex-1 truncate text-base font-semibold">{meta.label}</h2>
        <StatusPill status={res.status} />
        <button ref={closeBtn} type="button" onClick={close} aria-label="Close details" className="-mr-1 rounded p-1.5 text-muted hover:bg-s2 hover:text-text">
          <X size={16} aria-hidden="true" />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        <div className="flex items-end justify-between gap-3">
          <div className="flex items-baseline gap-1.5">
            <span className="num text-[44px] leading-[48px]" style={{ color: res.status === 'nodata' ? 'var(--nodata-text)' : 'var(--text)' }}>{res.status === 'nodata' ? '—' : res.display}</span>
            {res.status !== 'nodata' && <span className="num text-sm text-muted">{res.unit}</span>}
          </div>
          {USUAL[metric] && (
            <span className="num pb-2 text-right text-sm text-muted" title="The middle of your own readings before launch">
              Your usual<br /><b className="text-base text-text">{USUAL[metric]}</b>
            </span>
          )}
        </div>

        <p className="text-sm leading-5 text-text">{res.plain}</p>

        {series.length > 1 && (
          <figure>
            <Sparkline values={series} status={res.status} band={bandFor(metric)} width={360} height={84} label={`${meta.label}, last 14 days`} />
            <figcaption className="num mt-1 flex items-center justify-between text-[11px] text-muted">
              <span>14 d</span>
              <span className="flex items-center gap-1"><span className="inline-block h-2 w-3 rounded-sm" style={{ background: 'color-mix(in srgb, var(--text) 12%, transparent)' }} aria-hidden="true" />your usual</span>
              <span>now</span>
            </figcaption>
            <Link to="/trends" onClick={close} className="mt-1 inline-block text-sm text-muted underline underline-offset-4 hover:text-text">See all past days</Link>
          </figure>
        )}

        <section>
          <h3 className="mb-1 flex items-center gap-1.5 text-sm font-bold text-text"><Info size={12} aria-hidden="true" />What is this?</h3>
          <p className="text-sm text-text">{meta.what}</p>
        </section>

        <details className="text-sm">
          <summary className="flex cursor-pointer items-center gap-1.5 text-sm font-bold text-text"><ListChecks size={12} aria-hidden="true" />How do I measure it?</summary>
          <ol className="mt-1.5 list-decimal space-y-0.5 pl-5 text-text">
            {meta.howTo.map((t) => <li key={t}>{t}</li>)}
          </ol>
        </details>
        <details className="rounded border border-line p-3 text-sm">
          <summary className="flex cursor-pointer items-center gap-1.5 font-bold text-muted hover:text-text"><Stethoscope size={14} aria-hidden="true" />Details for the doctor</summary>
          <div className="mt-3 space-y-4">
        <ul className="num grid grid-cols-2 gap-2 text-xs">
          <li className="flex items-center gap-1.5 rounded border border-line bg-s2 px-2 py-1.5" title="Last reading">
            <Clock size={13} className="shrink-0 text-muted" aria-hidden="true" />
            {latest ? dayLabel(latest.timestamp, now) : 'none on record'}
          </li>
          <li className="flex items-center gap-1.5 rounded border border-line bg-s2 px-2 py-1.5" title="How often to measure">
            <Repeat size={13} className="shrink-0 text-muted" aria-hidden="true" />
            {meta.cadenceLabel}
          </li>
          {latest && (
            <li className="col-span-2 flex items-center gap-1.5 truncate rounded border border-line bg-s2 px-2 py-1.5" title="Where this number came from">
              <ProvenanceBadge p={latest.provenance} /> <span className="truncate text-muted">{latest.source}</span>
            </li>
          )}
        </ul>

        <section>
          <h3 className="mb-1.5 flex items-center gap-1.5 text-sm font-bold text-text"><Target size={12} aria-hidden="true" />Limits</h3>
          <ul className="space-y-1 text-[13px] leading-[18px]">
            {([['ok', rules.nominal], ['watch', rules.watch], ['act', rules.act]] as const).map(([k, txt]) => (
              <li key={k} className="flex items-start gap-2" style={res.status === k ? { color: 'var(--text)' } : { color: 'var(--text-muted)' }}>
                <span className="mt-0.5 shrink-0"><StatusIcon status={k} size={14} /></span>{txt}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-xs text-muted">{RULES_VALIDATION_STATE}</p>
        </section>

          </div>
        </details>
      </div>

      <div className="flex gap-2 border-t border-line px-4 py-3">
        <Link to={`/log?focus=${metric}`} onClick={close} className="flex flex-1 items-center justify-center gap-1.5 rounded bg-brand px-3 py-2 text-sm font-semibold text-on-brand btn-cut hover:opacity-90">
          <ClipboardPlus size={15} aria-hidden="true" />Measure again
        </Link>
        <button type="button" onClick={() => { select(sys); close(); }} className="flex flex-1 items-center justify-center gap-1.5 rounded border border-line px-3 py-2 text-sm text-text hover:border-brand">
          <SysIcon size={15} aria-hidden="true" />Show on body
        </button>
      </div>
    </div>
  );
}
