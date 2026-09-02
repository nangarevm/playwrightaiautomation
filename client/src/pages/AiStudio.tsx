import { useState } from "react";
import { useApp } from "../context/AppState.js";
import { api } from "../api.js";
import { CATEGORY_COLOR, Pill } from "../components/Pill.js";

export default function AiStudio({ compact = false }: { compact?: boolean }) {
  const {
    testCases,
    scripts,
    mode,
    reviewDrafts,
    setReviewDrafts,
    reviewNotes,
    setReviewNotes,
    reviewDetails,
    setReviewDetails,
    frameworkChoice,
    setFrameworkChoice,
    externalProvider,
    externalBaseUrl,
    externalToken,
    busy,
    withBusy,
    refreshAll,
  } = useApp();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [exportFormat, setExportFormat] = useState<"csv" | "xlsx" | "pdf" | "docx">("pdf");
  const [activeId, setActiveId] = useState<string | null>(testCases[0]?.id ?? null);
  // FR-9.1: concurrent-edit conflict state -- populated when the server returns
  // 409 (base_version mismatch) instead of silently overwriting someone else's change
  const [conflict, setConflict] = useState<{ testCaseId: string; current: any; yourBaseVersion: number } | null>(null);

  // FR-2.18: search/filter the test case library by keyword/priority/category, live (client-side over the already-loaded list)
  const [searchKeyword, setSearchKeyword] = useState("");
  const [filterCategory, setFilterCategory] = useState("");
  const [filterPriority, setFilterPriority] = useState("");
  // FR-4.26: filter down to test cases Ultrafast routed below-threshold, non-blocking
  const [needsReviewLaterOnly, setNeedsReviewLaterOnly] = useState(false);
  const filteredTestCases = testCases.filter((tc) => {
    if (searchKeyword && !tc.title.toLowerCase().includes(searchKeyword.toLowerCase())) return false;
    if (filterCategory && tc.category !== filterCategory) return false;
    if (filterPriority && (tc.priority ?? "Medium") !== filterPriority) return false;
    if (needsReviewLaterOnly && Number((tc as any).needs_review_later) !== 1) return false;
    return true;
  });

  async function reviewWithConflictHandling(
    testCaseId: string,
    action: "accept" | "edit" | "reject" | "needs_discussion",
    editedFields: any,
    notes: string | undefined,
    baseVersion: number
  ) {
    try {
      return await api.reviewTestCase(testCaseId, action, editedFields, notes, baseVersion);
    } catch (err: any) {
      if (err.conflict) {
        setConflict({ testCaseId, current: err.current, yourBaseVersion: baseVersion });
        return null;
      }
      throw err;
    }
  }

  const scriptByTestCase = Object.fromEntries(scripts.map((s) => [s.test_case_id, s]));
  const active = testCases.find((t) => t.id === activeId) ?? testCases[0] ?? null;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll() {
    setSelected(new Set(filteredTestCases.map((t) => t.id)));
  }

  return (
    <div className={compact ? "space-y-3" : "space-y-6"}>
      {!compact && (
        <div>
          <h2 className="font-display text-xl tracking-tight">AI Studio</h2>
          <p className="text-sm text-ink/60">Review, edit, and approve AI-generated test cases</p>
        </div>
      )}

      {/* FR-9.1: concurrent-edit merge/conflict view -- shown instead of silently
          overwriting when the server's version has moved since this tab loaded it */}
      {conflict && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-6">
          <div className="w-full max-w-2xl rounded-lg border border-line bg-white p-5 shadow-xl space-y-3">
            <p className="font-display text-lg text-alert">Edit conflict (FR-9.1)</p>
            <p className="text-sm text-ink/70">
              This test case was modified by someone else after you loaded it (your version: {conflict.yourBaseVersion}, current version: {conflict.current.version}).
              Review the current state below before deciding.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-md border border-line bg-white/60 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-ink/60 mb-1">Your loaded version</p>
                <p className="text-sm font-medium">{testCases.find((t) => t.id === conflict.testCaseId)?.title}</p>
                <p className="text-xs text-ink/50 mt-1">Status: {testCases.find((t) => t.id === conflict.testCaseId)?.status}</p>
              </div>
              <div className="rounded-md border border-signal bg-signal/5 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-ink/60 mb-1">Current server version</p>
                <p className="text-sm font-medium">{conflict.current.title}</p>
                <p className="text-xs text-ink/50 mt-1">Status: {conflict.current.status}</p>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                className="rounded-md border border-ink/20 text-ink/70 px-3 py-1.5 text-xs font-medium hover:bg-ink/5"
                onClick={async () => {
                  await refreshAll();
                  setConflict(null);
                }}
              >
                Discard my changes &amp; reload latest
              </button>
              <button
                className="rounded-md bg-ink text-paper px-3 py-1.5 text-xs font-medium hover:bg-ink/90"
                onClick={() =>
                  withBusy(`resolve-conflict-${conflict.testCaseId}`, async () => {
                    const result = await api.reviewTestCase(
                      conflict.testCaseId,
                      "edit",
                      reviewDrafts[conflict.testCaseId],
                      reviewNotes[conflict.testCaseId],
                      conflict.current.version
                    );
                    setReviewDetails((prev: any) => ({ ...prev, [conflict.testCaseId]: result.diff }));
                    await refreshAll();
                    setConflict(null);
                  })
                }
              >
                Apply my edit on top anyway
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-[380px_1fr] gap-4 items-start">
        {/* Left: list */}
        <div className="rounded-lg border border-line bg-white/60 shadow-panel overflow-hidden">
          {/* FR-2.18: search/filter the test case library, results update live without a page reload */}
          <div className="p-2 border-b border-line space-y-2">
            <input
              className="w-full rounded-md border border-line bg-white/60 p-1.5 text-xs"
              placeholder="Search by keyword…"
              value={searchKeyword}
              onChange={(e) => setSearchKeyword(e.target.value)}
            />
            <div className="flex gap-1.5 text-xs">
              <select className="flex-1 rounded-md border border-line bg-white/60 p-1 text-xs" value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)}>
                <option value="">All categories</option>
                <option value="Smoke">Smoke</option>
                <option value="Regression">Regression</option>
                <option value="Functional">Functional</option>
                <option value="Edge Case">Edge Case</option>
                <option value="Negative">Negative</option>
                <option value="API">API</option>
              </select>
              <select className="flex-1 rounded-md border border-line bg-white/60 p-1 text-xs" value={filterPriority} onChange={(e) => setFilterPriority(e.target.value)}>
                <option value="">All priorities</option>
                <option value="High">High</option>
                <option value="Medium">Medium</option>
                <option value="Low">Low</option>
              </select>
            </div>
            {/* FR-4.26: below-threshold Ultrafast cases, non-blocking, still awaiting review */}
            <label className="flex items-center gap-1.5 text-xs text-ink/60">
              <input type="checkbox" checked={needsReviewLaterOnly} onChange={(e) => setNeedsReviewLaterOnly(e.target.checked)} />
              Needs review later only ({testCases.filter((t) => Number((t as any).needs_review_later) === 1).length})
            </label>
          </div>

          <div className="flex items-center justify-between p-3 border-b border-line text-xs text-ink/60">
            <button className="underline" onClick={selectAll}>
              Select all ({filteredTestCases.length})
            </button>
            <span>{selected.size} selected</span>
          </div>

          {/* FR-2.15: bulk actions across a multi-selected set, applied as a single audit-log operation */}
          {selected.size > 0 && (
            <div className="flex flex-wrap gap-1.5 p-2 border-b border-line bg-white/40">
              <button
                className="rounded-md border border-signal text-signal px-2 py-1 text-[11px] font-medium"
                onClick={() => withBusy("bulk-accept", async () => { await api.bulkTestCaseAction(Array.from(selected), "accept"); await refreshAll(); setSelected(new Set()); })}
              >
                Bulk accept
              </button>
              <button
                className="rounded-md border border-alert text-alert px-2 py-1 text-[11px] font-medium"
                onClick={() => withBusy("bulk-reject", async () => { await api.bulkTestCaseAction(Array.from(selected), "reject"); await refreshAll(); setSelected(new Set()); })}
              >
                Bulk reject
              </button>
              <button
                className="rounded-md border border-ink/20 text-ink/70 px-2 py-1 text-[11px] font-medium"
                onClick={() => withBusy("bulk-priority", async () => { await api.bulkTestCaseAction(Array.from(selected), "priority-change", { priority: "High" }); await refreshAll(); setSelected(new Set()); })}
              >
                Set priority: High
              </button>
              <button
                className="rounded-md border border-alert text-alert px-2 py-1 text-[11px] font-medium"
                disabled={busy === "bulk-delete"}
                onClick={() => {
                  if (!window.confirm(`Delete ${selected.size} test case(s)? This also deletes their automation scripts and run history and can't be undone.`)) return;
                  withBusy("bulk-delete", async () => { await api.bulkTestCaseAction(Array.from(selected), "delete"); await refreshAll(); setSelected(new Set()); });
                }}
              >
                {busy === "bulk-delete" ? "Deleting…" : "Delete selected"}
              </button>
              <select
                className="rounded-md border border-line px-1.5 py-1 text-[11px]"
                value={exportFormat}
                onChange={(e) => setExportFormat(e.target.value as typeof exportFormat)}
              >
                <option value="pdf">PDF</option>
                <option value="docx">Word</option>
                <option value="xlsx">Excel</option>
                <option value="csv">CSV</option>
              </select>
              <button
                className="rounded-md border border-ink/20 text-ink/70 px-2 py-1 text-[11px] font-medium disabled:opacity-50"
                disabled={busy === "bulk-export"}
                onClick={() => withBusy("bulk-export", () => api.exportTestCases(Array.from(selected), exportFormat))}
              >
                {busy === "bulk-export" ? "Exporting…" : `Export selected (${selected.size})`}
              </button>
            </div>
          )}

          <div className="max-h-[70vh] overflow-y-auto divide-y divide-line">
            {filteredTestCases.length === 0 && <p className="p-4 text-sm text-ink/50">No test cases match this filter.</p>}
            {filteredTestCases.map((tc) => (
              <button
                key={tc.id}
                className={`w-full text-left p-3 flex items-start gap-2 hover:bg-ink/5 ${activeId === tc.id ? "bg-signal/5" : ""}`}
                onClick={() => setActiveId(tc.id)}
              >
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={selected.has(tc.id)}
                  onChange={(e) => {
                    e.stopPropagation();
                    toggle(tc.id);
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1 flex-wrap">
                    <span className={`text-[10px] rounded-full border px-2 py-0.5 ${CATEGORY_COLOR[tc.category] ?? "bg-ink/5"}`}>{tc.category}</span>
                    <Pill tone={tc.status === "accepted" || tc.status === "edited" ? "good" : tc.status === "rejected" ? "bad" : "neutral"}>{tc.status}</Pill>
                    {/* FR-4.26: flagged when Ultrafast routed this case below-threshold instead of blocking the run */}
                    {Number((tc as any).needs_review_later) === 1 && <Pill tone="warn">needs review later</Pill>}
                  </div>
                  <p className="text-sm font-medium truncate mt-1">{tc.title}</p>
                  <p className="text-xs text-ink/50">conf {Math.round(tc.confidence_score * 100)}% • {tc.authorship_type}</p>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Right: detail */}
        <div className="rounded-lg border border-line bg-white/60 shadow-panel p-5 min-h-[70vh]">
          {!active ? (
            <p className="text-sm text-ink/50">Select a test case to view details.</p>
          ) : (
            <TestCaseDetail
              tc={active}
              mode={mode}
              scriptByTestCase={scriptByTestCase}
              reviewDrafts={reviewDrafts}
              setReviewDrafts={setReviewDrafts}
              reviewNotes={reviewNotes}
              setReviewNotes={setReviewNotes}
              reviewDetails={reviewDetails}
              setReviewDetails={setReviewDetails}
              frameworkChoice={frameworkChoice}
              setFrameworkChoice={setFrameworkChoice}
              externalProvider={externalProvider}
              externalBaseUrl={externalBaseUrl}
              externalToken={externalToken}
              busy={busy}
              withBusy={withBusy}
              reviewWithConflictHandling={reviewWithConflictHandling}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function TestCaseDetail({
  tc,
  mode,
  scriptByTestCase,
  reviewDrafts,
  setReviewDrafts,
  reviewNotes,
  setReviewNotes,
  reviewDetails,
  setReviewDetails,
  frameworkChoice,
  setFrameworkChoice,
  externalProvider,
  externalBaseUrl,
  externalToken,
  busy,
  withBusy,
  reviewWithConflictHandling,
}: any) {
  const [showOverflow, setShowOverflow] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-xs text-ink/40">{tc.id}</span>
            <span className={`text-xs rounded-full border px-2 py-0.5 ${CATEGORY_COLOR[tc.category] ?? "bg-ink/5"}`}>{tc.category}</span>
            <Pill tone={tc.status === "accepted" || tc.status === "edited" ? "good" : tc.status === "rejected" ? "bad" : "neutral"}>{tc.status}</Pill>
            <Pill>conf {Math.round(tc.confidence_score * 100)}%</Pill>
            <Pill tone={tc.authorship_type === "human" ? "good" : tc.authorship_type === "edited" ? "warn" : "neutral"}>
              {tc.authorship_type === "human" ? "human-authored" : tc.authorship_type === "edited" ? "human-edited" : "AI-generated"}
            </Pill>
            {tc.critical_path ? <Pill tone="warn">critical path</Pill> : null}
            {tc.flagged_for_re_review ? <Pill tone="warn">flagged for re-review</Pill> : null}
          </div>
          <h3 className="font-display text-lg mt-2">{tc.title}</h3>
          <p className="mt-1 text-xs text-ink/50">Priority: {tc.priority ?? "Medium"} • Version {tc.version}</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          className="rounded-md border border-signal text-signal px-3 py-1.5 text-xs font-medium hover:bg-signal-soft disabled:opacity-40"
          disabled={tc.status === "accepted"}
          onClick={() =>
            withBusy(`accept-${tc.id}`, async () => {
              const result = await reviewWithConflictHandling(tc.id, "accept", reviewDrafts[tc.id], reviewNotes[tc.id], tc.version);
              if (result) setReviewDetails((prev: any) => ({ ...prev, [tc.id]: result.diff }));
            })
          }
        >
          Accept
        </button>
        <button
          className="rounded-md border border-alert text-alert px-3 py-1.5 text-xs font-medium hover:bg-alert-soft disabled:opacity-40"
          disabled={tc.status === "rejected"}
          onClick={() =>
            withBusy(`reject-${tc.id}`, async () => {
              const result = await reviewWithConflictHandling(tc.id, "reject", reviewDrafts[tc.id], reviewNotes[tc.id], tc.version);
              if (result) setReviewDetails((prev: any) => ({ ...prev, [tc.id]: result.diff }));
            })
          }
        >
          Reject
        </button>
        <button
          className="rounded-md border border-ink/20 text-ink/70 px-3 py-1.5 text-xs font-medium hover:bg-ink/5"
          onClick={() =>
            withBusy(`discuss-${tc.id}`, async () => {
              const result = await reviewWithConflictHandling(tc.id, "needs_discussion", reviewDrafts[tc.id], reviewNotes[tc.id], tc.version);
              if (result) setReviewDetails((prev: any) => ({ ...prev, [tc.id]: result.diff }));
            })
          }
        >
          Needs discussion
        </button>
        <button
          className="rounded-md border border-ink/20 text-ink/70 px-3 py-1.5 text-xs font-medium hover:bg-ink/5"
          onClick={() =>
            withBusy(`regen-${tc.id}`, async () => {
              const result = await api.regenerateTestCase(tc.id);
              setReviewDetails((prev: any) => ({ ...prev, [tc.id]: result.diff }));
            })
          }
        >
          Regenerate
        </button>
        <div className="relative">
          <button className="rounded-md border border-ink/20 text-ink/70 px-3 py-1.5 text-xs font-medium hover:bg-ink/5" onClick={() => setShowOverflow((v) => !v)}>
            More ⋯
          </button>
          {showOverflow && (
            <div className="absolute right-0 mt-1 w-72 rounded-md border border-line bg-white shadow-lg z-20 p-2 space-y-1 text-xs">
              <OverflowButton
                onClick={async () => {
                  const text = await api.exportTestCaseCsv(tc.id);
                  const blob = new Blob([text], { type: "text/csv" });
                  const url = URL.createObjectURL(blob);
                  const link = document.createElement("a");
                  link.href = url;
                  link.download = `${tc.id}.csv`;
                  link.click();
                  URL.revokeObjectURL(url);
                }}
              >
                Export CSV
              </OverflowButton>
              <OverflowButton onClick={() => withBusy(`excel-${tc.id}`, () => api.exportTestCaseXlsx(tc.id))}>Export XLSX</OverflowButton>
              <OverflowButton onClick={() => withBusy(`export-pdf-${tc.id}`, () => api.exportTestCases([tc.id], "pdf"))}>Export PDF</OverflowButton>
              <OverflowButton onClick={() => withBusy(`export-docx-${tc.id}`, () => api.exportTestCases([tc.id], "docx"))}>Export Word</OverflowButton>
              <OverflowButton
                onClick={() =>
                  withBusy(`explain-${tc.id}`, async () => {
                    // FR-2.9: read-only -- does not accept/edit/reject or bump the version
                    const result = await api.explainTestCase(tc.id);
                    setReviewDetails((prev: any) => ({ ...prev, [tc.id]: { explanation: result.explanation } }));
                  })
                }
              >
                Explain this test case
              </OverflowButton>
              <OverflowButton
                onClick={() =>
                  withBusy(`sync-${tc.id}`, () => api.syncTestCase(tc.id, externalProvider, externalBaseUrl.trim(), externalToken.trim()))
                }
              >
                Sync to {externalProvider === "jira" ? "Jira" : "Azure DevOps"}
              </OverflowButton>
              <OverflowButton
                onClick={() =>
                  withBusy(`push-additional-${tc.id}`, async () => {
                    // FR-7.5: push to a connected TestRail/Zephyr/qTest integration
                    const all = await api.listIntegrations();
                    const trackers = all.filter((i: any) => ["testrail", "zephyr", "qtest"].includes(i.type));
                    if (trackers.length === 0) {
                      window.alert("No TestRail/Zephyr/qTest integration connected yet. Add one in Settings first.");
                      return;
                    }
                    let target = trackers[0];
                    if (trackers.length > 1) {
                      const choice = window.prompt(
                        `Multiple trackers connected. Enter one:\n${trackers.map((t: any) => `${t.id} (${t.type})`).join("\n")}`,
                        trackers[0].id
                      );
                      if (!choice) return;
                      target = trackers.find((t: any) => t.id === choice) ?? target;
                    }
                    const result = await api.pushTestCaseAdditional(target.id, tc.id);
                    window.alert(`Pushed to ${target.type}: ${JSON.stringify(result)}`);
                  })
                }
              >
                Push to TestRail/Zephyr/qTest
              </OverflowButton>
              <OverflowButton onClick={() => withBusy(`critical-${tc.id}`, () => api.setCriticalPath(tc.id, !tc.critical_path))}>
                {tc.critical_path ? "Unmark critical path" : "Mark critical path"}
              </OverflowButton>
              {mode === "enterprise" && (
                <OverflowButton onClick={() => withBusy(`route-${tc.id}`, () => api.routeTestCaseToOwner(tc.id))}>Route to owner</OverflowButton>
              )}
              <div className="border-t border-line my-1" />
              <OverflowButton
                className="text-alert"
                onClick={() => {
                  if (!window.confirm(`Delete "${tc.title}"? This also deletes its automation scripts and run history and can't be undone.`)) return;
                  setShowOverflow(false);
                  withBusy(`delete-${tc.id}`, () => api.deleteTestCase(tc.id));
                }}
              >
                Delete test case
              </OverflowButton>
            </div>
          )}
        </div>
      </div>

      {mode === "enterprise" && tc.second_reviewer_required ? (
        <div className="flex items-center gap-2">
          <Pill tone={tc.second_reviewer_status === "approved" ? "good" : tc.second_reviewer_status === "rejected" ? "bad" : "warn"}>
            2nd reviewer: {tc.second_reviewer_status ?? "pending"}
          </Pill>
          <button
            className="rounded-md border border-signal text-signal px-2 py-1.5 text-xs font-medium hover:bg-signal-soft"
            onClick={() => withBusy(`signoff-approve-${tc.id}`, () => api.secondReviewerSignOff(tc.id, "approved"))}
          >
            Sign off (approve)
          </button>
          <button
            className="rounded-md border border-alert text-alert px-2 py-1.5 text-xs font-medium hover:bg-alert-soft"
            onClick={() => withBusy(`signoff-reject-${tc.id}`, () => api.secondReviewerSignOff(tc.id, "rejected"))}
          >
            Sign off (reject)
          </button>
        </div>
      ) : null}

      <div className="space-y-2 rounded-md border border-line bg-white/60 p-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">Edit</p>
        <div className="flex flex-wrap gap-2">
          <input
            className="rounded-md border border-line bg-white/60 p-2 text-sm flex-1 min-w-[160px]"
            placeholder="Edit title"
            value={reviewDrafts[tc.id]?.title ?? tc.title}
            onChange={(e) => setReviewDrafts((prev: any) => ({ ...prev, [tc.id]: { ...prev[tc.id], title: e.target.value } }))}
          />
          <select
            className="rounded-md border border-line bg-white/60 p-2 text-sm"
            value={reviewDrafts[tc.id]?.category ?? tc.category}
            onChange={(e) => setReviewDrafts((prev: any) => ({ ...prev, [tc.id]: { ...prev[tc.id], category: e.target.value } }))}
          >
            <option value="Smoke">Smoke</option>
            <option value="Regression">Regression</option>
            <option value="Functional">Functional/UserStory</option>
            <option value="Edge Case">EdgeCase</option>
            <option value="Negative">Negative</option>
            <option value="API">API-specific</option>
          </select>
          <select
            className="rounded-md border border-line bg-white/60 p-2 text-sm"
            value={reviewDrafts[tc.id]?.priority ?? tc.priority ?? "Medium"}
            onChange={(e) => setReviewDrafts((prev: any) => ({ ...prev, [tc.id]: { ...prev[tc.id], priority: e.target.value } }))}
          >
            <option value="Low">Low</option>
            <option value="Medium">Medium</option>
            <option value="High">High</option>
          </select>
        </div>
        <textarea
          className="w-full rounded-md border border-line bg-white/60 p-2 text-sm"
          rows={2}
          placeholder="Reviewer notes"
          value={reviewNotes[tc.id] ?? ""}
          onChange={(e) => setReviewNotes((prev: any) => ({ ...prev, [tc.id]: e.target.value }))}
        />
        <textarea
          className="w-full rounded-md border border-line bg-white/60 p-2 text-sm"
          rows={3}
          placeholder="Edit steps (one per line)"
          value={(reviewDrafts[tc.id]?.steps ?? tc.steps).join("\n")}
          onChange={(e) =>
            setReviewDrafts((prev: any) => ({
              ...prev,
              [tc.id]: { ...prev[tc.id], steps: e.target.value.split(/\n+/).map((s: string) => s.trim()).filter(Boolean) },
            }))
          }
        />
        <textarea
          className="w-full rounded-md border border-line bg-white/60 p-2 text-sm"
          rows={2}
          placeholder="Edit expected result"
          value={reviewDrafts[tc.id]?.expected_result ?? tc.expected_result}
          onChange={(e) => setReviewDrafts((prev: any) => ({ ...prev, [tc.id]: { ...prev[tc.id], expected_result: e.target.value } }))}
        />
      </div>

      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-ink/60 mb-1">Steps</p>
        <ol className="text-sm text-ink/70 list-decimal list-inside space-y-0.5">
          {tc.steps.map((s: string, idx: number) => (
            <li key={idx} className="step-count">
              {s}
            </li>
          ))}
        </ol>
        <p className="text-sm mt-2">
          <span className="text-ink/50">Expected: </span>
          {tc.expected_result}
        </p>
        {tc.explanation && <p className="mt-2 text-sm text-ink/70">{tc.explanation}</p>}
        {tc.source_rationale && <p className="text-xs text-ink/40 mt-2 italic">{tc.source_rationale}</p>}
      </div>

      <DataRowsPanel testCaseId={tc.id} withBusy={withBusy} />

      {(tc.status === "accepted" || tc.status === "edited") && !scriptByTestCase[tc.id] && (
        <div className="flex items-center gap-2 rounded-md border border-line bg-white/60 p-3">
          <select
            className="rounded-md border border-line bg-white/60 p-1.5 text-xs"
            value={frameworkChoice[tc.id] ?? "playwright"}
            onChange={(e) => setFrameworkChoice((prev: any) => ({ ...prev, [tc.id]: e.target.value }))}
          >
            <option value="playwright">Playwright (TS/JS/Python)</option>
            <option value="selenium">Selenium</option>
            <option value="cypress">Cypress</option>
          </select>
          <button
            className="ml-auto rounded-md bg-ink text-paper px-3 py-1.5 text-xs font-medium hover:bg-ink/90 disabled:opacity-50"
            disabled={busy === `codegen-${tc.id}`}
            onClick={() => withBusy(`codegen-${tc.id}`, () => api.generateScript(tc.id, frameworkChoice[tc.id]))}
          >
            {busy === `codegen-${tc.id}` ? "Generating script…" : "Generate script →"}
          </button>
        </div>
      )}

      {reviewDetails[tc.id] && (
        <div className="rounded-md border border-line bg-white/60 p-3 text-xs text-ink/70">
          <p className="font-medium">Review diff</p>
          <pre className="mt-1 whitespace-pre-wrap">{JSON.stringify(reviewDetails[tc.id], null, 2)}</pre>
        </div>
      )}
    </div>
  );
}

function OverflowButton({ children, onClick, className = "" }: { children: React.ReactNode; onClick: () => void; className?: string }) {
  return (
    <button className={`w-full text-left rounded px-2 py-1.5 hover:bg-ink/5 ${className}`} onClick={onClick}>
      {children}
    </button>
  );
}

// FR-2.17: data-driven/parameterized test cases -- add rows of input values and
// automatically run the test case's latest script once per row, showing each
// row's recorded pass/fail. Previously this was API-only (no UI at all).
function DataRowsPanel({ testCaseId, withBusy }: { testCaseId: string; withBusy: (key: string, fn: () => Promise<any>) => Promise<any> }) {
  const [rows, setRows] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  const [rawInput, setRawInput] = useState('{"field": "value"}');
  const [targetUrl, setTargetUrl] = useState("http://localhost:4100/demo/login.html");
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      setRows(await api.listDataRows(testCaseId));
    } catch {
      // no rows yet / not fetched
    }
  }

  return (
    <div className="rounded-md border border-line bg-white/60 p-3 text-sm">
      <button className="text-xs font-semibold uppercase tracking-wide text-ink/60" onClick={() => { setOpen(!open); if (!open) refresh(); }}>
        Data-driven rows {rows.length > 0 ? `(${rows.length})` : ""} {open ? "▲" : "▼"}
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {rows.length > 0 && (
            <table className="w-full text-xs">
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-line/50">
                    <td className="py-1 pr-2 text-ink/60">#{r.row_index}</td>
                    <td className="py-1 pr-2 font-mono">{JSON.stringify(r.input_values)}</td>
                    <td className="py-1">
                      <Pill tone={r.last_run_status === "passed" ? "good" : r.last_run_status === "failed" ? "bad" : "warn"}>
                        {r.last_run_status ?? "not run"}
                      </Pill>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="flex flex-wrap gap-2 items-center">
            <input
              className="rounded-md border border-line bg-white/60 p-1.5 text-xs flex-1 min-w-[160px] font-mono"
              value={rawInput}
              onChange={(e) => setRawInput(e.target.value)}
              placeholder='{"field": "value"}'
            />
            <button
              className="rounded-md border border-line px-2 py-1.5 text-xs font-medium hover:bg-ink/5"
              onClick={() =>
                withBusy(`add-row-${testCaseId}`, async () => {
                  try {
                    const parsed = JSON.parse(rawInput);
                    await api.addDataRow(testCaseId, parsed);
                    setError(null);
                    await refresh();
                  } catch {
                    setError("Input must be valid JSON, e.g. {\"username\": \"foo\"}");
                  }
                })
              }
            >
              Add row
            </button>
          </div>
          <div className="flex flex-wrap gap-2 items-center">
            <input
              className="rounded-md border border-line bg-white/60 p-1.5 text-xs flex-1 min-w-[160px]"
              value={targetUrl}
              onChange={(e) => setTargetUrl(e.target.value)}
              placeholder="Target URL to run against"
            />
            <button
              className="rounded-md bg-ink text-paper px-3 py-1.5 text-xs font-medium hover:bg-ink/90 disabled:opacity-50"
              disabled={rows.length === 0}
              onClick={() =>
                withBusy(`run-rows-${testCaseId}`, async () => {
                  await api.runAllDataRows(testCaseId, targetUrl);
                  await refresh();
                })
              }
            >
              Run all rows
            </button>
          </div>
          {error && <p className="text-xs text-alert">{error}</p>}
        </div>
      )}
    </div>
  );
}
