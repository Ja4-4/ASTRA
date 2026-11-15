import type { MetricId } from './indicators';

/** Today’s planned measurements (UTC) and approved exercise. Shared by Today’s plan and the home screen. */
export const MEASURES: { time: string; metric: MetricId; label: string }[] = [
  { time: '06:30', metric: 'sleep', label: 'Log last night’s sleep' },
  { time: '07:30', metric: 'hr', label: 'Resting heart rate' },
  { time: '07:35', metric: 'temp', label: 'Body temperature' },
  { time: '07:40', metric: 'bp', label: 'Blood pressure, rested' },
  { time: '08:00', metric: 'glucose', label: 'Blood sugar, before breakfast' },
  { time: '21:00', metric: 'mood', label: 'Mood' },
];
export const ACTIVITIES = [
  { id: 'ared', time: '10:30', label: 'Weight training', device: 'ARED machine', minutes: 60, note: 'Keeps bones and muscles strong without gravity.' },
  { id: 'cevis', time: '16:00', label: 'Exercise bike', device: 'CEVIS', minutes: 30, note: 'Keeps the heart and lungs fit.' },
];
