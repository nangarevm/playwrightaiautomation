import { useState } from "react";
import { useApp } from "../context/AppState.js";
import { TabBar } from "../components/TabBar.js";
import Environments from "./Environments.js";
import Settings from "./Settings.js";

type Tab = "environments" | "preferences" | "team";

function initials(name: string) {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

// Multi-user/Enterprise switching was previously in the header, visible on every
// screen even for the single-user case this app defaults to. Moved here as an
// advanced tab so it's still reachable when needed but doesn't clutter the header.
function TeamTab() {
  const { mode, setMode, users, currentUser, switchUser } = useApp();
  const activeUser = users.find((u) => u.id === currentUser);
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-line bg-white/60 shadow-panel p-4 space-y-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">Workspace mode</p>
        <p className="text-xs text-ink/50">Single QA is a solo workspace. Enterprise adds multi-user switching, governance, and team defaults.</p>
        <div className="flex items-center rounded-full border border-line bg-white/60 p-0.5 text-xs w-fit">
          <button
            data-testid="mode-single"
            className={`rounded-full px-3 py-1 font-medium ${mode === "single" ? "bg-ink text-paper" : "text-ink/60"}`}
            onClick={() => setMode("single")}
          >
            Single QA
          </button>
          <button
            data-testid="mode-enterprise"
            className={`rounded-full px-3 py-1 font-medium ${mode === "enterprise" ? "bg-ink text-paper" : "text-ink/60"}`}
            onClick={() => setMode("enterprise")}
          >
            Enterprise
          </button>
        </div>
      </div>

      {mode === "enterprise" && users.length > 0 && (
        <div className="rounded-lg border border-line bg-white/60 shadow-panel p-4 space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">Active user</p>
          <div className="flex items-center gap-2">
            <span className="h-7 w-7 rounded-full bg-signal text-white text-[11px] font-bold flex items-center justify-center">
              {activeUser ? initials(activeUser.name) : "?"}
            </span>
            <select
              data-testid="user-switcher"
              className="rounded-md border border-line bg-white/60 p-2 text-sm"
              value={currentUser}
              onChange={(e) => switchUser(e.target.value)}
            >
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.role})
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
    </div>
  );
}

// Groups target-app credentials (Environments), org/personal preferences (Settings),
// and workspace/team mode under one nav entry.
export default function SettingsHub() {
  const [tab, setTab] = useState<Tab>("environments");

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-xl tracking-tight">Settings</h2>
        <p className="text-sm text-ink/60">Environments, preferences, and workspace mode</p>
      </div>

      <TabBar<Tab>
        tabs={[
          { key: "environments", label: "Environments" },
          { key: "preferences", label: "Preferences" },
          { key: "team", label: "Team" },
        ]}
        active={tab}
        onChange={setTab}
      />

      <div style={{ display: tab === "environments" ? "block" : "none" }}>
        <Environments />
      </div>
      <div style={{ display: tab === "preferences" ? "block" : "none" }}>
        <Settings />
      </div>
      <div style={{ display: tab === "team" ? "block" : "none" }}>
        <TeamTab />
      </div>
    </div>
  );
}
