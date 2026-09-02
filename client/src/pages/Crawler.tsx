import { useEffect, useRef, useState } from "react";
import { api, CrawlSite, CrawlSiteDetail } from "../api.js";
import { Pill } from "../components/Pill.js";
import { AllureReportPanel } from "../components/AllureReportPanel.js";
import { BugReportPanel } from "../components/BugReportPanel.js";
import { CRAWL_PRESETS, type PresetId } from "../config/crawlPresets.js";

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
  const [captureApi, setCaptureApi] = useState(false);
  /** auto = server decides (diff on re-crawl); incremental/full = force */
  const [crawlMode, setCrawlMode] = useState<"auto" | "incremental" | "full">("auto");
  /** minimal = few scenarios/page covering load + components + primary flow (saves LLM tokens) */
  const [coverageMode, setCoverageMode] = useState<"minimal" | "standard" | "full">("minimal");
  const [lastModeInfo, setLastModeInfo] = useState<{ mode?: string; modeReason?: string; isRerun?: boolean } | null>(null);
  const [cockpit, setCockpit] = useState<any>(null);
  const [impactTier, setImpactTier] = useState<"smoke" | "critical" | "full-delta">("critical");
  const [impactBusy, setImpactBusy] = useState(false);
  const [impactMsg, setImpactMsg] = useState<string | null>(null);
  const [impactJobId, setImpactJobId] = useState<string | null>(null);
  const [impactJob, setImpactJob] = useState<any>(null);
  const impactPollRef = useRef<number | null>(null);
  const [ciSecret, setCiSecret] = useState<string | null>(null);
  
  // Smart presets — shown as three simple depth choices in the UI
  const [selectedPreset, setSelectedPreset] = useState<PresetId>("comprehensive");

  const [site, setSite] = useState<CrawlSite | null>(null);
  const [detail, setDetail] = useState<CrawlSiteDetail | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [knownSite, setKnownSite] = useState<{ known: boolean; site: CrawlSite | null } | null>(null);
  const [discoveredPages, setDiscoveredPages] = useState<{ url: string; title: string }[]>([]);
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
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showTestDetails, setShowTestDetails] = useState(false);

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

  function stopImpactPolling() {
    if (impactPollRef.current) {
      window.clearInterval(impactPollRef.current);
      impactPollRef.current = null;
    }
  }

  function startImpactPolling(siteId: string, jobId: string) {
    stopImpactPolling();
    impactPollRef.current = window.setInterval(async () => {
      try {
        const res = await api.crawlerGetImpactSuiteJob(siteId, jobId);
        const job = res?.job;
        if (!job) return;
        setImpactJob(job);
        setImpactMsg(job.message || null);
        if (job.status === "completed" || job.status === "failed") {
          stopImpactPolling();
          setImpactBusy(false);
        }
      } catch {
        /* keep polling through transient errors */
      }
    }, 2500);
  }

  function getEffectiveConfig() {
    const preset = CRAWL_PRESETS[selectedPreset];
    return {
      maxPages: preset.maxPages,
      crawlAllPages: preset.maxPages === 999999,
      concurrency: Math.min(5, preset.concurrency || 5),
    };
  }

  async function startCrawl() {
    setError(null);
    setGenResults(null);
    setDetail(null);
    setSelected(new Set());
    setDiscoveredPages([]);
    setLastModeInfo(null);
    try {
      const config = getEffectiveConfig();
      const res = await api.crawlerRun({
        url: url.trim(),
        username: username || undefined,
        password: password || undefined,
        maxPages: config.crawlAllPages ? 999999 : config.maxPages,
        captureApi,
        concurrency: config.concurrency,
        mode: crawlMode === "auto" ? undefined : crawlMode,
        coverageMode,
      });
      setLastModeInfo({ mode: res.mode, modeReason: res.modeReason, isRerun: res.isRerun });
      const initial = await api.crawlerGetSite(res.siteId);
      setSite(initial);
      api.crawlerGetCockpit(res.siteId).then(setCockpit).catch(() => undefined);
      stopPolling();
      pollRef.current = window.setInterval(async () => {
        try {
          const updated = await api.crawlerGetSite(res.siteId);
          setSite(updated);
          
          // Fetch detailed page info to show discovered pages
          if (updated.pages_discovered > discoveredPages.length) {
            const d = await api.crawlerGetSiteDetail(res.siteId);
            if (d && d.pages) {
              setDiscoveredPages(d.pages.map((p) => ({ url: p.url, title: p.title || p.url })));
            }
          }
          
          if (updated.status === "completed" || updated.status === "failed") {
            stopPolling();
            if (updated.status === "completed") {
              const d = await api.crawlerGetSiteDetail(res.siteId);
              setDetail(d);
              api.crawlerGetCockpit(res.siteId).then(setCockpit).catch(() => undefined);
              api.crawlerPlanImpactSuite(res.siteId, "critical").then((p) => {
                if (p?.plan?.estimatedTests) {
                  setImpactMsg(`Impact suite ready: ~${p.plan.estimatedTests} test(s) on changed/new pages`);
                }
              }).catch(() => undefined);
            }
          }
        } catch (e: any) {
          stopPolling();
          setError(e.message);
        }
      }, 500); // Faster polling for real-time updates
    } catch (e: any) {
      setError(e.message);
    }
  }

  useEffect(() => () => {
    stopPolling();
    stopImpactPolling();
  }, []);

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
    const config = getEffectiveConfig();

    for (let i = 0; i < urls.length; i++) {
      setBatchQueue((prev) => prev.map((item, idx) => (idx === i ? { ...item, status: "running" } : item)));
      try {
        const res = await api.crawlerRun({
          url: urls[i],
          username: username || undefined,
          password: password || undefined,
          maxPages: config.crawlAllPages ? 999999 : config.maxPages,
          captureApi,
          concurrency: config.concurrency,
          mode: crawlMode === "auto" ? undefined : crawlMode,
          coverageMode,
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

  // Select all scenarios from all pages (convenience for full crawl testing)
  function selectAllPages() {
    if (!detail) return;
    const ids = detail.pages.flatMap((p) =>
      p.scenarios.filter((s) => !s.generated_test_case_id).map((s) => s.id)
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

  /** Add missing component-coverage scenarios from the last crawl inventory (no re-crawl). */
  async function ensureComponentTests() {
    if (!site) return;
    setBusy("component-coverage");
    setError(null);
    try {
      const res = await api.crawlerEnsureComponentCoverage(site.id);
      await refreshDetail();
      setProgressMessage(
        res.added > 0
          ? `Added ${res.added} component test scenario(s) across ${res.pagesUpdated} page(s). Select them below and Generate + Run.`
          : "All discovered components already have coverage scenarios."
      );
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  /** Shrink the active scenario list to minimal/standard/full without re-crawling. */
  async function rebuildCoverage() {
    if (!site) return;
    setBusy("coverage-rebuild");
    setError(null);
    try {
      const res = await api.crawlerRebuildCoverage(site.id, coverageMode);
      await refreshDetail();
      setProgressMessage(
        `Coverage rebuilt (${res.coverageMode}): +${res.added} added, ${res.retired} retired across ${res.pagesUpdated} page(s).`
      );
      setTimeout(() => setProgressMessage(null), 6000);
    } catch (e: any) {
      setError(e.message);
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

  // First-time friendly: after a crawl finishes, pre-select every new scenario so
  // "Run all tests" works without manual checkbox hunting.
  useEffect(() => {
    if (site?.status !== "completed" || !detail) return;
    const ids = detail.pages.flatMap((p) =>
      p.scenarios.filter((s) => !s.generated_test_case_id).map((s) => s.id)
    );
    if (ids.length === 0) return;
    setSelected((prev) => (prev.size === 0 ? new Set(ids) : prev));
    // Collapse every page card — keeps the list scannable until the user expands one.
    setCollapsedPageIds(new Set(detail.pages.map((p) => p.id)));
  }, [site?.status, detail?.pages.length]);

  const allScenarios = detail?.pages.flatMap((p) => p.scenarios) ?? [];
  const uiScenarioCount = allScenarios.filter((s) => s.type !== "api").length;
  const apiScenarioCount = allScenarios.filter((s) => s.type === "api").length;
  const visibleScenarioCount = allScenarios.filter(scenarioVisible).length;
  const smokeCount = allScenarios.filter((s) => s.tier === "smoke").length;
  const functionalCount = allScenarios.filter((s) => s.tier === "functional").length;
  const regressionCount = allScenarios.filter((s) => s.tier === "regression").length;
  const negativeCount = allScenarios.filter((s) => s.type === "negative").length;
  const edgeCount = allScenarios.filter((s) => s.type === "edge").length;
  const flowCount = allScenarios.filter((s) => s.type === "flow").length;
  const isRunning = site?.status === "running";

  return (
    <div className="space-y-3 max-w-3xl">
      <div>
        <h2 className="font-display text-base tracking-tight">Test a website</h2>
        <p className="text-xs text-ink/55 mt-0.5">
          Enter a URL, crawl the site, then run automated tests — one flow, no extra steps.
        </p>
      </div>

      {error && <div className="rounded-md border border-alert bg-alert/5 px-3 py-2 text-xs text-alert">{error}</div>}

      {/* Setup — URL, depth, start */}
      <div className="rounded-lg border border-line bg-white/60 shadow-panel p-4 space-y-3">
        <label className="block space-y-1">
          <span className="text-xs font-medium text-ink/70">Website URL</span>
          <input
            className="w-full rounded-md border border-line px-3 py-2 text-sm"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://your-site.com"
            disabled={isRunning}
          />
        </label>

        <div className="space-y-1">
          <span className="text-xs font-medium text-ink/70">How deep to crawl</span>
          <div className="flex flex-wrap gap-2">
            {(
              [
                { id: "quick" as PresetId, label: "Quick", hint: "~10 pages · ~5 min" },
                { id: "comprehensive" as PresetId, label: "Standard", hint: "~50 pages · ~20 min" },
                { id: "enterprise" as PresetId, label: "Full site", hint: "All pages" },
              ] as const
            ).map(({ id, label, hint }) => (
              <button
                key={id}
                type="button"
                onClick={() => setSelectedPreset(id)}
                className={`rounded-lg border px-3 py-2 text-left text-xs transition ${
                  selectedPreset === id ? "border-ink bg-ink/5" : "border-line hover:border-ink/40"
                }`}
              >
                <span className="font-medium block">{label}</span>
                <span className="text-ink/45">{hint}</span>
              </button>
            ))}
          </div>
        </div>

        {knownSite?.known && (
          <p className="text-xs text-signal">
            Previously crawled — next run checks for changes only (fast re-crawl).
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button
            type="button"
            className="rounded-md bg-ink text-paper px-4 py-2 text-sm font-medium disabled:opacity-40"
            disabled={!url.trim() || isRunning || batchRunning}
            onClick={startCrawl}
          >
            {isRunning ? "Crawling…" : knownSite?.known ? "Re-crawl site" : "Start crawl"}
          </button>
          <button
            type="button"
            className="text-xs text-ink/50 underline-offset-2 hover:underline"
            onClick={() => setShowAdvanced((v) => !v)}
          >
            {showAdvanced ? "Hide options" : "Login & more options"}
          </button>
        </div>

        {showAdvanced && (
          <div className="rounded-md border border-line/70 bg-ink/[0.02] p-3 space-y-3 text-xs">
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="space-y-1 block">
                <span className="text-ink/60">Username (optional)</span>
                <input className="w-full rounded-md border border-line px-2 py-1.5 text-sm" value={username} onChange={(e) => setUsername(e.target.value)} />
              </label>
              <label className="space-y-1 block">
                <span className="text-ink/60">Password (optional)</span>
                <input type="password" className="w-full rounded-md border border-line px-2 py-1.5 text-sm" value={password} onChange={(e) => setPassword(e.target.value)} />
              </label>
            </div>
            <label className="flex items-center gap-2 text-ink/70">
              <input type="checkbox" checked={captureApi} onChange={(e) => setCaptureApi(e.target.checked)} />
              Also test API calls (slower crawl)
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-ink/60">Re-crawl:</span>
              {(["auto", "incremental", "full"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`rounded-full px-2.5 py-1 capitalize ${crawlMode === m ? "bg-ink text-paper" : "border border-line text-ink/60"}`}
                  onClick={() => setCrawlMode(m)}
                >
                  {m}
                </button>
              ))}
            </div>
            <div className="flex items-center rounded-full border border-line bg-white/60 p-0.5 w-fit">
              <button className={`rounded-full px-3 py-1 ${urlMode === "single" ? "bg-ink text-paper" : "text-ink/60"}`} onClick={() => setUrlMode("single")}>
                Single URL
              </button>
              <button className={`rounded-full px-3 py-1 ${urlMode === "multi" ? "bg-ink text-paper" : "text-ink/60"}`} onClick={() => setUrlMode("multi")}>
                Multiple URLs
              </button>
            </div>
            {urlMode === "multi" && (
              <>
                <textarea
                  className="w-full rounded-md border border-line px-2 py-1.5 text-sm font-mono"
                  rows={3}
                  value={multiUrls}
                  onChange={(e) => setMultiUrls(e.target.value)}
                  placeholder="One URL per line"
                />
                <button
                  type="button"
                  className="rounded-md bg-ink text-paper px-3 py-1.5 text-xs font-medium disabled:opacity-40"
                  disabled={batchRunning}
                  onClick={runBatch}
                >
                  {batchRunning ? "Crawling…" : "Crawl all URLs"}
                </button>
              </>
            )}
            <label className="space-y-1 block">
              <span className="text-ink/60">Test coverage</span>
              <select
                className="w-full rounded-md border border-line px-2 py-1.5 text-sm"
                value={coverageMode}
                onChange={(e) => setCoverageMode(e.target.value as typeof coverageMode)}
              >
                <option value="minimal">Minimal — smoke + key flows (fastest)</option>
                <option value="standard">Standard — forms + components</option>
                <option value="full">Full — maximum scenarios</option>
              </select>
            </label>
          </div>
        )}
      </div>

      {/* Multi-URL queue: live status per URL, click a completed one to curate it below */}
      {urlMode === "multi" && batchQueue.length > 0 && (
        <div className="rounded-lg border border-line bg-white/60 shadow-panel p-3 space-y-2">
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

      {/* Live progress — one compact line + optional detail */}
      {urlMode === "single" && site && (
        <div className="rounded-lg border border-line bg-white/60 shadow-panel px-4 py-3 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <Pill tone={site.status === "completed" ? "good" : site.status === "failed" ? "bad" : "warn"}>
                {site.status === "running" ? "Crawling…" : site.status}
              </Pill>
              <span className="text-ink/70">
                <strong>{site.pages_discovered}</strong> pages · <strong>{site.forms_discovered}</strong> forms ·{" "}
                <strong>{site.scenarios_discovered}</strong> tests
              </span>
            </div>
            {site.status === "completed" && detail && detail.pages.length > 0 && (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="text-xs text-ink/50 underline-offset-2 hover:underline"
                  onClick={() => setShowTestDetails((v) => !v)}
                >
                  {showTestDetails ? "Hide test list" : `View / edit tests (${selected.size})`}
                </button>
                <button
                  type="button"
                  className="rounded-md bg-ink text-paper px-4 py-2 text-sm font-medium disabled:opacity-40"
                  disabled={selected.size === 0 || busy === "generate-run-report"}
                  onClick={generateRunAndReport}
                >
                  {busy === "generate-run-report" ? "Running tests…" : `Run all tests (${selected.size})`}
                </button>
              </div>
            )}
          </div>
          {site.current_page && site.status === "running" && (
            <p className="text-xs text-ink/50 truncate">Now: {site.current_page}</p>
          )}
          {progressMessage && (
            <p className="text-xs text-signal flex items-center gap-1.5">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-signal animate-pulse" />
              {progressMessage}
            </p>
          )}
          {site.error && <p className="text-xs text-alert">{site.error}</p>}
          {detail?.site?.recrawl_summary && site.status === "completed" && (
            <p className="text-xs text-ink/55">
              Re-crawl: {detail.site.recrawl_summary.unchangedPages ?? 0} unchanged,{" "}
              {detail.site.recrawl_summary.changedPages ?? 0} changed, {detail.site.recrawl_summary.newPages ?? 0} new
              {detail.site.recrawl_summary.restoredPages
                ? `, ${detail.site.recrawl_summary.restoredPages} restored`
                : ""}
              {detail.site.recrawl_summary.temporarilyUnavailable
                ? `, ${detail.site.recrawl_summary.temporarilyUnavailable} temporarily unavailable`
                : ""}
              {detail.site.recrawl_summary.removedPages
                ? `, ${detail.site.recrawl_summary.removedPages} removed`
                : ""}
              {detail.site.recrawl_summary.sitemapAdded || detail.site.recrawl_summary.sitemapRemoved
                ? ` · sitemap +${detail.site.recrawl_summary.sitemapAdded ?? 0}/-${detail.site.recrawl_summary.sitemapRemoved ?? 0}`
                : ""}
            </p>
          )}
        </div>
      )}

      {/* Optional test list — hidden until user wants to curate */}
      {showTestDetails && detail && detail.pages.length > 0 && (
        <div className="rounded-lg border border-line bg-white/60 shadow-panel p-3 space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <p className="text-sm font-medium">
              {selected.size} of {allScenarios.filter((s) => !s.generated_test_case_id).length} tests selected
            </p>
            <div className="flex gap-2 flex-wrap text-xs">
              <button className="rounded-md border border-ink/20 text-ink/70 px-2.5 py-1" onClick={selectAllPages}>
                Select all
              </button>
              <button className="rounded-md border border-ink/20 text-ink/70 px-2.5 py-1 disabled:opacity-40" disabled={selected.size === 0} onClick={clearSelection}>
                Clear
              </button>
            </div>
          </div>

          {showAdvanced && (
            <div className="flex items-center gap-2 flex-wrap text-xs">
              <div className="flex items-center rounded-full border border-line bg-white/60 p-0.5">
                {(["ui", "api", "both"] as const).map((f) => (
                  <button
                    key={f}
                    className={`rounded-full px-2.5 py-1 capitalize ${scenarioFilter === f ? "bg-ink text-paper" : "text-ink/60"}`}
                    onClick={() => setScenarioFilter(f)}
                  >
                    {f === "both" ? `All (${uiScenarioCount + apiScenarioCount})` : `${f} (${f === "ui" ? uiScenarioCount : apiScenarioCount})`}
                  </button>
                ))}
              </div>
              <div className="flex items-center rounded-full border border-line bg-white/60 p-0.5">
                {(["all", "smoke", "functional", "regression"] as const).map((t) => (
                  <button
                    key={t}
                    className={`rounded-full px-2.5 py-1 capitalize ${tierFilter === t ? "bg-ink text-paper" : "text-ink/60"}`}
                    onClick={() => setTierFilter(t)}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
          )}
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
                    {page.changeSignals && showAdvanced && (
                      <span className="text-[10px] text-ink/50">
                        Structure {page.changeSignals.structure === "same" ? "✓" : page.changeSignals.structure === "changed" ? "≠" : "·"}
                        {" · "}A11y {page.changeSignals.a11y === "same" ? "✓" : page.changeSignals.a11y === "changed" ? "≠" : "·"}
                      </span>
                    )}
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

                    {page.scenarios.length === 0 ? (
                      <p className="text-xs text-ink/40">No scenarios (unchanged page — kept from the previous crawl).</p>
                    ) : visibleScenarios.length === 0 ? (
                      <p className="text-xs text-ink/40">No {scenarioFilter === "api" ? "API" : "UI"} scenarios on this page.</p>
                    ) : (
                      <ul className="space-y-1">
                        {visibleScenarios.map((s) => (
                          <li key={s.id} className="flex items-center justify-between gap-2 rounded border border-line/70 px-2 py-1.5 text-xs">
                            <label className="flex items-center gap-2 min-w-0 flex-1">
                              <input type="checkbox" checked={selected.has(s.id)} onChange={() => toggle(s.id)} disabled={Boolean(s.generated_test_case_id)} />
                              <span className="truncate font-medium" title={s.title}>{s.title}</span>
                              {s.generated_test_case_id && <Pill tone="neutral">done</Pill>}
                            </label>
                            <button className="text-alert shrink-0 disabled:opacity-40" disabled={busy === s.id} onClick={() => deleteOne(s.id)}>
                              Remove
                            </button>
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
        <div className="rounded-lg border border-line bg-white/60 shadow-panel p-3 space-y-2">
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

      {(genResults || batchStartedAt) && (
        <AllureReportPanel title="Test report" sinceMs={batchStartedAt ?? undefined} autoGenerateKey={allureAutoGenKey} />
      )}
      {crawlFailures.length > 0 && <BugReportPanel failures={crawlFailures} />}
    </div>
  );
}
