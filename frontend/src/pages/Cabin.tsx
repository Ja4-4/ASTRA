import { useCallback, useEffect, useState } from 'react';
import { Database, FileUp, ScanEye, Wind } from 'lucide-react';
import { useAstra } from '../store/useAstra';
import { PageHeader } from '../components/PageHeader';
import { Sparkline } from '../components/Sparkline';
import { STATUS, type StatusKey } from '../lib/status';
import * as api from '../data/server';
import { currentAstronaut } from '../data/api';

const PARAMS: { id: string; label: string }[] = [
  { id: 'cabin_temp', label: 'Cabin temperature' },
  { id: 'humidity', label: 'Cabin humidity' },
  { id: 'co2', label: 'Cabin CO₂' },
];
const toStatus = (s: string): StatusKey => (s === 'typical' ? 'ok' : s === 'watch' ? 'watch' : s === 'attention' || s === 'alert' ? 'act' : 'nodata');
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Cabin & data: the ISS cabin environment the server holds, a way to check a value, data imports, and the eye screenings. */
export default function Cabin() {
  const live = useAstra((s) => s.dataSource === 'live');
  const aid = currentAstronaut()?.id;
  if (!live || aid === undefined) {
    return (
      <div className="mx-auto max-w-[720px] p-3 lg:p-6">
        <PageHeader title="Cabin & data" />
        <p className="card mt-4 p-6 text-[17px]">This page reads from the backend, which is not connected right now. Start the backend and reload this page.</p>
      </div>
    );
  }
  return (
    <div className="mx-auto flex max-w-[1500px] flex-col gap-3 p-3">
      <PageHeader title="Cabin & data" sub="The ISS cabin air the server knows about, a way to check a value against past missions, data imports, and eye screenings." />
      <div className="grid gap-3 lg:grid-cols-2">
        <CabinCard />
        <div className="flex flex-col gap-3">
          <CheckCard />
          <ImportCard />
        </div>
        <EyeCard aid={aid} />
        <SourcesCard />
      </div>
    </div>
  );
}

function CabinCard() {
  const [rows, setRows] = useState<Record<string, api.EnvReading[]> | null>(null);
  const [assess, setAssess] = useState<Record<string, api.EnvAssessment | string>>({});
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const all = Object.fromEntries(await Promise.all(PARAMS.map(async (p) => [p.id, await api.envReadings(p.id, 240)] as const)));
        if (!live) return;
        setRows(all);
        for (const p of PARAMS) {
          const last = all[p.id][0];
          if (!last || last.value === null) continue;
          api.envAssess(p.id, last.value).then((a) => live && setAssess((x) => ({ ...x, [p.id]: a }))).catch((e) => live && setAssess((x) => ({ ...x, [p.id]: msg(e) })));
        }
      } catch (e) { if (live) setErr(msg(e)); }
    })();
    return () => { live = false; };
  }, []);
  return (
    <section className="card p-4" aria-labelledby="cab-h" data-testid="cabin-card">
      <h2 id="cab-h" className="panel-head"><Wind size={13} aria-hidden="true" />ISS cabin, latest readings</h2>
      {err && <p role="alert" className="text-sm" style={{ color: 'var(--watch)' }}>{err}</p>}
      {rows && PARAMS.every((p) => rows[p.id].length === 0) && <p className="text-sm text-muted" data-testid="cabin-empty">No cabin readings are loaded yet. Import them below (see “Data import”), or run scripts/load_eda.py.</p>}
      <ul className="divide-y divide-line">
        {PARAMS.map((p) => {
          const list = rows?.[p.id] ?? [];
          const last = list[0];
          const a = assess[p.id];
          const st = typeof a === 'object' ? toStatus(a.status) : 'nodata';
          return (
            <li key={p.id} className="py-3" data-testid="cabin-row">
              <div className="flex flex-wrap items-center gap-3">
                <span className="w-36 text-sm font-bold">{p.label}</span>
                {last ? <span className="num text-[22px]">{last.value}<span className="text-sm text-muted"> {last.unit}</span></span> : <span className="text-sm text-muted">no readings</span>}
                {list.length > 1 && <Sparkline values={[...list].reverse().map((r) => r.value ?? NaN).filter((v) => Number.isFinite(v))} status={st} label={`${p.label}, last ${list.length} readings`} width={140} height={32} />}
              </div>
              {last && <p className="num mt-0.5 text-xs text-muted">{last.measured_at.replace('T', ' ').replace('Z', ' UTC')} · {last.source_name}</p>}
              {typeof a === 'object' && <p className="mt-1 text-[13px]"><b style={{ color: STATUS[st].cssVar }}>{a.status}.</b> {a.rule_fired}</p>}
              {typeof a === 'string' && <p className="mt-1 text-[13px] text-muted">{a}</p>}
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-xs text-muted">Compared with past ISS missions. This is a statistical reference, not a safety limit and not a diagnosis.</p>
    </section>
  );
}

function CheckCard() {
  const [param, setParam] = useState(PARAMS[0].id);
  const [val, setVal] = useState('');
  const [out, setOut] = useState<api.EnvAssessment | null>(null);
  const [err, setErr] = useState('');
  const run = async () => {
    setErr(''); setOut(null);
    const n = Number(val);
    if (val.trim() === '' || !Number.isFinite(n)) { setErr('Type a number.'); return; }
    try { setOut(await api.envAssess(param, n)); } catch (e) { setErr(msg(e)); }
  };
  const st = out ? toStatus(out.status) : 'nodata';
  return (
    <section className="card p-4" aria-labelledby="chk-h">
      <h2 id="chk-h" className="panel-head"><Database size={13} aria-hidden="true" />Check a cabin value</h2>
      <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); void run(); }}>
        <label className="flex flex-col gap-1 text-sm">What
          <select value={param} onChange={(e) => setParam(e.target.value)} aria-label="Cabin parameter" className="rounded border border-line bg-s2 px-2 py-1.5">{PARAMS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select>
        </label>
        <label className="flex flex-col gap-1 text-sm">Value
          <input inputMode="decimal" value={val} onChange={(e) => setVal(e.target.value)} aria-label="Value to check" className="num w-32 rounded border border-line bg-s2 px-2 py-1.5" />
        </label>
        <button type="submit" className="rounded border border-brand px-3 py-1.5 text-sm text-brand">Check</button>
      </form>
      <div aria-live="polite" className="mt-3 min-h-[44px] text-sm">
        {err && <p role="alert" style={{ color: 'var(--watch)' }}>{err}</p>}
        {out && <p data-testid="assess-result"><b style={{ color: STATUS[st].cssVar }}>{out.status}.</b> {out.value} {out.unit}: {out.rule_fired}. <span className="text-muted">Typical is about {out.reference_median} {out.unit} (from {out.n_training_readings.toLocaleString()} readings).</span></p>}
      </div>
    </section>
  );
}

function ImportCard() {
  const [files, setFiles] = useState<api.ImportFiles | null>(null);
  const [log, setLog] = useState<api.ImportLogRow[]>([]);
  const [csv, setCsv] = useState('');
  const [map, setMap] = useState('');
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<Record<string, unknown> | null>(null);
  const [err, setErr] = useState('');
  const load = useCallback(async () => {
    try { const [f, l] = await Promise.all([api.importFiles(), api.importLog()]); setFiles(f); setLog(l); setCsv((c) => c || f.raw_csv[0] || ''); setMap((m) => m || f.mappings[0] || ''); } catch (e) { setErr(msg(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const go = async () => {
    if (!window.confirm(`Add the rows from ${csv} to the database, using ${map}?`)) return;
    setBusy(true); setErr(''); setReport(null);
    try { setReport(await api.runImport(csv, map)); await load(); } catch (e) { setErr(msg(e)); } finally { setBusy(false); }
  };
  return (
    <section className="card p-4" aria-labelledby="imp-h" data-testid="import-card">
      <h2 id="imp-h" className="panel-head"><FileUp size={13} aria-hidden="true" />Data import</h2>
      {files && files.raw_csv.length === 0 ? <p className="text-sm text-muted">No CSV files in data/raw yet. Put a file there, then pick it here with one of the mapping files.</p> : (
        <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); void go(); }}>
          <label className="flex flex-col gap-1 text-sm">CSV file<select value={csv} onChange={(e) => setCsv(e.target.value)} className="rounded border border-line bg-s2 px-2 py-1.5">{files?.raw_csv.map((f) => <option key={f}>{f}</option>)}</select></label>
          <label className="flex flex-col gap-1 text-sm">Mapping<select value={map} onChange={(e) => setMap(e.target.value)} className="rounded border border-line bg-s2 px-2 py-1.5">{files?.mappings.map((f) => <option key={f}>{f}</option>)}</select></label>
          <button type="submit" disabled={busy || !csv || !map} className="rounded border border-brand px-3 py-1.5 text-sm text-brand disabled:opacity-50">{busy ? 'Importing…' : 'Import'}</button>
        </form>
      )}
      {err && <p role="alert" className="mt-2 text-sm" style={{ color: 'var(--watch)' }}>{err}</p>}
      {report && <pre className="num mt-2 max-h-40 overflow-auto text-xs text-muted" data-testid="import-report">{JSON.stringify(report, null, 1)}</pre>}
      <h3 className="mt-3 text-sm font-bold">Earlier imports</h3>
      {log.length === 0 ? <p className="text-sm text-muted">Nothing imported yet.</p> : (
        <ul className="mt-1 max-h-40 space-y-1 overflow-auto text-sm" data-testid="import-log">
          {log.slice(0, 20).map((r) => { let n = ''; try { n = String((JSON.parse(r.report_json) as { inserted?: number }).inserted ?? ''); } catch { /* old rows */ } return <li key={r.id} className="flex flex-wrap gap-2"><span className="num text-xs text-muted">{r.imported_at.slice(0, 16).replace('T', ' ')}</span><span>{r.file}</span>{n && <span className="ml-auto text-xs text-muted">{n} rows added</span>}</li>; })}
        </ul>
      )}
    </section>
  );
}

function EyeCard({ aid }: { aid: number }) {
  const [rows, setRows] = useState<api.EyeRow[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api.eyeHistory(aid).then(setRows).catch((e) => setErr(msg(e))); }, [aid]);
  return (
    <section className="card p-4" aria-labelledby="eye-h" data-testid="eye-card">
      <h2 id="eye-h" className="panel-head"><ScanEye size={13} aria-hidden="true" />Eye screenings</h2>
      <p className="text-sm">A camera check for tiredness and visible signs. It cannot diagnose eye disease.</p>
      <a href="/eye" className="mt-2 inline-block rounded border border-brand px-3 py-1.5 text-sm text-brand">Open the eye check</a>
      {err && <p role="alert" className="mt-2 text-sm" style={{ color: 'var(--watch)' }}>{err}</p>}
      {rows && rows.length === 0 && <p className="mt-3 text-sm text-muted">No screenings yet.</p>}
      {rows && rows.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm" data-testid="eye-history">
          {rows.slice(0, 8).map((r) => <li key={r.id} className="flex flex-wrap gap-2"><span className="num text-xs text-muted">{r.taken_at.slice(0, 16).replace('T', ' ')}</span><span>{r.status}</span>{r.fatigue_score !== null && <span className="ml-auto num text-xs text-muted">fatigue {r.fatigue_score}</span>}</li>)}
        </ul>
      )}
    </section>
  );
}

function SourcesCard() {
  const [rows, setRows] = useState<api.EvidenceSource[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api.evidenceSources().then(setRows).catch((e) => setErr(msg(e))); }, []);
  return (
    <section className="card p-4" aria-labelledby="src-h" data-testid="sources-card">
      <h2 id="src-h" className="panel-head">Data sources recorded on the server</h2>
      {err && <p role="alert" className="text-sm" style={{ color: 'var(--watch)' }}>{err}</p>}
      <ul className="divide-y divide-line text-sm">
        {rows?.map((s) => (
          <li key={s.id} className="py-2">
            <p className="font-bold">{s.url ? <a href={s.url} target="_blank" rel="noreferrer" className="underline underline-offset-2">{s.title}</a> : s.title}</p>
            <p className="text-xs text-muted">{s.license ?? 'Licence not recorded yet'} · {s.note}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
