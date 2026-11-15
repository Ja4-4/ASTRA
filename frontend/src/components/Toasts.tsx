import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { X, Sparkles, Info, Award } from 'lucide-react';
import { useAstra } from '../store/useAstra';
import { StatusIcon } from './Status';

export function Toasts() {
  const toasts = useAstra((s) => s.toasts);
  const dismiss = useAstra((s) => s.dismissToast);
  const reduce = useReducedMotion();
  return (
    <div className="pointer-events-none fixed right-4 top-2 z-50 flex w-[min(380px,calc(100vw-32px))] flex-col gap-2 md:bottom-24 md:top-auto" aria-live="polite" role="status">
      <AnimatePresence initial={false}>
        {toasts.map((t, i) => (
          <motion.div
            key={t.id}
            layout={!reduce}
            initial={reduce ? false : { opacity: 0, y: -12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -12 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className={`card-raised pointer-events-auto relative gap-3 p-3 shadow-lg ${i < toasts.length - 1 ? 'hidden md:flex' : 'flex'}`}
          >
            {t.kind === 'xp' && !reduce && <OrbitBurst />}
            <div className="mt-0.5">
              {t.kind === 'xp' && <Sparkles size={18} style={{ color: 'var(--brand)' }} aria-hidden="true" />}
              {t.kind === 'badge' && <Award size={18} style={{ color: 'var(--brand)' }} aria-hidden="true" />}
              {t.kind === 'info' && <Info size={18} className="text-muted" aria-hidden="true" />}
              {t.kind === 'alert' && <StatusIcon status={t.title.startsWith('Act') ? 'act' : 'watch'} size={18} />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="num text-sm font-semibold text-text">{t.title}</div>
              {t.body && <div className="mt-0.5 text-xs text-muted">{t.body}</div>}
            </div>
            <button onClick={() => dismiss(t.id)} aria-label="Dismiss notification" className="self-start text-muted hover:text-text"><X size={14} /></button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

function OrbitBurst() {
  return (
    <motion.svg className="pointer-events-none absolute -left-3 -top-3" width="44" height="44" viewBox="0 0 44 44" aria-hidden="true" initial={{ opacity: 0.9, scale: 0.4, rotate: 0 }} animate={{ opacity: 0, scale: 1.6, rotate: 90 }} transition={{ duration: 0.9, ease: 'easeOut' }}>
      <ellipse cx="22" cy="22" rx="18" ry="8" fill="none" stroke="var(--brand)" strokeWidth="1.5" transform="rotate(-20 22 22)" />
      <circle cx="22" cy="22" r="3" fill="var(--starlight)" />
    </motion.svg>
  );
}
