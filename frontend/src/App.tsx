import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, MemoryRouter, Route, Routes } from 'react-router-dom';

/** Hosted builds (claude.ai artifact) keep routing in memory: the host frame only passes a plain #name. */
const Router = import.meta.env.VITE_ROUTER === 'memory' ? MemoryRouter : BrowserRouter;
import { Header } from './components/Header';
import { Nav } from './components/Nav';
import { Toasts } from './components/Toasts';
import { DemoKeys } from './components/DemoKeys';
import { Guide } from './components/Guide';
import { MetricSheet } from './components/MetricSheet';
import { AtlasDock } from './components/AtlasDock';
import { DeviceAccess } from './components/DeviceAccess';
import { MissionWatcher } from './components/Missions';
import { CelebrationLayer } from './components/Celebration';
import { OrbitLoader } from './components/BodyView';
import { useAstra } from './store/useAstra';
import { startLive } from './data/live';
import { startSync } from './store/sync';
import Overview from './pages/Overview';
import HealthLog from './pages/HealthLog';
import Events from './pages/Events';

const Trends = lazy(() => import('./pages/Trends'));
const Routine = lazy(() => import('./pages/Routine'));
const Evidence = lazy(() => import('./pages/Evidence'));
const Crew = lazy(() => import('./pages/Crew'));
const Scan = lazy(() => import('./pages/Scan'));
const Tests = lazy(() => import('./pages/Tests'));
const Reentry = lazy(() => import('./pages/Reentry'));
const Cabin = lazy(() => import('./pages/Cabin'));

export default function App() {
  const theme = useAstra((s) => s.theme);
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  useEffect(() => { void startLive(); return startSync(); }, []);
  return (
    <Router>
      <a href="#main" className="sr-only-focusable fixed left-2 top-2 z-50 rounded bg-brand px-3 py-1 text-on-brand btn-cut">Skip to content</a>
      <div className="flex h-full flex-col">
        <Header />
        <div className="flex min-h-0 flex-1">
          <Nav />
          <main id="main" tabIndex={0} aria-label="Main content" className="console-grid focus-visible:outline-none min-h-0 min-w-0 flex-1 overflow-y-auto pb-20 md:pb-0">
            <Suspense fallback={<OrbitLoader label="Loading" />}>
              <Routes>
                <Route path="/" element={<Overview />} />
                <Route path="/log" element={<HealthLog />} />
                <Route path="/trends" element={<Trends />} />
                <Route path="/routine" element={<Routine />} />
                <Route path="/events" element={<Events />} />
                <Route path="/evidence" element={<Evidence />} />
                <Route path="/crew" element={<Crew />} />
                <Route path="/scan" element={<Scan />} />
                <Route path="/tests" element={<Tests />} />
                <Route path="/reentry" element={<Reentry />} />
                <Route path="/cabin" element={<Cabin />} />
                <Route path="*" element={<Overview />} />
              </Routes>
            </Suspense>
          </main>
        </div>
      </div>
      <Toasts />
      <DemoKeys />
      <Guide />
      <MetricSheet />
      <DeviceAccess />
      <AtlasDock />
      <MissionWatcher />
      <CelebrationLayer />
    </Router>
  );
}
