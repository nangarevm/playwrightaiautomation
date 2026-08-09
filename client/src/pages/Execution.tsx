import { useState } from "react";
import { useApp } from "../context/AppState.js";
import { Pill } from "../components/Pill.js";
import { AllureReportPanel } from "../components/AllureReportPanel.js";
import { RealtimeExecutionDashboard } from "../components/RealtimeExecutionDashboard.js";
import { api } from "../api.js";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export default function Execution() {
  const {
    mode,
    profiles,
    queueEntries,
    runs,
    scripts,
    testCases,
    selectedProfileId,
    setSelectedProfileId,
    suggestedProfile,
    acceptSuggestedProfile,
    dismissSuggestedProfile,
    editingProfileId,
    setEditingProfileId,
    profileDraft,
    setProfileDraft,
    saveProfile,
    deleteProfile,
    resetProfileDraft,
    withBusy,
    busy,
    setError,
    speedMode,
    setSpeedMode,
    needsReviewLaterCases,
    lastUltrafastResult,
    runUltrafast,
    clearUltrafastResult,
  } = useApp();

  // FR-4.25: Ultrafast quick-trigger target -- which script/test case to run.
  const [ultrafastTargetScriptId, setUltrafastTargetScriptId] = useState<string>("");

  const [scope, setScope] = useState<"all" | "selected">("all");
  const [selectedScriptIds, setSelectedScriptIds] = useState<Set<string>>(new Set());
  const [showEditor, setShowEditor] = useState(false);
  const [showScheduleEditor, setShowScheduleEditor] = useState(false);
  const [scheduleTime, setScheduleTime] = useState("02:00");
  const [scheduleDays, setScheduleDays] = useState<Set<string>>(new Set());

  // FR-4.21: named secrets registry
  const [secrets, setSecrets] = useState<any[]>([]);
  const [showSecrets, setShowSecrets] = useState(false);
  const [secretDraft, setSecretDraft] = useState({ name: "", value: "" });
  const [secretsBusy, setSecretsBusy] = useState<string | null>(null);
  const [secretsError, setSecretsError] = useState<string | null>(null);

  async function refreshSecrets() {
    try {
      setSecrets(await api.listSecrets());
    } catch (e: any) {
      setSecretsError(e.message);
    }
  }

  // FR-4.23: Execution Profile version history
  const [versionHistory, setVersionHistory] = useState<{ profileId: string; versions: any[] } | null>(null);

  const activeProfile = profiles.find((p) => p.id === selectedProfileId);
  // Stop execution: surfaced whenever there's actually something in flight to stop --
  // a run mid-execution, or a batch still sitting in the queue (e.g. a large "Run all").
  const runningCount = runs.filter((r) => r.status === "running").length;
  const hasInFlightRuns = runningCount > 0 || queueEntries.length > 0;

  function toggleScript(id: string) {
    setSelectedScriptIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const scopedScripts = scope === "all" ? scripts : scripts.filter((s) => selectedScriptIds.has(s.id));

  // Fast path: one Playwright process with many workers (8–16). Previous
  // one-by-one queue + pool size 2 made 300+ tests take ~2.5 hours.
  async function runScopedTests() {
    if (scopedScripts.length === 0) {
      setError(scope === "selected" ? "Select at least one script to run." : "No automation scripts to run yet.");
      return;
    }
    await withBusy("pipeline", async () => {
      const concurrency =
        activeProfile?.concurrency && activeProfile.concurrency > 1
          ? Math.min(5, activeProfile.concurrency)
          : 5;
      try {
        const result = await api.runExecutionBatch(
          scopedScripts.map((s) => s.id),
          undefined,
          {
            ...(selectedProfileId ? { profile_id: selectedProfileId } : {}),
            concurrency,
            measureBaseline: false,
          }
        );
        setError(null);
        // Surface a quick summary so the user sees workers/time immediately.
        const mins = result?.concurrentDurationMs
          ? (result.concurrentDurationMs / 60000).toFixed(1)
          : "?";
        console.info(
          `[Run] ${result?.scriptCount ?? scopedScripts.length} tests | workers=${result?.concurrency ?? concurrency} | ${mins}m | passed=${result?.passed ?? "?"} failed=${result?.failed ?? "?"}`
        );
      } catch (err: any) {
        // Fallback: queue individually if batch endpoint fails (still uses enlarged pool).
        console.warn("Batch run failed, falling back to queue:", err?.message || err);
        for (const s of scopedScripts) {
          await api.queueScript(s.id, undefined, {
            ...(selectedProfileId ? { profile_id: selectedProfileId } : {}),
            trigger_source: "run-now",
            concurrency,
          });
        }
      }
    });
  }

  function openScheduleEditor() {
    if (!activeProfile) {
      setError("Select an active run profile first.");
      return;
    }
    try {
      const existing = activeProfile.schedule_json ? JSON.parse(activeProfile.schedule_json) : null;
      setScheduleTime(existing?.time || "02:00");
      setScheduleDays(new Set(existing?.daysOfWeek || []));
    } catch {
      setScheduleTime("02:00");
      setScheduleDays(new Set());
    }
    setShowScheduleEditor(true);
  }

  async function saveSchedule() {
    if (!activeProfile) return;
    await withBusy("schedule-save", () =>
      api.updateExecutionProfile(activeProfile.id, {
        ...activeProfile,
        schedule_json: { time: scheduleTime, daysOfWeek: Array.from(scheduleDays) } as any,
      })
    );
    setShowScheduleEditor(false);
  }

  async function clearSchedule() {
    if (!activeProfile) return;
    await withBusy("schedule-clear", () => api.updateExecutionProfile(activeProfile.id, { ...activeProfile, schedule_json: null as any }));
    setShowScheduleEditor(false);
  }

  const liveRunId =
    runs.find((r) => r.status === "running")?.id ||
    runs.find((r) => r.status === "queued")?.id ||
    null;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-xl tracking-tight">Execution</h2>
        <p className="text-sm text-ink/60">Run profiles, queue, and pipeline controls</p>
      </div>

      {liveRunId && (
        <RealtimeExecutionDashboard
          runId={liveRunId}
          onComplete={() => {
            /* AppState polling refreshes runs */
          }}
        />
      )}

      {/* FR-4.24: speed-mode toggle, positioned ahead of the profile dropdown. Ultrafast skips
          the Execution Settings Panel entirely (FR-4.25); Fast keeps the existing checkpointed
          flow (profile/environment confirmation + FR-2.4 review gate) below, unchanged. */}
      <div className="rounded-lg border border-line bg-white/60 shadow-panel p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">Speed mode (FR-4.24)</p>
          <div className="flex items-center rounded-full border border-line bg-white/60 p-0.5 text-xs">
            <button
              className={`rounded-full px-3 py-1 font-medium ${speedMode === "ultrafast" ? "bg-ink text-paper" : "text-ink/60"}`}
              onClick={() => setSpeedMode("ultrafast")}
            >
              Ultrafast
            </button>
            <button
              className={`rounded-full px-3 py-1 font-medium ${speedMode === "fast" ? "bg-ink text-paper" : "text-ink/60"}`}
              onClick={() => setSpeedMode("fast")}
            >
              Fast
            </button>
          </div>
          <span className="text-xs text-ink/50">
            {speedMode === "ultrafast"
              ? "No confirmation dialogs — profile, environment, and high-confidence test case review are all auto-resolved (FR-4.25/FR-4.26)."
              : "Confirm profile/environment and review test cases before automation runs (FR-4.28/FR-4.29)."}
          </span>
        </div>

        {/* FR-4.25: quick trigger -- persisted Ultrafast preference means subsequent runs skip
            the Execution Settings Panel entirely and fire immediately. */}
        {speedMode === "ultrafast" && (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-signal/30 bg-signal/5 p-3">
            <select
              className="rounded-md border border-line bg-white/60 p-2 text-xs"
              value={ultrafastTargetScriptId}
              onChange={(e) => setUltrafastTargetScriptId(e.target.value)}
            >
              <option value="">Choose a test case to run…</option>
              {testCases.map((tc) => (
                <option key={tc.id} value={tc.id}>
                  {tc.title} ({tc.status})
                </option>
              ))}
            </select>
            <button
              className="rounded-md bg-ink text-paper px-3 py-1.5 text-xs font-medium disabled:opacity-50"
              disabled={!ultrafastTargetScriptId || busy === "ultrafast-trigger"}
              onClick={() => runUltrafast({ testCaseId: ultrafastTargetScriptId })}
            >
              {busy === "ultrafast-trigger" ? "Running…" : "Quick trigger (Ultrafast)"}
            </button>
            <span className="text-xs text-ink/50">One click — starts immediately, no settings panel.</span>
          </div>
        )}

        {/* FR-4.27: the interactive HTML report is surfaced directly on completion, no export click required */}
        {lastUltrafastResult && (
          <div className="rounded-md border border-line bg-white/70 p-3 text-xs space-y-1">
            <div className="flex items-center justify-between">
              <p className="font-semibold text-ink/70">Ultrafast run result</p>
              <button className="text-ink/40 hover:text-ink/70" onClick={clearUltrafastResult}>
                Dismiss
              </button>
            </div>
            {lastUltrafastResult.run ? (
              <>
                <p>
                  Run <span className="font-mono">{lastUltrafastResult.run.id}</span>:{" "}
                  <Pill tone={lastUltrafastResult.run.status === "passed" ? "good" : "bad"}>{lastUltrafastResult.run.status}</Pill>
                </p>
                <p className="text-ink/50">
                  Profile: {lastUltrafastResult.resolvedProfile?.reason ?? "—"} · Environment: {lastUltrafastResult.resolvedEnvironment?.reason ?? "—"}
                </p>
                <p className="text-ink/50">Review: {lastUltrafastResult.reviewOutcome?.outcome}</p>
                {lastUltrafastResult.reportUrl && (
                  <a
                    className="inline-block rounded-md bg-signal text-white px-3 py-1.5 font-medium mt-1"
                    href={lastUltrafastResult.reportUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open interactive HTML report (FR-6.11)
                  </a>
                )}
              </>
            ) : (
              <p className="text-ink/60">
                Below the auto-accept threshold — routed to "Needs review later" instead of running (FR-4.26). No run was blocked or delayed.
              </p>
            )}
          </div>
        )}
      </div>

      {/* FR-4.26: non-blocking queue of test cases Ultrafast routed below-threshold */}
      {needsReviewLaterCases.length > 0 && (
        <div className="rounded-lg border border-alert/40 bg-alert/5 p-4 space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-alert">Needs review later ({needsReviewLaterCases.length}) — FR-4.26</p>
          <ul className="space-y-1 text-xs">
            {needsReviewLaterCases.map((tc) => (
              <li key={tc.id} className="flex items-center justify-between gap-2 rounded-md border border-line bg-white/60 px-2 py-1.5">
                <span>{tc.title}</span>
                <span className="text-ink/40">confidence {Math.round((tc.confidence_score ?? 0) * 100)}%</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="rounded-lg border border-line bg-white/60 shadow-panel p-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center rounded-full border border-line bg-white/60 p-0.5 text-xs">
          <button className={`rounded-full px-3 py-1 font-medium ${scope === "all" ? "bg-ink text-paper" : "text-ink/60"}`} onClick={() => setScope("all")}>
            All tests
          </button>
          <button className={`rounded-full px-3 py-1 font-medium ${scope === "selected" ? "bg-ink text-paper" : "text-ink/60"}`} onClick={() => setScope("selected")}>
            Selected tests ({selectedScriptIds.size})
          </button>
        </div>
        <button
          className="rounded-md bg-signal text-white px-3 py-1.5 text-xs font-medium hover:bg-signal/90 disabled:opacity-50"
          disabled={busy === "pipeline" || scopedScripts.length === 0}
          onClick={runScopedTests}
        >
          {busy === "pipeline" ? "Starting…" : `Run ${scope === "selected" ? "selected" : "all"} (${scopedScripts.length})`}
        </button>
        {hasInFlightRuns && (
          <button
            className="rounded-md border border-alert text-alert px-3 py-1.5 text-xs font-medium hover:bg-alert/5 disabled:opacity-50"
            disabled={busy === "stop-all"}
            onClick={() => withBusy("stop-all", () => api.stopAllExecutions())}
          >
            {busy === "stop-all" ? "Stopping…" : `Stop execution (${runningCount + queueEntries.length})`}
          </button>
        )}
        <button
          className="rounded-md border border-ink/20 text-ink/70 px-3 py-1.5 text-xs font-medium hover:bg-ink/5"
          onClick={openScheduleEditor}
        >
          Run schedule
        </button>
        <button
          className="rounded-md border border-ink/20 text-ink/70 px-3 py-1.5 text-xs font-medium hover:bg-ink/5"
          onClick={() => {
            setShowSecrets((v) => !v);
            if (!showSecrets) refreshSecrets();
          }}
        >
          {showSecrets ? "Close secrets" : "Manage secrets"}
        </button>
        <button className="ml-auto rounded-md bg-ink text-paper px-3 py-1.5 text-xs font-medium" onClick={() => setShowEditor((v) => !v)}>
          {showEditor ? "Close profile editor" : "Manage profiles"}
        </button>
      </div>

      {/* FR-4.14: suggested profile is surfaced as a dismissible accept/override banner
          instead of being silently auto-selected. */}
      {suggestedProfile && !selectedProfileId && (
        <div className="rounded-lg border border-signal/40 bg-signal/5 p-3 flex flex-wrap items-center gap-3 text-sm">
          <span>
            Suggested profile: <strong>{suggestedProfile.name}</strong>
            {suggestedProfile._reason ? <span className="text-ink/60"> — based on {suggestedProfile._reason}</span> : null}
          </span>
          <div className="ml-auto flex gap-2">
            <button
              className="rounded-md bg-ink text-paper px-3 py-1 text-xs font-medium"
              onClick={acceptSuggestedProfile}
            >
              Accept
            </button>
            <button
              className="rounded-md border border-line px-3 py-1 text-xs font-medium hover:bg-ink/5"
              onClick={dismissSuggestedProfile}
            >
              Use different profile
            </button>
          </div>
        </div>
      )}

      {/* FR-4.21: named secrets registry -- name + masked value, create/delete only, value never re-displayed */}
      {showSecrets && (
        <div className="rounded-lg border border-line bg-white/60 shadow-panel p-4 space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">Secrets (FR-4.21)</p>
          <p className="text-xs text-ink/50">Referenced by generated automation scripts at runtime. Values are encrypted at rest and never shown again after creation.</p>
          {secretsError && <div className="rounded-md border border-alert bg-alert/5 p-2 text-xs text-alert">{secretsError}</div>}
          <div className="grid gap-2 sm:grid-cols-3">
            <input
              className="rounded-md border border-line bg-white/60 p-2 text-sm"
              placeholder="Secret name (e.g. TEST_ACCOUNT_PASSWORD)"
              value={secretDraft.name}
              onChange={(e) => setSecretDraft((d) => ({ ...d, name: e.target.value }))}
            />
            <input
              className="rounded-md border border-line bg-white/60 p-2 text-sm"
              type="password"
              placeholder="Value"
              value={secretDraft.value}
              onChange={(e) => setSecretDraft((d) => ({ ...d, value: e.target.value }))}
            />
            <button
              className="rounded-md bg-ink text-paper px-3 py-1.5 text-xs font-medium disabled:opacity-50"
              disabled={secretsBusy === "create-secret"}
              onClick={async () => {
                if (!secretDraft.name.trim() || !secretDraft.value.trim()) {
                  setSecretsError("Name and value are required.");
                  return;
                }
                setSecretsBusy("create-secret");
                setSecretsError(null);
                try {
                  await api.createSecret(secretDraft.name.trim(), secretDraft.value.trim());
                  setSecretDraft({ name: "", value: "" });
                  await refreshSecrets();
                } catch (e: any) {
                  setSecretsError(e.message);
                } finally {
                  setSecretsBusy(null);
                }
              }}
            >
              Save secret
            </button>
          </div>
          {secrets.length === 0 ? (
            <p className="text-sm text-ink/50">No secrets stored yet.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {secrets.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-2 rounded-md border border-line bg-white/50 p-2">
                  <span className="font-mono text-xs">{s.name}</span>
                  <span className="text-ink/40 font-mono text-xs">{s.masked_value}</span>
                  <button
                    className="rounded border border-alert text-alert px-2 py-1 text-xs"
                    onClick={async () => {
                      setSecretsBusy(`delete-${s.name}`);
                      try {
                        await api.deleteSecret(s.name);
                        await refreshSecrets();
                      } catch (e: any) {
                        setSecretsError(e.message);
                      } finally {
                        setSecretsBusy(null);
                      }
                    }}
                  >
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="rounded-lg border border-line bg-white/60 shadow-panel p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink/60 mb-2">
          {scope === "selected" ? "Select scripts to include" : `All scripts (${scripts.length}) — included in Create pipeline`}
        </p>
        {scripts.length === 0 ? (
          <p className="text-sm text-ink/50">No automation scripts yet — generate one from AI Studio or Testing first.</p>
        ) : (
          <div className="space-y-1 max-h-56 overflow-y-auto">
            {scripts.map((s) => {
              const tc = testCases.find((t) => t.id === s.test_case_id);
              return (
                <label key={s.id} className="flex items-center gap-2 rounded-md border border-line bg-white/50 px-2 py-1.5 text-xs">
                  {scope === "selected" ? (
                    <input type="checkbox" checked={selectedScriptIds.has(s.id)} onChange={() => toggleScript(s.id)} />
                  ) : (
                    <span className="h-1.5 w-1.5 rounded-full bg-signal shrink-0" aria-hidden="true" />
                  )}
                  <span className="font-medium">{tc?.title ?? s.test_case_id}</span>
                  <span className="text-ink/40 font-mono ml-auto">{s.file_path.split(/[\\/]/).pop()}</span>
                </label>
              );
            })}
          </div>
        )}
      </div>

      {showScheduleEditor && activeProfile && (
        <div className="rounded-lg border border-line bg-white/60 shadow-panel p-4 space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">
            Schedule for "{activeProfile.name}" (FR-4.16 — runs automatically once/day at this time)
          </p>
          <div className="flex items-center gap-2 text-sm">
            <label className="text-ink/60">Time</label>
            <input
              type="time"
              className="rounded-md border border-line bg-white/60 p-2 text-sm"
              value={scheduleTime}
              onChange={(e) => setScheduleTime(e.target.value)}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            {DAYS.map((d) => (
              <button
                key={d}
                type="button"
                className={`rounded-full border px-2.5 py-1 text-xs font-medium ${scheduleDays.has(d) ? "bg-ink text-paper border-ink" : "border-line text-ink/60"}`}
                onClick={() =>
                  setScheduleDays((prev) => {
                    const next = new Set(prev);
                    if (next.has(d)) next.delete(d);
                    else next.add(d);
                    return next;
                  })
                }
              >
                {d}
              </button>
            ))}
          </div>
          <p className="text-xs text-ink/50">No days selected = runs every day at this time.</p>
          <div className="flex flex-wrap gap-2">
            <button className="rounded-md bg-ink text-paper px-3 py-1.5 text-xs font-medium disabled:opacity-50" disabled={busy === "schedule-save"} onClick={saveSchedule}>
              Save schedule
            </button>
            {activeProfile.schedule_json && (
              <button className="rounded-md border border-alert text-alert px-3 py-1.5 text-xs font-medium disabled:opacity-50" disabled={busy === "schedule-clear"} onClick={clearSchedule}>
                Clear schedule
              </button>
            )}
            <button
              className="rounded-md border border-line px-3 py-1.5 text-xs font-medium hover:bg-ink/5"
              disabled={busy === "scheduler-tick"}
              onClick={() => withBusy("scheduler-tick", () => api.triggerScheduler())}
            >
              Trigger scheduler now
            </button>
            <button className="rounded-md border border-line px-3 py-1.5 text-xs font-medium" onClick={() => setShowScheduleEditor(false)}>
              Close
            </button>
          </div>
        </div>
      )}

      {showEditor && (
        <div className="rounded-lg border border-line bg-white/60 shadow-panel p-4 space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">Profile editor</p>
          <input className="w-full rounded-md border border-line bg-white/60 p-2 text-sm" placeholder="Profile name" value={profileDraft.name} onChange={(e) => setProfileDraft((prev) => ({ ...prev, name: e.target.value }))} />
          <textarea className="w-full rounded-md border border-line bg-white/60 p-2 text-sm" rows={2} placeholder="Description" value={profileDraft.description} onChange={(e) => setProfileDraft((prev) => ({ ...prev, description: e.target.value }))} />
          <select className="w-full rounded-md border border-line bg-white/60 p-2 text-sm" value={profileDraft.browser_set} onChange={(e) => setProfileDraft((prev) => ({ ...prev, browser_set: e.target.value }))}>
            <option value="chromium">Chromium only</option>
            <option value="chromium+firefox">Chromium + Firefox</option>
            <option value="all">All three engines</option>
            <option value="headless">Headless</option>
          </select>
          <div className="grid gap-2 sm:grid-cols-2">
            <select className="rounded-md border border-line bg-white/60 p-2 text-sm" value={profileDraft.artifact_capture_mode} onChange={(e) => setProfileDraft((prev) => ({ ...prev, artifact_capture_mode: e.target.value }))}>
              <option value="logs-only">Logs only</option>
              <option value="failures-only">Failures only</option>
              <option value="all-screenshots">All screenshots</option>
              <option value="video-failures">Video failures</option>
              <option value="video-all">Video all</option>
              <option value="full-debug">Full debug</option>
            </select>
            <select className="rounded-md border border-line bg-white/60 p-2 text-sm" value={profileDraft.selection_mode} onChange={(e) => setProfileDraft((prev) => ({ ...prev, selection_mode: e.target.value }))}>
              <option value="full-suite">Full suite</option>
              <option value="smart-selection">Smart selection</option>
              <option value="custom-selection">Custom selection</option>
              <option value="flaky-tests-only">Flaky tests only</option>
              <option value="scheduled-regression">Scheduled regression</option>
            </select>
            <select className="rounded-md border border-line bg-white/60 p-2 text-sm" value={profileDraft.retry_strategy} onChange={(e) => setProfileDraft((prev) => ({ ...prev, retry_strategy: e.target.value }))}>
              <option value="no-retry">No retry</option>
              <option value="retry-flaky">Retry flaky</option>
              <option value="retry-all">Retry all</option>
              <option value="smart-retry">Smart retry</option>
            </select>
            <select className="rounded-md border border-line bg-white/60 p-2 text-sm" value={profileDraft.provider} onChange={(e) => setProfileDraft((prev) => ({ ...prev, provider: e.target.value }))}>
              <option value="local">Local</option>
              <option value="ci">CI</option>
              <option value="cloud">Cloud</option>
            </select>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <input className="rounded-md border border-line bg-white/60 p-2 text-sm" type="number" min="1" max="20" value={profileDraft.concurrency} onChange={(e) => setProfileDraft((prev) => ({ ...prev, concurrency: Number(e.target.value) }))} />
            <input className="rounded-md border border-line bg-white/60 p-2 text-sm" type="number" min="1" max="365" value={profileDraft.retention_days} onChange={(e) => setProfileDraft((prev) => ({ ...prev, retention_days: Number(e.target.value) }))} />
            {/* Shared-runner-pool reservations are a team/CI concept -- irrelevant for a
                solo QA running everything locally, so hide them outside Enterprise mode. */}
            {mode === "enterprise" && (
              <>
                <input className="rounded-md border border-line bg-white/60 p-2 text-sm" type="number" min="0" value={profileDraft.reserved_runner_count} onChange={(e) => setProfileDraft((prev) => ({ ...prev, reserved_runner_count: Number(e.target.value) }))} />
                <input className="rounded-md border border-line bg-white/60 p-2 text-sm" placeholder="Runner pool" value={profileDraft.runner_pool_name} onChange={(e) => setProfileDraft((prev) => ({ ...prev, runner_pool_name: e.target.value }))} />
              </>
            )}
          </div>
          <label className="flex items-center gap-2 text-sm text-ink/70">
            <input type="checkbox" checked={profileDraft.headless_mode === 1} onChange={(e) => setProfileDraft((prev) => ({ ...prev, headless_mode: e.target.checked ? 1 : 0 }))} />
            Headless mode
          </label>
          <label className="flex items-center gap-2 text-sm text-ink/70">
            <input type="checkbox" checked={profileDraft.reuse_browser_instances === 1} onChange={(e) => setProfileDraft((prev) => ({ ...prev, reuse_browser_instances: e.target.checked ? 1 : 0 }))} />
            Reuse browser instances
          </label>
          {mode === "enterprise" && (
            <label className="flex items-center gap-2 text-sm text-ink/70">
              <input type="checkbox" checked={profileDraft.is_default_for_team === 1} onChange={(e) => setProfileDraft((prev) => ({ ...prev, is_default_for_team: e.target.checked ? 1 : 0 }))} />
              Default for team
            </label>
          )}
          {/* FR-4.24: this profile's default speed mode -- when Ultrafast, the client's quick-trigger
              flow skips the Execution Settings Panel entirely for runs against this profile. */}
          <label className="flex items-center gap-2 text-sm text-ink/70">
            <input
              type="checkbox"
              checked={profileDraft.default_speed_mode === "ultrafast"}
              onChange={(e) => setProfileDraft((prev) => ({ ...prev, default_speed_mode: e.target.checked ? "ultrafast" : "fast" }))}
            />
            Default to Ultrafast Mode for this profile (FR-4.24)
          </label>
          <div className="flex gap-2">
            <button className="rounded-md bg-ink text-paper px-3 py-1.5 text-xs font-medium" onClick={() => withBusy("profile-save", saveProfile)}>
              {editingProfileId ? "Save profile" : "Create profile"}
            </button>
            {editingProfileId && (
              <button
                className="rounded-md border border-line px-3 py-1.5 text-xs font-medium"
                onClick={() => {
                  setEditingProfileId(null);
                  resetProfileDraft();
                }}
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-3">
        {profiles.map((profile) => (
          <button
            key={profile.id}
            className={`text-left rounded-lg border p-3 text-xs ${selectedProfileId === profile.id ? "border-signal bg-signal/5" : "border-line bg-white/60"}`}
            onClick={() => setSelectedProfileId(profile.id)}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-sm">{profile.name}</span>
              {selectedProfileId === profile.id && <Pill tone="good">active</Pill>}
            </div>
            <p className="text-ink/50 mt-1">{profile.browser_set} • {profile.selection_mode} • {profile.retry_strategy}</p>
            <div className="mt-2 flex gap-2">
              <button
                className="rounded border border-line px-2 py-1"
                onClick={(e) => {
                  e.stopPropagation();
                  setEditingProfileId(profile.id);
                  setProfileDraft({
                    name: profile.name,
                    description: profile.description || "",
                    browser_set: profile.browser_set,
                    concurrency: profile.concurrency,
                    artifact_capture_mode: profile.artifact_capture_mode,
                    retention_days: profile.retention_days,
                    selection_mode: profile.selection_mode,
                    retry_strategy: profile.retry_strategy,
                    provider: profile.provider,
                    runner_pool_name: profile.runner_pool_name || "",
                    reserved_runner_count: profile.reserved_runner_count,
                    headless_mode: profile.headless_mode,
                    reuse_browser_instances: profile.reuse_browser_instances,
                    is_default_for_team: profile.is_default_for_team,
                    is_default_for_suite: profile.is_default_for_suite,
                    default_speed_mode: (profile as any).default_speed_mode === "ultrafast" ? "ultrafast" : "fast",
                  });
                  setShowEditor(true);
                }}
              >
                Edit
              </button>
              <button
                className="rounded border border-alert text-alert px-2 py-1"
                onClick={(e) => {
                  e.stopPropagation();
                  deleteProfile(profile.id);
                }}
              >
                Delete
              </button>
              <button
                className="rounded border border-line px-2 py-1"
                onClick={async (e) => {
                  e.stopPropagation();
                  const versions = await api.listProfileVersions(profile.id);
                  setVersionHistory({ profileId: profile.id, versions });
                }}
              >
                History
              </button>
            </div>
          </button>
        ))}
      </div>

      {/* FR-4.23: Execution Profile version history -- prior versions with a diff and editor identity */}
      {versionHistory && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-6" onClick={() => setVersionHistory(null)}>
          <div className="w-full max-w-xl max-h-[80vh] overflow-y-auto rounded-lg border border-line bg-white p-5 shadow-xl space-y-3" onClick={(e) => e.stopPropagation()}>
            <p className="font-display text-lg">
              Version history — {profiles.find((p) => p.id === versionHistory.profileId)?.name ?? versionHistory.profileId}
            </p>
            {versionHistory.versions.length === 0 ? (
              <p className="text-sm text-ink/50">No prior versions recorded — this profile hasn't been edited yet.</p>
            ) : (
              <ul className="space-y-2 text-xs">
                {versionHistory.versions.map((v: any) => (
                  <li key={v.id} className="rounded-md border border-line p-3 space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold">Version {v.version}</span>
                      <span className="text-ink/50">{new Date(v.created_at).toLocaleString()}</span>
                    </div>
                    <p className="text-ink/50">Edited by: {v.edited_by ?? "unknown"}</p>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="rounded border border-line/60 p-2">
                        <p className="text-[10px] uppercase text-ink/40 mb-1">Before</p>
                        <pre className="whitespace-pre-wrap break-words text-[10px] text-ink/60">{JSON.stringify(v.snapshot.before, null, 1)}</pre>
                      </div>
                      <div className="rounded border border-line/60 p-2">
                        <p className="text-[10px] uppercase text-ink/40 mb-1">After</p>
                        <pre className="whitespace-pre-wrap break-words text-[10px] text-ink/60">{JSON.stringify(v.snapshot.after, null, 1)}</pre>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <button className="rounded-md border border-line px-3 py-1.5 text-xs" onClick={() => setVersionHistory(null)}>
              Close
            </button>
          </div>
        </div>
      )}

      {queueEntries.length > 0 && (
        <div className="rounded-lg border border-line bg-white/60 shadow-panel p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink/60 mb-2">Queue</p>
          <ul className="space-y-1 text-xs text-ink/70">
            {queueEntries.map((entry) => (
              <li key={entry.id} className="flex items-center justify-between gap-2">
                <span>#{entry.queue_position ?? 0} • {entry.id}</span>
                <span>{entry.status}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="rounded-lg border border-line bg-white/60 shadow-panel p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink/60 mb-2">Recent runs</p>
        {runs.length === 0 ? (
          <p className="text-sm text-ink/50">No runs yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead>
                <tr className="text-ink/50 border-b border-line">
                  <th className="py-1.5 pr-3">Run ID</th>
                  <th className="py-1.5 pr-3">Profile</th>
                  <th className="py-1.5 pr-3">Speed mode</th>
                  <th className="py-1.5 pr-3">Status</th>
                  <th className="py-1.5 pr-3">Duration</th>
                  <th className="py-1.5 pr-3">Started</th>
                  <th className="py-1.5 pr-3">Test case</th>
                  <th className="py-1.5 pr-3"></th>
                </tr>
              </thead>
              <tbody>
                {runs.slice(0, 20).map((r) => {
                  const profile = profiles.find((p) => p.id === r.profile_id);
                  const script = scripts.find((s) => s.id === r.script_id);
                  const tc = script ? testCases.find((t) => t.id === script.test_case_id) : null;
                  const statusTone = r.status === "passed" ? "good" : r.status === "blocked" || r.status === "running" || r.status === "queued" ? "warn" : r.status === "stopped" ? "neutral" : "bad";
                  return (
                    <tr key={r.id} className="border-b border-line/50">
                      <td className="py-1.5 pr-3 font-mono">{r.id}</td>
                      <td className="py-1.5 pr-3">{profile?.name ?? r.profile_id ?? "—"}</td>
                      {/* FR-4.24 acceptance criteria: the selected speed mode is displayed on the run summary */}
                      <td className="py-1.5 pr-3">
                        <Pill tone={r.speed_mode === "ultrafast" ? "warn" : "neutral"}>{r.speed_mode ?? "fast"}</Pill>
                      </td>
                      <td className="py-1.5 pr-3">
                        <Pill tone={statusTone}>{r.status}</Pill>
                      </td>
                      <td className="py-1.5 pr-3">{r.duration_ms ?? 0}ms</td>
                      <td className="py-1.5 pr-3 text-ink/50">{new Date(r.created_at).toLocaleString()}</td>
                      <td className="py-1.5 pr-3 text-ink/40">{tc?.title ?? ""}</td>
                      <td className="py-1.5 pr-3">
                        {(r.status === "running" || r.status === "queued") && (
                          <button
                            className="rounded border border-alert text-alert px-2 py-0.5 text-[10px] disabled:opacity-50"
                            disabled={busy === `stop-run-${r.id}`}
                            onClick={() => withBusy(`stop-run-${r.id}`, () => api.stopExecutionRun(r.id))}
                          >
                            Stop
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <AllureReportPanel />
    </div>
  );
}
