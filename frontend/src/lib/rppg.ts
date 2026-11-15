/**
 * Contactless pulse from a webcam (remote photoplethysmography, rPPG), CHROM method:
 * de Haan & Jeanne, "Robust pulse rate from chrominance-based rPPG", IEEE Trans Biomed Eng 60(10), 2013.
 *
 * Input: mean R, G, B of the skin region per frame, with timestamps. Output: heart beats per minute and a
 * signal quality ratio. This is an estimate for a demo, not a medical device: motion and poor light break it.
 */
export interface RgbSample { t: number; r: number; g: number; b: number }
export interface PulseResult { bpm: number; quality: number }

const FS = 30; // resample rate, Hz
const MIN_HZ = 0.75; // 45 beats per minute
const MAX_HZ = 3.0; // 180 beats per minute

/** Linear resample onto an even FS grid. */
function resample(samples: RgbSample[]): { r: number[]; g: number[]; b: number[] } {
  const out = { r: [] as number[], g: [] as number[], b: [] as number[] };
  const t0 = samples[0].t;
  const end = samples[samples.length - 1].t;
  let j = 0;
  for (let t = t0; t <= end; t += 1000 / FS) {
    while (j < samples.length - 2 && samples[j + 1].t < t) j++;
    const a = samples[j], c = samples[j + 1];
    const k = c.t === a.t ? 0 : (t - a.t) / (c.t - a.t);
    out.r.push(a.r + (c.r - a.r) * k);
    out.g.push(a.g + (c.g - a.g) * k);
    out.b.push(a.b + (c.b - a.b) * k);
  }
  return out;
}

const mean = (x: number[]) => x.reduce((s, v) => s + v, 0) / x.length;
const std = (x: number[]) => { const m = mean(x); return Math.sqrt(mean(x.map((v) => (v - m) ** 2))) || 1; };

/** Remove slow drift (lighting, breathing) by subtracting a 1-second moving average. */
function detrend(x: number[]): number[] {
  const w = FS;
  return x.map((v, i) => {
    const lo = Math.max(0, i - w / 2), hi = Math.min(x.length, i + w / 2);
    let s = 0;
    for (let k = lo; k < hi; k++) s += x[k];
    return v - s / (hi - lo);
  });
}

export function estimatePulse(samples: RgbSample[]): PulseResult | null {
  const seconds = samples.length > 1 ? (samples[samples.length - 1].t - samples[0].t) / 1000 : 0;
  // Need at least 8 s at 4 or more frames a second. Slow cameras or laptops can only see slower pulses
  // (a pulse is visible up to just under half the frame rate), so the search band shrinks to match.
  const rate = seconds > 0 ? samples.length / seconds : 0;
  if (seconds < 8 || rate < 4) return null;
  const maxHz = Math.min(MAX_HZ, rate * 0.45);
  const { r, g, b } = resample(samples);
  const [mr, mg, mb] = [mean(r), mean(g), mean(b)];
  const rn = r.map((v) => v / mr), gn = g.map((v) => v / mg), bn = b.map((v) => v / mb);
  const X = detrend(rn.map((v, i) => 3 * v - 2 * gn[i]));
  const Y = detrend(rn.map((v, i) => 1.5 * v + gn[i] - 1.5 * bn[i]));
  const alpha = std(X) / std(Y);
  const S = X.map((v, i) => v - alpha * Y[i]);
  // Hann window, then a direct DFT over the heart-rate band (cheap enough for ~900 samples).
  const n = S.length;
  const w = S.map((v, i) => v * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))));
  let bestHz = 0, bestP = 0, total = 0, count = 0;
  for (let hz = MIN_HZ; hz <= maxHz; hz += 0.01) {
    let re = 0, im = 0;
    for (let i = 0; i < n; i++) { const a = (2 * Math.PI * hz * i) / FS; re += w[i] * Math.cos(a); im -= w[i] * Math.sin(a); }
    const p = re * re + im * im;
    total += p; count++;
    if (p > bestP) { bestP = p; bestHz = hz; }
  }
  return { bpm: Math.round(bestHz * 60), quality: bestP / (total / count) };
}

/** Peak-to-average power ratio above which the reading is shown. Below it, ASTRA says the signal was too weak. */
export const MIN_QUALITY = 12;
/** From here up to MIN_QUALITY the number is shown, marked "Low confidence". Below it nothing is shown. */
export const LOW_QUALITY = 6;

export interface SkinStats {
  r: number; g: number; b: number;
  /** Share of the sampled frame that looks like skin, 0 to 1. */
  share: number;
  /** Where the skin is, as fractions of the frame (not mirrored). */
  box: { x: number; y: number; w: number; h: number };
  luma: number;
}

/** Classic YCbCr skin range (Chai & Ngan, 1999). Wide enough for most skin tones in normal indoor light. */
export function isSkin(r: number, g: number, b: number): boolean {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  return y > 40 && cb >= 77 && cb <= 127 && cr >= 133 && cr <= 173;
}

/**
 * Finds the face by colour instead of fixed boxes: keeps skin pixels, centres on the middle of the skin,
 * drops stray skin-coloured background far from it, and averages the rest. Works wherever the face sits in the frame.
 */
export function skinStats(px: Uint8ClampedArray, w: number, h: number): SkinStats | null {
  const mask = new Uint8Array(w * h);
  for (let k = 0; k < w * h; k++) mask[k] = isSkin(px[k * 4], px[k * 4 + 1], px[k * 4 + 2]) ? 1 : 0;
  // Keep only skin pixels with at least 3 skin neighbours: drops specks of skin-coloured background.
  const xs: number[] = [], ys: number[] = [];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const k = y * w + x;
    if (mask[k] && mask[k - 1] + mask[k + 1] + mask[k - w] + mask[k + w] >= 3) { xs.push(x); ys.push(y); }
  }
  if (xs.length < w * h * 0.02) return null;
  const median = (a: number[]) => [...a].sort((p, q) => p - q)[a.length >> 1];
  const cx = median(xs), cy = median(ys);
  const rx = w * 0.16, ry = h * 0.28;
  let r = 0, g = 0, b = 0, n = 0, x0 = w, x1 = 0, y0 = h, y1 = 0;
  for (let k = 0; k < xs.length; k++) {
    const x = xs[k], y = ys[k];
    if (Math.abs(x - cx) > rx || Math.abs(y - cy) > ry) continue;
    const i = (y * w + x) * 4;
    r += px[i]; g += px[i + 1]; b += px[i + 2]; n++;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (n < w * h * 0.015) return null;
  r /= n; g /= n; b /= n;
  return { r, g, b, share: n / (w * h), box: { x: x0 / w, y: y0 / h, w: (x1 - x0 + 1) / w, h: (y1 - y0 + 1) / h }, luma: 0.299 * r + 0.587 * g + 0.114 * b };
}
