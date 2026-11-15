import { useId, useRef, useState, type ReactNode } from 'react';

/** Plain-language definitions for every word on screen that a non-doctor might not know. */
export const GLOSSARY = {
  baseline: 'Your usual: the middle of your own readings before launch. ASTRA compares you with yourself, not with a textbook.',
  flightSurgeon: 'The crew doctor on the ground who looks after the astronauts’ health.',
  bpm: 'Beats per minute: how many times your heart beats in one minute.',
  mmHg: 'Millimetres of mercury, the unit for blood pressure. Written as top number / bottom number.',
  mgdl: 'Milligrams per decilitre, the unit for blood sugar.',
  delay: 'How long a message takes to reach Earth. Radio travels at light speed, but Mars is far, so it can take 4 to 24 minutes one way.',
  met: 'Mission time: days, hours and minutes since launch.',
  utc: 'Coordinated Universal Time. Space stations use it so everyone shares one clock.',
  provenance: 'Where a number came from. YOU = you typed it now. IMPORTED = from another system. SIMULATED = made-up demo data.',
  xp: 'Points for good habits: logging, following steps, being honest. Never for whether a number is good or bad.',
  orbit: 'Today’s 5 check-in numbers. Log all 5 and the ring closes: one orbit complete.',
  loop: 'Prevent = stay healthy with daily check-ins. Respond = something is off, follow 3 steps. Recover = follow-up checks until you are back to your usual.',
  radiation: 'Total radiation dose on this mission. Shown for context only; ASTRA does not judge it.',
} as const;
export type TermKey = keyof typeof GLOSSARY;

/** A word with a dotted underline that explains itself on hover or keyboard focus.
 *  The tip is position: fixed so scrolling panels never clip it. */
export function Term({ k, children, className = '' }: { k: TermKey; children: ReactNode; className?: string }) {
  const id = useId();
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number; up: boolean } | null>(null);
  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const x = Math.min(Math.max(r.left + r.width / 2, 136), window.innerWidth - 136);
    const up = r.bottom + 120 > window.innerHeight;
    setPos({ x, y: up ? r.top - 6 : r.bottom + 6, up });
  };
  const hide = () => setPos(null);
  return (
    <span
      ref={ref}
      className={`inline cursor-help underline decoration-dotted decoration-1 underline-offset-[3px] focus-visible:rounded focus-visible:outline focus-visible:outline-1 focus-visible:outline-brand ${className}`}
      tabIndex={0}
      aria-describedby={id}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onClick={(e) => { e.stopPropagation(); if (pos) hide(); else show(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') hide(); }}
    >
      {children}
      <span
        id={id}
        role="tooltip"
        className={pos ? 'pointer-events-none fixed z-[60] w-64 rounded border border-line-strong bg-s2 p-2 text-left font-sans text-xs font-normal normal-case leading-[17px] tracking-normal text-text no-underline shadow-xl' : 'sr-only'}
        style={pos ? { left: pos.x, top: pos.y, transform: `translate(-50%, ${pos.up ? '-100%' : '0'})` } : undefined}
      >
        {GLOSSARY[k]}
      </span>
    </span>
  );
}
