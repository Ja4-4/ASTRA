import { Sun, Moon, ChevronDown, CircleHelp, MapPin, CalendarDays, RadioTower, Satellite, FlaskConical, type LucideIcon } from 'lucide-react';
import { GLOSSARY } from './Term';
import { Pop } from './Pop';
import { Logo } from './Logo';
import { LoopStepper } from './LoopStepper';
import { OrbitChip } from './OrbitChip';
import { useAstra } from '../store/useAstra';
import { useDerived } from '../store/derived';
import { MISSION_SETTINGS, MISSION_BY_ID, type MissionSettingId } from '../lib/mission';
import { missionDay } from '../lib/time';

function Readout({ icon: Icon, title, value, children, className = '' }: { icon: LucideIcon; title: string; value: string; children: React.ReactNode; className?: string }) {
  return (
    <Pop title={title} className={`flex shrink-0 items-center gap-1.5 px-1.5 py-1 ${className}`} trigger={<><Icon size={14} className="text-muted" aria-hidden="true" /><span className="tlm-value">{value}</span></>}>
      {children}
    </Pop>
  );
}

export function Header() {
  const { now, stage, orbitDone } = useDerived();
  const mission = useAstra((s) => s.mission);
  const setMission = useAstra((s) => s.setMission);
  const theme = useAstra((s) => s.theme);
  const setTheme = useAstra((s) => s.setTheme);
  const openGuide = useAstra((s) => s.openGuide);
  const m = MISSION_BY_ID[mission];
  const live = m.delaySec < 60;
  return (
    <header className="relative z-20 border-b border-line bg-s1">
      <div className="flex flex-wrap items-center gap-x-4 px-3 sm:flex-nowrap sm:px-4">
        <div className="py-2 pr-1"><Logo /></div>
        <div className="hidden h-10 w-px bg-line sm:block" aria-hidden="true" />

        {/* Telemetry strip: own row on phones */}
        <div className="order-last -mx-3 flex w-[calc(100%+1.5rem)] min-w-0 items-center gap-x-5 overflow-x-auto border-t border-line px-3 py-1.5 sm:order-none sm:mx-0 sm:w-auto sm:flex-1 sm:border-t-0 sm:px-0 sm:py-2" aria-label="Mission clock and link">
          <span className="relative flex shrink-0 items-center gap-1.5 rounded border border-transparent px-1.5 py-1 hover:border-line focus-within:border-brand" title="Where: mission setting">
            <MapPin size={14} className="text-muted" aria-hidden="true" />
            <span className="tlm-value" aria-hidden="true">{m.label}</span>
            <ChevronDown size={12} aria-hidden="true" className="text-muted" />
            <select
              aria-label="Mission setting"
              value={mission}
              onChange={(e) => setMission(e.target.value as MissionSettingId)}
              className="absolute inset-0 w-full cursor-pointer opacity-0"
            >
              {MISSION_SETTINGS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </span>
          <Readout icon={CalendarDays} title={m.dayLabel(missionDay(now))} value={m.dayLabel(missionDay(now)).replace(/^(Mission |Transit )/, '')}>
            Days since launch on this mission.
          </Readout>
          <Readout icon={live ? RadioTower : Satellite} title={`Messages to Earth take ${m.owlt}`} value={`To Earth ${m.owlt.replace(/^under /, '<')}`}>
            {GLOSSARY.delay}
            <span className="mt-1 block text-text">{live ? 'Near real-time link to Earth.' : 'Delayed link: you act first, the doctor answers later.'}</span>
          </Readout>
        </div>

        <div className="hidden lg:block"><LoopStepper stage={stage} /></div>
        <button
          type="button"
          onClick={openGuide}
          title="Guide"
          className="ml-auto flex shrink-0 items-center rounded border border-line p-1.5 text-muted sm:ml-0 hover:border-line-strong hover:text-text"
        >
          <CircleHelp size={15} aria-hidden="true" /><span className="sr-only">Open the quick guide</span>
        </button>
        <button
          type="button"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          className="shrink-0 rounded border border-line p-1.5 text-muted hover:border-line-strong hover:text-text"
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
        >
          {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
        </button>
      </div>
      <div className="demo-strip flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-line py-1.5 pl-3 pr-3 sm:pl-4 sm:pr-4">
        <p className="flex items-center gap-1.5 text-[13px] text-muted" role="note">
          <FlaskConical size={13} aria-hidden="true" />Pretend data for a demo. Not real medical advice.
        </p>
        <div className="flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-1.5 lg:ml-auto lg:w-auto">
          <div className="lg:hidden"><LoopStepper stage={stage} /></div>
          <OrbitChip done={orbitDone.length} />
        </div>
      </div>
    </header>
  );
}
