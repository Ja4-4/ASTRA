import { BedDouble, Bone, Brain, Droplet, Dumbbell, Eye, Gauge, HeartPulse, Smile, Thermometer, type LucideIcon } from 'lucide-react';
import type { MetricId } from './indicators';
import type { SystemId } from './systems';

/** One glyph per body area. The glance layer shows these instead of the area's name. */
export const SYSTEM_ICON: Record<SystemId, LucideIcon> = {
  cardio: HeartPulse,
  neuro: Brain,
  metabolic: Droplet,
  immune: Thermometer,
  msk: Bone,
  ocular: Eye,
};

/** One glyph per logged number. Same glyph wherever the number appears. */
export const METRIC_ICON: Record<MetricId, LucideIcon> = {
  hr: HeartPulse,
  bp: Gauge,
  sleep: BedDouble,
  glucose: Droplet,
  temp: Thermometer,
  mood: Smile,
  exercise: Dumbbell,
};

export const SYSTEM_OF_METRIC: Record<MetricId, SystemId> = {
  hr: 'cardio', bp: 'cardio', sleep: 'neuro', mood: 'neuro', glucose: 'metabolic', temp: 'immune', exercise: 'msk',
};
