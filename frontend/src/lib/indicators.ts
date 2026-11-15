import type { IndicatorId } from '../data/types';

/** Logical metrics shown in the UI. BP is one metric made of two stored indicators. */
export type MetricId = 'hr' | 'bp' | 'glucose' | 'temp' | 'sleep' | 'mood' | 'exercise';

export interface MetricMeta {
  id: MetricId;
  label: string;
  short: string;
  /** One plain sentence: what this number is. */
  what: string;
  unit: string;
  indicators: IndicatorId[];
  cadenceHours: number;
  cadenceLabel: string;
  howTo: string[];
  decimals: number;
}

export const METRICS: Record<MetricId, MetricMeta> = {
  hr: {
    id: 'hr', label: 'Resting heart rate', short: 'Heart rate', what: 'How many times your heart beats in a minute while you rest.', unit: 'bpm', indicators: ['hr'], cadenceHours: 48, cadenceLabel: 'every 48 h', decimals: 0,
    howTo: ['Rest quietly for 5 minutes first.', 'Read the number from your wrist sensor, or count your pulse for 30 seconds and double it.', 'Do it before coffee or exercise.'],
  },
  bp: {
    id: 'bp', label: 'Blood pressure', short: 'Blood pressure', what: 'How hard blood pushes on your arteries. Written as top number / bottom number.', unit: 'mmHg', indicators: ['bp_sys', 'bp_dia'], cadenceHours: 48, cadenceLabel: 'every 48 h', decimals: 0,
    howTo: ['Rest for 5 minutes, strapped in or seated, arm at heart level.', 'Put the cuff on your bare upper arm. Don’t talk while it measures.', 'Measure twice, 1 minute apart, and enter the second one.'],
  },
  glucose: {
    id: 'glucose', label: 'Blood sugar', short: 'Blood sugar', what: 'How much sugar (glucose) is in your blood before breakfast.', unit: 'mg/dL', indicators: ['glucose'], cadenceHours: 48, cadenceLabel: 'every 48 h', decimals: 0,
    howTo: ['Measure before your first meal of the day.', 'Clean and dry your fingertip, then use the meter as trained.', 'Enter the number exactly as the meter shows it.'],
  },
  temp: {
    id: 'temp', label: 'Body temperature', short: 'Temperature', what: 'How warm your body is. A rise can be the first sign of an infection.', unit: '°C', indicators: ['temp'], cadenceHours: 48, cadenceLabel: 'every 48 h', decimals: 1,
    howTo: ['Measure at the same time each day, before exercise.', 'Use the same thermometer in the same spot each time.', 'Your body runs warmer in space, so ASTRA compares you with your own usual, not a textbook number.'],
  },
  sleep: {
    id: 'sleep', label: 'Sleep', short: 'Sleep', what: 'How many hours you slept in your last sleep period.', unit: 'h', indicators: ['sleep'], cadenceHours: 36, cadenceLabel: 'every 36 h', decimals: 1,
    howTo: ['Enter the total hours you slept last time.', 'Use your sleep tracker if you wear one, otherwise your best guess.', 'A guess is fine. Honest beats exact.'],
  },
  mood: {
    id: 'mood', label: 'Mood', short: 'Mood', what: 'How you feel right now, from 1 (very low) to 5 (very good).', unit: '/5', indicators: ['mood'], cadenceHours: 36, cadenceLabel: 'every 36 h', decimals: 0,
    howTo: ['1 = very low, 3 = steady, 5 = very good.', 'Rate how you feel right now, not how you think you should feel.', 'This is private to you and the flight surgeon.'],
  },
  exercise: {
    id: 'exercise', label: 'Exercise done', short: 'Exercise', what: 'How much of your planned exercise you did in the last 7 days.', unit: '%', indicators: ['exercise_min'], cadenceHours: 24 * 7, cadenceLabel: '7-day window', decimals: 0,
    howTo: ['Enter the minutes of your planned workout that you finished.', 'ASTRA adds up the last 7 days and compares it with your plan.', 'Doing more than planned does not earn extra.'],
  },
};

export const INDICATOR_UNIT: Record<IndicatorId, string> = {
  hr: 'bpm', bp_sys: 'mmHg', bp_dia: 'mmHg', glucose: 'mg/dL', temp: '°C', sleep: 'h', mood: '/5', exercise_min: 'min', rad_dose: 'mSv',
};

export const METRIC_ORDER: MetricId[] = ['hr', 'bp', 'sleep', 'glucose', 'temp', 'mood', 'exercise'];
/** Daily check-in items: each one logged fills a fifth of today's orbit. */
export const CHECKIN_ITEMS: MetricId[] = ['hr', 'bp', 'sleep', 'mood', 'temp'];
