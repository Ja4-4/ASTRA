import { STATUS } from '../lib/status';
import type { SystemId, SystemState } from '../lib/systems';

/** 2D front-view fallback with the same regions and colours as the 3D body. Never a blank canvas. */
export function BodyMap2D({ systems, selected, onSelect, reason }: { systems: SystemState[]; selected: SystemId | null; onSelect: (s: SystemId) => void; reason?: string }) {
  const st = Object.fromEntries(systems.map((s) => [s.def.id, s])) as Record<SystemId, SystemState>;
  const fill = (id: SystemId) => STATUS[st[id].status].cssVar;
  const op = (id: SystemId) => (selected && selected !== id ? 0.25 : 0.9);
  const region = (id: SystemId, el: JSX.Element) => (
    <g
      role="button"
      tabIndex={-1}
      aria-label={`${st[id].def.label}: ${STATUS[st[id].status].label}`}
      onClick={() => onSelect(id)}
      style={{ cursor: 'pointer', opacity: op(id) }}
    >
      {el}
    </g>
  );
  return (
    <div className="relative flex h-full w-full flex-col items-center justify-center">
      <svg viewBox="0 0 200 420" className="h-full max-h-[560px] w-auto" aria-hidden="false" role="group" aria-label="2D body map">
        {/* silhouette, tinted by Thermo/Immune */}
        <g fill="none" stroke={fill('immune')} strokeOpacity="0.55" strokeWidth="1.5">
          <ellipse cx="100" cy="40" rx="24" ry="30" />
          <path d="M88 68 L86 82 L52 92 L40 110 L30 210 L38 212 L54 120 L62 118 L64 220 L70 300 L74 400 L94 400 L96 300 L100 240 L104 300 L106 400 L126 400 L130 300 L136 220 L138 118 L146 120 L162 212 L170 210 L160 110 L148 92 L114 82 L112 68" />
        </g>
        {region('neuro', <ellipse cx="100" cy="34" rx="18" ry="16" fill={fill('neuro')} />)}
        {region('ocular', <g fill={fill('ocular')}><circle cx="92" cy="50" r="3" /><circle cx="108" cy="50" r="3" /></g>)}
        {region('immune', <ellipse cx="100" cy="100" rx="7" ry="5" fill={fill('immune')} />)}
        {region('cardio', <g fill={fill('cardio')}><path d="M100 140 C 92 124, 76 128, 82 144 C 86 154, 100 162, 104 166 C 110 160, 122 150, 120 140 C 120 128, 106 126, 100 140 Z" /><rect x="102" y="110" width="4" height="120" rx="2" /></g>)}
        {region('metabolic', <path d="M70 172 C 80 162, 112 164, 116 176 C 112 190, 84 192, 70 184 Z" fill={fill('metabolic')} />)}
        {region('msk', <g fill={fill('msk')}><rect x="98" y="100" width="4" height="130" rx="2" /><path d="M72 226 L128 226 L120 250 L80 250 Z" /><rect x="76" y="252" width="8" height="70" rx="3" /><rect x="116" y="252" width="8" height="70" rx="3" /><rect x="78" y="326" width="7" height="66" rx="3" /><rect x="115" y="326" width="7" height="66" rx="3" /></g>)}
      </svg>
      <p className="num mt-2 text-[11px] text-muted">2D view{reason ? ` · ${reason}` : ''}</p>
    </div>
  );
}
