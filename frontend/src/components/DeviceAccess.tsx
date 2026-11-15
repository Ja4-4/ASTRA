import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, Mic, X } from 'lucide-react';

/** The scan needs the camera and Atlas needs the microphone. Ask for both as soon as the app opens,
 *  then check again every 5 minutes (and whenever the browser reports a change) that the devices are
 *  still there and still allowed. Nothing is recorded: the first request stops the streams at once. */

type Access = 'granted' | 'denied' | 'prompt' | 'unknown';
interface DeviceState { camera: Access; mic: Access; hasCamera: boolean; hasMic: boolean }

const CHECK_EVERY_MS = 5 * 60 * 1000;
const HOSTED_SANDBOX = import.meta.env.MODE === 'artifact';

async function permission(name: 'camera' | 'microphone'): Promise<Access> {
  try {
    const status = await navigator.permissions.query({ name: name as PermissionName });
    return status.state as Access;
  } catch {
    return 'unknown'; // this browser cannot report camera/microphone permission (for example Firefox)
  }
}

async function readState(): Promise<DeviceState> {
  const [camera, mic] = await Promise.all([permission('camera'), permission('microphone')]);
  let hasCamera = true, hasMic = true;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    hasCamera = devices.some((d) => d.kind === 'videoinput');
    hasMic = devices.some((d) => d.kind === 'audioinput');
  } catch (err) {
    console.warn('[devices] could not list devices', err);
  }
  return { camera, mic, hasCamera, hasMic };
}

/** Opens the browser's permission prompt for what is still missing, then stops the streams straight away. */
async function askFor(state: DeviceState): Promise<void> {
  const video = state.hasCamera && state.camera !== 'granted' && state.camera !== 'denied';
  const audio = state.hasMic && state.mic !== 'granted' && state.mic !== 'denied';
  if (!video && !audio) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video, audio });
    stream.getTracks().forEach((t) => t.stop());
  } catch (err) {
    console.info('[devices] permission not given:', (err as Error).name);
  }
}

export function DeviceAccess() {
  const [state, setState] = useState<DeviceState | null>(null);
  const [hidden, setHidden] = useState(false);
  const watching = useRef<PermissionStatus[]>([]);

  const check = useCallback(async (ask: boolean) => {
    let s = await readState();
    if (ask) { await askFor(s); s = await readState(); }
    console.info(`[devices] camera ${s.hasCamera ? s.camera : 'not found'}, microphone ${s.hasMic ? s.mic : 'not found'}`);
    setState(s);
    setHidden(false);
  }, []);

  useEffect(() => {
    if (HOSTED_SANDBOX || !navigator.mediaDevices?.getUserMedia) return;
    void check(true);
    const timer = window.setInterval(() => void check(true), CHECK_EVERY_MS);
    const onDevices = () => void check(false);
    navigator.mediaDevices.addEventListener?.('devicechange', onDevices);
    // React at once when the person changes the permission in the browser.
    (['camera', 'microphone'] as const).forEach((name) => {
      navigator.permissions?.query({ name: name as PermissionName }).then((status) => {
        status.onchange = () => void check(false);
        watching.current.push(status);
      }).catch(() => { /* not supported in this browser: the 5-minute check still runs */ });
    });
    return () => {
      window.clearInterval(timer);
      navigator.mediaDevices.removeEventListener?.('devicechange', onDevices);
      watching.current.forEach((s) => { s.onchange = null; });
      watching.current = [];
    };
  }, [check]);

  if (!state || hidden) return null;
  const problems: { icon: typeof Camera; text: string }[] = [];
  if (!state.hasCamera) problems.push({ icon: Camera, text: 'No camera found. The scan needs one.' });
  else if (state.camera === 'denied') problems.push({ icon: Camera, text: 'Camera blocked. The scan needs it.' });
  if (!state.hasMic) problems.push({ icon: Mic, text: 'No microphone found. Talking to Atlas needs one.' });
  else if (state.mic === 'denied') problems.push({ icon: Mic, text: 'Microphone blocked. Talking to Atlas needs it.' });
  const canAsk = (state.hasCamera && state.camera === 'prompt') || (state.hasMic && state.mic === 'prompt');
  if (!problems.length && !canAsk) return null;

  return (
    <div role="status" className="card fixed bottom-24 left-1/2 z-40 flex w-[min(92vw,460px)] -translate-x-1/2 items-start gap-3 p-3 shadow-lg md:bottom-6">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 text-sm text-text">
        {problems.map(({ icon: Icon, text }) => (
          <p key={text} className="flex items-center gap-2"><Icon size={16} aria-hidden="true" />{text}</p>
        ))}
        {problems.some((p) => p.text.includes('blocked')) && (
          <p className="text-xs text-muted">To allow it: click the lock icon next to the web address, set Camera and Microphone to Allow, then reload.</p>
        )}
        {canAsk && (
          <button type="button" onClick={() => void check(true)} className="self-start rounded-sm bg-brand px-3 py-1.5 text-sm font-bold text-on-brand">
            Allow camera and microphone
          </button>
        )}
        <p className="text-xs text-muted">Nothing is recorded. Only numbers stay on this device.</p>
      </div>
      <button type="button" aria-label="Hide" onClick={() => setHidden(true)} className="text-muted hover:text-text"><X size={16} /></button>
    </div>
  );
}
