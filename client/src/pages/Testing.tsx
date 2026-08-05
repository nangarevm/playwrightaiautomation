import { useEffect, useState } from "react";
import { useApp } from "../context/AppState.js";
import { api } from "../api.js";
import { Pill } from "../components/Pill.js";

export default function Testing() {
  const {
    scripts,
    testCases,
    runs,
    profiles,
    environments,
    selectedProfileId,
    setSelectedProfileId,
    selectedEnvironmentId,
    setSelectedEnvironmentId,
    busy,
    withBusy,
  } = useApp();
  const [activeId, setActiveId] = useState<string | null>(scripts[0]?.id ?? null);
  const active = scripts.find((s) => s.id === activeId) ?? scripts[0] ?? null;
  const activeTc = active ? testCases.find((t) => t.id === active.test_case_id) : null;

  const runsByScript: Record<string, typeof runs> = {};
  for (const r of runs) (runsByScript[r.script_id] ??= []).push(r);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-xl tracking-tight">Testing</h2>
        <p className="text-sm text-ink/60">Automation scripts, code review, and self-healing</p>
      </div>

      <div className="grid grid-cols-[320px_1fr] gap-4 items-start">
        <div className="rounded-lg border border-line bg-white/60 shadow-panel overflow-hidden">
          <div className="p-3 border-b border-line text-xs font-semibold uppercase tracking-wide text-ink/60">Scripts</div>
          <div className="max-h-[70vh] overflow-y-auto divide-y divide-line">
            {scripts.length === 0 && <p className="p-4 text-sm text-ink/50">No scripts yet — generate one from AI Studio.</p>}
            {scripts.map((s) => {
              const tc = testCases.find((t) => t.id === s.test_case_id);
              return (
                <button
                  key={s.id}
                  className={`w-full text-left p-3 hover:bg-ink/5 ${activeId === s.id ? "bg-signal/5" : ""}`}
                  onClick={() => setActiveId(s.id)}
                >
                  <div className="flex items-center gap-1.5">
                    <p className="text-sm font-medium truncate">{tc?.title ?? s.test_case_id}</p>
                    <span className="shrink-0 rounded border border-line px-1 text-[10px] font-mono uppercase text-ink/50">{s.language}</span>
                  </div>
                  <p className="text-xs text-ink/40 font-mono truncate">{s.file_path.split(/[\\/]/).slice(-2).join("/")}</p>
                  <Pill tone={s.security_scan_status === "passed" ? "good" : "bad"}>
                    {s.security_scan_status === "passed" ? "Scan clean" : "Flagged"}
                  </Pill>
                </button>
              );
            })}
          </div>
        </div>

        <div className="space-y-4">
          {!active ? (
            <div className="rounded-lg border border-line bg-white/60 shadow-panel p-5">
              <p className="text-sm text-ink/50">Select a script to view its code.</p>
            </div>
          ) : (
            <>
              <div className="rounded-lg border border-line bg-white/60 shadow-panel p-4">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div>
                    <p className="font-medium">{activeTc?.title ?? active.test_case_id}</p>
                    <p className="text-xs text-ink/40 font-mono">{active.file_path}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Pill tone={active.security_scan_status === "passed" ? "good" : "bad"}>scan: {active.security_scan_status}</Pill>
                  </div>
                </div>
                <pre className="mt-3 text-xs bg-ink text-paper rounded-md p-3 overflow-x-auto max-h-96">{active.code}</pre>

                {/* FR-4.28: Fast Mode's Execution Settings Panel -- a run cannot proceed without
                    an explicit user confirmation of both profile and environment. The server
                    enforces this too (POST /execution-runs/:scriptId/run 400s without both), but
                    the button itself is also gated here so the UI doesn't submit a doomed request. */}
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <label className="text-xs text-ink/60">
                    Execution profile
                    <select
                      className="mt-1 w-full rounded-md border border-line bg-white/60 p-2 text-xs"
                      value={selectedProfileId}
                      onChange={(e) => setSelectedProfileId(e.target.value)}
                    >
                      <option value="">Select a profile…</option>
                      {profiles.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs text-ink/60">
                    Environment
                    <select
                      className="mt-1 w-full rounded-md border border-line bg-white/60 p-2 text-xs"
                      value={selectedEnvironmentId}
                      onChange={(e) => setSelectedEnvironmentId(e.target.value)}
                    >
                      <option value="">Select an environment…</option>
                      {environments.map((env) => (
                        <option key={env.id} value={env.id}>
                          {env.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    className="rounded-md bg-signal text-white px-3 py-1.5 text-xs font-medium hover:bg-signal/90 disabled:opacity-50"
                    disabled={
                      busy === `run-${active.id}` ||
                      active.security_scan_status === "flagged" ||
                      !selectedProfileId ||
                      !selectedEnvironmentId
                    }
                    onClick={() =>
                      withBusy(`run-${active.id}`, () =>
                        api.runScript(active.id, undefined, {
                          profile_id: selectedProfileId,
                          environment_id: selectedEnvironmentId,
                          trigger_source: "ui",
                        })
                      )
                    }
                  >
                    {busy === `run-${active.id}` ? "Running…" : "Run test"}
                  </button>
                  <button
                    className="rounded-md border border-ink/20 text-ink/70 px-3 py-1.5 text-xs font-medium hover:bg-ink/5"
                    disabled={busy === `queue-${active.id}` || active.security_scan_status === "flagged"}
                    onClick={() => withBusy(`queue-${active.id}`, () => api.queueScript(active.id, undefined, { profile_id: selectedProfileId || undefined, trigger_source: "ui" }))}
                  >
                    {busy === `queue-${active.id}` ? "Queueing…" : "Queue run"}
                  </button>
                </div>
                {!selectedProfileId || !selectedEnvironmentId ? (
                  <p className="mt-2 text-xs text-ink/40">
                    Select a profile and environment to enable Run test (FR-4.28).
                  </p>
                ) : null}
                {(runsByScript[active.id] ?? []).length > 0 && (
                  <div className="mt-3 space-y-1">
                    {(runsByScript[active.id] ?? []).slice(0, 3).map((r) => (
                      <div key={r.id} className="text-xs text-ink/60 flex gap-2 items-center">
                        <Pill tone={r.status === "passed" ? "good" : r.status === "blocked" ? "warn" : "bad"}>{r.status}</Pill>
                        <span>{r.duration_ms ?? 0}ms</span>
                        <span className="text-ink/30">{new Date(r.created_at).toLocaleTimeString()}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <SelfHealingPanel scriptId={active.id} testCaseId={active.test_case_id} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function SelfHealingPanel({ testCaseId }: { scriptId: string; testCaseId: string }) {
  const { healDrafts, setHealDrafts, healState, setHealState, withBusy } = useApp();
  const [open, setOpen] = useState(false);
  // FR-5.4: fetched from the QA-Lead-editable org setting instead of a hardcoded 0.8.
  const [confidenceThreshold, setConfidenceThreshold] = useState(0.8);
  useEffect(() => {
    api.getSelfHealThreshold().then((r) => setConfidenceThreshold(r.threshold)).catch(() => undefined);
  }, []);
  const draft = healDrafts[testCaseId] ?? { uiBefore: "", uiAfter: "", beforeLocator: "", afterLocator: "", confidence: 0.9 };
  const state = healState[testCaseId] ?? {};
  const setDraft = (patch: Partial<typeof draft>) => setHealDrafts((prev) => ({ ...prev, [testCaseId]: { ...draft, ...patch } }));

  return (
    <div className="rounded-lg border border-line bg-white/60 shadow-panel p-4">
      <button className="text-sm font-medium text-signal" onClick={() => setOpen((v) => !v)}>
        {open ? "▾" : "▸"} Change detection & self-healing
      </button>
      {open && (
        <div className="mt-3 space-y-2 text-xs">
          <p className="text-ink/50">Paste the before/after DOM snippet for the element this test targets, then run detection.</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <textarea
              className="w-full rounded-md border border-line bg-white/60 p-2"
              rows={2}
              placeholder='UI before, e.g. <input id="username" />'
              value={draft.uiBefore}
              onChange={(e) => setDraft({ uiBefore: e.target.value })}
            />
            <textarea
              className="w-full rounded-md border border-line bg-white/60 p-2"
              rows={2}
              placeholder='UI after, e.g. <input id="user-name" />'
              value={draft.uiAfter}
              onChange={(e) => setDraft({ uiAfter: e.target.value })}
            />
          </div>
          <button
            className="rounded-md border border-ink/20 text-ink/70 px-3 py-1.5 font-medium hover:bg-ink/5"
            onClick={() =>
              withBusy(`detect-${testCaseId}`, async () => {
                const detection = await api.detectChanges(testCaseId, { uiBeforeHtml: draft.uiBefore, uiAfterHtml: draft.uiAfter, source: "manual" });
                setHealState((prev) => ({ ...prev, [testCaseId]: { ...prev[testCaseId], detection } }));
              })
            }
          >
            Run change detection
          </button>

          {state.detection && (
            <div className="rounded-md border border-line bg-white/60 p-2">
              <p>
                Detected: <span className="font-medium">{String(state.detection.detected)}</span> • types: {state.detection.changeTypes?.join(", ") || "none"} • confidence{" "}
                <span className="font-medium">{Math.round(state.detection.confidenceScore * 100)}%</span>
              </p>
            </div>
          )}

          {state.detection && (
            <div className="grid gap-2 sm:grid-cols-3 items-end">
              <input
                className="rounded-md border border-line bg-white/60 p-2"
                placeholder="Before locator, e.g. getByLabel('Username')"
                value={draft.beforeLocator}
                onChange={(e) => setDraft({ beforeLocator: e.target.value })}
              />
              <input
                className="rounded-md border border-line bg-white/60 p-2"
                placeholder="After locator, e.g. getByTestId('username-input')"
                value={draft.afterLocator}
                onChange={(e) => setDraft({ afterLocator: e.target.value })}
              />
              <input
                className="rounded-md border border-line bg-white/60 p-2"
                type="number"
                min={0}
                max={1}
                step={0.01}
                value={draft.confidence}
                onChange={(e) => setDraft({ confidence: Number(e.target.value) })}
              />
            </div>
          )}

          {state.detection && (
            <button
              className="rounded-md bg-ink text-paper px-3 py-1.5 font-medium hover:bg-ink/90 disabled:opacity-50"
              disabled={!draft.beforeLocator || !draft.afterLocator}
              onClick={() =>
                withBusy(`heal-${testCaseId}`, async () => {
                  const healResult = await api.healTestCase(testCaseId, {
                    detectionId: state.detection.id,
                    beforeLocator: draft.beforeLocator,
                    afterLocator: draft.afterLocator,
                    confidence: draft.confidence,
                    reason: "manual locator update",
                  });
                  const actions = await api.listHealActions(testCaseId);
                  setHealState((prev) => ({ ...prev, [testCaseId]: { ...prev[testCaseId], healResult, actions } }));
                })
              }
            >
              {draft.confidence >= confidenceThreshold ? "Apply auto-heal" : `Flag for regeneration (below ${confidenceThreshold} threshold)`}
            </button>
          )}

          {state.healResult && (
            <div className={`rounded-md border p-2 ${state.healResult.applied ? "border-signal/30 bg-signal/5" : "border-warn/40 bg-warn-soft"}`}>
              {state.healResult.applied
                ? "Locator healed automatically and the script + test case were updated together."
                : "Confidence below threshold — flagged for regeneration instead of auto-applying."}
            </div>
          )}

          {(state.actions ?? []).length > 0 && (
            <div className="space-y-1">
              <p className="font-medium text-ink/60">Heal history</p>
              {(state.actions ?? []).map((action: any) => (
                <div key={action.id} className="flex items-center justify-between gap-2 rounded-md border border-line bg-white/60 p-2">
                  <span>
                    {action.applied ? "applied" : "flagged"} • conf {Math.round(action.confidence_score * 100)}% • {new Date(action.created_at).toLocaleTimeString()}
                    {action.rolled_back ? " • rolled back" : ""}
                  </span>
                  {!action.rolled_back && action.applied === 1 && (
                    <button
                      className="rounded border border-alert text-alert px-2 py-1"
                      onClick={() =>
                        withBusy(`rollback-${action.id}`, async () => {
                          await api.rollbackHeal(action.id);
                          const actions = await api.listHealActions(testCaseId);
                          setHealState((prev) => ({ ...prev, [testCaseId]: { ...prev[testCaseId], actions } }));
                        })
                      }
                    >
                      Rollback
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
