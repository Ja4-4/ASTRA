import { Component, lazy, Suspense, useMemo, useState, type ReactNode } from 'react';
import { MousePointerClick, Rotate3d, RotateCcw } from 'lucide-react';
import { useReducedMotion } from 'framer-motion';
import { useAstra } from '../store/useAstra';
import { useDerived } from '../store/derived';
import { StatusIcon } from './Status';
import { Pop } from './Pop';
import { STATUS } from '../lib/status';
import { webglAvailable } from '../three/bodyModel';
import { BodyMap2D } from './BodyMap2D';
import { MISSION_BY_ID } from '../lib/mission';
import { SYSTEM_ICON } from '../lib/icons';

const BodyScene = lazy(() => import('../three/BodyScene'));

class Boundary extends Component<{ fallback: (err: string) => ReactNode; children: ReactNode }, { err: string | null }> {
  state = { err: null as string | null };
  static getDerivedStateFromError(e: Error) { return { err: e.message || 'Failed to load the 3D model' }; }
  componentDidCatch(e: Error) { console.error('[ASTRA] 3D body failed, showing 2D fallback:', e); }
  render() { return this.state.err ? this.props.fallback(this.state.err) : this.props.children; }
}

export function OrbitLoader({ label = 'Loading body model' }: { label?: string }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3" role="status" aria-live="polite">
      <svg width="72" height="72" viewBox="0 0 72 72" aria-hidden="true">
        <g className="origin-center animate-spin" style={{ animationDuration: '2.4s', transformOrigin: '36px 36px' }}>
          <ellipse cx="36" cy="36" rx="30" ry="12" fill="none" stroke="var(--brand)" strokeWidth="1.5" transform="rotate(-20 36 36)" />
          <circle cx="64" cy="26" r="3" fill="var(--brand)" />
        </g>
        <circle cx="36" cy="36" r="5" fill="var(--starlight)" />
      </svg>
      <span className="num text-xs text-muted">{label}</span>
    </div>
  );
}

export function BodyView({ compact = false }: { compact?: boolean }) {
  const { systems } = useDerived();
  const selected = useAstra((s) => s.selectedSystem);
  const hovered = useAstra((s) => s.hoveredSystem);
  const select = useAstra((s) => s.select);
  const hover = useAstra((s) => s.hover);
  const mission = useAstra((s) => s.mission);
  const reduced = !!useReducedMotion();
  const [nonce, setNonce] = useState(0);
  const gl = useMemo(() => webglAvailable(), []);
  const summary = systems.map((s) => `${s.def.label} ${STATUS[s.status].label}`).join('; ');
  const toggle = (id: typeof selected) => select(selected === id ? null : id);

  return (
    <div className="force-dark relative h-full w-full overflow-hidden rounded-card border border-line-strong" style={{ background: MISSION_BY_ID[mission].sky }}>
      <div role="img" aria-label={`Body status overview. ${summary}.`} className="absolute inset-0">
        {gl ? (
          <Boundary fallback={(err) => <BodyMap2D systems={systems} selected={selected} onSelect={(id) => toggle(id)} reason={`3D unavailable: ${err}`} />}>
            <Suspense fallback={<OrbitLoader />}>
              <BodyScene
                systems={systems}
                selected={selected}
                hovered={hovered}
                onSelect={(id) => toggle(id)}
                onHover={hover}
                reducedMotion={reduced}
                resetNonce={nonce}
                sky={MISSION_BY_ID[mission].sky}
              />
            </Suspense>
          </Boundary>
        ) : (
          <BodyMap2D systems={systems} selected={selected} onSelect={(id) => toggle(id)} reason="WebGL not available" />
        )}
      </div>
      <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-2 text-muted" title="Click a coloured area for details. Drag to turn.">
        <span className="sr-only">Your body, live. Click a glowing area for details, drag to turn.</span>
        {!compact && <><MousePointerClick size={14} aria-hidden="true" /><Rotate3d size={14} aria-hidden="true" /></>}
      </div>
      <ul className="absolute right-3 top-3 flex flex-col gap-1" aria-label="Body areas">
        {systems.map((s) => {
          const Icon = SYSTEM_ICON[s.def.id];
          const on = selected === s.def.id;
          return (
            <li key={s.def.id}>
              <button type="button" onClick={() => toggle(s.def.id)} aria-pressed={on} aria-label={`${s.def.label}: ${STATUS[s.status].label}`} title={`${s.def.label}: ${STATUS[s.status].label}`}
                className={`relative flex h-10 w-10 items-center justify-center rounded-sm border-2 bg-s1 text-text ${on ? 'border-brand' : 'border-line hover:border-line-strong'}`}>
                <Icon size={18} aria-hidden="true" />
                <span className="absolute -right-1 -top-1 h-3 w-3 rounded-full border-2 border-s1" style={{ background: STATUS[s.status].cssVar }} aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>
      <ul className="absolute bottom-3 left-3 flex gap-0.5 rounded border border-line bg-s1 p-0.5" aria-label="Colour key">
        {(['ok', 'watch', 'act', 'nodata'] as const).map((k) => (
          <li key={k}>
            <Pop title={STATUS[k].label} className="flex p-1.5" trigger={<StatusIcon status={k} size={15} />}>
              <p>{STATUS[k].meaning}</p>
              <p className="mt-1 text-text">{STATUS[k].todo}</p>
            </Pop>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => { select(null); setNonce((n) => n + 1); }}
        aria-label="Reset view"
        title="Reset view"
        className="absolute bottom-3 right-3 rounded border border-line bg-s1 p-2 text-muted hover:border-line-strong hover:text-text"
      >
        <RotateCcw size={15} aria-hidden="true" />
      </button>
    </div>
  );
}
