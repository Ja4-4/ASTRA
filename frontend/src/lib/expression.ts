/**
 * Face expression -> a suggested mood, which the astronaut confirms or changes. Never a diagnosis.
 *
 * Input: MediaPipe's 52 expression scores (0..1 each, "blendshapes"). Each score is reduced to its median over
 * the good frames, then compared with the astronaut's own relaxed face (medians from the "Relax your face"
 * baseline). Only the change from that relaxed face counts, so a naturally serious resting face reads as Relaxed.
 */
type FaceLook = 'Smiling' | 'Smile (mouth only)' | 'Relaxed' | 'Tense' | 'Down' | 'Tired';
type Confidence = 'low' | 'medium' | 'high';
export type Shapes = Record<string, number>;

export interface FaceReading {
  /** null when the face was too hard to read (low confidence). */
  look: FaceLook | null;
  confidence: Confidence;
  /** Plain words: what changed compared with the relaxed face. */
  why: string;
  /** Suggested mood 1..5 for the mood buttons, null when there is no suggestion. */
  mood: number | null;
  /** The 6 scores that moved most from the relaxed face, with plain names, for "Details for the doctor". */
  top: { name: string; plain: string; now: number; usual: number }[];
  frames: number;
  /** Strength of each look as a multiple of its trigger (1 = just reached), for the logs and the debug panel. */
  ratios: Record<string, number>;
}

/**
 * Change from the relaxed face (median now minus relaxed median) at which each movement counts as "clearly up".
 * Defaults for any face; see the scan report for the calibration they were checked against.
 */
export const TRIGGER = {
  /** mouthSmileLeft/Right: mouth corners up. */
  smile: 0.25,
  /** cheekSquintLeft/Right: cheeks raised. Comes with a felt smile (Ekman, Davidson & Friesen 1990, "The Duchenne smile"). */
  cheek: 0.1,
  /** browInnerUp: inner brows raised. Sad-face movements are small on most faces (0.05-0.20). */
  innerBrows: 0.06,
  /** mouthFrownLeft/Right: mouth corners down. */
  frown: 0.06,
  /** mouthShrugLower: chin raised. */
  chin: 0.06,
  /** browDownLeft/Right: brows pulled down. */
  browDown: 0.15,
  /** mouthPressLeft/Right: lips pressed together. */
  press: 0.15,
  /** eyeSquintLeft/Right: eyes narrowed. */
  squint: 0.08,
  /** eyeBlinkLeft/Right: eyelids lower. */
  blink: 0.2,
  /** Share of the scan with the eyes closed, minus 0.10 (normal blinking closes the eyes about a tenth of the time). */
  eyesClosed: 0.2,
};

type Feature = keyof typeof TRIGGER;
const FEATURE_SHAPES: Record<Exclude<Feature, 'eyesClosed'>, string[]> = {
  smile: ['mouthSmileLeft', 'mouthSmileRight'],
  cheek: ['cheekSquintLeft', 'cheekSquintRight'],
  innerBrows: ['browInnerUp'],
  frown: ['mouthFrownLeft', 'mouthFrownRight'],
  chin: ['mouthShrugLower'],
  browDown: ['browDownLeft', 'browDownRight'],
  press: ['mouthPressLeft', 'mouthPressRight'],
  squint: ['eyeSquintLeft', 'eyeSquintRight'],
  blink: ['eyeBlinkLeft', 'eyeBlinkRight'],
};
const SAY: Record<Feature, string> = {
  smile: 'the corners of your mouth were raised',
  cheek: 'your cheeks were raised',
  innerBrows: 'your inner brows were raised',
  frown: 'the corners of your mouth were lower',
  chin: 'your chin was raised',
  browDown: 'your brows were pulled down',
  press: 'your lips were pressed together',
  squint: 'your eyes were narrowed',
  blink: 'your eyelids were lower',
  eyesClosed: 'your eyes were closed more of the time',
};

/** r[f] = change / trigger for each movement (1 = clearly up). */
type Ratios = Record<Feature, number>;
interface Rule {
  look: Exclude<FaceLook, 'Relaxed'>;
  mood: number;
  /** Strength of the look, as a multiple of the trigger; it counts from 1. */
  strength: (r: Ratios) => number;
  /** Movements named in the plain-words "why". */
  shows: Feature[];
}

/** The eye part of a felt smile: cheeks raised or eyes narrowed, whichever moved more. */
const eyeMarker = (r: Ratios) => Math.max(r.cheek, r.squint);
const second = (a: number[]) => [...a].sort((x, y) => y - x)[1];

/** The rule table. Suggested moods: Smiling 5, Relaxed 4, Smile (mouth only) 3, Tired 3, Tense 3, Down 2. */
const FACE_RULES: Rule[] = [
  // Smile with the eyes: mouth corners up AND the eye marker (cheeks raised or eyes narrowed), both must pass.
  // eyeSquint counts too: on the team calibration cheekSquint stayed 0.000 in all 1,305 frames, even at smile 0.43,
  // while eyeSquint rose from 0.10 to 0.15 (the orbicularis oculi narrows the eyes in a felt smile).
  { look: 'Smiling', mood: 5, strength: (r) => Math.min(r.smile, eyeMarker(r)), shows: ['smile', 'cheek', 'squint'] },
  // Mouth-only smile: mouth corners up, no eye marker. Never called "fake" anywhere.
  { look: 'Smile (mouth only)', mood: 3, strength: (r) => (eyeMarker(r) < 1 ? r.smile : 0), shows: ['smile'] },
  // Sad-like: at least 2 of inner brows up, mouth corners down, chin up; no smile. Strength = the weaker of the 2 strongest.
  { look: 'Down', mood: 2, strength: (r) => (r.smile < 0.5 ? second([r.innerBrows, r.frown, r.chin]) : 0), shows: ['innerBrows', 'frown', 'chin'] },
  // Tense: brows down and/or lips pressed, with the eyes narrowed (at least half its trigger); no smile.
  { look: 'Tense', mood: 3, strength: (r) => (r.smile < 0.5 && r.squint >= 0.5 ? Math.max(r.browDown, r.press) : 0), shows: ['browDown', 'press', 'squint'] },
  // Tired: eyes closed more of the time, or eyelids lower.
  { look: 'Tired', mood: 3, strength: (r) => Math.max(r.eyesClosed, r.blink), shows: ['eyesClosed', 'blink'] },
];
const RELAXED_MOOD = 4;

/** Fewer good frames than this (about 3 s at 15 frames a second) and the reading is low confidence. */
const MIN_FRAMES = 45;

const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };

/** Median of every score over the frames. */
export function medianShapes(frames: Shapes[]): Shapes {
  const names = Object.keys(frames[0] ?? {});
  return Object.fromEntries(names.map((n) => [n, median(frames.map((f) => f[n] ?? 0))]));
}

/** Plain name of a blendshape for the doctor's table ("mouthFrownLeft" -> "mouth corner down, left"). */
const PLAIN: Record<string, string> = {
  browInnerUp: 'inner brows raised', browDownLeft: 'brow down, left', browDownRight: 'brow down, right',
  browOuterUpLeft: 'outer brow raised, left', browOuterUpRight: 'outer brow raised, right',
  cheekSquintLeft: 'cheek raised, left', cheekSquintRight: 'cheek raised, right', cheekPuff: 'cheeks puffed',
  mouthSmileLeft: 'mouth corner up, left', mouthSmileRight: 'mouth corner up, right',
  mouthFrownLeft: 'mouth corner down, left', mouthFrownRight: 'mouth corner down, right',
  mouthShrugLower: 'chin raised', mouthShrugUpper: 'upper lip raised',
  mouthPressLeft: 'lips pressed, left', mouthPressRight: 'lips pressed, right',
  eyeSquintLeft: 'eye narrowed, left', eyeSquintRight: 'eye narrowed, right',
  eyeBlinkLeft: 'eyelid lower, left', eyeBlinkRight: 'eyelid lower, right',
  eyeWideLeft: 'eye wide open, left', eyeWideRight: 'eye wide open, right',
  jawOpen: 'mouth open', mouthClose: 'lips closed', mouthPucker: 'lips pushed forward',
  mouthStretchLeft: 'mouth stretched, left', mouthStretchRight: 'mouth stretched, right',
  mouthDimpleLeft: 'dimple, left', mouthDimpleRight: 'dimple, right',
  mouthRollLower: 'lower lip rolled in', mouthRollUpper: 'upper lip rolled in',
  noseSneerLeft: 'nose wrinkled, left', noseSneerRight: 'nose wrinkled, right',
};
export const plainName = (n: string) => PLAIN[n] ?? n.replace(/([A-Z])/g, ' $1').toLowerCase();

/** The `k` scores that moved most from the relaxed face, biggest first. */
export function mostMoved(now: Shapes, usual: Shapes, k: number): FaceReading['top'] {
  return Object.keys(now)
    .filter((n) => n !== '_neutral')
    .map((n) => ({ name: n, plain: plainName(n), now: now[n], usual: usual[n] ?? 0 }))
    .sort((a, b) => Math.abs(b.now - b.usual) - Math.abs(a.now - a.usual))
    .slice(0, k);
}

const conf = (s: number): Confidence => (s >= 2.5 ? 'high' : s >= 1.5 ? 'medium' : 'low');
const r2 = (x: number) => Math.round(x * 100) / 100;

/** The look from medians against the relaxed face, without the frame-count check (also used by the live debug panel). */
export function evaluateFace(now: Shapes, usual: Shapes, eyesClosedPct: number | null): Omit<FaceReading, 'top' | 'frames'> {
  const delta = (f: Feature) => (f === 'eyesClosed'
    ? (eyesClosedPct === null ? 0 : eyesClosedPct / 100 - 0.1)
    : FEATURE_SHAPES[f].reduce((s, n) => s + (now[n] ?? 0) - (usual[n] ?? 0), 0) / FEATURE_SHAPES[f].length);
  const r = Object.fromEntries((Object.keys(TRIGGER) as Feature[]).map((f) => [f, delta(f) / TRIGGER[f]])) as Ratios;
  const ratios: Record<string, number> = {};
  let best: { rule: Rule; s: number } | null = null;
  for (const rule of FACE_RULES) {
    const s = rule.strength(r);
    ratios[rule.look] = r2(s);
    if (!best || s > best.s) best = { rule, s };
  }
  const hard = { look: null, confidence: 'low' as const, why: 'Hard to read your face this time.', mood: null, ratios };
  if (!best || best.s < 1) {
    // Relaxed: nothing clearly up. Sure when everything stayed well under its trigger.
    if (best && best.s >= 0.75) return hard;
    return { look: 'Relaxed', confidence: !best || best.s < 0.5 ? 'high' : 'medium', why: 'your face was close to your relaxed face', mood: RELAXED_MOOD, ratios };
  }
  const c = conf(best.s);
  if (c === 'low') return hard;
  const { rule } = best;
  const said = rule.shows.filter((f) => r[f] >= 1).map((f) => SAY[f]);
  return { look: rule.look, confidence: c, why: `${(said.length ? said : [SAY[rule.shows[0]]]).join(' and ')}, compared with your relaxed face`, mood: rule.mood, ratios };
}

/** Reads the look from the scan's medians against the relaxed face. `eyesClosedPct` is from the eye-openness series. */
export function readFace(now: Shapes, usual: Shapes, frames: number, eyesClosedPct: number | null): FaceReading {
  const top = mostMoved(now, usual, 6);
  if (frames < MIN_FRAMES) return { look: null, confidence: 'low', why: 'Hard to read your face this time.', mood: null, top, frames, ratios: {} };
  return { ...evaluateFace(now, usual, eyesClosedPct), top, frames };
}
