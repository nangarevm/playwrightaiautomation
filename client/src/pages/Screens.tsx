import { useEffect, useState } from "react";
import { api } from "../api.js";
import { Pill, CATEGORY_COLOR } from "../components/Pill.js";
import { useApp } from "../context/AppState.js";

interface ScreenRow {
  id: string;
  name: string;
  module_name: string | null;
  url_or_path: string | null;
  change_status: "new" | "changed" | "unchanged";
  test_case_count: number;
  automation_script_count: number;
  last_compared_at: string | null;
  visual_baseline_ref: string | null;
}

interface CoverageGap {
  id: string;
  name: string;
  reason: "no-test-cases" | "stale-only";
}

// FR-1.10/FR-2.14/FR-4.18/FR-5.7/FR-5.8/FR-5.9/FR-5.10/FR-6.8: Screen Explorer --
// previously this entire view didn't exist even though the backend (screensService.ts)
// was fully built and verified live via curl. This is the missing UI.
export default function Screens() {
  const { testCases } = useApp();
  const [screens, setScreens] = useState<ScreenRow[]>([]);
  // Which screens have their test-case list expanded -- collapsed by default so
  // the grid stays scannable; the count on the card is always visible, the actual
  // list of test cases only renders once a screen is expanded.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [gaps, setGaps] = useState<CoverageGap[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [changedOnly, setChangedOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<any>(null);
  const [diffView, setDiffView] = useState<{ screenId: string; summary: any } | null>(null);
  // FR-2.16: duplicate/near-duplicate detection -- previously API-only, no UI
  const [dupResult, setDupResult] = useState<{ screenId: string; flags: any[] } | null>(null);
  // FR-2.16 resolve-flow: pending flags (with real flag ids) for the screen currently under review
  const [pendingFlags, setPendingFlags] = useState<any[]>([]);
  // Bug Detection Engine: on-demand exploratory UI scan result for the screen last scanned
  const [scanResult, setScanResult] = useState<{ screenId: string; count: number } | null>(null);
  const [scanning, setScanning] = useState<string | null>(null);

  async function refreshPendingFlags(testCaseIds: Set<string>) {
    try {
      const all = await api.listDuplicateFlags();
      setPendingFlags(all.filter((f: any) => testCaseIds.has(f.test_case_id)));
    } catch {
      setPendingFlags([]);
    }
  }

  async function refresh() {
    setLoading(true);
    try {
      const [s, g] = await Promise.all([api.listScreens(), api.getCoverageGaps()]);
      setScreens(s);
      setGaps(g);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const gapById = Object.fromEntries(gaps.map((g) => [g.id, g]));

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-xl tracking-tight">Screen Explorer</h2>
        <p className="text-sm text-ink/60">
          Every screen/module discovered from any input (FR-1.10), with Changed/Unchanged status (FR-5.7/5.8) and coverage gaps (FR-6.8)
        </p>
      </div>

      {error && <div className="rounded-md border border-alert bg-alert/5 p-3 text-sm text-alert">{error}</div>}

      <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-white/60 shadow-panel p-3">
        <div className="flex items-center gap-3 text-sm">
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={changedOnly} onChange={(e) => setChangedOnly(e.target.checked)} />
            Changed only
          </label>
          <span className="text-ink/50">{selected.size} screen(s) selected</span>
        </div>
        <button
          className="rounded-md bg-ink text-paper px-3 py-1.5 text-xs font-medium disabled:opacity-40"
          disabled={selected.size === 0}
          onClick={async () => {
            try {
              const result = await api.runScreensScoped(Array.from(selected), changedOnly);
              setRunResult(result);
            } catch (e: any) {
              setError(e.message);
            }
          }}
        >
          Run selected screens (FR-4.18)
        </button>
      </div>

      {runResult && (
        <div className="rounded-md border border-signal bg-signal/5 p-3 text-sm">
          Queued {runResult.script_count} script(s) across {runResult.test_case_count} test case(s) from {runResult.screen_count} screen(s).
        </div>
      )}

      {scanResult && (
        <div className="rounded-md border border-signal bg-signal/5 p-3 text-sm">
          Bug scan complete: {scanResult.count} finding(s). See Reports → Bugs for details.
        </div>
      )}

      {loading ? (
        <p className="text-sm text-ink/50">Loading screens…</p>
      ) : screens.length === 0 ? (
        <p className="text-sm text-ink/50">No screens catalogued yet — crawl a URL or upload screenshots/videos to populate this view.</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {screens.map((s) => {
            const gap = gapById[s.id];
            return (
              <div key={s.id} className="rounded-lg border border-line bg-white/60 shadow-panel p-4 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={selected.has(s.id)} onChange={() => toggle(s.id)} />
                    <span className="font-medium text-sm truncate max-w-[180px]" title={s.name}>{s.name}</span>
                  </label>
                  <Pill tone={s.change_status === "changed" ? "warn" : s.change_status === "new" ? "good" : "neutral"}>
                    {s.change_status}
                  </Pill>
                </div>
                <div className="flex items-center gap-3 text-xs text-ink/60">
                  <span>{s.test_case_count} test case(s)</span>
                  <span>{s.automation_script_count} script(s)</span>
                </div>
                {gap && (
                  <Pill tone="bad">
                    coverage gap: {gap.reason === "no-test-cases" ? "no test cases" : "stale-only"}
                  </Pill>
                )}
                <div className="flex gap-2 pt-1">
                  {s.change_status === "changed" && (
                    <button
                      className="text-xs underline text-signal"
                      onClick={async () => {
                        const summary = await api.getScreenChangeSummary(s.id);
                        setDiffView({ screenId: s.id, summary });
                      }}
                    >
                      View before/after (FR-5.10)
                    </button>
                  )}
                  <button
                    className="text-xs underline text-signal"
                    onClick={async () => {
                      try {
                        const flags = await api.detectDuplicates(s.id);
                        setDupResult({ screenId: s.id, flags });
                        const ids = new Set<string>(flags.map((f: any) => f.testCaseId));
                        await refreshPendingFlags(ids);
                      } catch (e: any) {
                        setError(e.message);
                      }
                    }}
                  >
                    Detect duplicates (FR-2.16)
                  </button>
                  <button
                    className="text-xs underline text-signal disabled:opacity-40"
                    disabled={!s.url_or_path || scanning === s.id}
                    title={s.url_or_path ? undefined : "Scan needs a known URL for this screen"}
                    onClick={async () => {
                      setScanning(s.id);
                      try {
                        const result = await api.scanScreenForBugs(s.id);
                        setScanResult({ screenId: s.id, count: result.count });
                      } catch (e: any) {
                        setError(e.message);
                      } finally {
                        setScanning(null);
                      }
                    }}
                  >
                    {scanning === s.id ? "Scanning…" : "Scan for bugs"}
                  </button>
                  {s.test_case_count > 0 && (
                    <button className="text-xs underline text-ink/60 ml-auto" onClick={() => toggleExpanded(s.id)}>
                      {expanded.has(s.id) ? "Hide test cases" : `Show test cases (${s.test_case_count})`}
                    </button>
                  )}
                </div>
                {expanded.has(s.id) && (
                  <div className="pt-1 space-y-1.5 border-t border-line/70">
                    {testCases
                      .filter((tc) => tc.screen_id === s.id)
                      .map((tc) => (
                        <div key={tc.id} className="rounded border border-line/70 bg-white/50 p-2 text-xs space-y-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium truncate">{tc.title}</span>
                            <div className="flex items-center gap-1 shrink-0">
                              <span className={`text-[10px] rounded-full border px-1.5 py-0.5 ${CATEGORY_COLOR[tc.category] ?? "bg-ink/5"}`}>{tc.category}</span>
                              <Pill tone={tc.status === "accepted" ? "good" : tc.status === "rejected" ? "bad" : "neutral"}>{tc.status}</Pill>
                            </div>
                          </div>
                        </div>
                      ))}
                    {testCases.filter((tc) => tc.screen_id === s.id).length === 0 && (
                      <p className="text-xs text-ink/40">No test cases loaded for this screen yet.</p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* FR-5.10: side-by-side before/after review for a Changed screen */}
      {diffView && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-6" onClick={() => setDiffView(null)}>
          <div className="w-full max-w-xl rounded-lg border border-line bg-white p-5 shadow-xl space-y-3" onClick={(e) => e.stopPropagation()}>
            <p className="font-display text-lg">Screen change review</p>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-md border border-line p-3">
                <p className="text-xs font-semibold uppercase text-ink/60 mb-1">Status</p>
                <p>{diffView.summary.is_changed ? "Changed" : "Unchanged"}</p>
              </div>
              <div className="rounded-md border border-line p-3">
                <p className="text-xs font-semibold uppercase text-ink/60 mb-1">Visual baseline</p>
                <p>{diffView.summary.visual_baseline_set ? "Set (FR-5.9)" : "Not set"}</p>
              </div>
            </div>
            <p className="text-xs text-ink/50">Last compared: {diffView.summary.last_compared_at}</p>
            <button className="rounded-md border border-ink/20 text-ink/70 px-3 py-1.5 text-xs" onClick={() => setDiffView(null)}>
              Close
            </button>
          </div>
        </div>
      )}
      {/* FR-2.16: duplicate/near-duplicate detection results for a screen */}
      {dupResult && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-6" onClick={() => setDupResult(null)}>
          <div className="w-full max-w-xl rounded-lg border border-line bg-white p-5 shadow-xl space-y-3" onClick={(e) => e.stopPropagation()}>
            <p className="font-display text-lg">Duplicate detection</p>
            {dupResult.flags.length === 0 ? (
              <p className="text-sm text-ink/60">No near-duplicate test cases found on this screen (Jaccard similarity ≥ 0.6 threshold).</p>
            ) : (
              <ul className="text-sm space-y-2">
                {dupResult.flags.map((f: any, i: number) => {
                  const flag = pendingFlags.find(
                    (pf: any) => pf.test_case_id === f.testCaseId && pf.duplicate_of_test_case_id === f.duplicateOfTestCaseId
                  );
                  return (
                    <li key={i} className="rounded-md border border-line p-2 space-y-1">
                      <div>
                        Test case <span className="font-mono">{f.testCaseId}</span> looks like a duplicate of{" "}
                        <span className="font-mono">{f.duplicateOfTestCaseId}</span> ({Math.round(f.similarity * 100)}% similar)
                      </div>
                      {flag ? (
                        <div className="flex gap-2 pt-1">
                          {(["merged", "discarded", "kept-both"] as const).map((res) => (
                            <button
                              key={res}
                              className="rounded border border-ink/20 px-2 py-0.5 text-xs text-ink/70 hover:bg-ink/5"
                              onClick={async () => {
                                try {
                                  await api.resolveDuplicateFlag(flag.id, res);
                                  const ids = new Set<string>(dupResult.flags.map((x: any) => x.testCaseId));
                                  await refreshPendingFlags(ids);
                                } catch (e: any) {
                                  setError(e.message);
                                }
                              }}
                            >
                              {res}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <p className="text-xs text-ink/40">resolved</p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="text-xs text-ink/50">Resolve each flagged pair as merged, discarded, or kept-both.</p>
            <button className="rounded-md border border-ink/20 text-ink/70 px-3 py-1.5 text-xs" onClick={() => setDupResult(null)}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
