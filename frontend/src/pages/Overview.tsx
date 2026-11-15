import { AnimatePresence } from 'framer-motion';
import { BodyView } from '../components/BodyView';
import { SystemPanel } from '../components/SystemPanel';
import { Hero } from '../components/Hero';
import { Today } from '../components/Today';
import { Numbers } from '../components/Numbers';
import { useAstra } from '../store/useAstra';

/** Home on one screen: the body on the left; on the right, am I OK, what to do now, and only the numbers worth a look. */
export default function Overview() {
  const selected = useAstra((s) => s.selectedSystem);
  return (
    <div className="mx-auto grid max-w-[1280px] grid-cols-[minmax(0,1fr)] gap-4 p-3 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:p-5">
      <h1 className="sr-only">Home</h1>
      <div className="order-2 h-[420px] lg:order-1 lg:h-[calc(100vh-150px)] lg:max-h-[720px] lg:min-h-[520px]"><BodyView /></div>
      <div className="order-1 flex min-w-0 flex-col gap-3 lg:order-2">
        <AnimatePresence mode="wait">
          {selected ? (
            <SystemPanel key={selected} id={selected} />
          ) : (
            <div key="home" className="flex flex-col gap-3">
              <Hero />
              <Numbers />
              <Today />
            </div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
