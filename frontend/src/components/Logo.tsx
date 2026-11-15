/** ASTRA wordmark: Chakra Petch, with the Ultraviolet marker (right end cut at 45°) under the letters. */
export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex select-none items-end gap-2.5" aria-label="ASTRA by FALAK">
      <div className="flex flex-col">
        <span className="font-display text-[22px] font-bold leading-none tracking-[0.04em] text-text">ASTRA</span>
        <span aria-hidden="true" className="mt-1 h-[3px] w-full bg-brand" style={{ clipPath: 'polygon(0 0, 100% 0, calc(100% - 3px) 100%, 0 100%)' }} />
      </div>
      {!compact && <span className="mb-[1px] text-[11px] leading-none text-muted">by FALAK <span lang="ar" className="font-arabic font-bold">فلك</span></span>}
    </div>
  );
}
