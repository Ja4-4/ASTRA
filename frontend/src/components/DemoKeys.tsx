import { useEffect } from 'react';
import { useAstra } from '../store/useAstra';

/** Hidden presenter controls. Shift+D: advance the simulated clock / log demo follow-ups. Shift+R: reset the demo. */
export function DemoKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (e.key === 'D') { e.preventDefault(); useAstra.getState().demoAdvance(); }
        if (e.key === 'R') { e.preventDefault(); useAstra.getState().resetDemo(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return null;
}
