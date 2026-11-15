/**
 * Face tracking for the camera scan: MediaPipe Tasks Vision FaceLandmarker (Apache-2.0). Per frame it gives
 * 478 points (the 468 face points of the classic face mesh in the same order, plus 10 iris points),
 * 52 expression scores and the head pose. This file is the only place that talks to MediaPipe.
 *
 * Offline: the WASM runtime is served from public/mediapipe/tasks-vision/wasm (copied from node_modules by
 * scripts/copy-mediapipe.mjs) and the model from public/models/face_landmarker.task. Nothing is fetched
 * from the internet. The library itself is imported on demand, so pages without the scan never load it.
 */
import { isSkin } from './rppg';

export interface Pt { x: number; y: number; z: number }
interface Pose { yaw: number; pitch: number; roll: number }
interface FaceFrame {
  pts: Pt[];
  /** Expression scores 0..1 by MediaPipe name (mouthSmileLeft, browInnerUp, ...). Left/Right are the person's own sides. */
  shapes: Record<string, number>;
  /** Degrees. 0, 0, 0 is looking straight into the camera. */
  pose: Pose | null;
}
export interface FaceTracker {
  delegate: 'GPU' | 'CPU';
  /** Face oval point indices in order around the face, for drawing the outline. */
  oval: number[];
  /** Call once per new video frame, with a time in ms that always increases. */
  detect: (video: HTMLVideoElement, t: number) => FaceFrame | null;
  /** Debug view only: draws every point and the full mesh. `pts` are already mapped to the canvas (0..1 of its size). */
  drawPoints: (ctx: CanvasRenderingContext2D, pts: Pt[]) => void;
  close: () => void;
}

const WASM = `${import.meta.env.BASE_URL}mediapipe/tasks-vision/wasm`;
const MODEL = `${import.meta.env.BASE_URL}models/face_landmarker.task`;

/**
 * Rotation from the 4x4 face transform, as yaw, pitch, roll in degrees. The translation (the face is 30-60 cm
 * from the camera) tells the layout: in column-major order it sits at 12..14, in row-major at 3, 7, 11.
 */
function poseFrom(d: number[]): Pose {
  const colMajor = Math.abs(d[14]) > Math.abs(d[11]);
  const at = (r: number, c: number) => (colMajor ? d[c * 4 + r] : d[r * 4 + c]);
  const deg = 180 / Math.PI;
  return {
    yaw: Math.atan2(-at(2, 0), Math.hypot(at(2, 1), at(2, 2))) * deg,
    pitch: Math.atan2(at(2, 1), at(2, 2)) * deg,
    roll: Math.atan2(at(1, 0), at(0, 0)) * deg,
  };
}

/** Connection pairs that form one closed loop -> point indices in order. */
function ring(pairs: { start: number; end: number }[]): number[] {
  const next = new Map(pairs.map((p) => [p.start, p.end]));
  const out = [pairs[0].start];
  for (let k = next.get(out[0]); k !== undefined && k !== out[0] && out.length <= pairs.length; k = next.get(k)) out.push(k);
  return out;
}

/** Loads the model on the GPU, or on the CPU if the GPU path fails (at start or on a frame). */
export async function createFaceTracker(): Promise<FaceTracker> {
  const t0 = performance.now();
  const { FaceLandmarker, FilesetResolver, DrawingUtils } = await import('@mediapipe/tasks-vision');
  const fileset = await FilesetResolver.forVisionTasks(WASM);
  const make = (delegate: 'GPU' | 'CPU') => FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL, delegate },
    runningMode: 'VIDEO',
    numFaces: 1,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
  });
  const forceCpu = new URLSearchParams(window.location.search).has('cpu');
  let delegate: 'GPU' | 'CPU' = forceCpu ? 'CPU' : 'GPU';
  let lm = await make(delegate).catch((err: unknown) => {
    console.info('[scan] GPU face model failed, using the CPU', err);
    delegate = 'CPU';
    return make('CPU');
  });
  console.info(`[scan] face model ready on ${delegate} in ${Math.round(performance.now() - t0)} ms (${MODEL}, wasm ${WASM})`);
  let switching = false;
  let poseLogged = false;

  const tracker: FaceTracker = {
    delegate,
    oval: ring(FaceLandmarker.FACE_LANDMARKS_FACE_OVAL),
    detect: (video, t) => {
      if (switching) return null;
      try {
        const r = lm.detectForVideo(video, t);
        const pts = r.faceLandmarks[0];
        if (!pts) return null;
        const shapes: Record<string, number> = {};
        for (const c of r.faceBlendshapes[0]?.categories ?? []) shapes[c.categoryName] = c.score;
        const m = r.facialTransformationMatrixes[0];
        if (m && !poseLogged) { poseLogged = true; console.info('[scan] head pose matrix (first frame)', m.data.map((v) => Math.round(v * 100) / 100), poseFrom(m.data)); }
        return { pts, shapes, pose: m ? poseFrom(m.data) : null };
      } catch (err) {
        if (tracker.delegate === 'CPU') throw err;
        console.info('[scan] GPU face model failed on a frame, switching to the CPU', err);
        switching = true;
        lm.close();
        void make('CPU').then((cpu) => { lm = cpu; tracker.delegate = 'CPU'; switching = false; });
        return null;
      }
    },
    drawPoints: (ctx, pts) => {
      const du = new DrawingUtils(ctx);
      const lms = pts.map((q) => ({ ...q, visibility: 1 }));
      du.drawConnectors(lms, FaceLandmarker.FACE_LANDMARKS_TESSELATION, { color: 'rgba(241, 238, 248, 0.25)', lineWidth: 0.5 });
      du.drawLandmarks(lms, { color: 'rgba(166, 132, 255, 0.9)', radius: 1, lineWidth: 0 });
    },
    close: () => lm.close(),
  };
  return tracker;
}

/**
 * Skin areas with the strongest pulse signal and no eyes or mouth: forehead and both cheeks.
 * Point sets from the canonical MediaPipe face mesh; each area is the convex hull of its points, so order does not matter.
 */
export const ROI_POINTS: number[][] = [
  [10, 109, 67, 103, 104, 69, 108, 151, 337, 299, 333, 332, 297, 338], // forehead
  [116, 117, 118, 119, 100, 101, 36, 205, 187, 147, 123, 50], // cheek, image left
  [345, 346, 347, 348, 329, 330, 266, 425, 411, 376, 352, 280], // cheek, image right
];

/** Convex hull (monotone chain) in image coordinates. */
export function hull(points: { x: number; y: number }[]): { x: number; y: number }[] {
  const p = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: typeof p = [], upper: typeof p = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (const q of [...p].reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** Eye corners and lids: [outer, upper-1, upper-2, inner, lower-2, lower-1]. */
const EYES = [[33, 160, 158, 133, 153, 144], [362, 385, 387, 263, 373, 380]];

const dist = (a: Pt, b: Pt, aspect: number) => Math.hypot((a.x - b.x) * aspect, a.y - b.y);

/** Eye aspect ratio (Soukupová & Čech, 2016), averaged over both eyes. Open is about 0.25 to 0.35; a blink drops near 0.1. */
export function eyeOpenness(p: Pt[], aspect: number): number {
  const one = (e: number[]) => (dist(p[e[1]], p[e[5]], aspect) + dist(p[e[2]], p[e[4]], aspect)) / (2 * dist(p[e[0]], p[e[3]], aspect));
  return (one(EYES[0]) + one(EYES[1])) / 2;
}

/** Head tilt to the side in degrees, from the line between the outer eye corners. */
export function headRoll(p: Pt[], aspect: number): number {
  const a = p[33], b = p[263];
  return (Math.atan2(b.y - a.y, (b.x - a.x) * aspect) * 180) / Math.PI;
}

function inRing(x: number, y: number, ring: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Colour sums of one skin area in one frame: `n` skin pixels out of `area` pixels inside it. */
interface Patch { r: number; g: number; b: number; n: number; area: number }

/** Colour sums of the pixels inside one area (only skin-coloured pixels when `skinOnly`). */
function patchOf(px: Uint8ClampedArray, w: number, h: number, p: Pt[], idx: number[], skinOnly: boolean): Patch {
  const out: Patch = { r: 0, g: 0, b: 0, n: 0, area: 0 };
  const ring = hull(idx.map((i) => ({ x: p[i].x * w, y: p[i].y * h })));
  const x0 = Math.max(0, Math.floor(Math.min(...ring.map((q) => q.x)))), x1 = Math.min(w - 1, Math.ceil(Math.max(...ring.map((q) => q.x))));
  const y0 = Math.max(0, Math.floor(Math.min(...ring.map((q) => q.y)))), y1 = Math.min(h - 1, Math.ceil(Math.max(...ring.map((q) => q.y))));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if (!inRing(x + 0.5, y + 0.5, ring)) continue;
    out.area++;
    const i = (y * w + x) * 4;
    if (skinOnly && !isSkin(px[i], px[i + 1], px[i + 2])) continue;
    out.r += px[i]; out.g += px[i + 1]; out.b += px[i + 2]; out.n++;
  }
  return out;
}

/**
 * Skin colour of the forehead, image-left cheek and image-right cheek (ROI_POINTS order) in one frame
 * (pixels of a w x h copy of the frame). Hair, brows, a cap brim and shadows are skipped, so a covered area has few skin pixels.
 */
export function roiPatches(px: Uint8ClampedArray, w: number, h: number, p: Pt[]): Patch[] {
  return ROI_POINTS.map((idx) => patchOf(px, w, h, p, idx, true));
}

/**
 * Just below each lower eyelid and above the cheekbone: between the 2nd and 3rd rings of points under the eye
 * (image-left eye first). Directly above the cheek patches, so the two can be compared as a ratio.
 */
export const UNDER_EYE_POINTS: number[][] = [
  [228, 229, 230, 231, 117, 118, 119, 120],
  [448, 449, 450, 451, 346, 347, 348, 349],
];

/** Under-eye areas in one frame. Every pixel counts: dark circles can fail the skin-colour test. */
export function underEyePatches(px: Uint8ClampedArray, w: number, h: number, p: Pt[]): Patch[] {
  return UNDER_EYE_POINTS.map((idx) => patchOf(px, w, h, p, idx, false));
}

/** Mean skin colour and brightness over some patches. */
export function patchMean(ps: Patch[]): { r: number; g: number; b: number; n: number; luma: number } {
  const t = ps.reduce((a, q) => ({ r: a.r + q.r, g: a.g + q.g, b: a.b + q.b, n: a.n + q.n }), { r: 0, g: 0, b: 0, n: 0 });
  if (!t.n) return { r: 0, g: 0, b: 0, n: 0, luma: 0 };
  const r = t.r / t.n, g = t.g / t.n, b = t.b / t.n;
  return { r, g, b, n: t.n, luma: 0.299 * r + 0.587 * g + 0.114 * b };
}
