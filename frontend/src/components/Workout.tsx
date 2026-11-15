import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useReducedMotion } from 'framer-motion';
import type { TrainingSession } from '../demo/newScreens';
import { PRIMARY } from './Answer';
import { Workout3D } from '../three/Workout3D';

type Kind = 'squat' | 'run' | 'cycle' | 'balance';
const KIND: Record<string, Kind> = { ared: 'squat', t2: 'run', cevis: 'cycle', balance: 'balance' };

/** Short form cues per exercise. General movement cues only, no medical advice. */
const CUES: Record<Kind, string[]> = {
  squat: ['Shoulders under the bar pads, feet shoulder-width.', 'Sit back and down, knees in line with your toes.', 'Push through your heels to stand tall.'],
  run: ['Clip the harness so it pulls you onto the belt.', 'Short, quick steps. Land under your hips.', 'Stop and tell the trainer if the harness rubs.'],
  cycle: ['Strap your feet in. There is no seat in space.', 'Hold the handles and keep a pace you can talk at.', 'Keep the pedals turning smoothly, no bouncing.'],
  balance: ['Stand on one foot, one hand near the rail.', 'Turn your head slowly left, then right.', 'Close your eyes only once you feel steady.'],
};

const S = { stroke: 'var(--text)', strokeWidth: 4.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' };
const M = { stroke: 'var(--text-muted)', strokeWidth: 2, strokeLinecap: 'round' as const, fill: 'none' };

/** Knee position for a leg from hip to foot (two-bone, knee bends forward = +x). */
function knee(hx: number, hy: number, fx: number, fy: number, thigh = 25, shin = 27): [number, number] {
  const dx = fx - hx, dy = fy - hy, d = Math.min(Math.hypot(dx, dy), thigh + shin - 0.01);
  const a = (thigh * thigh - shin * shin + d * d) / (2 * d), h = Math.sqrt(Math.max(0, thigh * thigh - a * a));
  const mx = hx + (a * dx) / d, my = hy + (a * dy) / d;
  const k1: [number, number] = [mx + (h * dy) / d, my - (h * dx) / d], k2: [number, number] = [mx - (h * dy) / d, my + (h * dx) / d];
  return k1[0] > k2[0] ? k1 : k2;
}

/** Original line figure doing the exercise, animated with SVG (still under reduced motion). */
export function ExerciseFigure({ sessionId, size = 120 }: { sessionId: string; size?: number }) {
  const reduce = !!useReducedMotion();
  const kind = KIND[sessionId] ?? 'squat';
  const A = (props: Record<string, string>) => (reduce ? null : <animate repeatCount="indefinite" {...props} />);

  return (
    <svg width={size} height={size} viewBox="0 0 120 120" role="img" aria-label={`${kind} animation`}>
      <line x1="14" y1="112" x2="106" y2="112" {...M} />
      {kind === 'squat' && (
        <g>
          <path d="M56 62 L58 87 L56 110 L68 110" {...S}>{A({ attributeName: 'd', dur: '2.4s', values: 'M56 62 L58 87 L56 110 L68 110;M44 84 L68 92 L56 110 L68 110;M56 62 L58 87 L56 110 L68 110', calcMode: 'spline', keySplines: '0.4 0 0.6 1;0.4 0 0.6 1' })}</path>
          <path d="M56 62 L58 28" {...S}>{A({ attributeName: 'd', dur: '2.4s', values: 'M56 62 L58 28;M44 84 L53 52;M56 62 L58 28', calcMode: 'spline', keySplines: '0.4 0 0.6 1;0.4 0 0.6 1' })}</path>
          <path d="M58 33 L66 40 L60 30" {...S} strokeWidth={3.5}>{A({ attributeName: 'd', dur: '2.4s', values: 'M58 33 L66 40 L60 30;M53 57 L62 63 L55 54;M58 33 L66 40 L60 30', calcMode: 'spline', keySplines: '0.4 0 0.6 1;0.4 0 0.6 1' })}</path>
          <circle cx="58" cy="19" r="7" {...S} strokeWidth={4}>{A({ attributeName: 'cy', dur: '2.4s', values: '19;43;19', calcMode: 'spline', keySplines: '0.4 0 0.6 1;0.4 0 0.6 1' })}{A({ attributeName: 'cx', dur: '2.4s', values: '58;54;58', calcMode: 'spline', keySplines: '0.4 0 0.6 1;0.4 0 0.6 1' })}</circle>
          <circle cx="59" cy="30" r="8" fill="var(--surface-2)" stroke="var(--brand)" strokeWidth="3">{A({ attributeName: 'cy', dur: '2.4s', values: '30;54;30', calcMode: 'spline', keySplines: '0.4 0 0.6 1;0.4 0 0.6 1' })}{A({ attributeName: 'cx', dur: '2.4s', values: '59;54;59', calcMode: 'spline', keySplines: '0.4 0 0.6 1;0.4 0 0.6 1' })}</circle>
        </g>
      )}
      {kind === 'run' && (
        <g>
          <line x1="18" y1="110" x2="102" y2="110" stroke="var(--brand)" strokeWidth="3" strokeDasharray="6 6" strokeLinecap="round">{A({ attributeName: 'stroke-dashoffset', dur: '0.5s', values: '0;12' })}</line>
          <path d="M58 60 L26 110 M58 60 L94 110" {...M} strokeDasharray="3 4" />
          <path d="M58 60 L70 83 L64 106" {...S}>{A({ attributeName: 'd', dur: '0.7s', values: 'M58 60 L70 83 L64 106;M58 60 L52 84 L40 100;M58 60 L70 83 L64 106' })}</path>
          <path d="M58 60 L52 84 L40 100" {...S}>{A({ attributeName: 'd', dur: '0.7s', values: 'M58 60 L52 84 L40 100;M58 60 L70 83 L64 106;M58 60 L52 84 L40 100' })}</path>
          <path d="M58 60 L62 28" {...S} />
          <path d="M61 34 L71 45 L78 37" {...S} strokeWidth={3.5}>{A({ attributeName: 'd', dur: '0.7s', values: 'M61 34 L71 45 L78 37;M61 34 L53 46 L47 40;M61 34 L71 45 L78 37' })}</path>
          <path d="M61 34 L53 46 L47 40" {...S} strokeWidth={3.5}>{A({ attributeName: 'd', dur: '0.7s', values: 'M61 34 L53 46 L47 40;M61 34 L71 45 L78 37;M61 34 L53 46 L47 40' })}</path>
          <circle cx="64" cy="19" r="7" {...S} strokeWidth={4} />
        </g>
      )}
      {kind === 'cycle' && <Cycle animate={!reduce} />}
      {kind === 'balance' && (
        <g>
          {!reduce && <animateTransform attributeName="transform" type="rotate" values="-3 58 110;3 58 110;-3 58 110" dur="3s" repeatCount="indefinite" />}
          <path d="M60 62 L58 86 L58 110" {...S} />
          <path d="M60 62 L73 79 L63 92" {...S} />
          <path d="M60 62 L60 28" {...S} />
          <path d="M60 34 L42 40 L32 37 M60 34 L78 40 L88 37" {...S} strokeWidth={3.5} />
          <circle cx="60" cy="19" r="7" {...S} strokeWidth={4} />
          <line x1="60" y1="19" x2="65" y2="21" stroke="var(--brand)" strokeWidth="3" strokeLinecap="round">{A({ attributeName: 'x2', dur: '3s', values: '65;55;65' })}</line>
        </g>
      )}
    </svg>
  );
}

function Cycle({ animate }: { animate: boolean }) {
  const C = { x: 62, y: 92, r: 12 }, hip = { x: 50, y: 60 };
  const steps = 8;
  const legD = (phase: number) => Array.from({ length: steps + 1 }, (_, i) => {
    const t = phase + (i / steps) * Math.PI * 2;
    const fx = C.x + C.r * Math.cos(t), fy = C.y + C.r * Math.sin(t);
    const [kx, ky] = knee(hip.x, hip.y, fx, fy);
    return `M${hip.x} ${hip.y} L${kx.toFixed(1)} ${ky.toFixed(1)} L${fx.toFixed(1)} ${fy.toFixed(1)}`;
  });
  const a = legD(0), b = legD(Math.PI);
  return (
    <g>
      <circle cx={C.x} cy={C.y} r="20" {...M} />
      <path d={`M${C.x} ${C.y} L84 52 L90 50`} {...M} strokeWidth={3} />
      <line x1={C.x - C.r} y1={C.y} x2={C.x + C.r} y2={C.y} stroke="var(--brand)" strokeWidth="3" strokeLinecap="round">
        {animate && <animateTransform attributeName="transform" type="rotate" from={`0 ${C.x} ${C.y}`} to={`360 ${C.x} ${C.y}`} dur="1.1s" repeatCount="indefinite" />}
      </line>
      <path d={a[0]} {...S}>{animate && <animate attributeName="d" dur="1.1s" repeatCount="indefinite" values={a.join(';')} />}</path>
      <path d={b[0]} {...S}>{animate && <animate attributeName="d" dur="1.1s" repeatCount="indefinite" values={b.join(';')} />}</path>
      <path d={`M${hip.x} ${hip.y} L56 30`} {...S} />
      <path d="M56 35 L72 44 L86 50" {...S} strokeWidth={3.5} />
      <circle cx="58" cy="21" r="7" {...S} strokeWidth={4} />
    </g>
  );
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** Guided session: the moving figure, three form cues and a timer. The astronaut says when it is done. */
export function WorkoutPlayer({ session, onFinish, onClose }: { session: TrainingSession; onFinish: () => void; onClose: () => void }) {
  const [sec, setSec] = useState(0);
  const kind = KIND[session.id] ?? 'squat';
  useEffect(() => {
    const t0 = performance.now();
    const id = window.setInterval(() => setSec((performance.now() - t0) / 1000), 500);
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', esc);
    return () => { window.clearInterval(id); document.removeEventListener('keydown', esc); };
  }, [onClose]);
  const planned = session.minutes * 60;

  return (
    <div role="dialog" aria-label={`${session.label} session`} className="fixed inset-0 z-[55] flex items-center justify-center bg-[#0B0A10]/80 p-4">
      <section className="card relative flex w-[min(820px,100%)] flex-col gap-5 p-6 md:flex-row md:items-center">
        <button type="button" onClick={onClose} aria-label="Close session" className="absolute right-3 top-3 rounded-sm p-1.5 text-muted hover:bg-s2 hover:text-text"><X size={18} aria-hidden="true" /></button>
        <div className="mx-auto flex shrink-0 flex-col items-center gap-2">
          <div className="h-[320px] w-[320px] overflow-hidden rounded-sm border border-line" role="img" aria-label={`3D crew member doing ${session.label} on ${session.device}`}>
            <Workout3D sessionId={session.id} fallback={<div className="flex h-full items-center justify-center bg-s2"><ExerciseFigure sessionId={session.id} size={220} /></div>} />
          </div>
          <div className="h-1.5 w-[320px] rounded-sm bg-line" role="progressbar" aria-label="Time against the plan" aria-valuemin={0} aria-valuemax={planned} aria-valuenow={Math.round(Math.min(sec, planned))}>
            <div className="h-full rounded-sm bg-brand" style={{ width: `${Math.min(1, sec / planned) * 100}%` }} />
          </div>
          <p className="text-xs text-muted">Drag to turn the view</p>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <p className="text-sm font-bold uppercase tracking-[0.12em] text-brand">{session.device}</p>
          <h2 className="font-display text-[28px] font-bold leading-[32px]">{session.label}</h2>
          <p className="num text-[17px]"><b>{mmss(sec)}</b> <span className="text-muted">of {session.minutes}:00 planned</span></p>
          <ol className="flex flex-col gap-1.5 text-[15px] text-text">
            {CUES[kind].map((cue, i) => <li key={cue} className="flex gap-2"><span className="num font-bold text-brand">{i + 1}</span>{cue}</li>)}
          </ol>
          <p className="text-sm text-muted">{session.why}</p>
          <div className="mt-1 flex flex-wrap items-center gap-4">
            <button type="button" className={PRIMARY} onClick={onFinish}>I finished it</button>
            <button type="button" onClick={onClose} className="text-[15px] text-muted underline underline-offset-4 hover:text-text">Stop for now</button>
          </div>
        </div>
      </section>
    </div>
  );
}
