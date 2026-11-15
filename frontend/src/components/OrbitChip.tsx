import { Flame, Star } from 'lucide-react';
import { motion, useReducedMotion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { useAstra } from '../store/useAstra';
import { rankFor } from '../lib/gamification';
import { CHECKIN_ITEMS } from '../lib/indicators';

export function OrbitChip({ done }: { done: number }) {
  const xp = useAstra((s) => s.xp);
  const streak = useAstra((s) => s.streak);
  const reduce = useReducedMotion();
  const total = CHECKIN_ITEMS.length;
  const r = 13, c = 2 * Math.PI * r;
  const { rank } = rankFor(xp);
  return (
    <Link to="/crew" title="Check-in, points and streak" className="flex items-center gap-2 rounded border border-line bg-s1 py-0.5 pl-0.5 pr-2.5 hover:border-line-strong" aria-label={`Orbit ${done}/${total} ${xp} XP ${streak}d streak. Rank ${rank.title}. Open Mission and Crew.`}>
      <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
        <circle cx="16" cy="16" r={r} fill="none" stroke="var(--line)" strokeWidth="3" />
        <motion.circle
          cx="16" cy="16" r={r} fill="none" stroke="var(--brand)" strokeWidth="3" strokeLinecap="round"
          strokeDasharray={c} transform="rotate(-90 16 16)"
          initial={false} animate={{ strokeDashoffset: c * (1 - done / total) }} transition={{ duration: reduce ? 0 : 0.6, ease: 'easeOut' }}
        />
        <circle cx="16" cy="16" r="3" fill="var(--starlight)" />
      </svg>
      <span className="flex items-center gap-1 text-xs text-muted"><Star size={12} aria-hidden="true" /><span className="num">{xp.toLocaleString('en-US')}</span> points</span>
      <span className="hidden items-center gap-1 text-xs text-muted sm:flex"><Flame size={12} aria-hidden="true" /><span><span className="num">{streak}</span>-day streak</span></span>
    </Link>
  );
}
