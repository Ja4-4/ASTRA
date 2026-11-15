import { STATUS, type StatusKey } from '../lib/status';

export function StatusIcon({ status, size = 16, pulse = false }: { status: StatusKey; size?: number; pulse?: boolean }) {
  const S = STATUS[status];
  const Icon = S.icon;
  return <Icon aria-hidden="true" size={size} strokeWidth={2} style={{ color: S.cssVar }} className={pulse && status === 'act' ? 'pulse-act' : undefined} />;
}

/** Colour + shape + text, always together. */
export function StatusPill({ status, small = false }: { status: StatusKey; small?: boolean }) {
  const S = STATUS[status];
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border font-medium ${small ? 'px-1.5 py-0 text-[11px]' : 'px-2 py-0.5 text-xs'}`}
      style={{ borderColor: `color-mix(in srgb, ${S.cssVar} 45%, transparent)`, color: status === 'nodata' ? 'var(--nodata-text)' : S.cssVar, background: `color-mix(in srgb, ${S.cssVar} 6%, transparent)` }}
    >
      <StatusIcon status={status} size={small ? 12 : 14} />
      {S.label}
    </span>
  );
}
