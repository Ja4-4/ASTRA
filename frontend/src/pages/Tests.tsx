import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { Answer, DemoChip, PRIMARY, SECONDARY } from '../components/Answer';
import { StatusPill } from '../components/Status';
import { STATUS } from '../lib/status';
import { useAstra } from '../store/useAstra';
import { useNow } from '../store/derived';
import { missionDay } from '../lib/time';
import { TESTS_DEMO, memoryStatus, testStatus } from '../demo/newScreens';

const R = TESTS_DEMO.reaction;
const M = TESTS_DEMO.memory;

/** Thinking tests. Reaction time is really measured with performance.now(); "your usual" is simulated. Points are for doing a test, never for the score. */
export default function Tests() {
  const [avg, setAvg] = useState<number>(R.lastAvgMs);
  const [fresh, setFresh] = useState(false);
  const [runNonce, setRunNonce] = useState(0);
  const status = testStatus(avg, R.usualMs);
  const day = missionDay(useNow());
  const done = useAstra((s) => s.routineDone);
  const completeTest = useAstra((s) => s.completeTest);
  const grantBadge = useAstra((s) => s.grantBadge);

  const finished = (test: 'reaction' | 'memory', label: string) => {
    completeTest(`test:${day}:${test}`, label);
    const other = test === 'reaction' ? 'memory' : 'reaction';
    if (useAstra.getState().routineDone[`test:${day}:${other}`]) grantBadge('sharp_mind', 'Sharp Mind', 'Both thinking tests done today. See it on Progress.');
  };

  return (
    <div className="mx-auto flex max-w-[1280px] flex-col gap-3 p-3 lg:p-5">
      <PageHeader title="Thinking tests" sub="Compared with your own usual, never with other people."><DemoChip /></PageHeader>
      <Answer
        status={status}
        title={`Thinking speed: ${STATUS[status].label.toLowerCase()}.`}
        why={`${fresh ? 'This' : 'Last'} reaction test: average ${avg} ms. Your usual is ${R.usualMs} ms.`}
        action={<button type="button" className={PRIMARY} onClick={() => setRunNonce((n) => n + 1)}>Start reaction test ({R.demoSeconds} s)</button>}
        aside={`Today: ${done[`test:${day}:reaction`] ? 'reaction done' : 'reaction not done'} · ${done[`test:${day}:memory`] ? 'memory done' : 'memory not done'}`}
      />
      <div className="grid gap-3 lg:grid-cols-2">
        <Reaction runNonce={runNonce} onResult={(ms) => { setAvg(ms); setFresh(true); finished('reaction', 'reaction test'); }} />
        <Memory onFinish={() => finished('memory', 'memory grid')} />
      </div>
    </div>
  );
}

type ReactionPhase = 'idle' | 'waiting' | 'on' | 'done';

function Reaction({ onResult, runNonce }: { onResult: (avgMs: number) => void; runNonce: number }) {
  const [phase, setPhase] = useState<ReactionPhase>('idle');
  const [times, setTimes] = useState<number[]>([]);
  const [early, setEarly] = useState(0);
  const [missed, setMissed] = useState(0);
  const [left, setLeft] = useState(R.demoSeconds);
  const [feedback, setFeedback] = useState('');
  const onAt = useRef(0);
  const t0 = useRef(0);
  const clock = useRef<number | null>(null);
  const square = useRef<number[]>([]);
  const target = useRef<HTMLButtonElement>(null);
  const timesRef = useRef<number[]>([]);
  const phaseRef = useRef<ReactionPhase>('idle');
  const go = (p: ReactionPhase) => { phaseRef.current = p; setPhase(p); };
  const clearSquare = () => { square.current.forEach((t) => window.clearTimeout(t)); square.current = []; };
  const clearAll = () => { clearSquare(); if (clock.current) window.clearInterval(clock.current); clock.current = null; };
  useEffect(() => clearAll, []); // eslint-disable-line react-hooks/exhaustive-deps

  const timeLeft = () => R.demoSeconds - (performance.now() - t0.current) / 1000;
  const finish = () => {
    clearAll();
    go('done');
    const all = timesRef.current;
    if (all.length) onResult(Math.round(all.reduce((a, b) => a + b, 0) / all.length));
  };
  const schedule = () => {
    const gap = R.minGapMs + Math.random() * (R.maxGapMs - R.minGapMs);
    if (timeLeft() * 1000 < gap) return; // no square fits before the end; the clock will finish the test
    square.current.push(window.setTimeout(() => {
      onAt.current = performance.now();
      go('on');
      square.current.push(window.setTimeout(() => {
        if (phaseRef.current !== 'on') return;
        setMissed((n) => n + 1);
        setFeedback('Missed that one. The next square is coming.');
        go('waiting');
        schedule();
      }, R.tooSlowMs));
    }, gap));
  };
  const start = () => {
    clearAll();
    timesRef.current = [];
    setTimes([]); setEarly(0); setMissed(0); setLeft(R.demoSeconds); setFeedback('Wait for the square.');
    t0.current = performance.now();
    go('waiting');
    schedule();
    // One clock for the whole test: the test always ends on time, with or without a last tap.
    clock.current = window.setInterval(() => {
      const l = timeLeft();
      setLeft(Math.max(0, Math.ceil(l)));
      if (l <= 0) finish();
    }, 250);
    target.current?.focus();
  };
  useEffect(() => { if (runNonce > 0) start(); }, [runNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const tap = () => {
    const p = phaseRef.current;
    if (p === 'idle' || p === 'done') { start(); return; }
    if (p === 'waiting') { setEarly((n) => n + 1); setFeedback('Too early. Wait until the square turns on.'); return; }
    const rt = Math.round(performance.now() - onAt.current);
    timesRef.current = [...timesRef.current, rt];
    setTimes(timesRef.current);
    setFeedback(`${rt} ms`);
    clearSquare();
    go('waiting');
    schedule();
  };

  const avg = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null;
  const best = times.length ? Math.min(...times) : null;
  const running = phase === 'waiting' || phase === 'on';
  const label = phase === 'idle' ? 'Tap to start' : phase === 'waiting' ? 'Wait' : phase === 'on' ? 'Tap now' : 'Tap to go again';

  return (
    <section className="card flex flex-col gap-3 p-4" aria-labelledby="rt-h">
      <h2 id="rt-h" className="panel-head">Reaction test</h2>
      <p className="text-[15px] text-text">Tap (or press Space) when the square turns on. Early taps are counted, not punished.</p>
      <button
        ref={target}
        type="button"
        onPointerDown={(e) => { e.preventDefault(); tap(); }}
        onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); tap(); } }}
        className="flex h-[200px] w-full touch-none select-none items-center justify-center rounded-sm border border-line bg-s2"
        aria-label={`${label}. ${feedback}`}
      >
        <span className={`flex h-[104px] w-[104px] items-center justify-center rounded-sm border-2 text-[15px] font-bold ${phase === 'on' ? 'border-text bg-text text-bg' : 'border-line-strong text-muted'}`}>{label}</span>
      </button>
      <div className="flex items-center gap-3">
        <div className="h-1.5 flex-1 rounded-sm bg-line" role="progressbar" aria-label="Time used" aria-valuemin={0} aria-valuemax={R.demoSeconds} aria-valuenow={R.demoSeconds - left}>
          <div className="h-full rounded-sm bg-brand" style={{ width: `${((R.demoSeconds - left) / R.demoSeconds) * 100}%` }} />
        </div>
        <span className="num w-12 text-right text-sm text-muted">{left} s</span>
        {running && <button type="button" onClick={finish} className="text-sm text-muted underline underline-offset-4 hover:text-text">Stop</button>}
      </div>
      <p className="num min-h-6 text-[15px] text-text" aria-live="polite">{phase === 'done' ? '' : feedback}</p>
      {phase === 'done' && (
        avg !== null ? (
          <div className="rounded-sm border border-line p-3 text-[15px]">
            <p className="flex flex-wrap items-center gap-2"><b className="num">Average {avg} ms.</b> Your usual {R.usualMs} ms. <StatusPill status={testStatus(avg, R.usualMs)} small /></p>
            <p className="num mt-1 text-sm text-muted">Fastest {best} ms · {times.length} taps · early {early} · missed {missed}</p>
          </div>
        ) : <p className="text-[15px] text-muted">No taps counted. Tap the square when it turns on.</p>
      )}
      <p className="text-sm text-muted">Full test: {R.fullMinutes} minutes. This demo: {R.demoSeconds} seconds.</p>
    </section>
  );
}

function pickCells(n: number): number[] {
  const all = Array.from({ length: M.size * M.size }, (_, i) => i);
  for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; }
  return all.slice(0, n);
}

type MemoryPhase = 'idle' | 'show' | 'repeat' | 'between' | 'done';

function Memory({ onFinish }: { onFinish: () => void }) {
  const [span, setSpan] = useState(M.start);
  const [round, setRound] = useState(1);
  const [best, setBest] = useState(0);
  const [pattern, setPattern] = useState<number[]>([]);
  const [picked, setPicked] = useState<number[]>([]);
  const [wrong, setWrong] = useState<number | null>(null);
  const [phase, setPhase] = useState<MemoryPhase>('idle');
  const [note, setNote] = useState('');
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  const show = (n: number, r: number) => {
    setRound(r); setSpan(n);
    setPattern(pickCells(n)); setPicked([]); setWrong(null);
    setPhase('show'); setNote(`Remember these ${n} squares.`);
    timer.current = window.setTimeout(() => { setPhase('repeat'); setNote(`Your turn: tap the ${n} squares.`); }, n * M.showMsPerCell + 600);
  };
  const start = () => { setBest(0); show(M.start, 1); };
  const endRound = (perfect: boolean) => {
    const nextSpan = perfect ? Math.min(M.max, span + 1) : Math.max(M.min, span - 1);
    if (perfect) setBest((b) => Math.max(b, span));
    if (round >= M.rounds) {
      setPhase('done');
      setNote('');
      onFinish();
      return;
    }
    setPhase('between');
    setNote(perfect ? `All ${span} right. Next round: ${nextSpan} squares.` : `Not quite. Next round: ${nextSpan} squares.`);
    timer.current = window.setTimeout(() => show(nextSpan, round + 1), 1400);
  };
  const pick = (i: number) => {
    if (phase !== 'repeat' || picked.includes(i)) return;
    if (!pattern.includes(i)) { setWrong(i); endRound(false); return; }
    const next = [...picked, i];
    setPicked(next);
    if (next.length === pattern.length) endRound(true);
  };

  const lit = (i: number) => (phase === 'show' && pattern.includes(i)) || picked.includes(i);

  return (
    <section className="card flex flex-col gap-3 p-4" aria-labelledby="mg-h">
      <h2 id="mg-h" className="panel-head">Memory grid</h2>
      <p className="min-h-6 text-[15px] text-text" aria-live="polite">
        {phase === 'idle' ? `Squares light up, then you tap the same ones. ${M.rounds} short rounds. Order does not matter.` : phase === 'done' ? `All ${M.rounds} rounds done.` : `Round ${round} of ${M.rounds} · ${note}`}
      </p>
      <div className="grid w-full max-w-[260px] grid-cols-4 gap-2 self-center" role="group" aria-label="Memory grid, 4 by 4">
        {Array.from({ length: M.size * M.size }, (_, i) => (
          <button key={i} type="button" onClick={() => pick(i)} disabled={phase !== 'repeat'} aria-pressed={picked.includes(i)} aria-label={`Square ${i + 1}`}
            className={`flex aspect-square items-center justify-center rounded-sm border transition-colors duration-150 ${lit(i) ? 'border-text bg-text' : 'border-line-strong bg-s2'} ${phase === 'repeat' ? 'hover:border-brand' : ''}`}>
            {wrong === i && <X size={22} className="text-muted" aria-label="wrong square" />}
          </button>
        ))}
      </div>
      {phase === 'done' && (
        <div className="rounded-sm border border-line p-3 text-[15px]">
          {best > 0
            ? <p className="flex flex-wrap items-center gap-2"><b className="num">You remembered up to {best} squares.</b> Your usual is {M.usualSpan}. <StatusPill status={memoryStatus(best, M.usualSpan)} small /></p>
            : <p>No perfect round this time. That happens when tired. Try again later today.</p>}
        </div>
      )}
      <button type="button" className={`${SECONDARY} self-start`} onClick={start} disabled={phase === 'show' || phase === 'repeat' || phase === 'between'}>{phase === 'idle' ? 'Start memory grid' : 'Play again'}</button>
    </section>
  );
}
