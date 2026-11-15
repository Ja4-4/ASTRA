import type { ReactNode } from 'react';

/** Single-row console page header, so the content gets the screen height. */
export function PageHeader({ title, sub, children }: { code?: string; title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line pb-2.5">
      <div className="mr-auto flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <h1 className="text-xl font-semibold leading-7 tracking-[-0.01em]">{title}</h1>
        {sub && <p className="min-w-0 text-sm text-muted lg:max-w-[72ch]">{sub}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-3">{children}</div>}
    </div>
  );
}
