import type { ReactNode } from 'react';
import { STATUS, type StatusKey } from '../lib/status';

/** The top of every screen: how am I (status + one line), why (one sentence with a number), what now (one primary action). */
export function Answer({ status, title, why, action, aside }: {
  status: StatusKey;
  title: string;
  why: string;
  /** The single primary action: a button or a link styled with .btn-cut by the caller. */
  action: ReactNode;
  /** Optional quiet line next to the action. */
  aside?: ReactNode;
}) {
  const S = STATUS[status];
  return (
    <section className="card p-5" aria-live="polite" style={{ boxShadow: `inset 6px 0 0 ${S.cssVar}` }}>
      <div className="flex items-start gap-4 pl-1">
        <S.icon size={40} strokeWidth={2.2} className="mt-0.5 shrink-0" style={{ color: S.cssVar }} aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-sm font-bold" style={{ color: status === 'nodata' ? 'var(--nodata-text)' : S.cssVar }}>{S.label}</p>
          <h2 className="font-display text-[28px] font-bold leading-[32px]">{title}</h2>
          <p className="mt-1.5 text-[17px] leading-6 text-text">{why}</p>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 pl-1">
        {action}
        {aside && <span className="text-[15px] text-muted">{aside}</span>}
      </div>
    </section>
  );
}

export const PRIMARY = 'btn-cut inline-flex items-center justify-center gap-2 rounded-sm bg-brand px-5 py-3 text-[17px] font-bold text-on-brand hover:opacity-90 disabled:opacity-50';
export const SECONDARY = 'inline-flex items-center gap-2 rounded-sm border border-line-strong px-4 py-2.5 text-[15px] font-bold text-text hover:border-brand';

/** Every demo shell says so, visibly. */
export function DemoChip() {
  return <span className="num rounded-sm border border-line px-2 py-0.5 text-xs text-muted">DEMO · simulated</span>;
}
