import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, useReducedMotion } from 'framer-motion';
import { ArrowLeft, ArrowRight, ClipboardPlus, Stethoscope, X, Footprints, Siren, ShieldCheck } from 'lucide-react';
import { useAstra } from '../store/useAstra';
import { STATUS, type StatusKey } from '../lib/status';
import { StatusIcon } from './Status';
import { Logo } from './Logo';

const ORDER: StatusKey[] = ['ok', 'watch', 'act', 'nodata'];

/** First-visit welcome. Three short screens, then straight into the first check-in. Reopen with the ? button. */
export function Guide() {
  const introSeen = useAstra((s) => s.introSeen);
  const guideOpen = useAstra((s) => s.guideOpen);
  const close = useAstra((s) => s.closeGuide);
  const open = guideOpen || !introSeen;
  const [step, setStep] = useState(0);
  const nav = useNavigate();
  const reduce = useReducedMotion();
  const dialog = useRef<HTMLDivElement>(null);
  const primary = useRef<HTMLButtonElement>(null);

  useEffect(() => { if (open) { setStep(0); } }, [open]);
  useEffect(() => { if (open) primary.current?.focus(); }, [open, step]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      if (e.key === 'Tab' && dialog.current) {
        const f = dialog.current.querySelectorAll<HTMLElement>('button, a[href]');
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  if (!open) return null;
  const last = step === 2;
  const finish = (to?: string) => { close(); if (to) nav(to); };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/50">
      <motion.div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="guide-h"
        initial={reduce ? false : { opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2, ease: 'easeOut' }}
        className="card-raised relative flex max-h-[calc(100vh-32px)] w-full max-w-[560px] flex-col overflow-y-auto p-5 sm:p-6"
      >
        <button type="button" onClick={() => close()} aria-label="Close the guide" className="absolute right-3 top-3 rounded p-1 text-muted hover:bg-s2 hover:text-text"><X size={16} /></button>
        <div className="num mb-3 flex items-center gap-2 text-[10.5px] text-muted">
          <span>Quick guide</span>
          <span aria-hidden="true">·</span>
          <span>{step + 1} of 3</span>
          <span className="ml-1 flex gap-1" aria-hidden="true">{[0, 1, 2].map((i) => <span key={i} className={`h-1 w-5 rounded-full ${i <= step ? 'bg-brand' : 'bg-line'}`} />)}</span>
        </div>

        {step === 0 && (
          <div>
            <div className="mb-3"><Logo /></div>
            <h2 id="guide-h" className="text-[26px] font-semibold leading-8 tracking-[-0.01em]">Your health, in plain words</h2>
            <p className="mt-2 text-[15px] leading-6 text-text">ASTRA keeps track of a few simple health numbers while you are in space. It tells you how each one compares with <em>your</em> usual, and what to do next.</p>
            <ul className="mt-4 space-y-2.5 text-sm">
              <li className="flex gap-3"><ClipboardPlus size={18} className="mt-0.5 shrink-0 text-brand" aria-hidden="true" /><span><b className="font-semibold">You log a few numbers</b> once a day: heart rate, blood pressure, temperature, sleep and mood. About 2 minutes.</span></li>
              <li className="flex gap-3"><Footprints size={18} className="mt-0.5 shrink-0 text-brand" aria-hidden="true" /><span><b className="font-semibold">ASTRA tells you the next step.</b> One clear action at a time, always at the top of the home screen.</span></li>
              <li className="flex gap-3"><Stethoscope size={18} className="mt-0.5 shrink-0 text-brand" aria-hidden="true" /><span><b className="font-semibold">It never diagnoses.</b> If something is clearly off, it helps you tell the crew doctor on the ground (the flight surgeon).</span></li>
            </ul>
          </div>
        )}

        {step === 1 && (
          <div>
            <h2 id="guide-h" className="text-[26px] font-semibold leading-8 tracking-[-0.01em]">Four colours. That’s all.</h2>
            <p className="mt-2 text-[15px] leading-6 text-text">Every number and every part of the body shows one of these. The colour always comes with an icon and a word.</p>
            <ul className="mt-4 grid gap-2">
              {ORDER.map((k) => {
                const S = STATUS[k];
                return (
                  <li key={k} className="flex items-start gap-3 rounded border border-line bg-s2 p-2.5" style={{ boxShadow: `inset 3px 0 0 ${S.cssVar}` }}>
                    <span className="mt-0.5"><StatusIcon status={k} size={18} /></span>
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold" style={{ color: k === 'nodata' ? 'var(--nodata-text)' : S.cssVar }}>{S.label}</span>
                      <span className="block text-sm text-text">{S.meaning} <span className="text-muted">{S.todo}</span></span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {step === 2 && (
          <div>
            <h2 id="guide-h" className="text-[26px] font-semibold leading-8 tracking-[-0.01em]">How a day works</h2>
            <ol className="mt-4 space-y-3">
              {[
                { icon: ShieldCheck, t: 'Stay healthy', d: 'Measure your numbers and do your exercise. This is most days.' },
                { icon: Siren, t: 'Fix it now', d: 'If a number turns red, ASTRA shows 3 steps: measure again, say how you feel, send it to the doctor.' },
                { icon: ArrowRight, t: 'Getting better', d: 'A few follow-up checks until you are back to your usual. Then the alert closes.' },
              ].map((x, i) => (
                <li key={x.t} className="flex gap-3">
                  <span className="num flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-brand/60 bg-brand-soft text-xs text-brand">{i + 1}</span>
                  <span className="text-sm"><b className="font-semibold">{x.t}.</b> <span className="text-text">{x.d}</span></span>
                </li>
              ))}
            </ol>
            <p className="mt-4 rounded border border-line bg-s2 p-2.5 text-xs text-muted">Points (XP) reward good habits, like logging and being honest. You never earn more for a “good” number.</p>
          </div>
        )}

        <div className="mt-5 flex flex-wrap items-center gap-2">
          {step > 0 && <button type="button" onClick={() => setStep(step - 1)} className="flex items-center gap-1.5 rounded border border-line px-3 py-2 text-sm text-text hover:border-line-strong"><ArrowLeft size={14} aria-hidden="true" />Back</button>}
          <div className="ml-auto flex flex-wrap gap-2">
            {last ? (
              <>
                <button type="button" onClick={() => finish()} className="rounded border border-line px-3 py-2 text-sm text-text hover:border-line-strong">Look around first</button>
                <button ref={primary} type="button" onClick={() => finish('/log')} className="flex items-center gap-1.5 rounded bg-brand px-4 py-2 text-sm font-semibold text-on-brand btn-cut hover:opacity-90"><ClipboardPlus size={15} aria-hidden="true" />Start measuring</button>
              </>
            ) : (
              <>
                <button type="button" onClick={() => finish()} className="rounded px-3 py-2 text-sm text-muted hover:text-text">Skip</button>
                <button ref={primary} type="button" onClick={() => setStep(step + 1)} className="flex items-center gap-1.5 rounded bg-brand px-4 py-2 text-sm font-semibold text-on-brand btn-cut hover:opacity-90">Next<ArrowRight size={14} aria-hidden="true" /></button>
              </>
            )}
          </div>
        </div>
      </motion.div>
    </div>
  );
}
