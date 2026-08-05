import { lazy, Suspense, useEffect, useState } from "react";
import { AppStateProvider, useApp, View } from "./context/AppState.js";
import { Sidebar } from "./components/Sidebar.js";
import { Header } from "./components/Header.js";
import Home from "./pages/Home.js";

// Code-split every non-landing tab: a solo QA typically works in one or two
// tabs per session, so there's no reason to ship Run/Library/Reports/Settings
// JS in the initial bundle before the user has even picked a tab. Home stays
// a static import since it's the very first thing rendered.
const Run = lazy(() => import("./pages/Run.js"));
const Library = lazy(() => import("./pages/Library.js"));
const ReportsHub = lazy(() => import("./pages/ReportsHub.js"));
const SettingsHub = lazy(() => import("./pages/SettingsHub.js"));

const PAGES: Record<View, JSX.Element> = {
  home: <Home />,
  run: <Run />,
  library: <Library />,
  reports: <ReportsHub />,
  settings: <SettingsHub />,
};

function Shell() {
  const { view, agreementRate } = useApp();

  // Every page keeps its own local state (form drafts, in-progress crawl results,
  // list selections, filters) in useState. Previously this Shell rendered only
  // `view === key && <Page/>`, which unmounts the inactive page -- destroying all
  // of that local state the instant you switched tabs, and re-creating it from
  // scratch on return. AI Crawler felt it worst (a running crawl's results
  // vanished), but every page loses its local state the same way. Fix: once a
  // tab has been visited, keep it mounted and just hide it with CSS instead of
  // unmounting it, so switching back restores exactly what was there.
  const [visited, setVisited] = useState<Set<View>>(() => new Set([view]));
  useEffect(() => {
    setVisited((prev) => (prev.has(view) ? prev : new Set(prev).add(view)));
  }, [view]);

  return (
    <div className="min-h-screen flex">
      <Sidebar />
      <div className="flex-1 min-w-0">
        <Header />
        <main className="px-6 py-8 max-w-6xl">
          {agreementRate !== null && (
            <div className="mb-6 rounded-lg border border-line bg-white/70 p-3 text-sm text-ink/70">
              Review agreement rate: <span className="font-semibold text-ink">{agreementRate}%</span>
            </div>
          )}
          <Suspense fallback={<p className="text-sm text-ink/50">Loading…</p>}>
            {(Object.keys(PAGES) as View[]).map(
              (key) =>
                visited.has(key) && (
                  <div key={key} style={{ display: view === key ? "block" : "none" }}>
                    {PAGES[key]}
                  </div>
                )
            )}
          </Suspense>
        </main>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <AppStateProvider>
      <Shell />
    </AppStateProvider>
  );
}
