export type MissionSettingId = 'iss' | 'gateway' | 'mars_transit' | 'mars_surface';

export interface MissionSetting {
  id: MissionSettingId;
  label: string;
  /** One-way comms delay in seconds for the demo. */
  delaySec: number;
  delayLabel: string;
  /** Short one-way light time for the header readout. */
  owlt: string;
  /** Vehicle code shown in the header. */
  code: string;
  dayLabel: (missionDay: number) => string;
  /** Muted backdrop tint for the 3D scene; never a status hue at full saturation. */
  sky: string;
  planet: string;
}

export const MISSION_SETTINGS: MissionSetting[] = [
  { id: 'iss', label: 'ISS', delaySec: 0, delayLabel: 'live link (~0 s)', owlt: 'under 1 s', code: 'ISS', dayLabel: (d) => `Mission Day ${d}`, sky: '#0B0A10', planet: '#2F5D9A' },
  { id: 'gateway', label: 'Lunar Gateway', delaySec: 1.3, delayLabel: '~1.3 s one-way', owlt: '1.3 s', code: 'GWY', dayLabel: (d) => `Mission Day ${d}`, sky: '#0B0A10', planet: '#7D8597' },
  { id: 'mars_transit', label: 'Mars Transit', delaySec: 14 * 60, delayLabel: '~14 min one-way (range 4–24 min)', owlt: '~14 min', code: 'MTV', dayLabel: (d) => `Transit Day ${d}`, sky: '#0B0A10', planet: '#8A6F63' },
  { id: 'mars_surface', label: 'Mars Surface Habitat', delaySec: 14 * 60, delayLabel: '~14 min one-way (range 4–24 min)', owlt: '~14 min', code: 'MSH', dayLabel: (d) => `Sol ${Math.floor((d * 86400) / 88775)}`, sky: '#0B0A10', planet: '#8A6F63' },
];
export const MISSION_BY_ID = Object.fromEntries(MISSION_SETTINGS.map((m) => [m.id, m])) as Record<MissionSettingId, MissionSetting>;

export function deliversIn(delaySec: number): string {
  if (delaySec < 1) return 'Message reaches Earth right away';
  if (delaySec < 60) return `Message reaches Earth in about ${delaySec.toFixed(1)} seconds`;
  return `Message reaches Earth in about ${Math.round(delaySec / 60)} minutes`;
}
