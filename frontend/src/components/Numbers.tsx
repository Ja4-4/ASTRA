import { ChevronRight } from 'lucide-react';
import { useAstra } from '../store/useAstra';
import { useDerived } from '../store/derived';
import { METRICS, METRIC_ORDER, type MetricId } from '../lib/indicators';
import { STATUS } from '../lib/status';

/** Home shows numbers in two groups: the few to look at (one row each, with the reason), and the rest in one quiet line. */
export function Numbers() {
  const { results } = useDerived();
  const openMetric = useAstra((s) => s.openMetric);
  const sorted = [...METRIC_ORDER].sort((a, b) => STATUS[results[b].status].severity - STATUS[results[a].status].severity);
  const look = sorted.filter((m) => results[m].status !== 'ok');
  const fine = sorted.filter((m) => results[m].status === 'ok');
  const value = (m: MetricId) => `${results[m].display} ${m === 'exercise' ? '% of plan' : results[m].unit}`;

  return (
    <section aria-labelledby="numbers-h" className="card">
      <h2 id="numbers-h" className="sr-only">Your numbers</h2>
      {look.length > 0 && (
        <>
          <h3 className="px-4 pt-3 text-sm text-muted">Look at {look.length === 1 ? 'this' : `these ${look.length}`}</h3>
          <ul>
            {look.map((m) => {
              const r = results[m];
              const S = STATUS[r.status];
              const color = r.status === 'nodata' ? 'var(--nodata-text)' : S.cssVar;
              return (
                <li key={m} className="border-b border-line last:border-b-0">
                  <button
                    type="button"
                    onClick={() => openMetric(m)}
                    aria-label={`${METRICS[m].label}, ${S.label}. ${r.plain} Show more.`}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-s2"
                  >
                    <S.icon size={22} className="shrink-0" style={{ color }} aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[17px] font-bold leading-6">{METRICS[m].short}</span>
                      <span className="block text-sm leading-5 text-muted">{r.plain}</span>
                    </span>
                    {r.status !== 'nodata' && <span className="num shrink-0 whitespace-nowrap text-right text-[22px] font-bold" style={{ color }}>{r.display}<span className="ml-1 text-sm font-normal text-muted">{m === 'exercise' ? '% of plan' : r.unit}</span></span>}
                    <ChevronRight size={18} className="shrink-0 text-muted" aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {fine.length > 0 && (
        <div className={`px-4 py-3 ${look.length > 0 ? 'border-t border-line-strong' : ''}`}>
          <h3 className="text-sm text-muted">{look.length > 0 ? 'Like your usual' : 'Everything is like your usual'}</h3>
          <ul className="mt-2 flex flex-wrap gap-2">
            {fine.map((m) => {
              const Ok = STATUS.ok.icon;
              return (
                <li key={m}>
                  <button type="button" onClick={() => openMetric(m)} aria-label={`${METRICS[m].label}: ${value(m)}, ${STATUS.ok.label}. Show more.`} className="flex items-center gap-1.5 rounded-sm border border-line px-2.5 py-1.5 text-sm hover:border-brand">
                    <Ok size={15} style={{ color: 'var(--ok)' }} aria-hidden="true" />
                    {METRICS[m].short}
                    <span className="num font-bold">{value(m)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
