import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ArrowUp, Ban, Check, ChevronDown, ChevronUp, Ear, Keyboard, Mic, Send, Square, Volume2, VolumeX, X, Zap } from 'lucide-react';
import { useReducedMotion } from 'framer-motion';
import { useAstra } from '../store/useAstra';
import { useDerived } from '../store/derived';
import { missionDay } from '../lib/time';
import { askAtlas, askAtlasSmart, settleAtlas, suggestionsFor, type AtlasAnswer, type SmartAnswer } from '../lib/atlas';
import { StatusPill } from './Status';
import { SYSTEMS } from '../lib/systems';

/** `a` is null while Atlas is still thinking. `settled` is set once a write the assistant proposed was approved or cancelled. */
interface Turn { id: number; q: string; a: SmartAnswer | null; settled?: 'approved' | 'cancelled' | 'failed'; note?: string }
type Mode = 'closed' | 'voice' | 'text';
type VoiceState = 'listening' | 'thinking' | 'speaking' | 'idle';
type Lang = 'en-US' | 'ar-SA';

/** Minimal typing for the browser speech API (Chrome ships it as webkitSpeechRecognition). */
interface RecResult { isFinal: boolean; 0: { transcript: string } }
interface Recognition {
  lang: string; interimResults: boolean; continuous: boolean; maxAlternatives: number;
  start: () => void; stop: () => void; abort: () => void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<RecResult> }) => void) | null;
  onend: (() => void) | null; onerror: ((e: { error: string }) => void) | null;
}
type RecognitionCtor = new () => Recognition;
const w = typeof window === 'undefined' ? undefined : (window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor });
const SpeechRec: RecognitionCtor | undefined = w?.SpeechRecognition ?? w?.webkitSpeechRecognition;

/** In the voice view, a model answer slower than this is replaced by the rules answer, so the view never hangs. */
const VOICE_WAIT_MS = 12_000;
/** After "Atlas" is heard, how long Atlas waits for the question before it goes back to sleep. */
const WAKE_QUESTION_MS = 8000;
/** Shown under model answers only, never spoken. */
const AI_NOTE = 'Small local model, can be wrong. Not medical advice.';

/** The name that wakes Atlas. The browser may write the Arabic name several ways. */
const WAKE_RE = /(?:^|[\s,.!?])(?:hey |ok |okay |hi |يا |هاي )?(atlas|أطلس|اطلس|أتلس|اتلس|أطلاس|اطلاس|ايتلس)(?=$|[\s,.!?])/i;
const YES_RE = /^(yes|yeah|yep|ok|okay|sure|confirm|do it|go ahead|approve|نعم|ايوه|أيوه|اي|أكيد|تمام|أكد|أكّد|نفّذ|نفذ)\b/i;
const NO_RE = /^(no|nope|cancel|stop|don'?t|never mind|لا|إلغاء|الغاء|ألغ|الغي|لا تنفذ|توقف)\b/i;
const LANG_KEY = 'astra-atlas-lang';
const WAKE_KEY = 'astra-atlas-wake';
const QUICK_KEY = 'astra-atlas-quick';
const LOG_KEY = 'astra-atlas-log';
/** How many silent listening rounds in a row before Atlas goes back to sleep. */
const MAX_SILENT_ROUNDS = 2;
interface DidEntry { id: number; at: string; text: string }
const readLog = (): DidEntry[] => { try { const v = JSON.parse(readPref(LOG_KEY) ?? '[]'); return Array.isArray(v) ? v.slice(0, 30) : []; } catch { return []; } };

function stopSpeaking() {
  try { window.speechSynthesis?.cancel(); } catch (err) { console.warn('Atlas could not stop speaking', err); }
}
const readPref = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const writePref = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage blocked: the choice lasts until the page closes */ } };

/**
 * ATLAS on every page. Say "Atlas" (or tap the button) and talk: a voice bar and waves move with your voice and with Atlas's,
 * then it closes by itself. Writes the assistant proposes wait for a yes (say it, or tap the button).
 */
export function AtlasDock() {
  const [mode, setMode] = useState<Mode>('closed');
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const [heard, setHeard] = useState('');
  const [reply, setReply] = useState<(AtlasAnswer & { source?: SmartAnswer['source'] }) | null>(null);
  const [text, setText] = useState('');
  /** A write is waiting for a yes or no. */
  const [awaiting, setAwaiting] = useState(false);
  /** The voice band shrinks to a slim strip so the body or the page underneath stays visible. */
  const [compact, setCompact] = useState(false);
  /** The typed panel shrinks to its title bar for the same reason. */
  const [minimized, setMinimized] = useState(false);
  /** Quick save: numbers the person tells Atlas to log are saved right away and read back. Off: Atlas asks first. */
  const [quickSave, setQuickSave] = useState<boolean>(() => readPref(QUICK_KEY) !== 'off');
  const quickRef = useRef(quickSave);
  quickRef.current = quickSave;
  /** What Atlas actually did, newest first, kept in this browser. */
  const [activity, setActivity] = useState<DidEntry[]>(readLog);
  const [recentDid, setRecentDid] = useState('');
  /** Listening rounds in a row where nothing was said. */
  const silentRounds = useRef(0);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [speakAloud, setSpeakAloud] = useState(true);
  const [lang, setLang] = useState<Lang>(() => (readPref(LANG_KEY) === 'ar-SA' ? 'ar-SA' : 'en-US'));
  const [wakeOn, setWakeOn] = useState<boolean>(() => readPref(WAKE_KEY) !== 'off');
  /** Whether the "Atlas" listener is running, and why not when it is not. */
  const [wakeState, setWakeState] = useState<'off' | 'on' | 'blocked'>('off');
  const rec = useRef<Recognition | null>(null);
  const closeTimer = useRef<number | null>(null);
  /** Bumped when Atlas closes or starts listening again: a late answer from before is shown but not spoken. */
  const gen = useRef(0);
  const level = useRef(0);
  const mic = useRef<{ stream: MediaStream; ctx: AudioContext; raf: number } | null>(null);
  /** A write waiting for a yes or no. */
  const pending = useRef<{ turnId: number; answer: SmartAnswer } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const langRef = useRef(lang);
  langRef.current = lang;
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { results, now } = useDerived();
  const mission = useAstra((s) => s.mission);
  const done = useAstra((s) => s.routineDone);
  const context = () => ({ results, day: missionDay(now), mission, pathname, done, at: now.toISOString() });
  const answerFor = (q: string) => askAtlasSmart(q, context());
  const logDid = (text: string) => {
    const entry: DidEntry = { id: Date.now() + Math.random(), at: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), text };
    setRecentDid(text);
    setActivity((a) => { const next = [entry, ...a].slice(0, 30); writePref(LOG_KEY, JSON.stringify(next)); return next; });
  };

  const stopMic = () => {
    if (!mic.current) return;
    cancelAnimationFrame(mic.current.raf);
    mic.current.stream.getTracks().forEach((t) => t.stop());
    mic.current.ctx.close().catch((err) => console.warn('Atlas audio close', err));
    mic.current = null;
    level.current = 0;
  };

  /** Loudness of the voice drives the bars and waves. Only a level number is read; no sound is recorded or kept. */
  const startMic = async () => {
    if (mic.current) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      const tick = () => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
        level.current = Math.min(1, Math.sqrt(sum / buf.length) * 6);
        if (mic.current) mic.current.raf = requestAnimationFrame(tick);
      };
      mic.current = { stream, ctx, raf: requestAnimationFrame(tick) };
    } catch (err) {
      console.warn('Atlas: no microphone level, waves use a steady motion', err);
    }
  };

  const closeAll = useCallback(() => {
    gen.current++;
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    rec.current?.abort();
    rec.current = null;
    wakeCtl.current?.release();
    pending.current = null; setAwaiting(false);
    stopMic();
    stopSpeaking();
    setVoiceState('idle');
    setCompact(false);
    setRecentDid('');
    setMode('closed');
  }, []);
  useEffect(() => closeAll, [closeAll]);

  useEffect(() => {
    if (mode === 'closed') return;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') closeAll(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [mode, closeAll]);
  useEffect(() => { if (mode === 'text') input.current?.focus(); }, [mode]);
  useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight }); }, [turns]);

  const chooseLang = () => {
    const next: Lang = langRef.current === 'en-US' ? 'ar-SA' : 'en-US';
    setLang(next);
    writePref(LANG_KEY, next);
  };

  /** Say the answer, run any command, then close the voice view a moment after Atlas stops talking. */
  const respond = (a: AtlasAnswer, fromVoice: boolean) => {
    if (a.navigate) navigate(a.navigate);
    else if (a.focus) {
      // The 3D body lives on Home: go there, then fly the camera to the part Atlas is talking about.
      if (pathname !== '/') navigate('/');
      useAstra.getState().select(a.focus);
      logDid(`Showed ${SYSTEMS.find((x) => x.id === a.focus)?.label ?? 'the body'} on the 3D body`);
    }
    if (a.did) logDid(a.did);
    // when the answer is on the screen behind Atlas (the body, a page), Atlas steps down so it can be seen
    const showing = !!(a.focus || a.navigate) && !a.end;
    if (fromVoice) setCompact(showing); else setMinimized(showing);
    const waitingForYes = !!a.confirm;
    const finish = () => {
      setVoiceState('idle');
      if (!fromVoice) { if (a.end || (a.close && !showing)) setMode('closed'); return; }
      if (a.end) { closeTimer.current = window.setTimeout(closeAll, 500); return; }
      // the conversation goes on: listen again (also for the yes or no of a write that is waiting)
      void waitingForYes;
      window.setTimeout(() => listen(), 300);
    };
    const quiet = a.silence || !speakAloud || !('speechSynthesis' in window);
    if (quiet) { window.setTimeout(finish, fromVoice ? Math.min(6000, 1200 + a.text.length * 45) : 0); return; }
    try {
      stopSpeaking();
      let finished = false;
      const once = () => { if (!finished) { finished = true; finish(); } };
      const u = new SpeechSynthesisUtterance(a.text);
      u.lang = a.lang === 'ar' ? 'ar-SA' : 'en-US';
      u.rate = 1;
      u.onend = once;
      u.onerror = once;
      // Some systems never fire onend (no installed voice): do not leave the voice view hanging.
      window.setTimeout(once, 2500 + a.text.length * 90);
      setVoiceState('speaking');
      window.speechSynthesis.speak(u);
    } catch (err) {
      console.warn('Atlas could not speak', err);
      finish();
    }
  };

  /** Approve or cancel the write Atlas proposed. */
  const settle = async (turnId: number, answer: SmartAnswer, approve: boolean, fromVoice: boolean) => {
    if (!answer.confirm) return;
    pending.current = null; setAwaiting(false);
    setVoiceState('thinking');
    const ar = answer.lang === 'ar';
    const out = await settleAtlas(answer.confirm, approve, ar);
    const settled: Turn['settled'] = !approve ? 'cancelled' : out.ok ? 'approved' : 'failed';
    setTurns((t) => t.map((x) => (x.id === turnId ? { ...x, settled, note: out.text } : x)));
    const a: SmartAnswer = { text: out.text, source: 'ai', lang: answer.lang, status: approve && out.ok ? 'ok' : undefined };
    if (approve && out.ok && out.did) {
      logDid(out.did);
      useAstra.getState().toast({ kind: 'info', title: 'Atlas', body: out.did });
    }
    setReply(a);
    respond(a, fromVoice);
  };

  /** One question, from the voice or the keyboard. A yes or no answers a write that is waiting. */
  const handleQuestion = (q: string, fromVoice: boolean) => {
    const p = pending.current;
    if (p) {
      if (YES_RE.test(q.trim())) { void settle(p.turnId, p.answer, true, fromVoice); return; }
      if (NO_RE.test(q.trim())) { void settle(p.turnId, p.answer, false, fromVoice); return; }
      pending.current = null; setAwaiting(false); // anything else is a new question, and the old proposal lapses
    }
    const id = Date.now();
    const g = gen.current;
    silentRounds.current = 0;
    if (fromVoice) setVoiceState('thinking');
    setTurns((t) => [...t.slice(-5), { id, q, a: null }]);
    const fallback = fromVoice
      ? new Promise<SmartAnswer>((res) => window.setTimeout(() => res({ ...askAtlas(q, context()), source: 'rules' }), VOICE_WAIT_MS))
      : null;
    void (fallback ? Promise.race([answerFor(q), fallback]) : answerFor(q)).then((a) => {
      if (g !== gen.current && fromVoice) return;
      setTurns((t) => t.map((x) => (x.id === id ? { ...x, a } : x)));
      if (a.confirm?.summary.action === 'log_measurement' && quickRef.current) { void settle(id, a, true, fromVoice); return; } // quick save
      if (a.confirm) { pending.current = { turnId: id, answer: a }; setAwaiting(true); }
      if (fromVoice) setReply(a);
      if (g === gen.current) respond(a, fromVoice);
    });
  };

  const listen = (preheard?: string) => {
    if (!SpeechRec) { setMode('text'); return; }
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    stopSpeaking();
    rec.current?.abort();
    gen.current++;
    setHeard(preheard ?? '');
    if (!pending.current) setReply(null); // a question waiting for yes or no stays on screen while Atlas listens for the answer
    setMode('voice'); setVoiceState('listening');
    const r = new SpeechRec();
    r.lang = langRef.current;
    r.interimResults = true;
    r.continuous = false;
    r.maxAlternatives = 1;
    let finalText = '';
    let micBlocked = false;
    r.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finalText += res[0].transcript; else interim += res[0].transcript;
      }
      setHeard((finalText + interim).trim());
    };
    r.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed' || e.error === 'audio-capture' || e.error === 'network') micBlocked = true;
      else if (e.error !== 'aborted' && e.error !== 'no-speech') console.warn('Atlas listening error', e.error);
    };
    r.onend = () => {
      if (rec.current !== r) return; // replaced or closed meanwhile
      stopMic();
      rec.current = null;
      const q = finalText.trim();
      if (micBlocked) {
        setVoiceState('idle');
        setReply({ text: 'I can’t use the microphone here. Type your question instead.' });
        closeTimer.current = window.setTimeout(() => setMode('text'), 1800);
        return;
      }
      if (!q) {
        silentRounds.current += 1;
        if (silentRounds.current < MAX_SILENT_ROUNDS) { listen(); return; } // nothing heard: try again right away
        silentRounds.current = 0;
        setVoiceState('idle');
        setReply({ text: 'I’m here whenever you need me. Say “Atlas” or tap the button.' });
        closeTimer.current = window.setTimeout(closeAll, 2500);
        return;
      }
      handleQuestion(q, true);
    };
    rec.current = r;
    void startMic();
    try { r.start(); } catch (err) { console.warn('Atlas could not listen', err); setMode('text'); }
  };

  const ask = (q: string) => {
    const question = q.trim();
    if (!question) return;
    setText('');
    handleQuestion(question, false);
  };
  const submit = (e: FormEvent) => { e.preventDefault(); ask(text); };

  const onButton = () => {
    if (mode === 'voice' && voiceState === 'listening') { rec.current?.stop(); return; }
    if (mode !== 'closed') { closeAll(); return; }
    listen();
  };

  // ---------- "Atlas" wakes the microphone ----------
  // The name listener runs only while Atlas is closed (so it never hears Atlas's own voice). When it hears the name it keeps its own
  // listening session and uses it for the question that follows, so "Atlas, how is my heart rate" works in one breath.
  const listenRef = useRef(listen);
  listenRef.current = listen;
  const handleRef = useRef(handleQuestion);
  handleRef.current = handleQuestion;
  const wakeCtl = useRef<{ sync: (closed: boolean) => void; release: () => void } | null>(null);
  /** True from the moment the name is heard until the question is handed over: the voice view is then driven by the name listener. */
  const wakeOwns = useRef(false);
  useEffect(() => {
    if (!wakeOn || !SpeechRec) { wakeCtl.current = null; setWakeState('off'); return; }
    let stopped = false;
    let running = false;
    let restart: number | undefined;
    let wokeTimer: number | undefined;
    let r: Recognition | null = null;
    const halt = () => {
      running = false;
      window.clearTimeout(restart); window.clearTimeout(wokeTimer);
      const cur = r; r = null;
      try { cur?.abort(); } catch { /* already ended */ }
    };
    const begin = () => {
      if (stopped || !running) return;
      const rec = new SpeechRec();
      r = rec;
      rec.lang = langRef.current;
      rec.interimResults = true;
      rec.continuous = true;
      rec.maxAlternatives = 1;
      let consumed = 0;       // results before this index were already looked at
      let wokeAt = -1;        // index of the result that held the name
      let question = '';
      let blocked = false;
      const startedAt = Date.now();
      rec.onresult = (e) => {
        if (r !== rec) return;
        const items = Array.from(e.results as ArrayLike<RecResult>);
        if (wokeAt < 0) {
          for (let i = consumed; i < items.length; i++) {
            if (WAKE_RE.test(items[i][0].transcript)) { wokeAt = i; break; }
          }
          consumed = items.length - (items[items.length - 1]?.isFinal ? 0 : 1);
          if (wokeAt < 0) return;
          // the name was heard: open the voice view at once and keep listening on this same session for the question
          wakeOwns.current = true;
          if (closeTimer.current) window.clearTimeout(closeTimer.current);
          stopSpeaking();
          gen.current++;
          setReply(null); setHeard('');
          setMode('voice'); setVoiceState('listening');
          void startMic();
          wokeTimer = window.setTimeout(() => { wakeOwns.current = false; halt(); closeAll(); }, WAKE_QUESTION_MS + 4000);
        }
        // everything said from the name on, without the name itself
        const spoken = items.slice(wokeAt).map((x) => x[0].transcript).join(' ');
        const m = WAKE_RE.exec(spoken);
        question = (m ? spoken.slice(m.index + m[0].length) : spoken).replace(/^[\s,.:!?-]+/, '').trim();
        setHeard(question);
        if (items[items.length - 1]?.isFinal && question.length >= 2) {
          wakeOwns.current = false;
          halt();
          stopMic();
          handleRef.current(question, true);
        }
      };
      rec.onerror = (e) => {
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { blocked = true; setWakeState('blocked'); }
        else if (e.error !== 'aborted' && e.error !== 'no-speech') console.warn('Atlas wake listener', e.error);
      };
      rec.onend = () => {
        if (r !== rec) return;            // stopped on purpose
        r = null;
        if (stopped || !running || blocked) return;
        if (wokeAt >= 0) {                // the browser ended the session after the name: carry on with an ordinary listening session
          window.clearTimeout(wokeTimer);
          wakeOwns.current = false; running = false;
          stopMic();
          listenRef.current(question || undefined);
          return;
        }
        // the browser ends a listening session now and then: start the next one (slower if it ends at once)
        restart = window.setTimeout(begin, Date.now() - startedAt < 1500 ? 2500 : 250);
      };
      try { rec.start(); setWakeState((s) => (s === 'blocked' ? s : 'on')); } catch (err) { console.warn('Atlas wake listener could not start', err); r = null; restart = window.setTimeout(begin, 4000); }
    };
    wakeCtl.current = {
      sync: (closed) => {
        if (closed) { if (!running) { running = true; begin(); } }
        else if (!wakeOwns.current && running) halt();
      },
      release: () => { wakeOwns.current = false; halt(); },
    };
    return () => { stopped = true; halt(); wakeCtl.current = null; wakeOwns.current = false; };
  }, [wakeOn, lang]);
  useEffect(() => {
    if (!wakeOn || !SpeechRec) { setWakeState('off'); return; }
    wakeCtl.current?.sync(mode === 'closed');
  }, [mode, wakeOn, lang]);

  const toggleQuick = () => {
    const next = !quickSave;
    setQuickSave(next);
    writePref(QUICK_KEY, next ? 'on' : 'off');
  };
  const toggleWake = () => {
    const next = !wakeOn;
    setWakeOn(next);
    writePref(WAKE_KEY, next ? 'on' : 'off');
  };

  return (
    <>
      {mode === 'voice' && (
        <VoiceView
          state={voiceState}
          heard={heard}
          reply={reply}
          level={level}
          lang={lang}
          awaiting={awaiting}
          compact={compact}
          did={recentDid}
          quickSave={quickSave}
          onCompact={() => setCompact((c) => !c)}
          onQuick={toggleQuick}
          onClose={closeAll}
          onSendNow={() => rec.current?.stop()}
          onStop={() => { rec.current?.abort(); rec.current = null; stopMic(); stopSpeaking(); if (closeTimer.current) window.clearTimeout(closeTimer.current); setVoiceState('idle'); }}
          onAgain={() => listen()}
          onLang={chooseLang}
          onYes={() => { const p = pending.current; if (p) void settle(p.turnId, p.answer, true, true); }}
          onNo={() => { const p = pending.current; if (p) void settle(p.turnId, p.answer, false, true); }}
          onType={() => { rec.current?.abort(); stopMic(); stopSpeaking(); if (closeTimer.current) window.clearTimeout(closeTimer.current); setMode('text'); }}
        />
      )}

      {mode === 'text' && (
        <section role="dialog" aria-label="Atlas" className="card fixed bottom-[160px] right-3 z-40 flex max-h-[min(560px,calc(100vh-190px))] w-[min(380px,calc(100vw-24px))] flex-col shadow-2xl md:bottom-[100px] md:right-5">
          <header className="flex items-center gap-2 border-b border-line px-4 py-3">
            <AtlasMark size={26} />
            <h2 className="font-display text-[18px] font-bold">Atlas</h2>
            <span className="text-sm text-muted">{minimized ? 'lowered' : 'answers in 3 short sentences'}</span>
            <button type="button" onClick={toggleQuick} aria-pressed={quickSave} title="On: numbers you ask Atlas to log are saved at once and read back to you. Off: Atlas asks first." className={`ml-auto flex items-center gap-1 rounded-sm border border-line px-1.5 py-1 text-[12px] ${quickSave ? 'text-brand' : 'text-muted'} hover:text-text`}><Zap size={12} aria-hidden="true" />Quick save {quickSave ? 'on' : 'off'}</button>
            <button type="button" onClick={() => setMinimized(!minimized)} aria-label={minimized ? 'Show Atlas' : 'Lower Atlas so I can see the screen'} aria-pressed={minimized} className="rounded-sm p-1.5 text-muted hover:bg-s2 hover:text-text">{minimized ? <ChevronUp size={18} aria-hidden="true" /> : <ChevronDown size={18} aria-hidden="true" />}</button>
            <button type="button" onClick={chooseLang} aria-label={`Language: ${lang === 'en-US' ? 'English' : 'Arabic'}. Tap to switch`} className="num rounded-sm border border-line px-1.5 py-1 text-[12px] text-muted hover:text-text">{lang === 'en-US' ? 'EN' : 'AR'}</button>
            <button type="button" onClick={() => setSpeakAloud(!speakAloud)} aria-pressed={speakAloud} aria-label={speakAloud ? 'Read answers aloud: on' : 'Read answers aloud: off'} className="rounded-sm p-1.5 text-muted hover:bg-s2 hover:text-text">
              {speakAloud ? <Volume2 size={18} aria-hidden="true" /> : <VolumeX size={18} aria-hidden="true" />}
            </button>
            <button type="button" onClick={closeAll} aria-label="Close Atlas" className="rounded-sm p-1.5 text-muted hover:bg-s2 hover:text-text"><X size={18} aria-hidden="true" /></button>
          </header>
          {minimized && turns.length > 0 && <p className="line-clamp-3 px-4 py-2 text-[15px] leading-5 text-text" dir="auto" aria-live="polite">{turns[turns.length - 1].a?.text ?? 'Thinking...'}</p>}
          {!minimized && <>
          <div ref={list} className="min-h-0 flex-1 overflow-y-auto px-4 py-3" aria-live="polite">
            {turns.length === 0 ? (
              <p className="text-[15px] text-muted">Ask in English or Arabic. For example: “how is my heart rate?”, “open alerts”, “log my sleep 7 hours”. Atlas asks before it saves anything.</p>
            ) : (
              <ol className="flex flex-col gap-4">
                {turns.map((t) => (
                  <li key={t.id} className="flex flex-col gap-1.5">
                    <p className="self-end rounded-sm bg-s2 px-3 py-1.5 text-[15px] text-text" dir="auto">{t.q}</p>
                    {t.a ? (
                      <div className="flex flex-col gap-1.5">
                        {t.a.status && <StatusPill status={t.a.status} small />}
                        <p className="text-[16px] leading-6 text-text" dir="auto">{t.a.text}</p>
                        {t.a.confirm && (
                          t.settled ? <p className="text-sm text-muted" data-testid="atlas-settled">{t.note ?? (t.settled === 'cancelled' ? 'Cancelled.' : 'Done.')}</p> : (
                            <div className="flex gap-2" data-testid="atlas-confirm">
                              <button type="button" onClick={() => void settle(t.id, t.a!, true, false)} data-testid="atlas-approve" className="flex items-center gap-1 rounded-sm border border-brand px-3 py-1.5 text-[15px] font-bold text-brand"><Check size={16} aria-hidden="true" />{t.a.lang === 'ar' ? 'نفّذ' : 'Do it'}</button>
                              <button type="button" onClick={() => void settle(t.id, t.a!, false, false)} data-testid="atlas-cancel" className="flex items-center gap-1 rounded-sm border border-line px-3 py-1.5 text-[15px] text-muted"><Ban size={16} aria-hidden="true" />{t.a.lang === 'ar' ? 'إلغاء' : 'Cancel'}</button>
                            </div>
                          )
                        )}
                        {t.a.source === 'ai' && !t.a.confirm && <p className="text-xs text-muted">{AI_NOTE}</p>}
                        {t.a.link && <Link to={t.a.link.to} onClick={closeAll} className="self-start text-[15px] font-bold text-text underline underline-offset-4 hover:text-brand">{t.a.link.label} ›</Link>}
                      </div>
                    ) : (
                      <p className="text-[16px] leading-6 text-muted">Thinking...</p>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </div>
          {activity.length > 0 && (
            <details className="border-t border-line px-4 py-2 text-sm" data-testid="atlas-activity">
              <summary className="cursor-pointer text-muted hover:text-text">What Atlas did ({activity.length})</summary>
              <ul className="mt-1 max-h-28 space-y-0.5 overflow-auto">
                {activity.slice(0, 8).map((e) => <li key={e.id} className="flex gap-2"><span className="num text-xs text-muted">{e.at}</span><span>{e.text}</span></li>)}
              </ul>
            </details>
          )}
          <div className="flex flex-wrap gap-1.5 border-t border-line px-4 pt-3">
            {suggestionsFor(pathname).map((s) => (
              <button key={s} type="button" onClick={() => ask(s)} className="rounded-sm border border-line px-2.5 py-1 text-sm text-text hover:border-brand">{s}</button>
            ))}
          </div>
          <form onSubmit={submit} className="flex items-center gap-2 px-4 py-3">
            {SpeechRec && (
              <button type="button" onClick={() => listen()} aria-label="Ask by voice" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-sm border border-line-strong text-text hover:border-brand">
                <Mic size={20} aria-hidden="true" />
              </button>
            )}
            <label className="sr-only" htmlFor="atlas-q">Question for Atlas</label>
            <input id="atlas-q" ref={input} value={text} onChange={(e) => setText(e.target.value)} placeholder={lang === 'ar-SA' ? 'اسأل أطلس…' : 'How is my blood pressure?'} dir="auto"
              className="h-11 min-w-0 flex-1 rounded-sm border border-line bg-s1 px-3 text-[15px] text-text placeholder:text-muted" />
            <button type="submit" aria-label="Ask" className="btn-cut flex h-11 w-11 shrink-0 items-center justify-center rounded-sm bg-brand text-on-brand hover:opacity-90"><Send size={18} aria-hidden="true" /></button>
          </form>
          </>}
        </section>
      )}

      {SpeechRec && mode === 'closed' && (
        <button type="button" onClick={toggleWake} aria-pressed={wakeOn} data-testid="atlas-wake"
          title={wakeState === 'blocked' ? 'The microphone is blocked in this browser' : wakeOn ? 'Atlas is listening for its name. Tap to turn off.' : 'Tap to let Atlas listen for its name.'}
          className="fixed bottom-[160px] right-3 z-[60] flex items-center gap-1.5 rounded-full border border-line-strong bg-s1 px-3 py-1.5 text-[12px] text-muted shadow-lg hover:text-text md:bottom-[100px] md:right-5">
          <Ear size={14} aria-hidden="true" className={wakeState === 'on' ? 'text-brand' : ''} />
          {wakeState === 'blocked' ? 'Mic blocked' : wakeOn ? (wakeState === 'on' ? 'Say “Atlas”' : 'Starting…') : 'Name off'}
        </button>
      )}

      <div className="fixed bottom-[84px] right-3 z-[60] md:bottom-5 md:right-5">
        {mode === 'closed' && <span className="pointer-events-none absolute inset-0 rounded-full border-2 border-brand motion-safe:animate-[atlas-ping_3.2s_ease-out_infinite]" aria-hidden="true" />}
        <button
          type="button"
          onClick={onButton}
          aria-expanded={mode !== 'closed'}
          aria-label={mode === 'voice' && voiceState === 'listening' ? 'Stop listening' : mode !== 'closed' ? 'Close Atlas' : 'Talk to Atlas'}
          title="Talk to Atlas"
          className={`group relative flex items-center justify-center rounded-full bg-brand shadow-[0_8px_24px_rgba(0,0,0,0.55)] ring-2 ring-text ring-offset-2 ring-offset-bg transition-all duration-200 hover:scale-105 active:scale-95 ${mode === 'voice' ? 'h-20 w-20' : 'h-16 w-16'}`}
        >
          <AtlasMark size={mode === 'voice' ? 54 : 44} listening={mode === 'voice' && voiceState !== 'idle'} onBrand />
          {mode === 'closed' && <span className="pointer-events-none absolute right-full mr-3 whitespace-nowrap rounded-sm border border-line-strong bg-s1 px-2.5 py-1 text-sm font-bold text-text opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100">Talk to Atlas</span>}
        </button>
      </div>
    </>
  );
}

/** The talking view: a dark band across the bottom of the screen, a voice bar with live bars, large live words, and Ultraviolet waves behind. */
function VoiceView({ state, heard, reply, level, lang, awaiting, compact, did, quickSave, onCompact, onQuick, onClose, onSendNow, onStop, onAgain, onLang, onYes, onNo, onType }: {
  state: VoiceState; heard: string; reply: (AtlasAnswer & { source?: SmartAnswer['source'] }) | null; level: React.MutableRefObject<number>; lang: Lang; awaiting: boolean;
  compact: boolean; did: string; quickSave: boolean; onCompact: () => void; onQuick: () => void;
  onClose: () => void; onSendNow: () => void; onStop: () => void; onAgain: () => void; onLang: () => void; onYes: () => void; onNo: () => void; onType: () => void;
}) {
  const big = compact ? 'text-[20px] leading-[26px] line-clamp-2' : 'text-[28px] leading-[36px]';
  const label = state === 'listening' ? 'Listening' : state === 'speaking' || state === 'thinking' ? 'Atlas' : reply ? 'Atlas' : '';
  const ar = reply?.lang === 'ar' || lang === 'ar-SA';
  const asking = !!reply?.confirm && state !== 'thinking';
  return (
    <div role="dialog" aria-label="Talking to Atlas" className="fixed inset-x-0 bottom-0 z-50 flex flex-col border-t-2 border-brand bg-[#0B0A10]/90 transition-[height] duration-300 md:left-[76px]" style={{ height: compact ? 176 : 'min(52vh, 430px)' }}>
      <Waves state={state} level={level} />
      <div className={`relative z-10 mx-auto flex w-full max-w-[920px] flex-1 flex-col px-6 pr-28 ${compact ? 'gap-1.5 pb-2 pt-2' : 'gap-3 pb-5 pt-5'}`} aria-live="polite">
        <VoiceBar state={state} level={level} onSendNow={onSendNow} onStop={onStop} onClose={onClose} />
        <p className="flex items-center gap-2 text-sm font-bold uppercase tracking-[0.12em] text-[#A684FF]">{label}{state === 'listening' && !compact && <span className="num font-normal normal-case tracking-normal text-[#A39DB5]">· ask anything, then say “stop” when you are done</span>}{state === 'listening' && compact && <span className="num font-normal normal-case tracking-normal text-[#A39DB5]">· still listening</span>}</p>
        {state === 'listening' && awaiting && reply ? (
          <>
            <p className={`font-display font-bold text-[#F1EEF8] ${big}`} dir="auto">{reply.text}</p>
            <div className="flex items-center gap-3" data-testid="atlas-voice-confirm">
              <button type="button" onClick={onYes} data-testid="atlas-approve" className="flex items-center gap-1.5 rounded-sm border border-[#A684FF] px-4 py-2 text-[16px] font-bold text-[#F1EEF8] hover:bg-[#A684FF]/20"><Check size={18} aria-hidden="true" />{ar ? 'نفّذ' : 'Do it'}</button>
              <button type="button" onClick={onNo} data-testid="atlas-cancel" className="flex items-center gap-1.5 rounded-sm border border-[#4B455C] px-4 py-2 text-[16px] text-[#A39DB5] hover:text-[#F1EEF8]"><Ban size={18} aria-hidden="true" />{ar ? 'إلغاء' : 'Cancel'}</button>
              <span className="text-[14px] text-[#A39DB5]">{ar ? 'أو قل «نعم» / «لا»' : 'or say “yes” / “no”'}</span>
            </div>
            {heard && <p className="text-[17px] text-[#A39DB5]" dir="auto">“{heard}”</p>}
          </>
        ) : state === 'listening' ? (
          <p className={`font-display font-bold text-[#F1EEF8] ${compact ? 'text-[20px] leading-[26px] line-clamp-2' : 'text-[34px] leading-[40px]'}`} dir="auto">{heard || '…'}</p>
        ) : (
          <>
            {heard && !compact && <p className="text-[17px] text-[#A39DB5]" dir="auto">“{heard}”</p>}
            {did && <p className="flex items-center gap-1.5 self-start rounded-full border border-[#3FBF74]/50 bg-[#3FBF74]/10 px-3 py-0.5 text-[14px] text-[#BDEBD0]" data-testid="atlas-did"><Check size={14} aria-hidden="true" />{did}</p>}
            {reply?.status && !compact && <span className="self-start"><StatusPill status={reply.status} /></span>}
            <p className={`font-display font-bold text-[#F1EEF8] ${big}`} dir="auto">{state === 'thinking' ? 'Thinking...' : reply?.text}</p>
            {asking && (
              <div className="flex items-center gap-3" data-testid="atlas-voice-confirm">
                <button type="button" onClick={onYes} data-testid="atlas-approve" className="flex items-center gap-1.5 rounded-sm border border-[#A684FF] px-4 py-2 text-[16px] font-bold text-[#F1EEF8] hover:bg-[#A684FF]/20"><Check size={18} aria-hidden="true" />{ar ? 'نفّذ' : 'Do it'}</button>
                <button type="button" onClick={onNo} data-testid="atlas-cancel" className="flex items-center gap-1.5 rounded-sm border border-[#4B455C] px-4 py-2 text-[16px] text-[#A39DB5] hover:text-[#F1EEF8]"><Ban size={18} aria-hidden="true" />{ar ? 'إلغاء' : 'Cancel'}</button>
                <span className="text-[14px] text-[#A39DB5]">{ar ? 'أو قل «نعم» / «لا»' : 'or say “yes” / “no”'}</span>
              </div>
            )}
            {state !== 'thinking' && reply?.source === 'ai' && !asking && <p className="text-[14px] text-[#A39DB5]">{AI_NOTE}</p>}
            {reply?.link && !reply.navigate && <Link to={reply.link.to} onClick={onClose} className="self-start text-[16px] font-bold text-[#F1EEF8] underline underline-offset-4 hover:text-[#A684FF]">{reply.link.label} ›</Link>}
          </>
        )}
        <div className="mt-auto flex items-center gap-4 rounded-sm bg-[#0B0A10]/80 py-1 text-[15px]">
          {state === 'idle' && !awaiting && <button type="button" onClick={onAgain} className="font-bold text-[#F1EEF8] underline underline-offset-4 hover:text-[#A684FF]">Ask again</button>}
          <button type="button" onClick={onCompact} aria-label={compact ? 'Show Atlas bigger' : 'Lower Atlas so I can see the screen'} aria-pressed={compact} className="flex items-center gap-1.5 text-[#A39DB5] hover:text-[#F1EEF8]">{compact ? <ChevronUp size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}{compact ? 'Bigger' : 'Lower'}</button>
          <button type="button" onClick={onQuick} aria-pressed={quickSave} title="On: numbers you ask Atlas to log are saved at once and read back to you. Off: Atlas asks first." className={`flex items-center gap-1.5 ${quickSave ? 'text-[#BDEBD0]' : 'text-[#A39DB5]'} hover:text-[#F1EEF8]`}><Zap size={15} aria-hidden="true" />Quick save {quickSave ? 'on' : 'off'}</button>
          <button type="button" onClick={onLang} aria-label="Switch the speaking language" className="num rounded-sm border border-[#4B455C] px-2 py-0.5 text-[13px] text-[#A39DB5] hover:text-[#F1EEF8]">{lang === 'en-US' ? 'EN' : 'AR'}</button>
          <button type="button" onClick={onType} className="flex items-center gap-1.5 text-[#A39DB5] hover:text-[#F1EEF8]"><Keyboard size={16} aria-hidden="true" />Type instead</button>
          <button type="button" onClick={onClose} className="flex items-center gap-1.5 text-[#A39DB5] hover:text-[#F1EEF8]"><X size={16} aria-hidden="true" />Close</button>
        </div>
      </div>
    </div>
  );
}

/**
 * The voice bar: send (stop listening and ask), stop, live bars that follow the voice, and close.
 * Silence is a row of dots; sound is bars that scroll to the left. Still under reduced motion.
 */
function VoiceBar({ state, level, onSendNow, onStop, onClose }: { state: VoiceState; level: React.MutableRefObject<number>; onSendNow: () => void; onStop: () => void; onClose: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const reduced = !!useReducedMotion();
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    const c = canvas.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    const SLOT = 7;                  // pixels per bar slot
    let history: number[] = [];
    let raf = 0;
    let last = 0;
    const draw = (t: number) => {
      const dpr = window.devicePixelRatio || 1;
      const W = c.clientWidth, H = c.clientHeight;
      if (c.width !== W * dpr || c.height !== H * dpr) { c.width = W * dpr; c.height = H * dpr; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const slots = Math.max(8, Math.floor(W / SLOT));
      if (history.length !== slots) history = Array.from({ length: slots }, (_, i) => history[i - (slots - history.length)] ?? 0);
      if (t - last > 45) {           // about 22 steps a second
        last = t;
        const s = stateRef.current;
        const v = s === 'listening' ? level.current
          : s === 'speaking' ? 0.25 + 0.55 * Math.abs(Math.sin(t / 150)) * (0.6 + 0.4 * Math.abs(Math.sin(t / 530)))
          : s === 'thinking' ? 0.08 * (1 + Math.sin(t / 250))
          : 0;
        history.push(reduced ? (s === 'idle' ? 0 : 0.3) : v);
        history.shift();
      }
      ctx.clearRect(0, 0, W, H);
      for (let i = 0; i < history.length; i++) {
        const v = history[i];
        const x = i * SLOT + SLOT / 2;
        if (v < 0.04) { ctx.fillStyle = 'rgba(163,157,181,0.55)'; ctx.beginPath(); ctx.arc(x, H / 2, 1.6, 0, Math.PI * 2); ctx.fill(); continue; }
        const h = Math.max(4, Math.min(H - 4, v * (H - 4)));
        ctx.fillStyle = 'rgba(241,238,248,0.92)';
        ctx.beginPath();
        ctx.roundRect(x - 1.6, H / 2 - h / 2, 3.2, h, 1.6);
        ctx.fill();
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [reduced, level]);
  return (
    <div className="flex h-14 items-center gap-3 rounded-full bg-[#1C1B22] px-3" data-testid="atlas-voicebar">
      <button type="button" onClick={onSendNow} aria-label="Done talking, ask now" disabled={state !== 'listening'} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#3B6BD6] text-white disabled:opacity-60"><ArrowUp size={20} aria-hidden="true" /></button>
      <button type="button" onClick={onStop} aria-label="Stop" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[#3A3846] text-[#F1EEF8]"><Square size={14} fill="currentColor" aria-hidden="true" /></button>
      <canvas ref={canvas} className="h-10 min-w-0 flex-1" aria-hidden="true" />
      <button type="button" onClick={onClose} aria-label="Close Atlas" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[#3A3846] text-[#F1EEF8]"><X size={18} aria-hidden="true" /></button>
    </div>
  );
}

/** Three Ultraviolet wave lines across the band. Listening: height follows the microphone level. Thinking: low and calm. Speaking: a steady talking rhythm. Still under reduced motion. */
function Waves({ state, level }: { state: VoiceState; level: React.MutableRefObject<number> }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const reduced = !!useReducedMotion();
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    const c = canvas.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    let raf = 0;
    let amp = 0.15;
    const draw = (t: number) => {
      const dpr = window.devicePixelRatio || 1;
      const W = c.clientWidth, H = c.clientHeight;
      if (c.width !== W * dpr || c.height !== H * dpr) { c.width = W * dpr; c.height = H * dpr; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const s = stateRef.current;
      const target = reduced ? 0.3 : s === 'listening' ? 0.3 + level.current * 0.7 : s === 'speaking' ? 0.5 + 0.35 * Math.abs(Math.sin(t / 180)) : s === 'thinking' ? 0.1 : 0.2;
      amp += (target - amp) * 0.12;
      const time = reduced ? 0 : t / 1000;
      const layers = [
        { k: 1.6, speed: 0.9, a: 1, alpha: 0.22, width: 16 },
        { k: 2.3, speed: -1.3, a: 0.75, alpha: 0.45, width: 6 },
        { k: 3.1, speed: 1.8, a: 0.55, alpha: 0.95, width: 3 },
      ];
      for (const L of layers) {
        ctx.beginPath();
        for (let x = 0; x <= W; x += 6) {
          const u = x / W;
          const envelope = Math.sin(Math.PI * u); // calm at the edges, tall in the middle
          const y = H * 0.84 - Math.sin(u * Math.PI * 2 * L.k + time * L.speed * 2) * envelope * amp * H * 0.38 * L.a;
          if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = `rgba(166, 132, 255, ${L.alpha})`;
        ctx.lineWidth = L.width;
        ctx.lineCap = 'round';
        ctx.stroke();
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [reduced, level]);
  return <canvas ref={canvas} className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true" />;
}

/**
 * Atlas's mark: a crew helmet seen from the front, the visor catching one line of light.
 * While Atlas listens or talks, the visor line moves (off under reduced motion).
 */
export function AtlasMark({ size = 32, listening = false, onBrand = false }: { size?: number; listening?: boolean; onBrand?: boolean }) {
  // On the Ultraviolet button the helmet is drawn light on dark lines; elsewhere it follows the theme.
  const shell = onBrand ? '#F1EEF8' : 'var(--surface-2)';
  const line = onBrand ? '#0B0A10' : 'var(--text)';
  const visorLine = onBrand ? '#0B0A10' : 'var(--text-muted)';
  const glint = onBrand ? '#A684FF' : 'var(--brand)';
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <rect x="12" y="29" width="16" height="6" rx="3" fill={shell} stroke={line} strokeWidth="1.6" />
      <circle cx="20" cy="17.5" r="13" fill={shell} stroke={line} strokeWidth="1.8" />
      <rect x="10" y="11.5" width="20" height="13" rx="6.5" fill="#0B0A10" stroke={visorLine} strokeWidth="1.2" />
      <path d="M13.5 16c2.6-2 6-2.4 9-1.3" fill="none" stroke={glint} strokeWidth="2" strokeLinecap="round"
        className={listening ? 'motion-safe:animate-[atlas-wave_0.9s_ease-in-out_infinite]' : ''} style={{ transformOrigin: '18px 15px' }} />
      <circle cx="25.5" cy="20.5" r="1.1" fill="#A39DB5" />
    </svg>
  );
}
