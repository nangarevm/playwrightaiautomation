import { useApp } from "../context/AppState.js";
import { Pill } from "./Pill.js";

// Mode switching and the multi-user selector used to live here, visible on every
// screen regardless of relevance -- moved to Settings -> Team, since this app
// defaults to a single-user workspace. Header now just orients + surfaces errors.
export function Header() {
  const { error } = useApp();
  return (
    <header className="border-b border-line bg-paper/95 backdrop-blur sticky top-0 z-10">
      <div className="px-6 py-3.5 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="font-display text-[11px] font-bold tracking-widest bg-ink text-paper rounded px-1.5 py-0.5">QA</span>
          <h1 className="text-base font-semibold tracking-tight text-ink">AI Test Automation Platform</h1>
        </div>
        {error && <Pill tone="bad">⚠ {error}</Pill>}
      </div>
    </header>
  );
}
