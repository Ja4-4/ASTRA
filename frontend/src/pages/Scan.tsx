import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Lock, X } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { PRIMARY, SECONDARY } from '../components/Answer';
import { StatusIcon, StatusPill } from '../components/Status';
import { STATUS, type StatusKey } from '../lib/status';
import { useAstra } from '../store/useAstra';
import { sendReadings } from '../data/live';
import { estimatePulse, LOW_QUALITY, MIN_QUALITY, skinStats, type RgbSample } from '../lib/rppg';
import { createFaceTracker, eyeOpenness, headRoll, patchMean, roiPatches, underEyePatches, UNDER_EYE_POINTS, type FaceTracker, type Pt } from '../lib/faceMesh';
import { coverFor, drawAreas, prepareCanvas, smoothPoints, toBox } from '../lib/faceOverlay';
import { evaluateFace, medianShapes, mostMoved, readFace, TRIGGER, type FaceReading, type Shapes } from '../lib/expression';
import { signsLine, TIRED_SOURCE, tiredSigns, type TiredResult, type TiredValues } from '../lib/tired';
import { SCAN_DEMO } from '../demo/newScreens';

type Phase = 'ready' | 'calibrating' | 'scanning' | 'done';
type Mode = 'opening' | 'camera' | 'demo';
/** 'mesh': face model; 'skin': colour-based face finder, used if the face model cannot load. */
type Tracker = 'mesh' | 'skin';
/** Pauses the progress ring: the pulse cannot be read. */
type Block = 'noface' | 'tiny' | 'motion' | 'dark';
/** A tip line only: the scan keeps going. */
type Tip = 'small' | 'turned' | 'motion' | 'light' | 'forehead';
interface Gate { block: Block | null; tip: Tip | null }
interface EyeResult { closedPct: number; blinksPerMin: number }
interface HeadResult { level: boolean; roll: number }
interface Details { fps: number; frames: number; quality: number | null; delegate: string; cheeksOnlyPct: number }
/** Frames behind the tired signs: with a face, with good light and skin (under-eye and skin colour), and the eye frames used. */
interface TiredInfo { values: TiredValues; faceFrames: number; lightFrames: number; eyeFrames: number }
interface Result { bpm: number | null; bpmLow?: boolean; mode: 'camera' | 'demo'; eyes: EyeResult | null; head: HeadResult | null; face: FaceReading | null; details: Details | null; tired: TiredResult | null; tiredInfo: TiredInfo | null }
/** Eye and skin values collected over one phase (the baseline or the scan). */
interface TiredBuf { eyeOpen: number[]; underEye: number[]; redness: number[]; faceFrames: number; lightFrames: number }
const emptyTired = (): TiredBuf => ({ eyeOpen: [], underEye: [], redness: [], faceFrames: 0, lightFrames: 0 });
/** Fewest frames for a value to count as measured (about 2 s at 15 frames a second). */
const MIN_TIRED_FRAMES = 30;
/** Cheek areas must be at least this share skin for the skin-colour values (same gate as the pulse). */
const MIN_CHEEK_SKIN = 0.5;

/** One analysed frame, recorded by the dev calibration session. Brightness is 0-255, angles in degrees. */
interface FrameRec {
  t: number; fps: number; faceWidth: number; motion: number; yaw: number; pitch: number; roll: number;
  lumaForehead: number; lumaCheekL: number; lumaCheekR: number; foreheadSkin: number; eyeOpen: number; cheeksOnly: boolean; shapes: Shapes;
  /** Under-eye / cheek brightness and cheek redness; null when the light or skin check failed in this frame. */
  underEye: number | null; redness: number | null; lightOk: boolean;
}
type FrameHook = (f: FrameRec, rgb: { r: number; g: number; b: number } | null) => void;

/** The artifact build never opens the camera and never downloads the face model: it runs the demo scan. */
const OFFLINE_BUILD = import.meta.env.MODE === 'artifact';
/** Size of the low-resolution copy of each frame used for colour. Small on purpose: fast, and no usable image is kept. */
const SAMPLE_W = 160;
const SAMPLE_H = 120;
/** Seconds of good frames for the "Relax your face" baseline. */
const CALIBRATE_S = 3;
/** Seconds of good frames for the pulse. estimatePulse still needs 8 s or more, and its quality decides if the number is shown. */
const SCAN_S = 20;
/** The expression is the median over the first this-many seconds of good frames, so it is ready early. */
const EXPRESSION_S = 6;
/** The scan ends anyway after this long, with what it has, if the checks keep failing. */
const MAX_SCAN_S = 90;

/**
 * Live checks. Only no face, strong motion or skin too dark to read pause the scan; everything else is a tip.
 * Defaults for any normal webcam; the dev calibration session (/scan?calibrate) records the numbers to tune them.
 */
const LIMITS = {
  /** Face oval width / video width. Tip below this; the face is about 0.23 at normal sitting distance on the team laptop. */
  tipFaceWidth: 0.15,
  /** Face oval width / video width. Pauses below this: too few skin pixels for a pulse. */
  blockFaceWidth: 0.1,
  /** Mean point movement per frame / face oval width (smoothed): tip, then pause. */
  tipMotion: 0.01,
  blockMotion: 0.02,
  /** Mean skin brightness of the patches in use (0-255): pause below blockLuma, tip outside tipLumaLow..tipLumaHigh. */
  blockLuma: 35,
  tipLumaLow: 60,
  tipLumaHigh: 230,
  /** Head turned left/right or up/down, and tilted to the side, degrees (tip only). */
  tipTurn: 20,
  tipRoll: 10,
  /** Forehead dropped from the pulse when under this share of it looks like skin (cap brim, hair)... */
  foreheadMinSkin: 0.5,
  /** ...or when it is darker than this share of the cheeks' brightness (shadow of a brim). */
  foreheadDark: 0.6,
};
/** Head counts as straight in the result when tilted to the side by less than this (degrees). */
const LEVEL_ROLL = 8;
const BLOCK_LINE: Record<Block, string> = {
  noface: 'Move your face into the outline.',
  tiny: 'Move a little closer.',
  motion: 'Hold still.',
  dark: 'Too dark to read your pulse. Find more light.',
};
const TIP_LINE: Record<Tip, string> = {
  small: 'Move a little closer.',
  turned: 'Look straight at the screen.',
  motion: 'Hold still.',
  light: 'Find softer, even light.',
  forehead: 'Forehead covered, reading from your cheeks.',
};

/** Same bands as the resting heart rate rule in rules.ts: act under 40 or over 120, watch from 15% away from your usual. */
function pulseStatus(bpm: number, usual: number): StatusKey {
  if (bpm < 40 || bpm > 120) return 'act';
  if (bpm < 50 || bpm > 90 || Math.abs(bpm - usual) / usual > 0.15) return 'watch';
  return 'ok';
}

const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
const percentile = (a: number[], q: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0; };

/** Eyes closed share and blinks from the eye-openness series. Closed = below 60% of this scan's open-eye level. */
function eyesFrom(series: { t: number; v: number }[]): EyeResult | null {
  if (series.length < 60) return null;
  const open = percentile(series.map((s) => s.v), 0.8);
  const limit = open * 0.6;
  let closed = 0, blinks = 0, wasClosed = false;
  for (const s of series) {
    const c = s.v < limit;
    if (c) closed++;
    if (wasClosed && !c) blinks++;
    wasClosed = c;
  }
  const minutes = (series[series.length - 1].t - series[0].t) / 60000;
  return { closedPct: Math.round((closed / series.length) * 100), blinksPerMin: Math.round(blinks / Math.max(minutes, 0.1)) };
}

/** One face model for the whole app session: loading it again on every visit would cost seconds. */
let trackerLoad: Promise<FaceTracker> | null = null;

/** Readable chip over the video, in the page background colour. */
const CHIP = { background: 'color-mix(in srgb, var(--bg) 85%, transparent)' };
const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const MOODS = ['Very bad', 'Bad', 'OK', 'Good', 'Great'];

/**
 * Camera scan. Finds the face with MediaPipe (served from this app, no internet), reads the colour of the forehead and
 * both cheeks for the pulse (CHROM), the eye lids for blinks, the head pose, and the face expression for a mood
 * suggestion the astronaut confirms. Frames are read in memory and dropped at once: no video or image is ever stored.
 * Without a camera (blocked, none attached, artifact build) it runs the labelled demo scan instead.
 */
export default function Scan() {
  const [phase, setPhase] = useState<Phase>('ready');
  const [mode, setMode] = useState<Mode>('opening');
  const [tracker, setTracker] = useState<Tracker>('mesh');
  const [loadingModel, setLoadingModel] = useState(false);
  const [gate, setGate] = useState<Gate>({ block: 'noface', tip: null });
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const [savedPulse, setSavedPulse] = useState(false);
  const [savedMood, setSavedMood] = useState<number | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsLink = useRef<HTMLButtonElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const wave = useRef<HTMLCanvasElement>(null);
  const sampler = useRef<HTMLCanvasElement | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const raf = useRef<number | null>(null);
  const timer = useRef<number | null>(null);
  const session = useRef(0);
  const faceTracker = useRef<FaceTracker | null>(null);
  const trackerKind = useRef<Tracker>('mesh');
  const phaseRef = useRef<Phase>('ready');
  const gateKey = useRef('noface|null');
  const fpsEma = useRef(0);
  /** Dev calibration session: receives every analysed frame. */
  const frameHook = useRef<FrameHook | null>(null);
  // per-frame state
  const lastVideoTime = useRef(-1);
  const lastT = useRef(0);
  const smooth = useRef<Pt[] | null>(null);
  const prevPts = useRef<Pt[] | null>(null);
  const prevCenter = useRef<{ x: number; y: number } | null>(null);
  const motion = useRef(0);
  /** Smoothed 0..1 "forehead covered" signal and the decision taken from it (with hysteresis, so it does not flicker). */
  const foreheadBad = useRef(0);
  const foreheadOffRef = useRef(false);
  const cheeksOnlyFrames = useRef(0);
  const stats = useRef({ t0: 0, frames: 0, sum: { w: 0, yaw: 0, pitch: 0, roll: 0, motion: 0, luma: 0, fh: 0, n: 0 } });
  // scan buffers
  const goodMs = useRef(0);
  const scanStart = useRef(0);
  /** When Start scan was pressed, for the Start -> result time in the log. */
  const startedAt = useRef(0);
  const scanFrames = useRef(0);
  const samples = useRef<RgbSample[]>([]);
  const eyeSeries = useRef<{ t: number; v: number }[]>([]);
  const heads = useRef<number[]>([]);
  const shapes = useRef<Shapes[]>([]);
  const tiredScan = useRef<TiredBuf>(emptyTired());
  const tiredBase = useRef<TiredBuf>(emptyTired());
  const logCheckin = useAstra((s) => s.logCheckin);
  const usualFace = useAstra((s) => s.usualFace);
  const setUsualFace = useAstra((s) => s.setUsualFace);
  const setLastFace = useAstra((s) => s.setLastFace);
  const addTiredScan = useAstra((s) => s.addTiredScan);
  const setLastTired = useAstra((s) => s.setLastTired);
  const resetUsual = useAstra((s) => s.resetUsual);

  /** Dev only: /scan?calibrate runs the guided calibration session instead of a scan. */
  const [calibrate] = useState(() => import.meta.env.DEV && new URLSearchParams(window.location.search).has('calibrate'));
  /** Dev only: /scan?debug shows the live expression reading under the video. */
  const [debug] = useState(() => import.meta.env.DEV && !calibrate && new URLSearchParams(window.location.search).has('debug'));

  const toPhase = (p: Phase) => { phaseRef.current = p; setPhase(p); };

  const stopCamera = () => {
    session.current++;
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = null;
    if (timer.current) window.clearInterval(timer.current);
    timer.current = null;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  };

  /** Draws the full face mesh (478 points, triangles, under-eye areas) over the mirrored, cover-cropped video. */
  const draw = (v: HTMLVideoElement, pts: Pt[] | null, brand: string) => {
    const c = overlay.current;
    const ctx = c && prepareCanvas(c);
    if (!c || !ctx) return;
    if (pts) smooth.current = smoothPoints(smooth.current, pts);
    const s = smooth.current;
    if (!s || trackerKind.current !== 'mesh' || !faceTracker.current) return;
    const cover = coverFor(c.clientWidth, c.clientHeight, v.videoWidth, v.videoHeight);
    if (!pts) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    faceTracker.current.drawPoints(ctx, s.map((q) => { const b = toBox(cover, q); return { x: b.x / cover.W, y: b.y / cover.H, z: q.z }; }));
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawAreas(ctx, cover, s, UNDER_EYE_POINTS, brand);
  };

  /** Last 5 seconds of the skin colour signal (green channel, slow drift removed), drawn as a moving line. */
  const drawWave = (brand: string) => {
    const c = wave.current;
    const ctx = c && prepareCanvas(c);
    if (!c || !ctx) return;
    const now = performance.now();
    const s = samples.current.filter((q) => now - q.t < 5000);
    if (s.length < 20) return;
    const g = s.map((q) => q.g);
    const k = 8;
    const d = g.map((v, i) => { const lo = Math.max(0, i - k), hi = Math.min(g.length, i + k + 1); let m = 0; for (let j = lo; j < hi; j++) m += g[j]; return -(v - m / (hi - lo)); });
    const lo = Math.min(...d), hi = Math.max(...d), W = c.clientWidth, H = c.clientHeight;
    ctx.strokeStyle = brand;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    s.forEach((q, i) => {
      const x = W - ((now - q.t) / 5000) * W;
      const y = H - 4 - ((d[i] - lo) / (hi - lo || 1)) * (H - 8);
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    });
    ctx.stroke();
  };

  const loop = (id: number, brand: string) => {
    if (id !== session.current) return;
    raf.current = requestAnimationFrame(() => loop(id, brand));
    const v = video.current;
    if (!v || v.readyState < 2 || !v.videoWidth) return;
    const now = performance.now();
    if (v.currentTime === lastVideoTime.current) { draw(v, null, brand); return; }
    lastVideoTime.current = v.currentTime;
    const dt = lastT.current ? Math.min(200, now - lastT.current) : 0;
    lastT.current = now;
    if (!sampler.current) { sampler.current = document.createElement('canvas'); sampler.current.width = SAMPLE_W; sampler.current.height = SAMPLE_H; }
    const sctx = sampler.current.getContext('2d', { willReadFrequently: true });
    if (!sctx) return;
    sctx.drawImage(v, 0, 0, SAMPLE_W, SAMPLE_H);
    const px = sctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;
    const aspect = v.videoWidth / v.videoHeight;
    const scanning = phaseRef.current === 'scanning' || phaseRef.current === 'calibrating';
    let block: Block | null = 'noface';
    let tip: Tip | null = null;
    let pts: Pt[] | null = null;
    let rgb: { r: number; g: number; b: number } | null = null;
    if (dt) fpsEma.current = fpsEma.current ? fpsEma.current * 0.9 + (1000 / dt) * 0.1 : 1000 / dt;

    if (trackerKind.current === 'mesh' && faceTracker.current) {
      const f = faceTracker.current.detect(v, now);
      if (f) {
        pts = f.pts;
        const xs = faceTracker.current.oval.map((i) => f.pts[i].x);
        const w = Math.max(...xs) - Math.min(...xs);
        const prev = prevPts.current;
        if (prev && prev.length === f.pts.length) {
          let m = 0;
          for (let i = 0; i < f.pts.length; i++) m += Math.hypot((f.pts[i].x - prev[i].x) * aspect, f.pts[i].y - prev[i].y);
          motion.current = motion.current * 0.7 + (m / f.pts.length / (w * aspect)) * 0.3;
        }
        prevPts.current = f.pts;
        const roll = f.pose ? f.pose.roll : headRoll(f.pts, aspect);
        const ps = roiPatches(px, SAMPLE_W, SAMPLE_H, f.pts);
        const lumas = ps.map((q) => patchMean([q]).luma);
        const cheeks = patchMean([ps[1], ps[2]]);
        const skinShare = ps[0].area ? ps[0].n / ps[0].area : 0;
        const bad = skinShare < LIMITS.foreheadMinSkin || lumas[0] < cheeks.luma * LIMITS.foreheadDark;
        foreheadBad.current = foreheadBad.current * 0.9 + (bad ? 0.1 : 0);
        const off = foreheadOffRef.current ? foreheadBad.current > 0.3 : foreheadBad.current > 0.6;
        if (off !== foreheadOffRef.current) { foreheadOffRef.current = off; console.info(`[scan] forehead ${off ? 'covered, pulse from cheeks only' : 'clear, pulse from forehead and cheeks'} (skin share ${skinShare.toFixed(2)})`); }
        const m = off ? cheeks : patchMean(ps);
        if (m.n > 30) rgb = m;
        if (scanning && off) cheeksOnlyFrames.current++;
        const turned = !!f.pose && (Math.abs(f.pose.yaw) > LIMITS.tipTurn || Math.abs(f.pose.pitch) > LIMITS.tipTurn);
        block = w < LIMITS.blockFaceWidth ? 'tiny' : motion.current > LIMITS.blockMotion ? 'motion' : m.luma < LIMITS.blockLuma ? 'dark' : null;
        tip = w < LIMITS.tipFaceWidth ? 'small'
          : turned || Math.abs(roll) > LIMITS.tipRoll ? 'turned'
          : motion.current > LIMITS.tipMotion ? 'motion'
          : m.luma < LIMITS.tipLumaLow || m.luma > LIMITS.tipLumaHigh ? 'light'
          : off ? 'forehead' : null;
        const eye = eyeOpenness(f.pts, aspect);
        // Tired signs: under-eye / cheek brightness and cheek redness, only with good light and enough cheek skin.
        const ue = patchMean(underEyePatches(px, SAMPLE_W, SAMPLE_H, f.pts));
        const cheekArea = ps[1].area + ps[2].area;
        const lightOk = !block && m.luma >= LIMITS.tipLumaLow && m.luma <= LIMITS.tipLumaHigh
          && cheekArea > 0 && (ps[1].n + ps[2].n) / cheekArea >= MIN_CHEEK_SKIN && cheeks.n > 30 && ue.n >= 4;
        const underEye = lightOk ? ue.luma / cheeks.luma : null;
        const redness = lightOk ? cheeks.r / (cheeks.r + cheeks.g + cheeks.b) : null;
        if (scanning) {
          const tb = phaseRef.current === 'calibrating' ? tiredBase.current : tiredScan.current;
          tb.faceFrames++;
          if (!block) tb.eyeOpen.push(eye);
          if (underEye !== null && redness !== null) { tb.underEye.push(underEye); tb.redness.push(redness); tb.lightFrames++; }
        }
        const st = stats.current.sum;
        st.w += w; st.yaw += Math.abs(f.pose?.yaw ?? 0); st.pitch += Math.abs(f.pose?.pitch ?? 0); st.roll += Math.abs(roll); st.motion += motion.current; st.luma += m.luma; st.fh += skinShare; st.n++;
        frameHook.current?.({
          t: Math.round(now), fps: fpsEma.current, faceWidth: w, motion: motion.current, yaw: f.pose?.yaw ?? 0, pitch: f.pose?.pitch ?? 0, roll,
          lumaForehead: lumas[0], lumaCheekL: lumas[1], lumaCheekR: lumas[2], foreheadSkin: skinShare, eyeOpen: eye, cheeksOnly: off, shapes: f.shapes, underEye, redness, lightOk,
        }, rgb);
        if (scanning) {
          eyeSeries.current.push({ t: now, v: eye });
          heads.current.push(headRoll(f.pts, aspect));
          if (!block && goodMs.current < EXPRESSION_S * 1000) shapes.current.push(f.shapes);
        }
      } else { prevPts.current = null; }
    } else {
      const st = skinStats(px, SAMPLE_W, SAMPLE_H);
      if (st) {
        rgb = st;
        const c = { x: st.box.x + st.box.w / 2, y: st.box.y + st.box.h / 2 };
        if (prevCenter.current) motion.current = motion.current * 0.85 + Math.hypot(c.x - prevCenter.current.x, c.y - prevCenter.current.y) * 0.15;
        prevCenter.current = c;
        block = motion.current > 0.02 ? 'motion' : st.luma < LIMITS.blockLuma ? 'dark' : null;
        tip = motion.current > 0.012 ? 'motion' : st.luma < LIMITS.tipLumaLow || st.luma > LIMITS.tipLumaHigh ? 'light' : null;
      } else { prevCenter.current = null; }
    }

    if (scanning) {
      scanFrames.current++;
      if (rgb) samples.current.push({ t: now, r: rgb.r, g: rgb.g, b: rgb.b });
      if (!block) goodMs.current += dt;
      drawWave(brand);
    }
    const key = `${block}|${tip}`;
    if (key !== gateKey.current) { gateKey.current = key; setGate({ block, tip }); }
    draw(v, pts, brand);

    const S = stats.current;
    S.frames++;
    if (now - S.t0 >= 2000) {
      const n = S.sum.n || 1, r = (x: number, d = 1) => Math.round((x / n) * 10 ** d) / 10 ** d;
      console.info(`[scan] fps ${Math.round((S.frames * 1000) / (now - S.t0))} (${faceTracker.current?.delegate ?? trackerKind.current}) | face width ${r(S.sum.w, 3)} | turn ${r(S.sum.yaw)}° up/down ${r(S.sum.pitch)}° tilt ${r(S.sum.roll)}° | motion ${r(S.sum.motion, 4)} | skin brightness ${r(S.sum.luma, 0)} | forehead skin share ${r(S.sum.fh, 2)} | pause ${block ?? 'no'} tip ${tip ?? 'no'}`);
      stats.current = { t0: now, frames: 0, sum: { w: 0, yaw: 0, pitch: 0, roll: 0, motion: 0, luma: 0, fh: 0, n: 0 } };
    }
  };

  /** Opens the camera for the "Get ready" preview. No camera (or the artifact build) means the demo scan. */
  const openCamera = async () => {
    stopCamera();
    const id = session.current;
    setMode('opening');
    if (OFFLINE_BUILD || !navigator.mediaDevices?.getUserMedia) { setMode('demo'); return; }
    let s: MediaStream;
    try {
      s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
    } catch (err) {
      console.info('[scan] no camera, running the demo scan', err);
      if (id === session.current) setMode('demo');
      return;
    }
    if (id !== session.current) { s.getTracks().forEach((t) => t.stop()); return; }
    stream.current = s;
    const v = video.current;
    if (v) { v.srcObject = s; await v.play().catch((err: unknown) => console.warn('[scan] video play', err)); }
    setMode('camera');
    if (!faceTracker.current && trackerKind.current === 'mesh') {
      setLoadingModel(true);
      try {
        trackerLoad ??= createFaceTracker();
        faceTracker.current = await trackerLoad;
      } catch (err) {
        console.warn('[scan] face model unavailable, using the colour face finder', err);
        trackerLoad = null;
        trackerKind.current = 'skin';
        setTracker('skin');
      }
      setLoadingModel(false);
    }
    if (id !== session.current) return;
    lastT.current = 0;
    stats.current.t0 = performance.now();
    raf.current = requestAnimationFrame(() => loop(id, cssVar('--brand') || '#A684FF'));
  };

  useEffect(() => {
    void openCamera();
    // Runs once: the camera opens for the preview and closes when the page closes.
    return stopCamera;
  }, []);


  const finish = (m: 'camera' | 'demo') => {
    const seconds = (performance.now() - scanStart.current) / 1000;
    stopCamera();
    setElapsed(SCAN_S);
    if (m === 'demo') {
      setResult({ bpm: SCAN_DEMO.pulse, mode: 'demo', eyes: null, head: null, face: null, details: null, tired: null, tiredInfo: null });
      toPhase('done');
      return;
    }
    const est = estimatePulse(samples.current);
    const eyes = eyesFrom(eyeSeries.current);
    const hs = heads.current;
    const head = hs.length > 20 ? { roll: Math.round(median(hs)), level: Math.abs(median(hs)) < LEVEL_ROLL } : null;
    const usual = useAstra.getState().usualFace;
    let face = trackerKind.current === 'mesh' && usual && shapes.current.length ? readFace(medianShapes(shapes.current), usual, shapes.current.length, eyes?.closedPct ?? null) : null;
    const tb = tiredScan.current;
    const values: TiredValues = {
      eyeOpen: tb.eyeOpen.length >= MIN_TIRED_FRAMES ? median(tb.eyeOpen) : null,
      underEye: tb.underEye.length >= MIN_TIRED_FRAMES ? median(tb.underEye) : null,
      redness: tb.redness.length >= MIN_TIRED_FRAMES ? median(tb.redness) : null,
      closedPct: eyes?.closedPct ?? null, blinksPerMin: eyes?.blinksPerMin ?? null, kind: 'scan',
    };
    const mesh = trackerKind.current === 'mesh';
    const tired = mesh ? tiredSigns(values, useAstra.getState().tiredHistory) : null;
    if (tired) {
      console.info('[scan] tired signs', tired.learning ? 'first scan, saved as the usual' : `${tired.count} of 5`, tired.signs.map((g) => `${g.id} ${g.now?.toFixed(4) ?? 'not measured'} vs usual ${g.usual?.toFixed(4) ?? '—'} (${g.diffPct ?? '—'}%)${g.on ? ' SIGN' : ''}`).join(', '), `frames: eyes ${tb.eyeOpen.length}, light+skin ${tb.lightFrames} of ${tb.faceFrames}`);
      const on = tired.signs.filter((g) => g.on).map((g) => g.id);
      // Tired face reading from the eyes: 2 or more eye signs, unless the face clearly smiled.
      if (face && tired.eyeSigns >= 2 && face.look !== 'Smiling') {
        face = { ...face, look: 'Tired', confidence: 'medium', mood: 3, why: signsLine(on.filter((id) => id !== 'pale')).slice(0, -1).toLowerCase() };
      }
      if (values.eyeOpen !== null) addTiredScan(values);
      setLastTired({ at: useAstra.getState().now().toISOString(), count: tired.count, signs: on, learning: tired.learning });
    }
    const fps = Math.round(scanFrames.current / Math.max(seconds, 1));
    console.info('[scan] done', { startToResultMs: Math.round(performance.now() - startedAt.current), pulseSeconds: Math.round(seconds), fps, cheeksOnlyFrames: cheeksOnlyFrames.current, delegate: faceTracker.current?.delegate ?? 'skin', samples: samples.current.length, goodFrames: shapes.current.length, pulse: est, eyes, head });
    if (face) {
      console.info('[scan] face', face.look ?? 'hard to read', face.confidence, 'strength vs trigger', face.ratios, 'top scores', face.top.map((t) => `${t.name} ${t.now.toFixed(3)} (relaxed ${t.usual.toFixed(3)})`).join(', '));
      setLastFace({ at: useAstra.getState().now().toISOString(), look: face.look, confidence: face.confidence, why: face.why });
    }
    setResult({
      bpm: est && est.quality >= LOW_QUALITY ? est.bpm : null, bpmLow: !!est && est.quality < MIN_QUALITY, mode: 'camera', eyes, head, face,
      tired, tiredInfo: tired ? { values, faceFrames: tb.faceFrames, lightFrames: tb.lightFrames, eyeFrames: tb.eyeOpen.length } : null,
      details: { fps, frames: shapes.current.length, quality: est ? Math.round(est.quality * 10) / 10 : null, delegate: faceTracker.current?.delegate ?? 'colour finder', cheeksOnlyPct: Math.round((cheeksOnlyFrames.current / Math.max(scanFrames.current, 1)) * 100) },
    });
    toPhase('done');
  };

  const start = () => {
    samples.current = []; eyeSeries.current = []; heads.current = []; shapes.current = [];
    tiredScan.current = emptyTired(); tiredBase.current = emptyTired();
    goodMs.current = 0; scanFrames.current = 0; cheeksOnlyFrames.current = 0; scanStart.current = performance.now(); startedAt.current = scanStart.current;
    setResult(null); setSavedPulse(false); setSavedMood(null); setElapsed(0);
    if (mode === 'demo') {
      toPhase('scanning');
      const t0 = performance.now();
      timer.current = window.setInterval(() => {
        const s = (performance.now() - t0) / 1000;
        setGate({ block: null, tip: s >= SCAN_DEMO.lightOkAt ? null : 'light' });
        if (s >= SCAN_S) finish('demo'); else setElapsed(s);
      }, 100);
      return;
    }
    const calibrate = trackerKind.current === 'mesh' && !useAstra.getState().usualFace;
    toPhase(calibrate ? 'calibrating' : 'scanning');
    timer.current = window.setInterval(() => {
      const good = goodMs.current / 1000;
      if (phaseRef.current === 'calibrating') {
        // Checks never passed long enough: end without a usual face rather than wait forever.
        if ((performance.now() - scanStart.current) / 1000 > MAX_SCAN_S) { finish('camera'); return; }
        setElapsed(good);
        if (good >= CALIBRATE_S) {
          const usual = medianShapes(shapes.current);
          console.info('[scan] usual face saved from', shapes.current.length, 'frames', usual);
          setUsualFace(usual);
          // The first usual for the tired signs comes from these relaxed seconds; later scans update it.
          const base = tiredBase.current;
          if (!useAstra.getState().tiredHistory.length && base.eyeOpen.length >= 20) {
            addTiredScan({ eyeOpen: median(base.eyeOpen), underEye: base.underEye.length >= 20 ? median(base.underEye) : null, redness: base.redness.length >= 20 ? median(base.redness) : null, closedPct: null, blinksPerMin: null, kind: 'baseline' });
          }
          samples.current = []; eyeSeries.current = []; heads.current = []; shapes.current = []; tiredScan.current = emptyTired();
          goodMs.current = 0; scanFrames.current = 0; cheeksOnlyFrames.current = 0; scanStart.current = performance.now();
          setElapsed(0);
          toPhase('scanning');
        }
        return;
      }
      if (good >= SCAN_S || (performance.now() - scanStart.current) / 1000 > MAX_SCAN_S) finish('camera');
      else setElapsed(good);
    }, 100);
  };

  const stop = () => {
    if (timer.current) window.clearInterval(timer.current);
    timer.current = null;
    toPhase('ready');
    setElapsed(0);
  };

  const again = () => { toPhase('ready'); setResult(null); setElapsed(0); void openCamera(); };

  const savePulse = () => {
    if (!result?.bpm) return;
    // Only a real camera pulse reaches the station server; a demo scan stays in the app (see backendSource).
    void sendReadings(logCheckin([{ metric: 'hr', values: [result.bpm], source: result.mode === 'camera' ? 'camera scan (estimate)' : 'camera scan (demo)' }]));
    setSavedPulse(true);
  };

  const saveMood = (n: number) => {
    if (savedMood !== null || !result) return;
    // The astronaut's own answer, saved like a mood from the check-in. A demo scan never reaches the server.
    void sendReadings(logCheckin([{ metric: 'mood', values: [n], source: result.mode === 'camera' ? 'self-report' : 'camera scan (demo)' }]));
    setSavedMood(n);
  };

  const recalibrate = () => { resetUsual(); if (phaseRef.current === 'done') again(); };

  const live = mode === 'camera' && phase !== 'done';
  const total = phase === 'calibrating' ? CALIBRATE_S : SCAN_S;
  const left = Math.max(0, Math.ceil(total - elapsed));
  const usual = SCAN_DEMO.pulseUsual;
  const status = result?.bpm && !result.bpmLow ? pulseStatus(result.bpm, usual) : 'nodata';
  const eyesLonger = result?.eyes ? result.eyes.closedPct > SCAN_DEMO.eyesClosedUsualPct * 1.5 + 2 : null;
  const faceFound = gate.block !== 'noface';
  const line = gate.block ? BLOCK_LINE[gate.block]
    : gate.tip ? `${TIP_LINE[gate.tip]}${phase === 'scanning' || phase === 'calibrating' ? ` ${left} s left.` : ''}`
    : phase === 'calibrating' ? `Good. Keep your face relaxed for ${left} seconds.`
    : phase === 'scanning' ? `Good. Keep still for ${left} seconds.` : 'Good. You are ready to start.';
  const demo = result?.mode === 'demo';
  const suggested = demo ? SCAN_DEMO.face.mood : result?.face?.mood ?? null;
  const tired = result?.tired ?? null;
  const tiredStatus: StatusKey = demo ? 'ok' : !tired || tired.learning ? 'nodata' : tired.count >= 3 ? 'act' : tired.count === 2 ? 'watch' : 'ok';
  const eyesStatus: StatusKey = demo ? (SCAN_DEMO.eyesClosedLonger ? 'watch' : 'ok') : result?.eyes ? (eyesLonger ? 'watch' : 'ok') : 'nodata';
  // One summary line, coloured by the worst row.
  const rows: { name: string; status: StatusKey }[] = [{ name: 'heart beats', status }, { name: 'tired signs', status: tiredStatus }, { name: 'eyes', status: eyesStatus }];
  const acts = rows.filter((r) => r.status === 'act'), watches = rows.filter((r) => r.status === 'watch');
  const summary: { status: StatusKey; text: string } = acts.length ? { status: 'act', text: `Act now: ${acts.map((r) => r.name).join(' and ')}` }
    : watches.length ? { status: 'watch', text: `${watches.length} ${watches.length === 1 ? 'thing' : 'things'} to watch` }
    : rows.some((r) => r.status === 'ok') ? { status: 'ok', text: 'All in range' } : { status: 'nodata', text: 'Not available' };
  const onTired = tired?.signs.filter((g) => g.on).map((g) => g.id) ?? [];
  const done = phase === 'done' && !!result;
  const closeDetails = () => { setDetailsOpen(false); detailsLink.current?.focus(); };

  return (
    <div className="mx-auto flex max-w-[1280px] flex-col gap-3 p-3 lg:p-5">
      <PageHeader title="Camera scan" sub="20 seconds in front of the camera, no sensors on your skin.">
        <span className="num rounded-sm border border-line px-2 py-0.5 text-xs text-muted">{mode === 'demo' ? 'DEMO · simulated' : 'Estimate · not a medical device'}</span>
      </PageHeader>

      {calibrate && <Calibration hook={frameHook} ready={mode === 'camera' && !loadingModel && tracker === 'mesh'} />}

      <div className={`grid gap-3 ${done ? 'lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)]' : ''}`}>
        <section className="card flex flex-col gap-3 p-4" aria-label="Camera view">
          <div className="relative aspect-[3/4] w-full overflow-hidden rounded-sm border border-line bg-s2 sm:aspect-[4/3] lg:aspect-auto lg:h-[460px]">
            <video ref={video} muted playsInline className={`absolute inset-0 h-full w-full -scale-x-100 object-cover ${live ? '' : 'invisible'}`} aria-hidden="true" />
            <canvas ref={overlay} className={`pointer-events-none absolute inset-0 h-full w-full ${live && tracker === 'mesh' ? '' : 'invisible'}`} aria-hidden="true" />
            {!done && <Guide progress={phase === 'ready' ? 0 : elapsed / total} showFace={!(live && faceFound)} paused={phase !== 'ready' && !!gate.block} active={phase !== 'ready'} />}
            {!done && mode !== 'opening' && !(mode === 'demo' && phase === 'ready') && (
              <p className="absolute left-1/2 top-3 flex max-w-[90%] -translate-x-1/2 items-center gap-1.5 rounded-sm px-3 py-1.5 text-center text-[15px] font-bold text-text" style={CHIP} aria-live="polite">
                <StatusIcon status={gate.block ? 'watch' : 'ok'} size={15} />{line}
              </p>
            )}
            {phase !== 'ready' && !done && <p className="num absolute bottom-3 left-1/2 -translate-x-1/2 rounded-sm px-2 py-0.5 text-sm font-bold" style={CHIP}>{left} s</p>}
            {mode === 'demo' && !done && <p className="absolute bottom-10 left-3 right-3 text-center text-xs text-muted">No camera here, so this is the demo scan.</p>}
            {done && <p className="absolute inset-0 flex items-center justify-center text-[15px] text-muted">Scan finished. The camera is off.</p>}
          </div>
          {(phase === 'scanning' || phase === 'calibrating') && mode === 'camera' && (
            <div>
              <p className="text-xs text-muted">Your pulse, live (from the colour of your forehead and cheeks)</p>
              <canvas ref={wave} className="h-12 w-full" aria-hidden="true" />
            </div>
          )}
          {debug && mode === 'camera' && tracker === 'mesh' && <LiveFace hook={frameHook} usual={usualFace} />}
          {!calibrate && phase === 'ready' && (
            <button type="button" className={`${PRIMARY} w-full sm:w-auto sm:self-center`} onClick={start} disabled={mode === 'opening' || loadingModel}>
              {mode === 'opening' ? 'Opening the camera…' : loadingModel ? 'Loading the face model…' : 'Start scan'}
            </button>
          )}
          {(phase === 'scanning' || phase === 'calibrating') && <button type="button" className={`${SECONDARY} w-full justify-center sm:w-auto sm:self-center`} onClick={stop}>Stop</button>}
        </section>

        {done && result && (
          <section className="card flex flex-col gap-3 p-4" aria-labelledby="scan-res">
            <h2 id="scan-res" className="flex flex-wrap items-center gap-2 text-[20px] font-bold leading-7" aria-live="polite">
              <StatusPill status={summary.status} />{summary.text}
              {demo && <span className="num rounded-sm border border-line px-2 py-0.5 text-xs font-normal text-muted">DEMO · simulated</span>}
            </h2>
            <div className="flex flex-col gap-2">
              <ResultRow status={result.bpmLow ? null : status} label="Heart beats per minute" value={result.bpm ? String(result.bpm) : '—'}
                meaning={!result.bpm ? 'Not read this time: hold still, face a soft light, and scan again.' : result.bpmLow ? 'Low confidence: hold still, face a soft light, and scan again to confirm.' : status === 'ok' ? `Close to your usual (${usual})` : `Different from your usual (${usual}). Measure again after 5 minutes of rest.`} />
              <ResultRow status={tiredStatus} label="Tired signs"
                value={demo ? `${DEMO_TIRED.count} of 5` : !tired ? '—' : tired.learning ? 'Saved as your usual' : `${tired.count} of 5`}
                meaning={demo ? DEMO_TIRED.line : !tired ? 'Not read this time.' : tired.learning ? 'First scan: this is now your usual. The next scan is compared with it.' : `${tired.count ? signsLine(onTired) : 'No tired signs today.'}${tired.early ? ' Compared with your first scan.' : ''}`}>
                {!demo && tired && !tired.learning && tired.count >= 2 && <Link to="/routine" className="text-sm font-bold text-text underline underline-offset-4">Sleep counts tonight. Open your sleep plan.</Link>}
                {!demo && tired && !tired.learning && tired.count >= 2 && tired.closedHigh && <p className="text-sm text-text">Avoid tasks that need full attention until you rest.</p>}
              </ResultRow>
              <ResultRow status={eyesStatus} label="Eyes"
                value={demo ? (SCAN_DEMO.eyesClosedLonger ? 'Closed more than usual' : 'Normal') : result.eyes ? (eyesLonger ? 'Closed more than usual' : 'Normal') : '—'}
                meaning={result.eyes ? 'Eye tests from this scan:' : demo ? 'Demo value' : 'Not read this time.'}>
                {result.eyes && <EyeTests closedPct={result.eyes.closedPct} blinks={result.eyes.blinksPerMin} tired={tired} />}
              </ResultRow>
              <ResultRow status={null} label="Your face looked"
                value={demo ? SCAN_DEMO.face.look : result.face?.look ?? 'Hard to read'}
                meaning={demo ? `${cap(SCAN_DEMO.face.why)}.` : result.face?.look ? `${cap(result.face.why)}.` : 'Hard to read your face this time.'}>
                <p className="mt-1 text-[15px] font-bold">How do you feel right now?</p>
                <div className="grid grid-cols-5 gap-1.5" role="radiogroup" aria-label="How do you feel right now?">
                  {MOODS.map((label, i) => {
                    const n = i + 1, saved = savedMood === n, hint = savedMood === null && suggested === n;
                    return (
                      <button key={n} type="button" role="radio" aria-checked={saved} disabled={savedMood !== null && !saved} onClick={() => saveMood(n)}
                        className={`flex flex-col items-center rounded-sm border-2 py-2 disabled:opacity-40 ${saved ? 'border-brand bg-brand-soft font-bold' : hint ? 'border-dashed border-brand' : 'border-line hover:border-line-strong'}`}>
                        <span className="num text-[20px] leading-6">{n}</span>
                        <span className="text-[12px]">{label}</span>
                      </button>
                    );
                  })}
                </div>
                <p className="text-sm text-muted">{savedMood !== null ? `Saved: ${savedMood} out of 5 in today’s check-in.` : suggested ? 'The dashed one is the suggestion from your face. Nothing is saved until you tap.' : 'Nothing is saved until you tap.'}</p>
                <p className="text-xs text-muted">Read from your face. Faces don’t always show feelings, so you choose.</p>
              </ResultRow>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
              {result.bpm && !result.bpmLow && <button type="button" className={`${PRIMARY} w-full sm:w-auto`} onClick={savePulse} disabled={savedPulse}>{savedPulse ? 'Heart rate saved' : 'Save heart rate to today’s check-in'}</button>}
              <button type="button" className={`${SECONDARY} w-full justify-center sm:w-auto`} onClick={again}>Scan again</button>
            </div>
            <button ref={detailsLink} type="button" onClick={() => setDetailsOpen(true)} className="self-start text-sm text-muted underline underline-offset-4 hover:text-text">More details</button>
          </section>
        )}
      </div>

      {detailsOpen && (
        <DetailsSheet onClose={closeDetails}>
          <p className="flex items-start gap-2 text-text"><Lock size={15} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />No video is saved. Only the numbers stay on this computer. The camera turns off when the scan ends.</p>
          <p>Estimate, not a medical device. Movement and dim light make the numbers wrong. “Your usual” for the eyes is a demo value until ASTRA has your own history.</p>
          <p>Pulse: remote photoplethysmography (rPPG, CHROM method) on the forehead and both cheeks. Eyes: eye aspect ratio per frame; “closed” is below 60% of the scan’s open level (similar to PERCLOS). Face: MediaPipe FaceLandmarker, 478 landmarks and 52 blendshape scores, median over the good frames, compared with the astronaut’s calibrated neutral face.</p>
          {result?.head && <p className="num">Head straight: {result.head.level ? 'yes' : `no, tilted ${Math.abs(result.head.roll)}° to the side`}</p>}
          {result?.mode === 'demo' && <p className="num">Posture: {SCAN_DEMO.posture} (demo)</p>}
          {result?.eyes && <p className="num">Eyes closed {result.eyes.closedPct}% of the scan · {result.eyes.blinksPerMin} blinks per minute</p>}
          {result?.details && (
            <p className="num">Frames per second {result.details.fps} ({result.details.delegate}) · good frames used {result.details.frames} · pulse signal quality {result.details.quality ?? '—'} (shown from {MIN_QUALITY}) · pulse read from {result.details.cheeksOnlyPct >= 50 ? 'cheeks only (forehead covered)' : 'forehead and cheeks'}, cheeks only in {result.details.cheeksOnlyPct}% of frames</p>
          )}
          {result?.face && (
            <>
              <p className="num">Expression confidence: {result.face.confidence} · frames {result.face.frames}</p>
              <table className="num w-full text-left text-xs">
                <thead><tr><th className="py-1 font-bold">Biggest changes (blendshape)</th><th className="text-right font-bold">This scan</th><th className="text-right font-bold">Relaxed face</th></tr></thead>
                <tbody>{result.face.top.map((t) => <tr key={t.name} className="border-t border-line"><td className="py-1">{t.plain} <span className="text-muted">({t.name})</span></td><td className="text-right">{t.now.toFixed(3)}</td><td className="text-right">{t.usual.toFixed(3)}</td></tr>)}</tbody>
              </table>
            </>
          )}
          {result?.tired && result.tiredInfo && (
            <>
              <p className="font-bold text-text">Tired signs (eyes and skin vs this astronaut’s own usual)</p>
              <table className="num w-full text-left text-xs">
                <thead><tr><th className="py-1 font-bold">Value</th><th className="text-right font-bold">This scan</th><th className="text-right font-bold">Usual</th><th className="text-right font-bold">Diff</th></tr></thead>
                <tbody>{result.tired.signs.map((g) => (
                  <tr key={g.id} className="border-t border-line"><td className="py-1">{g.label}{g.on ? ' · sign' : ''}</td>
                    <td className="text-right">{g.now === null ? 'not measured this time' : g.now.toFixed(g.now > 2 ? 0 : 4)}</td>
                    <td className="text-right">{g.usual === null ? '—' : g.usual.toFixed(g.usual > 2 ? 0 : 4)}</td>
                    <td className="text-right">{g.diffPct === null ? '—' : `${g.diffPct > 0 ? '+' : ''}${g.diffPct}%`}</td></tr>
                ))}</tbody>
              </table>
              <p className="num">Eye frames used {result.tiredInfo.eyeFrames} · good light and skin in {result.tiredInfo.lightFrames} of {result.tiredInfo.faceFrames} frames ({Math.round((result.tiredInfo.lightFrames / Math.max(result.tiredInfo.faceFrames, 1)) * 100)}%). Eyelids: eye aspect ratio. Under the eyes: brightness below the lower lids divided by the cheeks’. Skin colour: cheek R/(R+G+B). Usual = median of the last 7 good scans. Thresholds are provisional.</p>
            </>
          )}
          <p>Source for the tired signs: {TIRED_SOURCE} These are cues other people see, not a diagnosis.</p>
          <p>{usualFace ? 'Usual face saved on this device.' : 'No usual face yet: the next scan starts with 3 relaxed seconds.'} {usualFace && <button type="button" onClick={() => { closeDetails(); recalibrate(); }} className="font-bold text-text underline underline-offset-4">Recalibrate</button>} {usualFace && '(also resets the usual eye and skin values)'}</p>
        </DetailsSheet>
      )}
    </div>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** One result: status icon, plain label, the value in large numbers, one muted meaning line; a thin left border in the status colour. */
/** Four small eye tests in a 2x2 grid: closed time, blinks, eyelid opening and under-eye shade vs the usual. */
function EyeTests({ closedPct, blinks, tired }: { closedPct: number; blinks: number; tired: TiredResult | null }) {
  const sign = (id: string) => tired?.signs.find((g) => g.id === id);
  const vsUsual = (id: string, lower: string, higher: string) => {
    const g = sign(id);
    if (!g || !g.measured || g.diffPct === null) return { text: tired?.learning ? 'Saved as usual' : 'Not measured', on: false };
    if (Math.abs(g.diffPct) < 2) return { text: 'Same as usual', on: false };
    return { text: `${Math.abs(g.diffPct)}% ${g.diffPct < 0 ? lower : higher} than usual`, on: g.on };
  };
  const tests = [
    { name: 'Eyes closed', value: `${closedPct}% of the scan`, on: !!sign('closed')?.on },
    { name: 'Blinks', value: `${blinks} per minute`, on: !!sign('blinks')?.on },
    { name: 'Eyelid opening', ...(() => { const v = vsUsual('lids', 'lower', 'higher'); return { value: v.text, on: v.on }; })() },
    { name: 'Under the eyes', ...(() => { const v = vsUsual('underEye', 'darker', 'lighter'); return { value: v.text, on: v.on }; })() },
  ];
  return (
    <ul className="grid grid-cols-2 gap-1.5">
      {tests.map((t) => (
        <li key={t.name} className="rounded-sm border border-line px-2.5 py-2" style={{ boxShadow: `inset 3px 0 0 ${t.on ? STATUS.watch.cssVar : STATUS.ok.cssVar}` }}>
          <p className="text-[12px] text-muted">{t.name}</p>
          <p className="num text-[15px] font-bold leading-5 text-text">{t.value}</p>
        </li>
      ))}
    </ul>
  );
}

function ResultRow({ status, label, value, meaning, children }: { status: StatusKey | null; label: string; value: string; meaning: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-sm border border-line py-2.5 pl-3 pr-3" style={{ boxShadow: `inset 3px 0 0 ${status ? STATUS[status].cssVar : 'var(--line-strong)'}` }}>
      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-1.5 text-[15px] text-text">{status && <StatusIcon status={status} size={15} />}{label}</p>
        {status && <span className="sr-only">{STATUS[status].label}</span>}
      </div>
      <p className="num text-[26px] font-bold leading-8 text-text">{value}</p>
      <p className="text-sm text-muted">{meaning}</p>
      {children}
    </div>
  );
}

/** "More details": a side sheet. Esc or the close button closes it; focus goes to the close button and back to the link. */
function DetailsSheet({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const closeBtn = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    closeBtn.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close.current(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-[#0B0A10]/60" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="scan-details-h" className="flex h-full w-[min(480px,100%)] flex-col border-l border-line bg-s1" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <h2 id="scan-details-h" className="flex-1 text-base font-semibold">More details</h2>
          <button ref={closeBtn} type="button" onClick={onClose} aria-label="Close details" className="-mr-1 rounded p-1.5 text-muted hover:bg-s2 hover:text-text"><X size={18} aria-hidden="true" /></button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4 text-sm text-muted">{children}</div>
      </div>
    </div>
  );
}

/** Faint face outline in the centre until a face is found, and the progress ring around it. Scales with the shorter side. */
function Guide({ progress, showFace, paused, active }: { progress: number; showFace: boolean; paused: boolean; active: boolean }) {
  const r = 44;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true">
      {showFace && <ellipse cx="50" cy="48" rx="24" ry="32" fill="none" stroke="var(--text-muted)" strokeWidth="0.6" strokeDasharray="2 2" opacity="0.8" />}
      {active && (
        <g className={paused ? 'motion-safe:animate-pulse' : undefined}>
          <circle cx="50" cy="50" r={r} fill="none" stroke="var(--line)" strokeWidth="1.2" opacity="0.7" />
          <circle cx="50" cy="50" r={r} fill="none" stroke={paused ? 'var(--watch)' : 'var(--brand)'} strokeWidth="1.4" strokeLinecap="round"
            strokeDasharray={c} strokeDashoffset={c * (1 - Math.min(1, progress))} transform="rotate(-90 50 50)" />
        </g>
      )}
    </svg>
  );
}

/** Dev calibration session: one instruction at a time, a 2 s unrecorded "Get ready", then 5 s recorded; saved by itself at the end. */
const GET_READY_S = 2;
const CAL_STEPS = [
  { id: 'eyesOpen', say: 'Look at the screen, relaxed, eyes open', s: 5 },
  { id: 'relaxed', say: 'Relax your face', s: 5 },
  { id: 'smile', say: 'Real smile: think of something funny', s: 5 },
  { id: 'politeSmile', say: 'Polite smile: smile with the lips, keep the eyes still', s: 5 },
  { id: 'sad', say: 'Sad face: inner brows up, mouth corners down, chin up a little', s: 5 },
  { id: 'tense', say: 'Tense: brows down, lips pressed', s: 5 },
  { id: 'blinks', say: 'Slow blinks: close your eyes slowly, open, repeat', s: 5 },
];
const r4 = (x: number) => Math.round(x * 10000) / 10000;
const NUM_KEYS = ['fps', 'faceWidth', 'motion', 'yaw', 'pitch', 'roll', 'lumaForehead', 'lumaCheekL', 'lumaCheekR', 'foreheadSkin', 'eyeOpen'] as const;

/** Median and 10th/90th percentiles of every number and every expression score in one step. */
function summarize(frames: FrameRec[]) {
  const stat = (a: number[]) => ({ median: r4(percentile(a, 0.5)), p10: r4(percentile(a, 0.1)), p90: r4(percentile(a, 0.9)) });
  const names = Object.keys(frames[0]?.shapes ?? {});
  return {
    frames: frames.length,
    cheeksOnlyShare: r4(frames.filter((f) => f.cheeksOnly).length / Math.max(frames.length, 1)),
    ...Object.fromEntries(NUM_KEYS.map((k) => [k, stat(frames.map((f) => f[k]))])),
    lightOkShare: r4(frames.filter((f) => f.lightOk).length / Math.max(frames.length, 1)),
    underEye: stat(frames.flatMap((f) => (f.underEye === null ? [] : [f.underEye]))),
    redness: stat(frames.flatMap((f) => (f.redness === null ? [] : [f.redness]))),
    shapes: Object.fromEntries(names.map((n) => [n, stat(frames.map((f) => f.shapes[n] ?? 0))])),
  };
}

function Calibration({ hook, ready }: { hook: { current: FrameHook | null }; ready: boolean }) {
  const [step, setStep] = useState(-1);
  const [left, setLeft] = useState(0);
  /** True during the unrecorded "Get ready" lead-in before each step. */
  const [prep, setPrep] = useState(false);
  const [saved, setSaved] = useState<'no' | 'saving' | 'yes' | 'failed'>('no');
  const frames = useRef<FrameRec[][]>([]);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { hook.current = null; if (timer.current) window.clearInterval(timer.current); }, [hook]);

  const save = async () => {
    setSaved('saving');
    const body = {
      savedAt: new Date().toISOString(),
      limits: LIMITS,
      triggers: TRIGGER,
      steps: CAL_STEPS.map((st, k) => ({ id: st.id, instruction: st.say, seconds: st.s, summary: summarize(frames.current[k]), frames: frames.current[k] })),
    };
    const res = await fetch('/__scan-calibration', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .catch((err: unknown) => { console.warn('[scan] calibration save', err); return null; });
    console.info('[scan] calibration saved', res?.ok, CAL_STEPS.map((st, k) => `${st.id}: ${frames.current[k].length} frames`).join(', '));
    setSaved(res?.ok ? 'yes' : 'failed');
  };

  const run = () => {
    frames.current = CAL_STEPS.map(() => []);
    let i = 0, t0 = performance.now(), recording = false;
    setStep(0); setPrep(true); setLeft(GET_READY_S); setSaved('no');
    hook.current = (f) => {
      if (!recording) return;
      frames.current[i].push({ ...f, underEye: f.underEye === null ? null : r4(f.underEye), redness: f.redness === null ? null : r4(f.redness), ...Object.fromEntries(NUM_KEYS.map((k) => [k, r4(f[k])])), shapes: Object.fromEntries(Object.entries(f.shapes).map(([n, v]) => [n, r4(v)])) });
    };
    timer.current = window.setInterval(() => {
      const sec = (performance.now() - t0) / 1000;
      const len = recording ? CAL_STEPS[i].s : GET_READY_S;
      if (sec < len) { setLeft(Math.ceil(len - sec)); return; }
      t0 = performance.now();
      if (!recording) { recording = true; setPrep(false); setLeft(CAL_STEPS[i].s); return; }
      recording = false;
      i++;
      if (i < CAL_STEPS.length) { setStep(i); setPrep(true); setLeft(GET_READY_S); return; }
      if (timer.current) window.clearInterval(timer.current);
      hook.current = null;
      setStep(CAL_STEPS.length);
      void save();
    }, 100);
  };

  const cur = CAL_STEPS[step];
  return (
    <section className="card flex flex-col gap-3 p-5" aria-live="polite">
      <p className="text-sm font-bold text-muted">Calibration session (development only) · step {Math.max(0, Math.min(step + 1, CAL_STEPS.length))} of {CAL_STEPS.length}</p>
      {step < 0 && (
        <>
          <h2 className="font-display text-[28px] font-bold leading-[32px]">About 45 seconds, one instruction at a time.</h2>
          <p className="text-[17px]">Take off any cap, sit at your normal distance, and hold each face for the full 5 seconds. It moves on by itself.</p>
          <div><button type="button" className={PRIMARY} onClick={run} disabled={!ready}>{ready ? 'Start calibration' : 'Waiting for the camera and face model…'}</button></div>
        </>
      )}
      {cur && (
        <div className="flex items-center gap-6">
          <span className={`num text-[64px] font-bold leading-none ${prep ? 'text-muted' : 'text-brand'}`}>{left}</span>
          <h2 className="font-display text-[28px] font-bold leading-[32px]">{prep ? `Get ready: ${cur.say}` : cur.say}</h2>
        </div>
      )}
      {step === CAL_STEPS.length && (
        saved === 'yes' ? <p className="text-[20px] font-bold">Saved. Tell Claude Code: done</p>
          : saved === 'failed' ? <p className="text-[17px]">Not saved: the dev server did not answer. Is npm run dev running? <button type="button" className="font-bold underline" onClick={() => void save()}>Try again</button></p>
          : <p className="text-[17px]">Saving…</p>
      )}
    </section>
  );
}

/** Dev live view: the expression reading over the last second (median), each rule's strength, and the 8 most-moved scores. */
function LiveFace({ hook, usual }: { hook: { current: FrameHook | null }; usual: Shapes | null }) {
  const buf = useRef<{ t: number; shapes: Shapes }[]>([]);
  const [view, setView] = useState<{ look: string; ratios: Record<string, number>; moved: FaceReading['top'] } | null>(null);
  useEffect(() => {
    hook.current = (f) => {
      buf.current.push({ t: f.t, shapes: f.shapes });
      while (buf.current.length && f.t - buf.current[0].t > 1000) buf.current.shift();
    };
    const id = window.setInterval(() => {
      if (!usual || buf.current.length < 5) { setView(null); return; }
      const now = medianShapes(buf.current.map((b) => b.shapes));
      const e = evaluateFace(now, usual, null);
      setView({ look: `${e.look ?? 'Hard to read'} (${e.confidence})`, ratios: e.ratios, moved: mostMoved(now, usual, 8) });
    }, 300);
    return () => { window.clearInterval(id); hook.current = null; };
  }, [hook, usual]);
  if (!usual) return <p className="num text-xs text-muted">Debug: no relaxed face yet. Run one scan first (it starts with 3 relaxed seconds).</p>;
  if (!view) return <p className="num text-xs text-muted">Debug: waiting for frames…</p>;
  return (
    <div className="num grid gap-2 rounded-sm border border-line p-2 text-xs sm:grid-cols-2">
      <div>
        <p className="font-bold text-text">Live (last 1 s): {view.look}</p>
        {Object.entries(view.ratios).map(([k, v]) => <p key={k}>{k}: {v.toFixed(2)} {v >= 1 ? '✓' : ''}</p>)}
      </div>
      <div>
        {view.moved.map((m) => <p key={m.name}>{m.plain}: {(m.now - m.usual >= 0 ? '+' : '') + (m.now - m.usual).toFixed(3)}</p>)}
      </div>
    </div>
  );
}

/** Demo tired result: always labelled, never saved or sent. */
const DEMO_TIRED = { count: 1, line: 'Eyelids lower than your usual.' };
