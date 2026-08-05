import { useEffect, useState } from "react";
import { api, EnvironmentRow, ExecutionProfileRow } from "../api.js";
import { Pill } from "../components/Pill.js";

const DRAFT_DEFAULT = { name: "", target_url: "", username: "", password: "", default_profile_id: "" };

// FR-4.19/FR-4.20/FR-1.3c: Environments management -- previously fully built on the
// backend (server/src/routes/environments.ts) with zero client UI. Credentials are
// never displayed in plaintext here; the backend masks them (has_credentials only).
export default function Environments() {
  const [environments, setEnvironments] = useState<EnvironmentRow[]>([]);
  const [profiles, setProfiles] = useState<ExecutionProfileRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState({ ...DRAFT_DEFAULT });
  const [showEditor, setShowEditor] = useState(false);
  const [healthResults, setHealthResults] = useState<Record<string, any>>({});
  const [rotatingId, setRotatingId] = useState<string | null>(null);
  const [rotateUsername, setRotateUsername] = useState("");
  const [rotatePassword, setRotatePassword] = useState("");

  async function refresh() {
    setLoading(true);
    try {
      const [envs, p] = await Promise.all([api.listEnvironments(), api.listExecutionProfiles()]);
      setEnvironments(envs);
      setProfiles(p);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function withBusy(key: string, fn: () => Promise<any>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-xl tracking-tight">Environments</h2>
        <p className="text-sm text-ink/60">
          Named target apps (Dev/Staging/Prod/custom) with encrypted-at-rest credentials, a default run profile, and pre-flight health checks (FR-4.19/FR-4.20)
        </p>
      </div>

      {error && <div className="rounded-md border border-alert bg-alert/5 p-3 text-sm text-alert">{error}</div>}

      <div className="flex justify-end">
        <button className="rounded-md bg-ink text-paper px-3 py-1.5 text-xs font-medium" onClick={() => setShowEditor((v) => !v)}>
          {showEditor ? "Close" : "Add environment"}
        </button>
      </div>

      {showEditor && (
        <div className="rounded-lg border border-line bg-white/60 shadow-panel p-4 space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">New environment</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <input
              className="rounded-md border border-line bg-white/60 p-2 text-sm"
              placeholder="Name (e.g. Staging)"
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            />
            <input
              className="rounded-md border border-line bg-white/60 p-2 text-sm"
              placeholder="Target URL"
              value={draft.target_url}
              onChange={(e) => setDraft((d) => ({ ...d, target_url: e.target.value }))}
            />
            <input
              className="rounded-md border border-line bg-white/60 p-2 text-sm"
              placeholder="Username (optional)"
              value={draft.username}
              onChange={(e) => setDraft((d) => ({ ...d, username: e.target.value }))}
            />
            <input
              className="rounded-md border border-line bg-white/60 p-2 text-sm"
              type="password"
              placeholder="Password (optional)"
              value={draft.password}
              onChange={(e) => setDraft((d) => ({ ...d, password: e.target.value }))}
            />
            <select
              className="rounded-md border border-line bg-white/60 p-2 text-sm sm:col-span-2"
              value={draft.default_profile_id}
              onChange={(e) => setDraft((d) => ({ ...d, default_profile_id: e.target.value }))}
            >
              <option value="">No default profile</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <button
            className="rounded-md bg-ink text-paper px-3 py-1.5 text-xs font-medium disabled:opacity-50"
            disabled={busy === "create-env"}
            onClick={() =>
              withBusy("create-env", async () => {
                if (!draft.name.trim() || !draft.target_url.trim()) throw new Error("Name and target URL are required.");
                await api.createEnvironment({
                  name: draft.name.trim(),
                  target_url: draft.target_url.trim(),
                  username: draft.username.trim() || undefined,
                  password: draft.password.trim() || undefined,
                  default_profile_id: draft.default_profile_id || undefined,
                });
                setDraft({ ...DRAFT_DEFAULT });
                setShowEditor(false);
              })
            }
          >
            {busy === "create-env" ? "Creating…" : "Create environment"}
          </button>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-ink/50">Loading environments…</p>
      ) : environments.length === 0 ? (
        <p className="text-sm text-ink/50">No environments configured yet.</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {environments.map((env) => {
            const profile = profiles.find((p) => p.id === env.default_profile_id);
            const health = healthResults[env.id];
            return (
              <div key={env.id} className="rounded-lg border border-line bg-white/60 shadow-panel p-4 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-medium text-sm">{env.name}</p>
                    <p className="text-xs text-ink/50 font-mono">{env.target_url}</p>
                  </div>
                  <Pill tone={env.has_credentials ? "good" : "neutral"}>{env.has_credentials ? "credentials set" : "no credentials"}</Pill>
                </div>
                <p className="text-xs text-ink/60">Default profile: {profile?.name ?? "none"}</p>
                {env.last_health_check_status && (
                  <p className="text-xs text-ink/40">
                    Last health check: {env.last_health_check_status} ({env.last_health_check_at ? new Date(env.last_health_check_at).toLocaleString() : ""})
                  </p>
                )}
                {health && (
                  <div className="flex gap-2">
                    <Pill tone={health.reachable ? "good" : "bad"}>{health.reachable ? "reachable" : "unreachable"}</Pill>
                    <Pill tone={health.auth_ok ? "good" : "bad"}>{health.auth_ok ? "auth ok" : "auth failed"}</Pill>
                  </div>
                )}
                <div className="flex flex-wrap gap-2 pt-1">
                  <button
                    className="rounded border border-ink/20 text-ink/70 px-2 py-1 text-xs"
                    disabled={busy === `health-${env.id}`}
                    onClick={() =>
                      withBusy(`health-${env.id}`, async () => {
                        const result = await api.runEnvironmentHealthCheck(env.id);
                        setHealthResults((prev) => ({ ...prev, [env.id]: result }));
                      })
                    }
                  >
                    Run health check
                  </button>
                  {env.has_credentials && (
                    <button
                      className="rounded border border-ink/20 text-ink/70 px-2 py-1 text-xs"
                      disabled={busy === `revoke-${env.id}`}
                      onClick={() => withBusy(`revoke-${env.id}`, () => api.revokeEnvironmentCredentials(env.id))}
                    >
                      Revoke credentials
                    </button>
                  )}
                  <button
                    className="rounded border border-ink/20 text-ink/70 px-2 py-1 text-xs"
                    onClick={() => {
                      setRotatingId(rotatingId === env.id ? null : env.id);
                      setRotateUsername("");
                      setRotatePassword("");
                    }}
                  >
                    Rotate credentials
                  </button>
                  <button
                    className="rounded border border-alert text-alert px-2 py-1 text-xs"
                    disabled={busy === `delete-${env.id}`}
                    onClick={() => withBusy(`delete-${env.id}`, () => api.deleteEnvironment(env.id))}
                  >
                    Delete
                  </button>
                </div>
                {rotatingId === env.id && (
                  <div className="rounded-md border border-line bg-white/50 p-2 space-y-2">
                    <div className="grid gap-2 sm:grid-cols-2">
                      <input
                        className="rounded-md border border-line bg-white/60 p-2 text-sm"
                        placeholder="New username"
                        value={rotateUsername}
                        onChange={(e) => setRotateUsername(e.target.value)}
                      />
                      <input
                        className="rounded-md border border-line bg-white/60 p-2 text-sm"
                        type="password"
                        placeholder="New password"
                        value={rotatePassword}
                        onChange={(e) => setRotatePassword(e.target.value)}
                      />
                    </div>
                    <button
                      className="rounded-md bg-ink text-paper px-3 py-1.5 text-xs font-medium disabled:opacity-50"
                      disabled={busy === `rotate-${env.id}`}
                      onClick={() =>
                        withBusy(`rotate-${env.id}`, async () => {
                          if (!rotateUsername.trim() || !rotatePassword.trim()) throw new Error("Username and password are required to rotate.");
                          await api.rotateEnvironmentCredentials(env.id, rotateUsername.trim(), rotatePassword.trim());
                          setRotatingId(null);
                        })
                      }
                    >
                      Save new credentials
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
