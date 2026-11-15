/**
 * ATLAS answers: plain rules over today's real (demo-data) numbers. askAtlasSmart (end of file) may use
 * the local AI model instead when the station server and Ollama are on.
 * Every answer is at most 3 short sentences: the number, what it means, what to do.
 */
import { METRICS, METRIC_ORDER, type MetricId } from './indicators';
import type { RuleResult } from './rules';
import type { StatusKey } from './status';
import { DEMO_PROFILE } from '../data/demo/profile';
import { MISSION_BY_ID, type MissionSettingId } from './mission';
import { LANDING_DAY, readiness, sessionsFor, reentryKey, weekProgress } from '../demo/newScreens';
import { activeAstronaut } from '../data/api';
import * as server from '../data/server';
import { reloadLive, switchAstronaut } from '../data/live';
import { useAstra } from '../store/useAstra';
import { SYSTEMS, type SystemId } from './systems';
import { signsSaid } from './tired';

export interface AtlasContext {
  results: Record<MetricId, RuleResult>;
  day: number;
  mission: MissionSettingId;
  pathname: string;
  done: Record<string, string>;
  /** The app's clock (the demo runs on a simulated one). Atlas passes it so numbers it records land on the demo timeline. */
  at?: string;
}
export interface AtlasAnswer {
  text: string;
  status?: StatusKey;
  link?: { to: string; label: string };
  /** A spoken command: go to this page right after answering. */
  navigate?: string;
  /** A spoken command: close Atlas after answering. */
  close?: boolean;
  /** Body system to fly the 3D camera to while answering. */
  focus?: SystemId;
  /** A write the assistant wants to make: nothing happens until the person approves it. */
  confirm?: server.AtlasConfirm;
  /** The language the answer is in (Atlas answers Arabic questions in Arabic). */
  lang?: 'ar' | 'en';
  /** Stop reading aloud (the person asked Atlas to be quiet). */
  silence?: boolean;
  /** The conversation is over (goodbye, thanks, stop): Atlas closes instead of listening again. */
  end?: boolean;
  /** One short line for the activity log: what Atlas actually did (opened a page, saved a number, changed the theme). */
  did?: string;
}

/** The body system that holds a number, so Atlas can show it on the 3D body. */
const systemOf = (m: MetricId): SystemId | undefined => SYSTEMS.find((s) => s.metrics.includes(m))?.id;

/** Spoken page names -> route. Checked in order. */
const ROUTES: [RegExp, string, string][] = [
  [/home|main/, '/', 'Home'],
  [/measure|check-?in|log/, '/log', 'Measure'],
  [/alert/, '/events', 'Alerts'],
  [/scan|camera/, '/scan', 'the camera scan'],
  [/test|game|reaction|memory/, '/tests', 'the thinking tests'],
  [/re-?entry|training|landing/, '/reentry', 'Re-entry'],
  [/history|chart|trend/, '/trends', 'History'],
  [/plan|routine|schedule/, '/routine', 'today’s plan'],
  [/learn|evidence/, '/evidence', 'Learn'],
  [/progress|points|badge|rank/, '/crew', 'Progress'],
];

const B = DEMO_PROFILE.baseline;
const USUAL_NUM: Partial<Record<MetricId, number>> = { hr: B.hr, bp: B.bp_sys, glucose: B.glucose, temp: B.temp, sleep: B.sleep, mood: B.mood };
const USUAL_SAID: Partial<Record<MetricId, string>> = {
  hr: `${B.hr} beats per minute`, bp: `${B.bp_sys} over ${B.bp_dia}`, glucose: `${B.glucose}`, temp: `${B.temp?.toFixed(1)} degrees`, sleep: `${B.sleep} hours`,
};

/** Words that point at each number. Checked in this order, so "heart rate" wins over "heart". */
const WORDS: [MetricId, RegExp][] = [
  ['bp', /blood pressure|\bbp\b|pressure/],
  ['hr', /heart ?rate|pulse|heart ?beat|\bbpm\b|\bheart\b/],
  ['glucose', /sugar|glucose/],
  ['temp', /temperature|\btemp\b|fever/],
  ['sleep', /sleep|slept|tired|rest/],
  ['mood', /mood|feel|feeling|mental|stress|sad|happy|lonely/],
  ['exercise', /exercise|workout|training|gym|ared|treadmill|bike/],
];

const PAGES: Record<string, string> = {
  '/': 'This is Home. The top line says how you are, the button is the one thing to do now, and the body shows which part needs a look.',
  '/log': 'This is Measure. It asks one number at a time and shows your usual next to it.',
  '/events': 'This is Alerts. When a number is far from your usual, it walks you through 3 steps and helps you tell the doctor.',
  '/scan': 'This is the camera scan. 30 seconds in front of the camera gives your heart beats per minute, and no video is saved.',
  '/tests': 'These are the thinking tests. They compare your reaction speed and memory with your own usual.',
  '/reentry': `This is Re-entry. It shows how ready your body is for gravity and your training plan until landing on Day ${LANDING_DAY}.`,
  '/trends': 'This is History. Each chart shows your number over time, with a dashed line for your usual.',
  '/routine': 'This is today’s plan: what to measure and which exercise to do.',
  '/evidence': 'This is Learn. It explains each number and where the rules come from.',
  '/crew': 'This is Progress. Points come from showing up and being honest, never from good numbers.',
};

const name = (m: MetricId) => METRICS[m].short.toLowerCase();

function spoken(r: RuleResult): string {
  if (r.metric === 'bp') return r.display.replace('/', ' over ');
  if (r.metric === 'sleep') return `${r.display} hours`;
  if (r.metric === 'hr') return `${r.display} beats per minute`;
  if (r.metric === 'temp') return `${r.display} degrees`;
  if (r.metric === 'mood') return `${r.display} out of 5`;
  if (r.metric === 'exercise') return `${r.display}% of your plan`;
  return r.display;
}

function action(m: MetricId, s: StatusKey): string {
  if (s === 'nodata') return `Log your ${name(m)} on the Measure page.`;
  if (s === 'ok') return 'Nothing to do. Keep your routine.';
  if (s === 'act') return 'Rest 5 minutes, measure again, then tell the doctor.';
  if (m === 'bp') return 'Measure again after 10 minutes of rest.';
  if (m === 'sleep') return 'Start your next sleep period on time tonight.';
  if (m === 'exercise') return 'Do today’s training on the Re-entry page.';
  if (m === 'mood') return 'Talk to someone you trust today, and tell the doctor if it stays low.';
  return `Measure your ${name(m)} again later today.`;
}

/** "Your face looked tense in today's scan." when today's camera scan read the face, else ''. */
function faceLine(): string {
  const st = useAstra.getState();
  const f = st.lastFace;
  if (!f?.look || f.at.slice(0, 10) !== st.now().toISOString().slice(0, 10)) return '';
  return `Your face looked ${f.look.toLowerCase()} in today’s scan.`;
}

/** "Am I tired?" / "How do I look?" from today's camera scan; null when there is no scan today (then the sleep answer runs). */
function tiredAnswer(): AtlasAnswer | null {
  const st = useAstra.getState();
  const t = st.lastTired;
  if (!t || t.at.slice(0, 10) !== st.now().toISOString().slice(0, 10)) return null;
  const link = { to: '/scan', label: 'Open the scan' };
  if (t.learning) return { text: 'That was your first scan, so it is now your usual. Scan again tomorrow and I can compare.', link };
  if (!t.count) return { text: 'Today’s scan showed no tired signs compared with your usual.', status: 'ok', link };
  return { text: `${signsSaid(t.signs)}${t.count >= 2 ? ' Sleep counts tonight.' : ''}`, status: t.count >= 3 ? 'act' : t.count === 2 ? 'watch' : 'ok', link: t.count >= 2 ? { to: '/routine', label: 'Open your sleep plan' } : link };
}

export function aboutMetric(m: MetricId, r: RuleResult): AtlasAnswer {
  const face = m === 'mood' ? faceLine() : '';
  if (r.status === 'nodata' || r.display === '—') {
    return { text: `There is no recent ${name(m)} number.${face ? ` ${face}` : ''} ${action(m, 'nodata')}`, status: 'nodata', link: { to: `/log?focus=${m}`, label: `Log ${name(m)}` }, focus: systemOf(m) };
  }
  const first = m === 'sleep' ? `You slept ${spoken(r)}.` : `Your ${name(m)} is ${spoken(r)} today.`;
  const value = parseFloat(r.display);
  const usual = USUAL_NUM[m];
  const said = USUAL_SAID[m];
  let meaning: string;
  if (r.status === 'ok') meaning = said ? `That’s close to your usual ${said}.` : 'That’s in range.';
  else if (r.status === 'act') meaning = 'That’s far from your usual, so it needs you now.';
  else if (usual !== undefined && Number.isFinite(value)) meaning = `That’s a bit ${value > usual ? 'higher' : 'lower'} than your usual${said ? ` ${said}` : ''}.`;
  else meaning = r.plain;
  if (face) meaning = face;
  const link = r.status === 'act' ? { to: '/events', label: 'Open the 3 steps' } : m === 'exercise' ? { to: '/reentry', label: 'Open training' } : r.status === 'watch' ? { to: `/log?focus=${m}`, label: m === 'sleep' || m === 'mood' ? `Log ${name(m)}` : `Measure ${name(m)}` } : undefined;
  return { text: `${first} ${meaning} ${action(m, r.status)}`, status: r.status, link, focus: systemOf(m) };
}

export function overall(ctx: AtlasContext): AtlasAnswer {
  const off = METRIC_ORDER.filter((m) => ctx.results[m].status === 'act' || ctx.results[m].status === 'watch')
    .sort((a, b) => (ctx.results[b].status === 'act' ? 1 : 0) - (ctx.results[a].status === 'act' ? 1 : 0));
  if (off.length === 0) return { text: 'All your numbers are close to your usual. Nothing needs a look. Keep your routine.', status: 'ok' };
  const list = off.map(name);
  const joined = list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}` : list[0];
  const worst = ctx.results[off[0]].status;
  return {
    text: `${off.length === 1 ? 'One thing needs' : `${off.length} things need`} a look: ${joined}. Start with ${name(off[0])}. ${action(off[0], worst)}`,
    status: worst,
    link: worst === 'act' ? { to: '/events', label: 'Open the 3 steps' } : { to: `/log?focus=${off[0]}`, label: `Measure ${name(off[0])}` },
    focus: systemOf(off[0]),
  };
}

function reentry(ctx: AtlasContext): AtlasAnswer {
  const { doneThisWeek } = weekProgress(ctx.day, ctx.done);
  const r = readiness(doneThisWeek);
  const left = sessionsFor(ctx.day).filter((s) => !ctx.done[reentryKey(ctx.day, s.id)]).length;
  return {
    text: `Your re-entry readiness is ${r.score} of 100, ${LANDING_DAY - ctx.day} days before landing. ${r.first.label} is the part to improve first. ${left ? `You have ${left} training session${left > 1 ? 's' : ''} left today.` : 'Today’s training is done.'}`,
    status: r.status,
    link: { to: '/reentry', label: 'Open re-entry' },
  };
}

export function askAtlas(question: string, ctx: AtlasContext): AtlasAnswer {
  const q = question.toLowerCase().trim();
  if (!q) return { text: 'Ask me about one of your numbers, for example: how is my blood pressure?' };
  if (/^(close|stop|cancel|that'?s all|thanks?|thank you|goodbye|bye|done)\b/.test(q) || /^(شكرا|شكراً|مع السلامة|خلاص|توقف|اغلق|أغلق)/.test(q)) return { text: 'Okay.', close: true, end: true };
  const go = q.match(/^(?:please\s+)?(?:open|go to|show(?: me)?|take me to|switch to)\s+(?:the\s+)?(.+)$/);
  if (go) {
    const route = ROUTES.find(([re]) => re.test(go[1]));
    if (route) return { text: `Sure. Opening ${route[2]}.`, navigate: route[1], close: true, did: `Opened ${route[2]}` };
  }
  if (/what is this|this page|where am i|what can i do here|help/.test(q)) {
    return { text: PAGES[ctx.pathname] ?? 'Ask me about your numbers, your training or how you are today.' };
  }
  if (/re-?entry|landing|gravity|ready|go home/.test(q)) return reentry(ctx);
  if (/delay|message|reach earth|doctor|surgeon/.test(q)) {
    const m = MISSION_BY_ID[ctx.mission];
    return { text: m.delaySec >= 60 ? `From ${m.label}, a message reaches Earth in about ${Math.round(m.delaySec / 60)} minutes. A reply takes at least twice that. Keep following the steps while you wait.` : `From ${m.label}, the doctor gets your message in about a second. Use the Alerts page to send it.`, link: { to: '/events', label: 'Open Alerts' } };
  }
  if (/\btired\b|how do i look|sleepy|exhausted|fatigue/.test(q)) { const t = tiredAnswer(); if (t) return t; }
  const hit = WORDS.find(([, re]) => re.test(q));
  if (hit) return aboutMetric(hit[0], ctx.results[hit[0]]);
  if (/how am i|how are my|overall|status|anything wrong|okay|ok\b/.test(q)) return overall(ctx);
  if (/what should i do|next|now|first/.test(q)) return overall(ctx);
  return { text: 'I can answer about blood pressure, heart rate, sleep, blood sugar, temperature, mood, exercise and re-entry. Try: how am I today?' };
}

/** Three suggested questions that fit the page the astronaut is on. */
export function suggestionsFor(pathname: string): string[] {
  if (pathname === '/reentry') return ['Am I ready for re-entry?', 'How is my exercise?', 'What should I do next?'];
  if (pathname === '/tests') return ['What is this page?', 'How did I sleep?', 'How is my mood?'];
  if (pathname === '/scan') return ['How is my heart rate?', 'What is this page?', 'How am I today?'];
  if (pathname === '/events') return ['How long does a message take?', 'How is my blood pressure?', 'What should I do next?'];
  return ['How am I today?', 'How is my blood pressure?', 'How did I sleep?'];
}

// ---------- the assistant on the station server (AI model + action registry), with the rules above as the fallback ----------

type AtlasSource = 'ai' | 'rules';
export type SmartAnswer = AtlasAnswer & { source: AtlasSource };

const isArabic = (q: string) => /[\u0600-\u06FF]/.test(q);
const L = (ar: boolean, en: string, arText: string) => (ar ? arText : en);

/** Questions the rules answer better than the model: the app's own pages, re-entry and message delay (English). */
const RULES_ONLY = /what is this|this page|where am i|what can i do here|help|re-?entry|landing|gravity|ready|go home|delay|message|reach earth|doctor|surgeon/;

/** Replies where the model only refuses ("I cannot ...", "no access", "not able"). */
const REFUSAL = /\b(cannot|can't|can not|unable|not able|no access|full access|don't have access|do not have access|not allowed)\b|لا أستطيع|لا يمكنني|غير قادر|ليس لدي صلاحية|لا أملك صلاحية|لا أملك وصول/i;

const MODEL_TTL_MS = 30_000;
let modelState: { at: number; ok: boolean; hint?: string } | null = null;
async function modelAvailable(): Promise<{ ok: boolean; hint?: string }> {
  if (modelState && Date.now() - modelState.at < MODEL_TTL_MS) return modelState;
  try {
    const st = await server.atlasStatus();
    modelState = { at: Date.now(), ok: st.model.reachable && st.model.model_installed, hint: st.model.hint };
  } catch (e) {
    modelState = { at: Date.now(), ok: false, hint: e instanceof Error ? e.message : String(e) };
  }
  return modelState;
}
/** Forget what was learned about the model (after a failure, so the next question looks again). */
export function forgetModelState() { modelState = null; }

const METRIC_OF: Record<string, MetricId> = {
  heart_rate: 'hr', bp_systolic: 'bp', bp_diastolic: 'bp', glucose: 'glucose', body_temp: 'temp', sleep_hours: 'sleep', mood: 'mood', exercise_minutes: 'exercise', exercise_min: 'exercise',
};
const NAME_AR: Record<string, string> = {
  heart_rate: 'معدل ضربات القلب', bp_systolic: 'الضغط الانقباضي', bp_diastolic: 'الضغط الانبساطي', glucose: 'سكر الدم', body_temp: 'حرارة الجسم', spo2: 'تشبع الأكسجين',
  sleep_hours: 'ساعات النوم', mood: 'المزاج', exercise_minutes: 'دقائق التمرين', exercise_min: 'دقائق التمرين', radiation_dose_cumulative: 'جرعة الإشعاع',
};
const NAME_EN: Record<string, string> = {
  heart_rate: 'heart rate', bp_systolic: 'top blood pressure', bp_diastolic: 'bottom blood pressure', glucose: 'blood sugar', body_temp: 'temperature', spo2: 'blood oxygen',
  sleep_hours: 'sleep', mood: 'mood', exercise_minutes: 'exercise minutes', exercise_min: 'exercise minutes', radiation_dose_cumulative: 'radiation dose',
};
const nameOf = (code: string, ar: boolean) => (ar ? NAME_AR[code] : NAME_EN[code]) ?? code.replace(/_/g, ' ');
const unitOf = (u: string) => (u === 'score' ? '/5' : u);
const num = (v: unknown) => (typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(1)) : String(v));
const arr = (x: unknown): Record<string, unknown>[] => (Array.isArray(x) ? (x as Record<string, unknown>[]) : []);
const obj = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {});
const firstSentence = (t: unknown) => String(t ?? '').split(/(?<=[.!?])\s/)[0];

/** Turn what a read action returned into one or two plain sentences, in the person's language. */
function describeRead(name: string, args: Record<string, unknown>, result: unknown, ctx: AtlasContext, ar: boolean, fallback: string): AtlasAnswer {
  const lang = ar ? 'ar' : 'en';
  const code = String(args.indicator ?? '');
  switch (name) {
    case 'get_latest': {
      const m = METRIC_OF[code];
      const row = arr(result)[0];
      if (!ar && m) return { ...aboutMetric(m, ctx.results[m]), lang };   // the same friendly answer as the rules, from the numbers on screen
      if (!row || row.value === null || row.value === undefined) return { text: L(ar, `There is no recent ${nameOf(code, false)} number.`, `لا توجد قراءة حديثة لـ${nameOf(code, true)}.`), status: 'nodata', lang };
      return { text: L(ar, `Your latest ${nameOf(code, false)} is ${num(row.value)} ${unitOf(String(row.unit))}.`, `آخر قراءة لـ${nameOf(code, true)} هي ${num(row.value)} ${unitOf(String(row.unit))}.`), link: m ? { to: `/log?focus=${m}`, label: L(ar, 'Log it again', 'سجّلها من جديد') } : undefined, lang };
    }
    case 'show_overview': {
      if (!ar) return { ...overall(ctx), lang };
      const o = overall(ctx);
      return { text: o.status === 'ok' ? 'كل أرقامك قريبة من المعتاد. لا شيء يحتاج انتباهك.' : 'بعض أرقامك تحتاج نظرة. افتح الصفحة الرئيسية لترى التفاصيل.', status: o.status, link: o.link, lang };
    }
    case 'list_alerts': case 'alert_history': {
      const rows = arr(result);
      if (rows.length === 0) return { text: L(ar, 'No alerts from the station server.', 'لا توجد تنبيهات من الخادم.'), status: 'ok', lang };
      return { text: L(ar, `${rows.length} alert${rows.length > 1 ? 's' : ''} on the station server. First: ${firstSentence(rows[0].explanation)}`, `هناك ${rows.length} تنبيه على الخادم. الأول: ${firstSentence(rows[0].explanation)}`), status: 'watch', link: { to: '/events', label: L(ar, 'Open Alerts', 'افتح التنبيهات') }, lang };
    }
    case 'list_events': {
      const rows = arr(result);
      const open = rows.filter((e) => e.status !== 'closed').length;
      return { text: L(ar, rows.length ? `${rows.length} event${rows.length > 1 ? 's' : ''}, ${open} still open.` : 'No events yet.', rows.length ? `لديك ${rows.length} حدث، منها ${open} مفتوح.` : 'لا توجد أحداث بعد.'), link: { to: '/events', label: L(ar, 'Open Alerts', 'افتح التنبيهات') }, lang };
    }
    case 'show_event': {
      const ev = obj(obj(result).event); const fu = arr(obj(result).follow_ups);
      return { text: L(ar, `${ev.title ?? 'Event'}: ${ev.status}. ${fu.filter((f) => f.completed_at).length} of ${fu.length} follow-ups done.`, `${ev.title ?? 'الحدث'}: ${ev.status}. أُنجز ${fu.filter((f) => f.completed_at).length} من ${fu.length} متابعات.`), lang };
    }
    case 'list_routines': {
      const rows = arr(result); const due = rows.filter((r) => r.due);
      return { text: L(ar, due.length ? `${due.length} routine${due.length > 1 ? 's' : ''} due: ${due.slice(0, 3).map((r) => r.title).join('; ')}.` : 'Nothing is due in your routines.', due.length ? `لديك ${due.length} من الروتين مستحق: ${due.slice(0, 3).map((r) => r.title).join('؛ ')}.` : 'لا شيء مستحق في الروتين.'), link: { to: '/routine', label: L(ar, 'Open the plan', 'افتح الخطة') }, lang };
    }
    case 'show_trend': {
      const pts = arr(obj(result).points); const m = METRIC_OF[code];
      if (pts.length === 0) return { text: L(ar, `There is no history for ${nameOf(code, false)} yet.`, `لا يوجد سجل لـ${nameOf(code, true)} بعد.`), status: 'nodata', lang };
      const avg = pts.reduce((a, p) => a + Number(p.avg), 0) / pts.length; const last = pts[pts.length - 1];
      const u = unitOf(String(obj(result).unit ?? ''));
      return { text: L(ar, `Over ${pts.length} days your ${nameOf(code, false)} averaged ${num(avg)} ${u}. The latest day was ${num(last.avg)} ${u}.`, `خلال ${pts.length} يوماً كان متوسط ${nameOf(code, true)} ${num(avg)} ${u}. آخر يوم: ${num(last.avg)} ${u}.`), link: { to: m ? `/trends?metric=${m}` : '/trends', label: L(ar, 'Open History', 'افتح السجل') }, lang };
    }
    case 'env_latest': {
      const row = arr(result)[0];
      return row && row.value !== null ? { text: L(ar, `Latest cabin ${row.parameter}: ${num(row.value)} ${row.unit}.`, `آخر قراءة في المقصورة (${row.parameter}): ${num(row.value)} ${row.unit}.`), link: { to: '/cabin', label: L(ar, 'Open Cabin', 'افتح المقصورة') }, lang } : { text: L(ar, 'No cabin data for that yet. Load the ISS files first.', 'لا توجد بيانات مقصورة بعد. حمّل ملفات المحطة أولاً.'), status: 'nodata', lang };
    }
    case 'assess_env': {
      const a = obj(result);
      return { text: L(ar, `${a.parameter} ${num(a.value)} ${a.unit}: ${a.status}. ${firstSentence(a.note)}`, `${a.parameter} ${num(a.value)} ${a.unit}: ${a.status}.`), link: { to: '/cabin', label: L(ar, 'Open Cabin', 'افتح المقصورة') }, lang };
    }
    case 'env_model': return { text: L(ar, `The cabin model covers ${Object.keys(obj(obj(result).parameters)).length} parameters from past ISS missions.`, `نموذج المقصورة يغطي ${Object.keys(obj(obj(result).parameters)).length} مؤشرات من مهام المحطة السابقة.`), link: { to: '/cabin', label: L(ar, 'Open Cabin', 'افتح المقصورة') }, lang };
    case 'show_evidence': { const rows = arr(result); return { text: L(ar, `${rows.length} sources behind ASTRA: ${rows.slice(0, 2).map((r) => r.title).join('; ')}.`, `${rows.length} مصادر وراء ASTRA، منها: ${rows.slice(0, 2).map((r) => r.title).join('؛ ')}.`), link: { to: '/evidence', label: L(ar, 'Open Learn', 'افتح التعلم') }, lang }; }
    case 'list_astronauts': { const rows = arr(result); return { text: L(ar, `${rows.length} astronaut${rows.length > 1 ? 's' : ''}: ${rows.map((r) => r.display_name).join(', ')}.`, `رواد الفضاء (${rows.length}): ${rows.map((r) => r.display_name).join('، ')}.`), lang }; }
    case 'list_import_files': { const o = obj(result); return { text: L(ar, `${arr(o.raw_csv).length} data files and ${arr(o.mappings).length} mappings are ready to import.`, `يوجد ${arr(o.raw_csv).length} ملف بيانات و${arr(o.mappings).length} ملف ربط جاهزة للاستيراد.`), link: { to: '/cabin', label: L(ar, 'Open Cabin', 'افتح المقصورة') }, lang }; }
    case 'import_log': { const rows = arr(result); return { text: L(ar, rows.length ? `${rows.length} import${rows.length > 1 ? 's' : ''} so far.` : 'Nothing has been imported yet.', rows.length ? `تم ${rows.length} استيراد حتى الآن.` : 'لم يتم استيراد شيء بعد.'), lang }; }
    case 'eye_history': { const rows = arr(result); return { text: L(ar, rows.length ? `${rows.length} eye screening${rows.length > 1 ? 's' : ''} on file. Latest: ${rows[0].status}.` : 'No eye screenings yet.', rows.length ? `لديك ${rows.length} فحص عين. الأحدث: ${rows[0].status}.` : 'لا توجد فحوصات عين بعد.'), lang }; }
    default: return { text: fallback, lang };
  }
}

/** The one-line description of a write Atlas wants to make, shown before the person approves it. */
function describeWrite(c: server.AtlasConfirm, ar: boolean, replyText: string): string {
  const a = c.summary.args ?? {};
  switch (c.summary.action) {
    case 'log_measurement': return L(ar, `Save ${nameOf(String(a.indicator), false)}: ${a.value}${a.unit ? ` ${a.unit}` : ''}?`, `حفظ ${nameOf(String(a.indicator), true)}: ${a.value}؟`);
    case 'acknowledge_alert': return L(ar, 'Mark this alert as seen?', 'تعليم هذا التنبيه كمقروء؟');
    case 'complete_routine': return L(ar, 'Tick this routine as done?', 'تعليم هذا الروتين كمنجز؟');
    case 'open_event': return L(ar, `Open an event: ${a.title}?`, `فتح حدث: ${a.title}؟`);
    default: return c.summary.description ?? replyText;
  }
}

/**
 * Atlas with the assistant on the station server (the fine-tuned model picks one allow-listed action; the server runs it),
 * and the rules above for the app's own pages, navigation and as the fallback. Never throws.
 */
export async function askAtlasSmart(question: string, ctx: AtlasContext): Promise<SmartAnswer> {
  const rules = askAtlas(question, ctx);
  const q = question.toLowerCase().trim();
  const ar = isArabic(question);
  const local = (note?: string): SmartAnswer => ({ ...(ar ? { text: note ?? 'للإجابة بالعربية أحتاج النموذج الذكي، وهو غير متصل الآن.', lang: 'ar' as const } : rules), source: 'rules' });
  if (!q) return { ...rules, source: 'rules' };
  if (!ar && (rules.navigate || rules.close || RULES_ONLY.test(q))) return { ...rules, source: 'rules' };
  if (useAstra.getState().dataSource !== 'live') return local();
  const m = await modelAvailable();
  if (!m.ok) return local();
  const astronaut = await activeAstronaut();
  if (!astronaut) return local();
  let r: server.AtlasReply;
  try {
    r = await server.atlasCommand(question, astronaut.id, ctx.at ?? useAstra.getState().now().toISOString());
  } catch {
    forgetModelState();
    return local();
  }
  const rlang = r.lang === 'ar' || (r.lang !== 'en' && ar) ? 'ar' : 'en';
  const arr_ = rlang === 'ar';
  const say = r.reply ?? '';
  switch (r.status) {
    case 'needs_confirmation':
      if (!r.confirm) return { text: say, source: 'ai', lang: rlang };
      return { text: describeWrite(r.confirm, arr_, say), confirm: r.confirm, source: 'ai', lang: rlang };
    case 'executed': {
      const a = describeRead(r.action?.name ?? '', r.action?.args ?? {}, r.result, ctx, arr_, say || L(arr_, 'Done.', 'تم.'));
      return { ...a, source: 'ai' };
    }
    case 'ui': {
      const ui = r.ui ?? { op: '' };
      if (ui.op === 'navigate' && ui.route) return { text: say || L(arr_, 'Opening it.', 'حسناً، أفتحها.'), navigate: ui.route === '/eye' ? '/scan' : ui.route, close: true, did: `Opened ${ui.route === '/eye' ? '/scan' : ui.route}`, source: 'ai', lang: rlang };
      if (ui.op === 'set_theme') {
        const mode = ui.args?.mode;
        if (mode === 'dark' || mode === 'light') useAstra.getState().setTheme(mode);
        return { text: say || L(arr_, 'Done.', 'تم.'), did: `Switched to ${String(mode)} mode`, source: 'ai', lang: rlang };
      }
      if (ui.op === 'set_language') {
        useAstra.getState().toast({ kind: 'info', title: L(arr_, 'Language', 'اللغة'), body: L(arr_, 'The screen is English only for now. Atlas still answers in Arabic.', 'الشاشة بالإنجليزية فقط حالياً، لكن أطلس يجيب بالعربية.') });
        return { text: say || L(arr_, 'Done.', 'تم.'), source: 'ai', lang: rlang };
      }
      if (ui.op === 'select_astronaut' && ui.astronaut_id !== undefined) {
        const ok = await switchAstronaut(ui.astronaut_id).catch(() => false);
        return { text: ok ? say || L(arr_, `Showing ${ui.display_name ?? 'that astronaut'}.`, `أعرض ${ui.display_name ?? 'الرائد'}.`) : L(arr_, 'I could not switch astronaut.', 'تعذّر تغيير الرائد.'), did: ok ? `Switched to ${ui.display_name ?? 'another astronaut'}` : undefined, source: 'ai', lang: rlang };
      }
      if (ui.op === 'stop_speaking') return { text: say || L(arr_, 'Okay.', 'حسناً.'), silence: true, source: 'ai', lang: rlang };
      return { text: say || L(arr_, 'Done.', 'تم.'), source: 'ai', lang: rlang };
    }
    case 'chat': case 'needs_clarification': {
      // the small model says "I cannot do that / I have no access" to things it just does not know: answer with what Atlas really can do
      if (r.status === 'chat' && REFUSAL.test(say)) {
        const GENERIC = /^I can answer about/;
        if (!ar && !GENERIC.test(rules.text)) return { ...rules, source: 'rules' };
        return { text: L(arr_, 'I could not do that one. I can read your numbers, save a measurement, open any page, show the heart or another body part, and switch dark or light mode. Try: show my heart, or log my sleep 7 hours.', 'لم أستطع تنفيذ هذا. أستطيع قراءة أرقامك وحفظ قياس وفتح أي صفحة وعرض القلب أو أي جزء من الجسم وتبديل الوضع الداكن أو الفاتح. جرّب: اعرض قلبي، أو سجّل نومي ٧ ساعات.'), source: 'ai', lang: rlang };
      }
      return { text: say, source: 'ai', lang: rlang };
    }
    default: {
      // the model's answer was not usable: the rules still answer what they can
      forgetModelState();
      return ar ? { text: say || 'عذراً، لم أفهم الطلب. هل يمكنك إعادته؟', lang: 'ar', source: 'ai' } : { ...rules, source: 'rules' };
    }
  }
}

/** The person approved or cancelled a write. Approved writes change the server, so the readings are read again. */
/** What a write did, in the past tense, with the real values, so the person can check Atlas heard them right. */
function writeDone(c: server.AtlasConfirm, ar: boolean): { text: string; did: string } {
  const a = c.summary.args ?? {};
  switch (c.summary.action) {
    case 'log_measurement': {
      const unit = a.unit ? ` ${a.unit === 'score' ? '/5' : a.unit}` : '';
      const en = `${nameOf(String(a.indicator), false)}: ${a.value}${unit}`;
      return { text: L(ar, `Saved ${en}.`, `تم حفظ ${nameOf(String(a.indicator), true)}: ${a.value}.`), did: `Saved ${en}` };
    }
    case 'acknowledge_alert': return { text: L(ar, 'Alert marked as seen.', 'تم تعليم التنبيه كمقروء.'), did: 'Alert marked as seen' };
    case 'complete_routine': return { text: L(ar, 'Routine ticked as done.', 'تم تعليم الروتين كمنجز.'), did: 'Routine ticked as done' };
    case 'open_event': return { text: L(ar, 'Event opened.', 'تم فتح الحدث.'), did: 'Event opened' };
    case 'add_astronaut': return { text: L(ar, 'Astronaut added.', 'تمت إضافة الرائد.'), did: 'Astronaut added' };
    default: return { text: L(ar, 'Done. It is saved on the station server.', 'تم. حُفظ على الخادم.'), did: 'Saved on the station server' };
  }
}

export async function settleAtlas(c: server.AtlasConfirm, approve: boolean, ar: boolean): Promise<{ text: string; ok: boolean; did?: string }> {
  try {
    const r = await server.atlasConfirm(c.token, approve);
    if (!approve) return { text: r.reply ?? L(ar, 'Cancelled, nothing was changed.', 'تم الإلغاء، لم يتغير شيء.'), ok: true };
    if (r.status === 'executed') {
      useAstra.setState((s) => ({ clockOffsetMin: s.clockOffsetMin + 1 })); // the next number gets its own minute
      await reloadLive();
      const d = writeDone(c, ar);
      return { text: d.text, ok: true, did: d.did };
    }
    return { text: r.reply ?? L(ar, 'It did not work.', 'لم ينجح الأمر.'), ok: false };
  } catch (e) {
    const expired = e instanceof server.ApiError && e.status === 404;
    return { text: expired ? L(ar, 'That confirmation expired. Ask again.', 'انتهت صلاحية التأكيد. اطلب مرة أخرى.') : L(ar, `It did not work: ${e instanceof Error ? e.message : String(e)}`, 'لم ينجح الأمر.'), ok: false };
  }
}
