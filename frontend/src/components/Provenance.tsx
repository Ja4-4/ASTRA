import type { Provenance } from '../data/types';

const STYLE: Record<Provenance, { label: string; title: string }> = {
  real: { label: 'YOU', title: 'You typed this in, in this session' },
  imported: { label: 'IMPORTED', title: 'Brought in from another system' },
  simulated: { label: 'SIMULATED', title: 'Made-up demo data, not a real measurement' },
};

export function ProvenanceBadge({ p }: { p: Provenance }) {
  const s = STYLE[p];
  return (
    <span title={s.title} className="num inline-flex items-center rounded border border-line px-1 text-[10px] leading-4 tracking-wider text-muted" style={p === 'real' ? { color: 'var(--brand)', borderColor: 'var(--brand)' } : undefined}>
      {s.label}
    </span>
  );
}
