import { useApp } from "../context/AppState.js";
import { Pill } from "./Pill.js";

// Mode switching and the multi-user selector used to live here, visible on every
// screen regardless of relevance -- moved to Settings -> Team, since this app
// defaults to a single-user workspace. Header now just orients + surfaces errors.
export function Header() {
  const { error } = useApp();
  return (
    <header className="border-b border-line bg-paper/95 backdrop-blur sticky top-0 z-10 h-14 flex items-center">
      <div className="px-4 w-full flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="font-display text-[10px] font-bold tracking-widest bg-ink text-paper rounded px-1 py-0.5">QA</span>
          <h1 className="text-sm font-semibold tracking-tight text-ink truncate">Test Automation</h1>
        </div>
        {error && <Pill tone="bad">⚠ {error}</Pill>}
      </div>
    </header>
  );
}
