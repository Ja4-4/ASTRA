import { Link } from 'react-router-dom';
import { useAstra } from '../store/useAstra';
import { useDerived } from '../store/derived';
import { METRICS, METRIC_ORDER, type MetricId } from '../lib/indicators';
import { STATUS, type StatusKey } from '../lib/status';
import { useToday } from './Today';
import { USUAL } from './MetricSheet';

const lower = (m: MetricId) => METRICS[m].short.toLowerCase();

/** The number, then the astronaut's own usual. Falls back to the rule's plain sentence when there is no usual (exercise, mood). */
function whyLine(m: MetricId, display: string, plain: string): string {
  const usual = USUAL[m];
  if (!usual || display === '—') return plain;
  if (m === 'sleep') return `You slept ${display} h. Your usual is ${usual}.`;
  return `Your ${lower(m)} is ${display} today. Your usual is ${usual}.`;
}

/** The button always acts on the same number the title names. */
function nextStepFor(m: MetricId): { label: string; to: string } {
  if (m === 'exercise') return { label: 'Open today’s exercise', to: '/routine' };
  if (m === 'sleep') return { label: 'Log last night’s sleep', to: '/log?focus=sleep' };
  if (m === 'mood') return { label: 'Log how you feel', to: '/log?focus=mood' };
  return { label: `Measure your ${lower(m)} again`, to: `/log?focus=${m}` };
}

/** The first thing on screen: am I OK, why, and the one thing to do now. */
export function Hero() {
  const { results } = useDerived();
  const events = useAstra((s) => s.events);
  const openMetric = useAstra((s) => s.openMetric);
  const { todo } = useToday();
  const open = events.find((e) => e.stage !== 'closed');
  const off = METRIC_ORDER.filter((m) => results[m].status === 'watch');
  const next = todo[0];

  let status: StatusKey;
  let title: string;
  let why: string;
  let action: { label: string; to: string } | null = next
    ? { label: next.metric ? `Measure your ${lower(next.metric)}` : `Start: ${next.label.toLowerCase()}`, to: next.to }
    : null;

  if (open?.stage === 'respond') {
    const r = results[open.metric];
    status = 'act';
    title = 'Do something now';
    why = `Your ${lower(open.metric)} is ${r.display} ${r.unit}. That is far from your usual.`;
    action = { label: 'Start the 3 easy steps', to: '/events' };
  } else if (open?.stage === 'recover') {
    status = 'watch';
    title = 'Getting better';
    why = `Your ${lower(open.metric)} is coming back to your usual. Check it again to be sure.`;
    action = { label: `Check your ${lower(open.metric)} again`, to: `/log?focus=${open.metric}` };
  } else if (off.length > 0) {
    const first = off[0];
    status = 'watch';
    title = off.length === 1 ? `One thing to check: ${lower(first)}.` : `${off.length} things to check. Start with ${lower(first)}.`;
    why = whyLine(first, results[first].display, results[first].plain);
    action = nextStepFor(first);
  } else {
    status = 'ok';
    title = 'You’re in range today.';
    why = 'All your numbers are close to your usual.';
  }
  const S = STATUS[status];

  return (
    <section className="card relative overflow-hidden p-5" aria-live="polite" style={{ boxShadow: `inset 6px 0 0 ${S.cssVar}` }}>
      <div className="flex items-start gap-4 pl-1">
        <S.icon size={44} strokeWidth={2.2} className="mt-0.5 shrink-0" style={{ color: S.cssVar }} aria-hidden="true" />
        <div className="min-w-0">
          <h2 className="font-display text-[30px] font-bold leading-[34px]">{title}</h2>
          <p className="mt-1.5 text-[17px] leading-6 text-text">{why}</p>
          {status === 'watch' && !open && off[0] && (
            <button type="button" onClick={() => openMetric(off[0])} className="mt-1 text-[15px] text-muted underline underline-offset-4 hover:text-text">Why?</button>
          )}
        </div>
      </div>
      {action ? (
        <Link to={action.to} className="btn-cut mt-5 flex w-full items-center justify-center rounded-sm bg-brand px-5 py-3.5 text-[17px] font-bold text-on-brand hover:opacity-90">
          {action.label}
        </Link>
      ) : (
        <p className="mt-4 pl-1 text-[15px] text-muted">Nothing left to do today.</p>
      )}
    </section>
  );
}
