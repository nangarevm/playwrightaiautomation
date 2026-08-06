import { useEffect, useRef, useState } from "react";
import { api, CrawlSite, CrawlSiteDetail } from "../api.js";
import { Pill } from "../components/Pill.js";
import { AllureReportPanel } from "../components/AllureReportPanel.js";
import { BugReportPanel } from "../components/BugReportPanel.js";

// AI Crawler end-to-end flow (project brief Phase 8): onboarding -> live crawl
// progress -> curate-before-generate review -> one-click test generation + run ->
// auto diff-mode on repeat URLs. The Allure report also builds/renders/downloads/
// emails right here via AllureReportPanel (same panel Execution.tsx uses), since
// this is the Ultrafast Mode "crawl a website" tab and shouldn't require a tab
// switch to see the finished report.
interface BatchItem {
  url: string;
  status: "queued" | "running" | "completed" | "failed";
  siteId?: string;
  pagesDiscovered?: number;
  scenariosDiscovered?: number;
  error?: string;
}

export default function Crawler() {
  // Single URL vs multiple URLs: same underlying crawl (startCrawl/runCrawl) for
  // either -- "multiple" just loops the single-URL call sequentially, one at a
  // time. Sequential (not parallel) is deliberate: this is a single-user local
  // setup, and several headless-browser crawls running at once would compete
  // unpredictably for the same machine's CPU/memory. A queue you can walk away
  // from and come back to is the better fit than a parallel race.
  const [urlMode, setUrlMode] = useState<"single" | "multi">("single");
  const [url, setUrl] = useState("http://localhost:4100/demo/login.html");
  const [multiUrls, setMultiUrls] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [maxPages, setMaxPages] = useState(10);
  const [captureApi, setCaptureApi] = useState(false);
  const [knownSite, setKnownSite] = useState<{ known: boolean; site: CrawlSite | null } | null>(null);

  const [site, setSite] = useState<CrawlSite | null>(null);
  const [detail, setDetail] = useState<CrawlSiteDetail | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // UI scenarios come from discovered form/element interactions; API scenarios
  // come from the same-origin XHR/fetch calls captured during the crawl
  // (--capture-api). Same underlying scenario list, same curate/generate/run/
  // download actions below -- this only filters which ones are visible and
  // selectable, so every existing action works identically for either kind.
  const [scenarioFilter, setScenarioFilter] = useState<"ui" | "api" | "both">("both");
  // Independent of scenarioFilter (UI/API/Both) -- which test suite tier to
  // show. "all" (default) applies no tier restriction; the three specific
  // options let a reviewer pull just the smoke suite, just functional
  // coverage, or just the regression set carried forward from unchanged pages.
  const [tierFilter, setTierFilter] = useState<"all" | "smoke" | "functional" | "regression">("all");
  // Per-page collapse state for the "Review & curate" cards below -- a crawl
  // of any real size produces one card per page, and having every one of them
  // permanently expanded makes the list unreadable. Pages start expanded
  // (matching prior behavior); collapsing is opt-in per page.
  const [collapsedPageIds, setCollapsedPageIds] = useState<Set<string>>(new Set());
  function togglePageCollapsed(pageId: string) {
    setCollapsedPageIds((prev) => {
      const next = new Set(prev);
      if (next.has(pageId)) next.delete(pageId);
      else next.add(pageId);
      return next;
    });
  }
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [genResults, setGenResults] = useState<any[] | null>(null);
  const pollRef = useRef<number | null>(null);

  // Per-test-case automation run outcome from "Generate + Run" -- previously
  // triggerUltrafast's result was awaited then discarded (`.catch(() => undefined)`
  // silently swallowed failures too), so after generation there was no signal at
  // all of which scripts actually passed/failed/errored, only the Execution tab's
  // full run history to cross-reference manually. Keyed by testCaseId.
  type RunStatus = { state: "running" | "passed" | "failed" | "error" | "needs_review" | "trigger_failed"; durationMs?: number; reportUrl?: string | null; error?: string; runId?: string };
  const [runStatuses, setRunStatuses] = useState<Record<string, RunStatus>>({});

  // Marks when the current "Generate + Run" batch started, so the Allure panel
  // below can scope its report to only this crawl's runs (allure-results/
  // accumulates every run ever executed on this machine and never clears
  // itself, so an unscoped report was always showing stale aggregate data).
  const [batchStartedAt, setBatchStartedAt] = useState<number | null>(null);

  // Customer-facing bug list, built from this batch's failed/errored runs --
  // the exact Playwright error for each (plus a script-issue-vs-real-bug
  // classification), not just a pass/fail pill.
  type CrawlFailure = {
    testCaseId: string;
    title: string;
    errorMessage: string | null;
    reportUrl?: string | null;
    runId: string;
    failureClass: "automation_issue" | "environment_issue" | "possible_bug" | "unknown" | null;
    failureLabel: string | null;
  };
  const [crawlFailures, setCrawlFailures] = useState<CrawlFailure[]>([]);

  // Bumped once the "Generate + Run" batch's runs all finish, to trigger the
  // Allure panel's own generate step automatically -- so the user never has to
  // click "Generate Allure report" separately after running tests here.
  const [allureAutoGenKey, setAllureAutoGenKey] = useState<number | undefined>(undefined);

  // Live "what's happening right now" status line for the multi-step Generate +
  // Run + Report flow, which otherwise looks stalled for the many seconds each
  // step (script generation, each test run, Allure build) actually takes.
  const [progressMessage, setProgressMessage] = useState<string | null>(null);

  const [batchQueue, setBatchQueue] = useState<BatchItem[]>([]);
  const [batchRunning, setBatchRunning] = useState(false);

  // Download generated test cases straight from this tab -- reuses the same
  // multi-format bulk export the Library page uses, scoped to whichever test
  // cases this crawl's "Generate tests" step just produced.
  const [downloadSelected, setDownloadSelected] = useState<Set<string>>(new Set());
  const [exportFormat, setExportFormat] = useState<"csv" | "xlsx" | "pdf" | "docx">("xlsx");
  const [downloadBusy, setDownloadBusy] = useState(false);

  // Phase 8 step 6: auto-detect a known site so the onboarding form can say
  // up front that a re-run will diff against the last crawl, no manual toggle.
  useEffect(() => {
    const handle = setTimeout(() => {
      if (!url.trim()) return setKnownSite(null);
      api.crawlerKnownSite(url.trim()).then(setKnownSite).catch(() => setKnownSite(null));
    }, 400);
    return () => clearTimeout(handle);
  }, [url]);

  function stopPolling() {
    if (pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  async function startCrawl() {
    setError(null);
    setGenResults(null);
    setDetail(null);
    setSelected(new Set());
    try {
      const res = await api.crawlerRun({
        url: url.trim(),
        username: username || undefined,
        password: password || undefined,
        maxPages: Number(maxPages) || 10,
        captureApi,
      });
      const initial = await api.crawlerGetSite(res.siteId);
      setSite(initial);
      stopPolling();
      pollRef.current = window.setInterval(async () => {
        try {
          const updated = await api.crawlerGetSite(res.siteId);
          setSite(updated);
          if (updated.status === "completed" || updated.status === "failed") {
            stopPolling();
            if (updated.status === "completed") {
              const d = await api.crawlerGetSiteDetail(res.siteId);
              setDetail(d);
            }
          }
        } catch (e: any) {
          stopPolling();
          setError(e.message);
        }
      }, 1500);
    } catch (e: any) {
      setError(e.message);
    }
  }

  useEffect(() => () => stopPolling(), []);

  // Awaitable version of the same poll-until-done loop startCrawl runs live for a
  // single URL -- runBatch (below) awaits one of these per queued URL so it can
  // move to the next only once the current one actually finishes.
  function pollUntilDone(siteId: string, onTick?: (s: CrawlSite) => void): Promise<CrawlSite> {
    return new Promise((resolve, reject) => {
      const tick = async () => {
        try {
          const updated = await api.crawlerGetSite(siteId);
          onTick?.(updated);
          if (updated.status === "completed" || updated.status === "failed") {
            resolve(updated);
          } else {
            window.setTimeout(tick, 1500);
          }
        } catch (e) {
          reject(e);
        }
      };
      tick();
    });
  }

  // Multiple-URLs mode: same startCrawl() call, looped sequentially. Each entry's
  // live status updates in the queue list below as it runs; the finished site
  // isn't auto-opened for curation -- click "View" on any completed row to load
  // it into the same review/generate/run flow single-URL mode uses.
  async function runBatch() {
    const urls = Array.from(new Set(multiUrls.split(/[\n,]/).map((u) => u.trim()).filter(Boolean)));
    if (urls.length === 0) {
      setError("Enter at least one URL, one per line.");
      return;
    }
    setError(null);
    setBatchRunning(true);
    setBatchQueue(urls.map((u) => ({ url: u, status: "queued" })));

    for (let i = 0; i < urls.length; i++) {
      setBatchQueue((prev) => prev.map((item, idx) => (idx === i ? { ...item, status: "running" } : item)));
      try {
        const res = await api.crawlerRun({
          url: urls[i],
          username: username || undefined,
          password: password || undefined,
          maxPages: Number(maxPages) || 10,
          captureApi,
        });
        const finalSite = await pollUntilDone(res.siteId, (s) =>
          setBatchQueue((prev) =>
            prev.map((item, idx) => (idx === i ? { ...item, siteId: s.id, pagesDiscovered: s.pages_discovered, scenariosDiscovered: s.scenarios_discovered } : item))
          )
        );
        setBatchQueue((prev) =>
          prev.map((item, idx) =>
            idx === i
              ? {
                  ...item,
                  status: finalSite.status === "completed" ? "completed" : "failed",
                  siteId: finalSite.id,
                  pagesDiscovered: finalSite.pages_discovered,
                  scenariosDiscovered: finalSite.scenarios_discovered,
                  error: finalSite.error ?? undefined,
                }
              : item
          )
        );
      } catch (e: any) {
        setBatchQueue((prev) => prev.map((item, idx) => (idx === i ? { ...item, status: "failed", error: e.message } : item)));
      }
    }
    setBatchRunning(false);
  }

  // Loads a completed batch entry into the same curate/generate/run section
  // single-URL mode uses -- also syncs `url` so generateRunAndReport's Ultrafast
  // trigger targets the right site instead of whatever was last typed into it.
  async function viewBatchSite(item: BatchItem) {
    if (!item.siteId) return;
    setError(null);
    setGenResults(null);
    setSelected(new Set());
    setUrl(item.url);
    const s = await api.crawlerGetSite(item.siteId);
    setSite(s);
    const d = await api.crawlerGetSiteDetail(item.siteId);
    setDetail(d);
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function scenarioVisible(s: { type: string; tier?: string | null }): boolean {
    const typeOk = scenarioFilter === "both" ? true : scenarioFilter === "api" ? s.type === "api" : s.type !== "api";
    const tierOk = tierFilter === "all" ? true : s.tier === tierFilter;
    return typeOk && tierOk;
  }

  // Faster curation: one click to select every not-yet-generated scenario
  // instead of checking each box individually -- scoped to whichever filter
  // (UI/API/Both) is currently active, so "Select all" never grabs scenarios
  // the user has filtered out of view.
  function selectAll() {
    if (!detail) return;
    const ids = detail.pages.flatMap((p) =>
      p.scenarios.filter((s) => !s.generated_test_case_id && scenarioVisible(s)).map((s) => s.id)
    );
    setSelected(new Set(ids));
  }

  function clearSelection() {
    setSelected(new Set());
  }

  async function refreshDetail() {
    if (!site) return;
    const d = await api.crawlerGetSiteDetail(site.id);
    setDetail(d);
  }

  async function deleteOne(id: string) {
    setBusy(id);
    try {
      await api.crawlerDeleteScenario(id);
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      await refreshDetail();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function deleteSelected() {
    if (selected.size === 0) return;
    setBusy("bulk-delete");
    try {
      await api.crawlerBulkDeleteScenarios(Array.from(selected));
      setSelected(new Set());
      await refreshDetail();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function generateTests() {
    if (selected.size === 0) return null;
    setBusy("generate");
    setGenResults(null);
    try {
      const { results } = await api.crawlerGenerateTests(Array.from(selected));
      setGenResults(results);
      setDownloadSelected(new Set(results.filter((r: any) => r.ok && r.testCaseId).map((r: any) => r.testCaseId)));
      await refreshDetail();
      return results;
    } catch (e: any) {
      setError(e.message);
      return null;
    } finally {
      setBusy(null);
    }
  }

  // Closes most of the loop from inside this one tab: generate real Playwright
  // tests for the selected scenarios and run each one immediately (Ultrafast --
  // no profile/environment picking needed). The Allure report itself is built
  // from the Execution tab, where all runs (crawler-originated or not) land.
  async function generateRunAndReport() {
    if (selected.size === 0) return;
    setBusy("generate-run-report");
    setGenResults(null);
    setRunStatuses({});
    setCrawlFailures([]);
    // Subtract a few seconds of slack for clock/latency skew between this
    // browser and the server writing allure-results -- better to include one
    // extra stray result than to clip off the very run we're scoping to.
    const startedAt = Date.now() - 5000;
    setBatchStartedAt(startedAt);
    try {
      setProgressMessage(`Generating ${selected.size} test script(s)…`);
      const { results } = await api.crawlerGenerateTests(Array.from(selected));
      setGenResults(results);
      setDownloadSelected(new Set(results.filter((r: any) => r.ok && r.testCaseId).map((r: any) => r.testCaseId)));
      await refreshDetail();

      const runnable = results.filter((r: any) => r.ok && r.testCaseId);
      let completed = 0;
      for (const r of runnable) {
        setProgressMessage(`Running test ${completed + 1} of ${runnable.length}: ${r.scriptFile || r.testCaseId}…`);
        setRunStatuses((prev) => ({ ...prev, [r.testCaseId]: { state: "running" } }));
        try {
          const runResult = await api.triggerUltrafast({ testCaseId: r.testCaseId }, url.trim());
          if (!runResult.run) {
            // FR-4.26: a critical-path case routed to second-reviewer sign-off, or
            // below the confidence threshold -- genuinely not run yet, not a failure.
            setRunStatuses((prev) => ({ ...prev, [r.testCaseId]: { state: "needs_review" } }));
          } else {
            const status = runResult.run.status as string;
            const state = status === "passed" ? "passed" : status === "failed" ? "failed" : "error";
            setRunStatuses((prev) => ({
              ...prev,
              [r.testCaseId]: {
                state,
                durationMs: runResult.run.durationMs,
                reportUrl: runResult.reportUrl,
                runId: runResult.run.id,
              },
            }));
            if (state === "failed" || state === "error") {
              try {
                const evidence = await api.getExecutionEvidence(runResult.run.id);
                const first = evidence[0];
                setCrawlFailures((prev) => [
                  ...prev,
                  {
                    testCaseId: r.testCaseId,
                    title: first?.test_title || r.scriptFile || r.testCaseId,
                    errorMessage: first?.error_message ?? null,
                    reportUrl: runResult.reportUrl,
                    runId: runResult.run.id,
                    failureClass: first?.failure_class ?? null,
                    failureLabel: first?.failure_label ?? null,
                  },
                ]);
              } catch {
                // Evidence lookup is best-effort -- the pass/fail pill above already reflects the outcome.
              }
            }
          }
        } catch (runErr: any) {
          setRunStatuses((prev) => ({ ...prev, [r.testCaseId]: { state: "trigger_failed", error: runErr.message } }));
        }
        completed++;
      }

      // Last step: build the Allure report for this crawl automatically -- no
      // separate click required. AllureReportPanel does the actual generate
      // call and shows its own "Generating…" state; this just triggers it.
      setProgressMessage("Building Allure report for this crawl…");
      setAllureAutoGenKey(Date.now());
      setProgressMessage("Done.");
    } catch (e: any) {
      setError(e.message);
      setProgressMessage(null);
    } finally {
      setBusy(null);
      setTimeout(() => setProgressMessage(null), 4000);
    }
  }

  function toggleDownload(testCaseId: string) {
    setDownloadSelected((prev) => {
      const next = new Set(prev);
      if (next.has(testCaseId)) next.delete(testCaseId);
      else next.add(testCaseId);
      return next;
    });
  }

  const generatedTestCaseIds = (genResults ?? []).filter((r) => r.ok && r.testCaseId).map((r) => r.testCaseId as string);

  async function downloadTestCases(ids: string[]) {
    if (ids.length === 0) return;
    setDownloadBusy(true);
    try {
      await api.exportTestCases(ids, exportFormat);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setDownloadBusy(false);
    }
  }

  const isRunning = site?.status === "running";
  const allScenarios = detail?.pages.flatMap((p) => p.scenarios) ?? [];
  const uiScenarioCount = allScenarios.filter((s) => s.type !== "api").length;
  const apiScenarioCount = allScenarios.filter((s) => s.type === "api").length;
  const visibleScenarioCount = allScenarios.filter(scenarioVisible).length;
  const smokeCount = allScenarios.filter((s) => s.tier === "smoke").length;
  const functionalCount = allScenarios.filter((s) => s.tier === "functional").length;
  const regressionCount = allScenarios.filter((s) => s.tier === "regression").length;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-xl tracking-tight">AI Crawler</h2>
        <p className="text-sm text-ink/60">
          Point it at a URL, curate the discovered scenarios, then generate and run real Playwright tests in one flow — build, view, download, or
          email the Allure report right here, and download the generated test cases in any format.
        </p>
      </div>

      {error && <div className="rounded-md border border-alert bg-alert/5 p-3 text-sm text-alert">{error}</div>}

      {/* Step 1: Onboarding */}
      <div className="rounded-lg border border-line bg-white/60 shadow-panel p-4 space-y-3">
        <div className="flex items-center rounded-full border border-line bg-white/60 p-0.5 text-xs w-fit">
          <button className={`rounded-full px-3 py-1 font-medium ${urlMode === "single" ? "bg-ink text-paper" : "text-ink/60"}`} onClick={() => setUrlMode("single")}>
            Single URL
          </button>
          <button className={`rounded-full px-3 py-1 font-medium ${urlMode === "multi" ? "bg-ink text-paper" : "text-ink/60"}`} onClick={() => setUrlMode("multi")}>
            Multiple URLs
          </button>
        </div>

        {urlMode === "single" ? (
          <label className="text-xs text-ink/60 space-y-1 block">
            <span>Target URL</span>
            <input className="w-full rounded-md border border-line px-2 py-1.5 text-sm" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com" />
          </label>
        ) : (
          <label className="text-xs text-ink/60 space-y-1 block">
            <span>Target URLs — one per line</span>
            <textarea
              className="w-full rounded-md border border-line px-2 py-1.5 text-sm font-mono"
              rows={4}
              value={multiUrls}
              onChange={(e) => setMultiUrls(e.target.value)}
              placeholder={"https://example.com\nhttps://staging.example.com\nhttps://another-app.com"}
            />
          </label>
        )}

        <div className="grid gap-3 md:grid-cols-3">
          <label className="text-xs text-ink/60 space-y-1">
            <span>Max pages {urlMode === "multi" && "(per URL)"}</span>
            <input type="number" min={1} className="w-full rounded-md border border-line px-2 py-1.5 text-sm" value={maxPages} onChange={(e) => setMaxPages(Number(e.target.value))} />
          </label>
          <label className="text-xs text-ink/60 space-y-1">
            <span>Username (optional)</span>
            <input className="w-full rounded-md border border-line px-2 py-1.5 text-sm" value={username} onChange={(e) => setUsername(e.target.value)} />
          </label>
          <label className="text-xs text-ink/60 space-y-1">
            <span>Password (optional)</span>
            <input type="password" className="w-full rounded-md border border-line px-2 py-1.5 text-sm" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
        </div>
        <label className="flex items-center gap-1.5 text-xs text-ink/70">
          <input type="checkbox" checked={captureApi} onChange={(e) => setCaptureApi(e.target.checked)} />
          Capture API calls per interaction (--capture-api) — required for API scenarios below to appear
        </label>
        {urlMode === "multi" && <p className="text-xs text-ink/50">Same settings apply to every URL. Crawled one at a time so a local run doesn't compete with itself for resources.</p>}
        {urlMode === "single" && knownSite?.known && (
          <p className="text-xs text-signal">
            This URL was crawled before (last: {knownSite.site?.last_crawled_at ?? "unknown"}) — this run will auto-switch to diff mode and only
            re-capture changed pages.
          </p>
        )}
        {urlMode === "single" ? (
          <button
            className="rounded-md bg-ink text-paper px-3 py-1.5 text-xs font-medium disabled:opacity-40"
            disabled={!url.trim() || isRunning}
            onClick={startCrawl}
          >
            {isRunning ? "Crawling…" : knownSite?.known ? "Re-crawl (diff mode)" : "Start crawl"}
          </button>
        ) : (
          <button
            className="rounded-md bg-ink text-paper px-3 py-1.5 text-xs font-medium disabled:opacity-40"
            disabled={batchRunning}
            onClick={runBatch}
          >
            {batchRunning ? "Crawling…" : `Crawl ${new Set(multiUrls.split(/[\n,]/).map((u) => u.trim()).filter(Boolean)).size || ""} URL(s)`}
          </button>
        )}
      </div>

      {/* Multi-URL queue: live status per URL, click a completed one to curate it below */}
      {urlMode === "multi" && batchQueue.length > 0 && (
        <div className="rounded-lg border border-line bg-white/60 shadow-panel p-4 space-y-2">
          <p className="font-medium text-sm">Crawl queue ({batchQueue.filter((b) => b.status === "completed").length}/{batchQueue.length} done)</p>
          <ul className="space-y-1.5">
            {batchQueue.map((item, i) => (
              <li key={i} className="flex items-center justify-between gap-2 rounded-md border border-line/70 bg-white/50 px-2 py-1.5 text-xs">
                <span className="truncate max-w-[420px]" title={item.url}>{item.url}</span>
                <div className="flex items-center gap-2 shrink-0">
                  {item.status === "completed" && (
                    <span className="text-ink/50">
                      {item.pagesDiscovered ?? 0} page(s), {item.scenariosDiscovered ?? 0} scenario(s)
                    </span>
                  )}
                  {item.status === "failed" && item.error && <span className="text-alert truncate max-w-[200px]" title={item.error}>{item.error}</span>}
                  <Pill tone={item.status === "completed" ? "good" : item.status === "failed" ? "bad" : item.status === "running" ? "warn" : "neutral"}>{item.status}</Pill>
                  {item.status === "completed" && (
                    <button className="rounded border border-ink/20 text-ink/70 px-2 py-1" onClick={() => viewBatchSite(item)}>
                      View
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Step 2: live progress */}
      {urlMode === "single" && site && (
        <div className="rounded-lg border border-line bg-white/60 shadow-panel p-4 space-y-2">
          <div className="flex items-center justify-between">
            <p className="font-medium text-sm">Crawl status</p>
            <Pill tone={site.status === "completed" ? "good" : site.status === "failed" ? "bad" : "warn"}>{site.status}</Pill>
          </div>
          <p className="text-xs text-ink/60">
            Discovered {site.pages_discovered} page(s), {site.forms_discovered} form(s), {site.scenarios_discovered} scenario(s),{" "}
            {site.spelling_issues_found} spelling issue(s)
            {site.current_page ? ` — currently on ${site.current_page}` : ""}
          </p>
          {site.error && <p className="text-xs text-alert">{site.error}</p>}
        </div>
      )}

      {/* Step 3: review & curate */}
      {detail && detail.pages.length > 0 && (
        <div className="rounded-lg border border-line bg-white/60 shadow-panel p-4 space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <p className="font-medium text-sm">Review & curate ({visibleScenarioCount} scenario(s) across {detail.pages.length} page(s))</p>
            <div className="flex gap-2 flex-wrap">
              <button className="rounded-md border border-ink/20 text-ink/70 px-3 py-1.5 text-xs" onClick={selectAll}>
                Select all
              </button>
              <button className="rounded-md border border-ink/20 text-ink/70 px-3 py-1.5 text-xs disabled:opacity-40" disabled={selected.size === 0} onClick={clearSelection}>
                Clear
              </button>
              <button className="rounded-md border border-ink/20 text-ink/70 px-3 py-1.5 text-xs disabled:opacity-40" disabled={selected.size === 0 || busy === "bulk-delete"} onClick={deleteSelected}>
                Delete selected ({selected.size})
              </button>
              <button className="rounded-md border border-ink/20 text-ink/70 px-3 py-1.5 text-xs disabled:opacity-40" disabled={selected.size === 0 || busy === "generate"} onClick={generateTests}>
                Generate tests only ({selected.size})
              </button>
              <button
                className="rounded-md bg-ink text-paper px-3 py-1.5 text-xs font-medium disabled:opacity-40"
                disabled={selected.size === 0 || busy === "generate-run-report"}
                onClick={generateRunAndReport}
                title="Generate real Playwright tests and run them immediately (Ultrafast) — build the Allure report below afterward"
              >
                {busy === "generate-run-report" ? "Working…" : `Generate + Run (${selected.size})`}
              </button>
            </div>
            {progressMessage && (
              <p className="text-xs text-signal flex items-center gap-1.5">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-signal animate-pulse" />
                {progressMessage}
              </p>
            )}
          </div>

          {/* UI scenarios come from discovered page elements; API scenarios come from
              same-origin XHR/fetch calls captured during the crawl (needs --capture-api
              checked above). Both feed the exact same curate/generate/run/download
              actions -- this only controls which ones are shown and selectable. */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center rounded-full border border-line bg-white/60 p-0.5 text-xs w-fit">
              <button
                className={`rounded-full px-3 py-1 font-medium ${scenarioFilter === "ui" ? "bg-ink text-paper" : "text-ink/60"}`}
                onClick={() => setScenarioFilter("ui")}
              >
                UI ({uiScenarioCount})
              </button>
              <button
                className={`rounded-full px-3 py-1 font-medium ${scenarioFilter === "api" ? "bg-ink text-paper" : "text-ink/60"}`}
                onClick={() => setScenarioFilter("api")}
              >
                API ({apiScenarioCount})
              </button>
              <button
                className={`rounded-full px-3 py-1 font-medium ${scenarioFilter === "both" ? "bg-ink text-paper" : "text-ink/60"}`}
                onClick={() => setScenarioFilter("both")}
              >
                Both ({uiScenarioCount + apiScenarioCount})
              </button>
            </div>
            {apiScenarioCount === 0 && (
              <span className="text-xs text-ink/40">
                No API scenarios yet — check "Capture API calls per interaction" and (re-)crawl to discover the site's own backend endpoints.
              </span>
            )}
          </div>

          {/* Smoke = the one core happy path per page/form. Functional = everything
              else generated at crawl time (edge/negative/boundary/multi-step/API).
              Regression = scenarios carried forward unchanged from a page that
              didn't change on a re-crawl -- see crawlerService.ts's persistCrawlResult. */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-ink/50">Test suite:</span>
            <div className="flex items-center rounded-full border border-line bg-white/60 p-0.5 text-xs w-fit">
              <button
                className={`rounded-full px-3 py-1 font-medium ${tierFilter === "all" ? "bg-ink text-paper" : "text-ink/60"}`}
                onClick={() => setTierFilter("all")}
              >
                All ({allScenarios.length})
              </button>
              <button
                className={`rounded-full px-3 py-1 font-medium ${tierFilter === "smoke" ? "bg-ink text-paper" : "text-ink/60"}`}
                onClick={() => setTierFilter("smoke")}
                title="Core critical flows confirming the app is functional"
              >
                Smoke ({smokeCount})
              </button>
              <button
                className={`rounded-full px-3 py-1 font-medium ${tierFilter === "functional" ? "bg-ink text-paper" : "text-ink/60"}`}
                onClick={() => setTierFilter("functional")}
                title="Edge cases, negative/error handling, boundary conditions, multi-step and cross-page flows"
              >
                Functional ({functionalCount})
              </button>
              <button
                className={`rounded-full px-3 py-1 font-medium ${tierFilter === "regression" ? "bg-ink text-paper" : "text-ink/60"}`}
                onClick={() => setTierFilter("regression")}
                title="Previously-working scenarios carried forward from an unchanged page on a re-crawl"
              >
                Regression ({regressionCount})
              </button>
            </div>
          </div>

          {detail.pages.map((page) => {
            const visibleScenarios = page.scenarios.filter(scenarioVisible);
            const isCollapsed = collapsedPageIds.has(page.id);
            return (
              <div key={page.id} className="rounded-md border border-line p-3 space-y-2">
                <button
                  className="flex items-center justify-between w-full text-left"
                  onClick={() => togglePageCollapsed(page.id)}
                  aria-expanded={!isCollapsed}
                >
                  <span className="flex items-center gap-1.5 min-w-0">
                    <span className={`text-ink/40 text-xs shrink-0 transition-transform ${isCollapsed ? "" : "rotate-90"}`}>▶</span>
                    <p className="text-sm font-medium truncate max-w-[420px]" title={page.url}>{page.title || page.url}</p>
                  </span>
                  <span className="flex items-center gap-1.5 shrink-0">
                    <span className="text-xs text-ink/40">{visibleScenarios.length} scenario(s)</span>
                    {page.spellingIssues.length > 0 && <Pill tone="warn">{page.spellingIssues.length} spelling issue(s)</Pill>}
                    <Pill tone={page.change_status === "changed" ? "warn" : page.change_status === "new" ? "good" : "neutral"}>{page.change_status}</Pill>
                  </span>
                </button>
                {!isCollapsed && (
                  <>
                    {page.diff && (page.diff.added.length + page.diff.removed.length + page.diff.changed.length > 0) && (
                      <p className="text-xs text-ink/50">
                        +{page.diff.added.length} added / -{page.diff.removed.length} removed / ~{page.diff.changed.length} changed
                      </p>
                    )}
                    {page.spellingIssues.length > 0 && (
                      <ul className="rounded border border-line/70 bg-alert/5 p-2 text-xs space-y-1">
                        {page.spellingIssues.map((issue, i) => (
                          <li key={i}>
                            <span className="font-medium text-alert">"{issue.word}"</span>{" "}
                            <span className="text-ink/50">({issue.context})</span>
                            {issue.suggestions.length > 0 && (
                              <span className="text-ink/60"> — did you mean: {issue.suggestions.join(", ")}?</span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                    {/* Step 1: Component Inventory -- what's actually on this page (header,
                        navbar, forms, tables, modals, filters, pagination, cards, footer, ...),
                        shown before Step 2's test cases so composition is visible up front. */}
                    {page.componentInventory && page.componentInventory.length > 0 && (
                      <div className="rounded border border-line/70 bg-ink/[0.03] p-2 space-y-1.5">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-ink/50">Step 1 · Component inventory</p>
                        <div className="flex flex-wrap gap-1.5">
                          {page.componentInventory.map((c) => (
                            <span
                              key={c.kind}
                              className="inline-flex items-center gap-1 rounded-full border border-line bg-white/70 px-2 py-0.5 text-[11px] text-ink/70"
                              title={c.samples.length > 0 ? c.samples.join(", ") : undefined}
                            >
                              {c.label} <span className="text-ink/40">×{c.count}</span>
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {page.scenarios.length > 0 && (
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-ink/50 pt-1">Step 2 · Test cases</p>
                    )}
                    {page.scenarios.length === 0 ? (
                      <p className="text-xs text-ink/40">No scenarios (unchanged page — kept from the previous crawl).</p>
                    ) : visibleScenarios.length === 0 ? (
                      <p className="text-xs text-ink/40">No {scenarioFilter === "api" ? "API" : "UI"} scenarios on this page.</p>
                    ) : (
                      <ul className="space-y-1.5">
                        {visibleScenarios.map((s) => (
                          <li key={s.id} className="rounded border border-line/70 p-2 text-xs space-y-1">
                            <div className="flex items-center justify-between gap-2">
                              <label className="flex items-center gap-2">
                                <input type="checkbox" checked={selected.has(s.id)} onChange={() => toggle(s.id)} disabled={Boolean(s.generated_test_case_id)} />
                                <span className="font-medium">{s.title}</span>
                                <Pill tone={s.type === "negative" ? "bad" : s.type === "flow" ? "warn" : s.type === "api" ? "neutral" : "good"}>{s.type}</Pill>
                                {s.tier && (
                                  <Pill tone={s.tier === "regression" ? "warn" : s.tier === "smoke" ? "good" : "neutral"}>{s.tier}</Pill>
                                )}
                                {s.generated_test_case_id && <Pill tone="neutral">test generated</Pill>}
                              </label>
                              <button className="text-alert underline disabled:opacity-40" disabled={busy === s.id} onClick={() => deleteOne(s.id)}>
                                Delete
                              </button>
                            </div>
                            <ul className="pl-4 list-disc text-ink/60">
                              {s.steps.map((step, i) => (
                                <li key={i}>{step}</li>
                              ))}
                            </ul>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      {genResults && (
        <div className="rounded-lg border border-line bg-white/60 shadow-panel p-4 space-y-2">
          <p className="font-medium text-sm">Test generation results</p>

          {Object.keys(runStatuses).length > 0 && (() => {
            const statuses = Object.values(runStatuses);
            const counts = {
              running: statuses.filter((s) => s.state === "running").length,
              passed: statuses.filter((s) => s.state === "passed").length,
              failed: statuses.filter((s) => s.state === "failed" || s.state === "error" || s.state === "trigger_failed").length,
              needsReview: statuses.filter((s) => s.state === "needs_review").length,
            };
            return (
              <div className="flex items-center gap-2 flex-wrap text-xs pb-1">
                <span className="text-ink/60">Automation run status:</span>
                {counts.running > 0 && <Pill tone="neutral">{counts.running} running…</Pill>}
                {counts.passed > 0 && <Pill tone="good">{counts.passed} passed</Pill>}
                {counts.failed > 0 && <Pill tone="bad">{counts.failed} failed</Pill>}
                {counts.needsReview > 0 && <Pill tone="warn">{counts.needsReview} needs review</Pill>}
              </div>
            );
          })()}

          <ul className="text-xs space-y-1">
            {genResults.map((r, i) => {
              const runStatus = r.testCaseId ? runStatuses[r.testCaseId] : undefined;
              return (
                <li key={i} className="flex items-center gap-2 flex-wrap">
                  {r.ok ? (
                    <>
                      <label className="flex items-center gap-2 text-signal">
                        <input
                          type="checkbox"
                          checked={downloadSelected.has(r.testCaseId)}
                          onChange={() => toggleDownload(r.testCaseId)}
                        />
                        Generated {r.scriptFile} (test case {r.testCaseId})
                      </label>
                      {runStatus && (
                        <>
                          <Pill
                            tone={
                              runStatus.state === "passed"
                                ? "good"
                                : runStatus.state === "running"
                                ? "neutral"
                                : runStatus.state === "needs_review"
                                ? "warn"
                                : "bad"
                            }
                          >
                            {runStatus.state === "running" && "Running…"}
                            {runStatus.state === "passed" && `Passed${runStatus.durationMs ? ` (${runStatus.durationMs}ms)` : ""}`}
                            {runStatus.state === "failed" && "Failed"}
                            {runStatus.state === "error" && "Error"}
                            {runStatus.state === "needs_review" && "Needs review (not run)"}
                            {runStatus.state === "trigger_failed" && "Could not start run"}
                          </Pill>
                          {runStatus.reportUrl && (runStatus.state === "failed" || runStatus.state === "error") && (
                            <a className="underline text-signal" href={runStatus.reportUrl} target="_blank" rel="noreferrer">
                              View failure report
                            </a>
                          )}
                          {runStatus.state === "trigger_failed" && runStatus.error && (
                            <span className="text-alert">{runStatus.error}</span>
                          )}
                        </>
                      )}
                    </>
                  ) : (
                    <span className="text-alert">Failed: {r.error}</span>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="text-xs text-ink/50">Run these from the Execution tab (or use "Generate + Run" above), then build the Allure report below.</p>

          {generatedTestCaseIds.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap pt-2 border-t border-line/70">
              <span className="text-xs text-ink/60">Download test cases as</span>
              <select
                className="rounded-md border border-line px-2 py-1 text-xs"
                value={exportFormat}
                onChange={(e) => setExportFormat(e.target.value as typeof exportFormat)}
              >
                <option value="csv">CSV</option>
                <option value="xlsx">XLSX</option>
                <option value="pdf">PDF</option>
                <option value="docx">DOCX</option>
              </select>
              <button
                className="rounded-md border border-ink/20 text-ink/70 px-3 py-1.5 text-xs disabled:opacity-40"
                disabled={downloadBusy || downloadSelected.size === 0}
                onClick={() => downloadTestCases(Array.from(downloadSelected))}
              >
                Download selected ({downloadSelected.size})
              </button>
              <button
                className="rounded-md bg-ink text-paper px-3 py-1.5 text-xs font-medium disabled:opacity-40"
                disabled={downloadBusy}
                onClick={() => downloadTestCases(generatedTestCaseIds)}
              >
                Download all ({generatedTestCaseIds.length})
              </button>
            </div>
          )}
        </div>
      )}

      <AllureReportPanel title="Allure report (from this crawl's runs)" sinceMs={batchStartedAt ?? undefined} autoGenerateKey={allureAutoGenKey} />
      <BugReportPanel failures={crawlFailures} />
    </div>
  );
}
