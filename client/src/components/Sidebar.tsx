import { useApp, View } from "../context/AppState.js";

interface NavItem {
  key: View;
  icon: string;
  label: string;
}

// Five screens total: Home (overview), Run (the whole input->report pipeline in one
// guided flow), Library (scripts/screens/crawler for going deeper), Reports
// (exports + analytics), Settings (environments/preferences/team). Down from 11 --
// a freelancer/QA/dev/founder shouldn't have to learn what "AI Studio" vs
// "Execution" vs "Testing" means just to find the thing they want.
const NAV: NavItem[] = [
  { key: "home", icon: "🏠", label: "Home" },
  { key: "run", icon: "▶", label: "Run" },
  { key: "library", icon: "📚", label: "Library" },
  { key: "reports", icon: "📄", label: "Reports" },
  { key: "settings", icon: "⚙", label: "Settings" },
];

export function Sidebar() {
  const { view, setView, mode } = useApp();
  return (
    <nav className="w-48 shrink-0 bg-ink min-h-screen py-6">
      <div className="px-4 mb-6">
        <p className="font-display text-lg tracking-tight text-paper">Test Automation</p>
        <p className="text-[11px] text-paper/50">{mode === "enterprise" ? "Acme Corp · Enterprise" : "Solo QA workspace"}</p>
      </div>
      <div className="px-2">
        <ul className="space-y-0.5">
          {NAV.map((n) => (
            <li key={n.key}>
              <button
                data-testid={`nav-${n.key}`}
                className={`w-full flex items-center gap-3 rounded-md px-3 py-2 text-sm text-left transition-colors ${
                  view === n.key ? "bg-signal text-white" : "text-paper/70 hover:bg-white/10 hover:text-paper"
                }`}
                onClick={() => setView(n.key)}
              >
                <span className="text-base leading-none">{n.icon}</span>
                <span className="font-medium">{n.label}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}
