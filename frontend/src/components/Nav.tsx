import { useEffect, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useAstra } from '../store/useAstra';
import { Pop } from './Pop';
import { LayoutDashboard, ClipboardPlus, LineChart, CalendarCheck, Siren, BookOpen, Users, ScanFace, Timer, ArrowDownToLine, Ellipsis, Orbit } from 'lucide-react';

export const NAV = [
  { to: '/', label: 'Home', icon: LayoutDashboard },
  { to: '/log', label: 'Measure', icon: ClipboardPlus },
  { to: '/events', label: 'Alerts', icon: Siren },
  { to: '/scan', label: 'Scan', icon: ScanFace },
  { to: '/tests', label: 'Tests', icon: Timer },
  { to: '/reentry', label: 'Re-entry', icon: ArrowDownToLine },
];

/** Used less often, so they sit behind "More". */
export const MORE_NAV = [
  { to: '/trends', label: 'History', icon: LineChart },
  { to: '/routine', label: 'Plan', icon: CalendarCheck },
  { to: '/evidence', label: 'Learn', icon: BookOpen },
  { to: '/crew', label: 'Progress', icon: Users },
  { to: '/cabin', label: 'Cabin', icon: Orbit },
];

const ITEM = 'group relative flex flex-col items-center gap-1 px-1 py-3 text-[10px] leading-tight transition-colors duration-150 md:py-3';
const ACTIVE = 'bg-brand-soft text-brand before:absolute before:inset-x-3 before:top-0 before:h-0.5 before:bg-brand md:before:inset-x-auto md:before:inset-y-2 md:before:left-0 md:before:h-auto md:before:w-0.5';
const IDLE = 'text-muted hover:bg-s2 hover:text-text';

export function Nav() {
  const openAlerts = useAstra((s) => s.events.filter((e) => e.stage !== 'closed').length);
  return (
    <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-s1 pb-[env(safe-area-inset-bottom)] md:static md:z-auto md:w-[76px] md:shrink-0 md:border-r md:border-t-0 md:pb-0">
      <ul className="flex justify-around md:h-full md:flex-col md:gap-0.5 md:py-2">
        {NAV.map(({ to, label, icon: Icon }) => (
          <li key={to} className="flex-1 md:flex-none">
            <NavLink
              to={to}
              end={to === '/'}
              className={({ isActive }) => `${ITEM} ${isActive ? ACTIVE : IDLE}`}
            >
              <span className="relative">
                <Icon size={22} aria-hidden="true" />
                {to === '/events' && openAlerts > 0 && <span className="num absolute -right-2.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold text-white" style={{ background: 'var(--act)' }} aria-label={`${openAlerts} open`}>{openAlerts}</span>}
              </span>
              <span className="text-center text-[12px] leading-tight">{label}</span>
            </NavLink>
          </li>
        ))}
        <li className="hidden md:mt-auto md:block"><DataChip /></li>
        <li className="flex-1 md:flex-none"><More /></li>
      </ul>
    </nav>
  );
}

const DATA_LINE = {
  live: { label: 'Live data', line: 'Live: reading from the station server.' },
  demo: { label: 'Demo data', line: 'Demo: the station server is off, showing sample data.' },
};

/** Where the numbers come from. Quiet on purpose: one short word, one line on tap. */
function DataChip({ wide = false }: { wide?: boolean }) {
  const d = DATA_LINE[useAstra((s) => s.dataSource)];
  return (
    <Pop title={d.label} className={`${wide ? 'w-full px-3 py-2.5 text-left text-[13px]' : 'mx-auto block px-1 py-1.5 text-center text-[10px] leading-tight'} text-muted hover:text-text`} trigger={d.label}>
      {d.line}
    </Pop>
  );
}

function More() {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  const box = useRef<HTMLDivElement>(null);
  const here = MORE_NAV.some((n) => n.to === pathname);
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <div ref={box} className="relative">
      <button type="button" aria-expanded={open} aria-controls="nav-more" onClick={() => setOpen(!open)} className={`${ITEM} w-full ${here ? ACTIVE : IDLE}`}>
        <Ellipsis size={20} aria-hidden="true" />
        <span className="text-center text-[11px] leading-tight">More</span>
      </button>
      {open && (
        <ul id="nav-more" className="card absolute bottom-full right-0 z-40 mb-1 w-44 py-1 md:bottom-0 md:left-full md:right-auto md:mb-0 md:ml-1">
          <li className="border-b border-line md:hidden"><DataChip wide /></li>
          {MORE_NAV.map(({ to, label, icon: Icon }) => (
            <li key={to}>
              <NavLink to={to} className={({ isActive }) => `flex items-center gap-2.5 px-3 py-2.5 text-[15px] ${isActive ? 'bg-brand-soft text-brand' : 'text-text hover:bg-s2'}`}>
                <Icon size={18} aria-hidden="true" />{label}
              </NavLink>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
