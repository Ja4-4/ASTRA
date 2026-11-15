import { useEffect } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useAstra } from '../store/useAstra';

const SHOW_MS = 4200;

/** A short full-screen moment for a new rank, a badge, or all missions done. Tap or wait to close. */
export function CelebrationLayer() {
  const c = useAstra((s) => s.celebration);
  const dismiss = useAstra((s) => s.dismissCelebration);
  const reduce = !!useReducedMotion();
  useEffect(() => {
    if (!c) return;
    const t = window.setTimeout(dismiss, SHOW_MS);
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') dismiss(); };
    document.addEventListener('keydown', esc);
    return () => { window.clearTimeout(t); document.removeEventListener('keydown', esc); };
  }, [c, dismiss]);

  return (
    <AnimatePresence>
      {c && (
        <motion.div
          key={c.id}
          role="dialog"
          aria-label={c.title}
          className="fixed inset-0 z-[70] flex items-center justify-center bg-[#0B0A10]/75"
          onClick={dismiss}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}
        >
          <motion.div
            className="card relative flex w-[min(420px,calc(100vw-32px))] flex-col items-center gap-3 px-8 py-8 text-center"
            initial={reduce ? false : { scale: 0.85, y: 20 }} animate={{ scale: 1, y: 0 }} transition={{ type: 'spring', stiffness: 260, damping: 20 }}
          >
            {!reduce && <Burst />}
            <Insignia kind={c.kind} animate={!reduce} />
            <p className="text-sm font-bold uppercase tracking-[0.14em] text-brand">{c.kind === 'rank' ? 'Rank up' : c.kind === 'badge' ? 'Badge earned' : 'Daily missions'}</p>
            <h2 className="font-display text-[28px] font-bold leading-[32px]">{c.title}</h2>
            <p className="text-[15px] text-muted">{c.body}</p>
            {c.xp !== undefined && <p className="num text-sm text-muted">{c.xp.toLocaleString('en-US')} points in total</p>}
            <p className="text-xs text-muted">Tap anywhere to close</p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Mission-patch style mark: chevrons for a rank, a star for a badge, three ticks for missions. Lines draw in. */
function Insignia({ kind, animate }: { kind: 'rank' | 'badge' | 'mission'; animate: boolean }) {
  const draw = (delay: number) => (animate ? { initial: { pathLength: 0 }, animate: { pathLength: 1 }, transition: { duration: 0.6, delay } } : {});
  return (
    <svg width="96" height="96" viewBox="0 0 96 96" aria-hidden="true">
      <motion.circle cx="48" cy="48" r="44" fill="var(--surface-2)" stroke="var(--brand)" strokeWidth="3" {...draw(0)} />
      {kind === 'rank' && [30, 44, 58].map((y, i) => (
        <motion.path key={y} d={`M28 ${y + 8} L48 ${y - 4} L68 ${y + 8}`} fill="none" stroke="var(--text)" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" {...draw(0.25 + i * 0.15)} />
      ))}
      {kind === 'badge' && (
        <motion.path d="M48 22 L55 40 L74 41 L59 53 L64 72 L48 61 L32 72 L37 53 L22 41 L41 40 Z" fill="none" stroke="var(--text)" strokeWidth="4" strokeLinejoin="round" {...draw(0.25)} />
      )}
      {kind === 'mission' && [32, 48, 64].map((y, i) => (
        <motion.path key={y} d={`M30 ${y} l6 6 l12 -12`} transform={`translate(${i * 0}, ${-6})`} fill="none" stroke="var(--text)" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" {...draw(0.25 + i * 0.15)} />
      ))}
    </svg>
  );
}

/** Small dots that fly out once: Ultraviolet and Moon White only (status colours are kept for health). */
function Burst() {
  const dots = Array.from({ length: 18 }, (_, i) => {
    const a = (i / 18) * Math.PI * 2;
    return { x: Math.cos(a) * (120 + (i % 3) * 30), y: Math.sin(a) * (90 + (i % 4) * 20), c: i % 2 ? 'var(--brand)' : 'var(--text)' };
  });
  return (
    <div className="pointer-events-none absolute left-1/2 top-16" aria-hidden="true">
      {dots.map((d, i) => (
        <motion.span key={i} className="absolute h-2 w-2 rounded-full" style={{ background: d.c }}
          initial={{ x: 0, y: 0, opacity: 1, scale: 1 }} animate={{ x: d.x, y: d.y, opacity: 0, scale: 0.4 }} transition={{ duration: 1.1, ease: 'easeOut' }} />
      ))}
    </div>
  );
}
