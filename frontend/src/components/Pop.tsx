import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

const OPEN_EVENT = 'astra-pop-open';
const W = 288;

/**
 * Click-for-details. The trigger shows an icon (and maybe a number); the words live in the card
 * that opens under it. One card open at a time. Closes on Escape, outside click or scroll.
 */
export function Pop({
  title,
  trigger,
  children,
  className = '',
  style,
}: {
  /** Heading inside the card. Also the trigger's accessible name. */
  title: string;
  trigger: ReactNode;
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  const id = useId();
  const btn = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number; up: boolean } | null>(null);

  const place = () => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const x = Math.min(Math.max(r.left + r.width / 2, W / 2 + 8), window.innerWidth - W / 2 - 8);
    const up = r.bottom + 220 > window.innerHeight;
    setPos({ x, y: up ? r.top - 8 : r.bottom + 8, up });
  };
  const close = () => setPos(null);

  useEffect(() => {
    const other = (e: Event) => { if ((e as CustomEvent<string>).detail !== id) close(); };
    window.addEventListener(OPEN_EVENT, other);
    return () => window.removeEventListener(OPEN_EVENT, other);
  }, [id]);

  useLayoutEffect(() => {
    if (!pos) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!card.current?.contains(t) && !btn.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { close(); btn.current?.focus(); } };
    const onScroll = (e: Event) => { if (!card.current?.contains(e.target as Node)) close(); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', close);
    };
  }, [pos]);

  return (
    <>
      <button
        ref={btn}
        type="button"
        aria-label={title}
        aria-expanded={!!pos}
        aria-controls={id}
        title={title}
        onClick={() => {
          if (pos) return close();
          window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: id }));
          place();
        }}
        className={`rounded transition-colors duration-150 hover:bg-s2 aria-expanded:bg-brand-soft ${className}`}
        style={style}
      >
        {trigger}
      </button>
      {pos && (
        <div
          ref={card}
          id={id}
          role="dialog"
          aria-label={title}
          className="pop-card fixed z-[60] rounded-card border border-line-strong bg-s2 p-3 text-left text-sm normal-case leading-5 tracking-normal text-text shadow-2xl"
          style={{ width: W, left: pos.x, top: pos.y, transform: `translate(-50%, ${pos.up ? '-100%' : '0'})` }}
        >
          <p className="mb-1 font-sans text-[13px] font-semibold">{title}</p>
          <div className="font-sans text-[13px] leading-[18px] text-muted">{children}</div>
        </div>
      )}
    </>
  );
}
