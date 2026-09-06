import { useEffect, useState } from "react";
import { useApp } from "../context/AppState.js";
import { api } from "../api.js";
import { TabBar } from "../components/TabBar.js";
import Environments from "./Environments.js";
import Settings from "./Settings.js";

type Tab = "environments" | "preferences" | "team";

interface UserActivitySummary {
  id: string;
  name: string;
  role: string;
  email: string | null;
  disabled: boolean;
  lastSeenAt: string | null;
  isOnline: boolean;
  totalActionCount: number;
  lastAction: { action: string; entityType: string; createdAt: string } | null;
}

function relativeTime(iso: string | null): string {
  if (!iso) return "Never";
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// Who's currently active and what they've been doing -- QA Lead only (the
// backend route enforces this too; the 403 is caught and shown as an empty
// state rather than an error toast, since a non-QA-Lead simply isn't meant
// to see this panel). Polls every 30s: "online now" is inherently live data,
// and this tab has no other reason to re-render on its own.
function UserActivityPanel() {
  const [activity, setActivity] = useState<UserActivitySummary[] | null>(null);
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await api.getUserActivity();
        if (!cancelled) setActivity(data);
      } catch {
        if (!cancelled) setForbidden(true);
      }
    }
    load();
    const interval = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (forbidden) {
    return <p className="text-xs text-ink/50">Only a QA Lead can view team activity.</p>;
  }
  if (!activity) {
    return <p className="text-xs text-ink/50">Loading team activity…</p>;
  }

  return (
    <div className="rounded-lg border border-line bg-white/60 shadow-panel p-4 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">Team activity</p>
        <p className="text-xs text-ink/40">{activity.filter((u) => u.isOnline).length} online now</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-ink/50">
              <th className="pb-2 pr-4 font-medium">User</th>
              <th className="pb-2 pr-4 font-medium">Role</th>
              <th className="pb-2 pr-4 font-medium">Status</th>
              <th className="pb-2 pr-4 font-medium">Last seen</th>
              <th className="pb-2 pr-4 font-medium">Last action</th>
              <th className="pb-2 font-medium">Total actions</th>
            </tr>
          </thead>
          <tbody>
            {activity.map((u) => (
              <tr key={u.id} className="border-t border-line/60">
                <td className="py-2 pr-4">
                  {u.name}
                  {u.disabled && <span className="ml-1 text-[10px] text-red-500">(disabled)</span>}
                </td>
                <td className="py-2 pr-4 text-ink/70">{u.role}</td>
                <td className="py-2 pr-4">
                  <span className="inline-flex items-center gap-1.5">
                    <span className={`h-2 w-2 rounded-full ${u.isOnline ? "bg-emerald-500" : "bg-ink/20"}`} />
                    {u.isOnline ? "Online" : "Offline"}
                  </span>
                </td>
                <td className="py-2 pr-4 text-ink/70">{relativeTime(u.lastSeenAt)}</td>
                <td className="py-2 pr-4 text-ink/70">{u.lastAction ? `${u.lastAction.action} (${u.lastAction.entityType})` : "—"}</td>
                <td className="py-2 text-ink/70">{u.totalActionCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

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

      <UserActivityPanel />
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
