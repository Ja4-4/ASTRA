import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import { EVIDENCE } from '../lib/evidence';
import { RULE_TABLE, RULES_VALIDATION_STATE } from '../lib/rules';
import { SYSTEM_BY_ID } from '../lib/systems';
import { STATUS } from '../lib/status';
import { PageHeader } from '../components/PageHeader';
import { METRICS, type MetricId } from '../lib/indicators';

const ORDER: MetricId[] = ['hr', 'bp', 'sleep', 'mood', 'glucose', 'temp', 'exercise'];
const COLS = [
  { key: 'nominal', status: 'ok' },
  { key: 'watch', status: 'watch' },
  { key: 'act', status: 'act' },
  { key: 'stale', status: 'nodata' },
] as const;
const sysOf = (m: MetricId) => EVIDENCE.find((e) => e.system !== 'radiation' && SYSTEM_BY_ID[e.system].metrics.includes(m))!.system;

export default function Evidence() {
  const { hash } = useLocation();
  const [sel, setSel] = useState<string>(EVIDENCE[0].system);
  useEffect(() => { if (hash && EVIDENCE.some((e) => e.system === hash.slice(1))) setSel(hash.slice(1)); }, [hash]);
  const e = EVIDENCE.find((x) => x.system === sel) ?? EVIDENCE[0];

  return (
    <div className="mx-auto flex max-w-[1800px] flex-col gap-3 p-3 lg:h-full">
      <PageHeader code="06" title="How it works" sub="Every limit ASTRA uses, in plain words, and the research behind it. Click a row for the why.">
        <span className="num rounded border border-brand/50 bg-brand-soft px-2 py-1 text-[10.5px] text-brand" title="Demo rules on synthetic data. Not clinical criteria. ASTRA interprets readings and points to the next step; it does not replace the flight surgeon. Citation check pending the team’s research and validation partner.">{RULES_VALIDATION_STATE}</span>
      </PageHeader>

      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1.75fr)_minmax(320px,1fr)]">
        {/* Rule matrix: every threshold at a glance */}
        <section className="card flex min-h-0 flex-col p-3" aria-labelledby="matrix-h">
          <h2 id="matrix-h" className="panel-head">When does a number change colour?</h2>
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full min-w-[640px] table-fixed border-collapse text-left text-xs">
              <caption className="sr-only">In range, Watch, Act now and Not available limits for each number</caption>
              <colgroup><col className="w-[15%]" /><col /><col /><col /><col className="w-[12%]" /></colgroup>
              <thead>
                <tr className="num text-[10.5px]">
                  <th scope="col" className="pb-2 pr-2 font-medium text-muted">Number</th>
                  {COLS.map((c) => {
                    const S = STATUS[c.status];
                    return <th key={c.key} scope="col" className="pb-2 pr-2 font-medium" style={{ color: c.status === 'nodata' ? 'var(--nodata-text)' : S.cssVar }}><span className="inline-flex items-center gap-1"><S.icon size={11} aria-hidden="true" />{S.label}</span></th>;
                  })}
                </tr>
              </thead>
              <tbody>
                {ORDER.map((m) => {
                  const active = sysOf(m) === sel;
                  return (
                    <tr key={m} className={`border-t border-line align-top ${active ? 'bg-brand-soft' : ''}`}>
                      <th scope="row" className="py-1.5 pr-2 font-normal short:py-1">
                        <button type="button" onClick={() => setSel(sysOf(m))} className="text-left text-[13px] leading-[17px] text-text hover:text-brand">{METRICS[m].label} <span className="num text-[10.5px] text-muted">{METRICS[m].unit}</span></button>
                      </th>
                      {COLS.map((c) => <td key={c.key} className="num py-1.5 pr-2 text-[11.5px] leading-[16px] text-text short:py-1">{RULE_TABLE[m][c.key]}</td>)}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-2 shrink-0 border-t border-line pt-2 text-[11px] text-muted">Demo limits on made-up data, loosely based on general adult ranges. Not medical rules. ASTRA never replaces the crew doctor (flight surgeon).</p>
        </section>

        {/* Why + sources, per system */}
        <section className="card flex min-h-0 flex-col p-3" aria-labelledby="why-h">
          <h2 id="why-h" className="panel-head">Why we track it · sources</h2>
          <div role="tablist" aria-label="Body system" className="flex flex-wrap gap-1">
            {EVIDENCE.map((x) => {
              const on = x.system === sel;
              return (
                <button key={x.system} role="tab" type="button" aria-selected={on} aria-controls="why-panel" onClick={() => setSel(x.system)}
                  className={`rounded border px-2 py-1 text-xs ${on ? 'border-brand bg-brand-soft text-brand' : 'border-line text-muted hover:text-text'}`}>
                  {x.system === 'radiation' ? 'Radiation' : SYSTEM_BY_ID[x.system].shortLabel}
                </button>
              );
            })}
          </div>
          <div id="why-panel" role="tabpanel" tabIndex={0} className="mt-3 min-h-0 flex-1 overflow-y-auto pr-1 text-sm short:mt-2 short:text-[13px]">
            <h3 className="text-base font-semibold">{e.title}</h3>
            <p className="mt-1 text-text">{e.why}</p>
            <dl className="mt-3 space-y-2">
              <div><dt className="num text-[10.5px] text-muted">What ASTRA tracks</dt><dd>{e.indicators}</dd></div>
              <div><dt className="num text-[10.5px] text-muted">Where the limits come from</dt><dd>{e.ruleBasis}</dd></div>
            </dl>
            <h4 className="num mt-3 text-[10.5px] text-muted">Sources (research papers)</h4>
            <ul className="mt-1 space-y-1.5 text-[13px] leading-5">
              {e.sources.map((s) => (
                <li key={s.cite}>
                  <a href={s.url} target="_blank" rel="noreferrer" className="inline-flex items-start gap-1 text-text underline decoration-line underline-offset-2 hover:decoration-brand">
                    {s.cite}<ExternalLink size={12} className="mt-1 shrink-0 text-muted" aria-label="opens in a new tab" />
                  </a>
                </li>
              ))}
            </ul>
          </div>
          <p className="mt-2 border-t border-line pt-2 text-[11px] text-muted">Sources are still being checked by the team’s research partner.</p>
        </section>
      </div>
    </div>
  );
}
