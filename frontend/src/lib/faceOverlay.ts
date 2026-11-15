/**
 * Drawing for the scan overlay: a thin outline on the face oval and three faint skin patches.
 * The canvas uses the same cover crop and the same mirror as the <video> under it, so the line sits on the jaw.
 */
import { hull, ROI_POINTS, type Pt } from './faceMesh';

interface Cover { W: number; H: number; scale: number; ox: number; oy: number; vw: number; vh: number }

/** object-fit: cover for a vw x vh video in a W x H box: scale to fill, centre, crop the overflowing side. */
export function coverFor(W: number, H: number, vw: number, vh: number): Cover {
  const scale = Math.max(W / vw, H / vh);
  return { W, H, scale, vw, vh, ox: (W - vw * scale) / 2, oy: (H - vh * scale) / 2 };
}

/** Video point (0..1 of the frame) -> CSS px in the box, mirrored like the selfie video. */
export function toBox(c: Cover, p: { x: number; y: number }): { x: number; y: number } {
  return { x: c.W - (c.ox + p.x * c.vw * c.scale), y: c.oy + p.y * c.vh * c.scale };
}

/** Exponential smoothing of point positions, for drawing only (the pulse uses the raw points). */
export function smoothPoints(prev: Pt[] | null, next: Pt[], alpha = 0.5): Pt[] {
  if (!prev || prev.length !== next.length) return next.map((q) => ({ ...q }));
  return next.map((q, i) => ({ x: prev[i].x + alpha * (q.x - prev[i].x), y: prev[i].y + alpha * (q.y - prev[i].y), z: q.z }));
}

/** Closed Catmull-Rom curve through the points, as cubic Béziers. */
function smoothLoop(ctx: CanvasRenderingContext2D, q: { x: number; y: number }[]) {
  const n = q.length;
  ctx.beginPath();
  ctx.moveTo(q[0].x, q[0].y);
  for (let i = 0; i < n; i++) {
    const p0 = q[(i - 1 + n) % n], p1 = q[i], p2 = q[(i + 1) % n], p3 = q[(i + 2) % n];
    ctx.bezierCurveTo(p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6, p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6, p2.x, p2.y);
  }
  ctx.closePath();
}

/** Sizes the canvas to its box in device pixels and returns a context that draws in CSS px. */
export function prepareCanvas(c: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  const W = c.clientWidth, H = c.clientHeight, dpr = window.devicePixelRatio || 1;
  if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  return ctx;
}

/** The normal view: face outline and the pulse patches in use (indices into ROI_POINTS). `alpha` fades it in and out (0..1). */
export function drawFace(ctx: CanvasRenderingContext2D, c: Cover, pts: Pt[], oval: number[], patches: number[], brand: string, alpha: number) {
  if (alpha <= 0.01) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = brand;
  for (const k of patches) {
    const r = hull(ROI_POINTS[k].map((i) => toBox(c, pts[i])));
    ctx.globalAlpha = alpha * 0.13;
    smoothLoop(ctx, r);
    ctx.fill();
  }
  ctx.globalAlpha = alpha * 0.6;
  ctx.strokeStyle = brand;
  ctx.lineWidth = 1.75;
  ctx.lineJoin = 'round';
  ctx.shadowColor = brand;
  ctx.shadowBlur = 6;
  smoothLoop(ctx, oval.map((i) => toBox(c, pts[i])));
  ctx.stroke();
  ctx.restore();
}

/** Debug view only: outlines of extra sampled areas (for example under the eyes). */
export function drawAreas(ctx: CanvasRenderingContext2D, c: Cover, pts: Pt[], areas: number[][], color: string) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  for (const idx of areas) {
    const r = hull(idx.map((i) => toBox(c, pts[i])));
    ctx.beginPath();
    r.forEach((q, k) => (k ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
    ctx.closePath();
    ctx.stroke();
  }
  ctx.restore();
}
