import { ShieldCheck, Radio, RotateCcw } from 'lucide-react';
import type { LoopStage } from '../store/useAstra';
import { Pop } from './Pop';

const STEPS: { id: LoopStage; label: string; icon: typeof ShieldCheck; hint: string }[] = [
  { id: 'prevent', label: 'Stay healthy', icon: ShieldCheck, hint: 'Prevent. Measure and exercise every day to stay healthy.' },
  { id: 'respond', label: 'Fix it now', icon: Radio, hint: 'Respond. A number is red: do the 3 steps.' },
  { id: 'recover', label: 'Getting better', icon: RotateCcw, hint: 'Recover. Check again until you are back to your usual.' },
];

/** Segmented mode annunciator. Brand hues only: never green/orange/red, so a stage is never mistaken for a health status. */
export function LoopStepper({ stage }: { stage: LoopStage }) {
  const at = STEPS.findIndex((s) => s.id === stage);
  return (
    <ol className="flex items-stretch overflow-hidden rounded border border-line" aria-label={`Mode. Current: ${stage}`}>
      {STEPS.map((s, i) => {
        const active = i === at;
        const past = i < at;
        const Icon = s.icon;
        return (
          <li
            key={s.id}
            aria-current={active ? 'step' : undefined}
            className={i > 0 ? 'border-l border-line' : ''}
          >
            <Pop
              title={s.label}
              className={`num flex h-full items-center gap-1.5 rounded-none px-2.5 py-1.5 text-[11px] ${active ? 'font-semibold' : past ? 'text-text' : 'text-muted'}`}
              style={active ? { background: 'var(--brand-soft)', color: 'var(--brand)', boxShadow: 'inset 0 -2px 0 var(--brand)' } : undefined}
              trigger={<><Icon size={13} aria-hidden="true" />{active && s.label}</>}
            >
              {s.hint}
            </Pop>
          </li>
        );
      })}
    </ol>
  );
}
