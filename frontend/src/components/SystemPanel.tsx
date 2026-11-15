import { Link } from 'react-router-dom';
import { motion, useReducedMotion } from 'framer-motion';
import { X, ClipboardPlus, BookOpen, Siren, CheckCheck, ChevronRight, Info, ListChecks, Stethoscope } from 'lucide-react';
import { useAstra } from '../store/useAstra';
import { useDerived } from '../store/derived';
import { STATUS } from '../lib/status';
import { GUIDANCE, type SystemId } from '../lib/systems';
import { METRICS } from '../lib/indicators';
import { RULE_TABLE, RULES_VALIDATION_STATE } from '../lib/rules';
import { seriesOf } from '../lib/series';
import { DEMO_PROFILE } from '../data/demo/profile';
import { startUTC } from '../lib/time';
import { StatusIcon, StatusPill } from './Status';
import { METRIC_ICON, SYSTEM_ICON } from '../lib/icons';
import type { MetricId } from '../lib/indicators';
import { Sparkline } from './Sparkline';
import { Term } from './Term';

export function SystemPanel({ id }: { id: SystemId }) {
  const { systems, visible, now } = useDerived();
  const select = useAstra((s) => s.select);
  const ackWatch = useAstra((s) => s.ackWatch);
  const watchAcks = useAstra((s) => s.watchAcks);
  const reduce = useReducedMotion();
  const st = systems.find((s) => s.def.id === id)!;
  const g = GUIDANCE[st.status];
  const driver = st.driver;
  const metric = driver?.metric;
  const ind = metric ? METRICS[metric].indicators[0] : undefined;
  const series = ind ? seriesOf(visible, ind, now, 14).map((r) => r.value) : [];
  const base = ind ? DEMO_PROFILE.baseline[ind] : undefined;
  const openMetric = useAstra((s) => s.openMetric);
  const SysIcon = SYSTEM_ICON[id];
  const color = st.status === 'nodata' ? 'var(--nodata-text)' : STATUS[st.status].cssVar;
  const ackKey = driver ? `${startUTC(now).toISOString()}:${driver.ruleId}` : '';
  return (
    <motion.section
      key={id}
      initial={reduce ? false : { opacity: 0, x: 16 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className="card flex h-full min-h-0 flex-col overflow-y-auto p-4"
      aria-labelledby="panel-h"
    >
      <div className="flex items-center gap-2.5">
        <SysIcon size={20} className="shrink-0" style={{ color }} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h2 id="panel-h" className="text-lg font-semibold leading-6 text-text">{st.def.label}</h2>
          <p className="num truncate text-[11px] text-muted" title={st.def.anatomy}>{st.def.technical}</p>
        </div>
        <StatusPill status={st.status} />
        <button onClick={() => select(null)} aria-label="Close and go back" title="Close" className="-mr-1 rounded p-1.5 text-muted hover:bg-s2 hover:text-text"><X size={16} aria-hidden="true" /></button>
      </div>

      {!st.def.tracked ? (
        <>
          <p className="mt-3 text-sm text-text">{st.def.relevance}</p>
          <p className="mt-2 text-sm text-muted">ASTRA does not track the eyes yet, so this stays grey. Grey never means “fine”: it means “no number”. An eyesight self-check is planned.</p>
        </>
      ) : (
        <>
          <ul className="mt-3 space-y-1.5 short:mt-2">
            {[...st.results].sort((a, b) => STATUS[b.status].severity - STATUS[a.status].severity).map((r) => (
              <li key={r.metric}>
                <button type="button" onClick={() => openMetric(r.metric)} aria-label={`${METRICS[r.metric].label}: ${r.plain} Open details.`} className="group w-full rounded border border-line bg-s2 p-2.5 text-left hover:border-line-strong short:p-2" style={{ boxShadow: `inset 3px 0 0 ${STATUS[r.status].cssVar}` }}>
                  <span className="flex items-center gap-2">
                    <MetricGlyph metric={r.metric} />
                    <span className="text-xs font-medium text-muted">{METRICS[r.metric].short}</span>
                    {r.display !== '—' && <span className="num text-xs text-text">{r.display} {r.unit}</span>}
                    <span className="ml-auto"><StatusIcon status={r.status} size={15} /></span>
                    <ChevronRight size={14} className="text-muted group-hover:text-text" aria-hidden="true" />
                  </span>
                  <span className="mt-1 block text-sm leading-5 text-text short:text-[13px] short:leading-[18px]">{r.plain}</span>
                </button>
              </li>
            ))}
          </ul>
          {series.length > 1 && driver && (
            <div className="mt-3 short:hidden">
              <div className="mb-1 text-xs text-muted">{METRICS[driver.metric].label}, last 14 days (shaded band: <Term k="baseline">your usual</Term>)</div>
              <Sparkline values={series} status={st.status} band={base !== undefined ? [base * 0.95, base * 1.05] : undefined} width={290} height={56} label={`${METRICS[driver.metric].label} trend`} />
            </div>
          )}
          <h3 className="mt-3 flex items-center gap-1.5 text-sm font-bold text-text"><Info size={12} aria-hidden="true" />What this means</h3>
          <p className="mt-1 text-sm text-text short:text-[13px] short:leading-[18px]">{g.means}</p>
          <h3 className="mt-3 flex items-center gap-1.5 text-sm font-bold text-text"><ListChecks size={12} aria-hidden="true" />What to do</h3>
          <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-sm text-text short:text-[13px] short:leading-[18px]">
            {g.todo.map((t) => <li key={t}>{t}</li>)}
          </ol>
          <details className="mb-3 mt-3 text-xs text-muted short:mt-2">
            <summary className="flex cursor-pointer items-center gap-1.5 hover:text-text"><Stethoscope size={13} aria-hidden="true" />Why it matters in space, and details for the doctor</summary>
            <p className="mt-1.5 text-text">{st.def.relevance}</p>
            {driver && (
              <ul className="mt-1.5 space-y-0.5">
                <li><b className="font-medium" style={{ color: STATUS.ok.cssVar }}>{STATUS.ok.label}:</b> {RULE_TABLE[driver.metric].nominal}</li>
                <li><b className="font-medium" style={{ color: STATUS.watch.cssVar }}>{STATUS.watch.label}:</b> {RULE_TABLE[driver.metric].watch}</li>
                <li><b className="font-medium" style={{ color: STATUS.act.cssVar }}>{STATUS.act.label}:</b> {RULE_TABLE[driver.metric].act}</li>
              </ul>
            )}
            <div className="num mt-1.5 space-y-0.5 text-[11px]">
              {st.results.map((r) => <p key={r.metric}>{r.ruleId}: {r.explanation}</p>)}
              <p>{RULES_VALIDATION_STATE}</p>
            </div>
          </details>
          <div className="sticky -bottom-4 -mx-4 -mb-4 mt-auto flex flex-wrap gap-2 border-t border-line bg-s1 px-4 py-3">
            {st.status === 'act' && (
              <Link to="/events" className="flex items-center gap-1.5 rounded bg-brand px-3 py-1.5 text-sm font-semibold text-on-brand btn-cut"><Siren size={14} aria-hidden="true" />Start the 3 steps</Link>
            )}
            {st.status === 'watch' && driver && (
              watchAcks[ackKey] ? (
                <span className="flex items-center gap-1.5 rounded border border-brand/60 px-3 py-1.5 text-sm text-brand"><CheckCheck size={14} aria-hidden="true" />Done for today</span>
              ) : (
                <button type="button" onClick={() => ackWatch(driver.ruleId)} className="flex items-center gap-1.5 rounded bg-brand px-3 py-1.5 text-sm font-semibold text-on-brand btn-cut">
                  <CheckCheck size={14} aria-hidden="true" />Measured again
                </button>
              )
            )}
            <Link to={`/log?focus=${driver?.metric ?? ''}`} className={`flex items-center gap-1.5 rounded px-3 py-1.5 text-sm ${st.status === 'ok' || st.status === 'nodata' ? 'bg-brand font-semibold text-on-brand btn-cut' : 'border border-line text-text hover:border-brand'}`}><ClipboardPlus size={14} aria-hidden="true" />Log</Link>
            <Link to={`/evidence#${id}`} aria-label="How it works" title="How it works" className="ml-auto flex items-center rounded border border-line px-2.5 py-1.5 text-text hover:border-brand"><BookOpen size={15} aria-hidden="true" /></Link>
          </div>
        </>
      )}
    </motion.section>
  );
}

function MetricGlyph({ metric }: { metric: MetricId }) {
  const I = METRIC_ICON[metric];
  return <I size={14} className="shrink-0 text-muted" aria-hidden="true" />;
}
