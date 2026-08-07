import { useRef, useState } from "react";
import { useApp } from "../../context/AppState.js";
import { api } from "../../api.js";
import { Pill } from "../../components/Pill.js";
import { UltrafastLiveModal } from "../../components/UltrafastLiveModal.js";
import { ExecutionSummaryCard } from "../../components/ExecutionSummaryCard.js";
import Crawler from "../Crawler.js";

interface StepState {
  key: "input" | "generate" | "execute" | "report";
  label: string;
  status: "pending" | "active" | "done" | "error";
  detail?: string;
}

const BASE_STEPS: StepState[] = [
  { key: "input", label: "Input received", status: "pending" },
  { key: "generate", label: "Test cases generated", status: "pending" },
  { key: "execute", label: "Tests executed", status: "pending" },
  { key: "report", label: "Report ready", status: "pending" },
];

interface RunResult {
  testCaseTitle: string;
  status: string | null;
  reportUrl: string | null;
  needsReview: boolean;
}

// FR-4.24/4.25/4.27: Ultrafast Mode's whole reason to exist -- one input, zero further
// clicks, a finished report. This component owns the client-side orchestration (submit
// input -> generate test cases -> run each one) by chaining existing endpoints; nothing
// new on the backend. Fast Mode does NOT use this -- it uses the step tabs in Run.tsx,
// which keep every existing checkpoint (review, profile/environment confirm) intact.
export function UltrafastRunner() {
  const { draftInput, setDraftInput, businessRules, withBusy, busy, error, needsReviewLaterCases } = useApp();
  const [steps, setSteps] = useState<StepState[]>(BASE_STEPS);
  const [results, setResults] = useState<RunResult[] | null>(null);
  // Summary metrics for execution summary card
  const [executionSummary, setExecutionSummary] = useState<{
    testsPassed: number;
    testsFailed: number;
    totalTests: number;
    bugsFound: number;
    costAccumulated: number;
    bugsByCriticality?: { critical: number; high: number; medium: number; low: number };
  } | null>(null);
  const [lastRunId, setLastRunId] = useState<string | null>(null);
  // The AI Crawler lives here now, not in Library: crawling a site is an input
  // source for the automatic pipeline (discover pages -> curate -> generate ->
  // run, all inside Crawler's own "Generate + Run" action), the same role the
  // text description plays below -- just for "test my whole site" instead of
  // "test this one scenario I can describe."
  const [source, setSource] = useState<"text" | "crawl">("text");
  // "No human intervention" is the default, not a lock-in -- if a run is going
  // somewhere unwanted (wrong input, runs taking too long), the user can still
  // abandon it. Checked between loop iterations; the in-flight request for the
  // current test case is ended server-side by killing its process (see stopRun).
  const stopRequestedRef = useRef(false);
  const [stopRequested, setStopRequested] = useState(false);
  const [stoppedEarly, setStoppedEarly] = useState(false);
  // Real-time execution modal
  const [liveRunId, setLiveRunId] = useState<string | null>(null);
  const [showLiveView, setShowLiveView] = useState(false);

  function setStep(key: StepState["key"], status: StepState["status"], detail?: string) {
    setSteps((prev) => prev.map((s) => (s.key === key ? { ...s, status, detail } : s)));
  }

  async function runNow() {
    setResults(null);
    setStoppedEarly(false);
    setStopRequested(false);
    stopRequestedRef.current = false;
    setSteps(BASE_STEPS.map((s) => ({ ...s })));
    await withBusy("ultrafast-run", async () => {
      setStep("input", "active");
      const input = await api.createInput(draftInput, "free_text", businessRules || undefined);
      setStep("input", "done", input.type);

      setStep("generate", "active");
      const cases = await api.generateTestCases(input.id);
      if (cases.length === 0) {
        setStep("generate", "error", "No test cases were generated from this input — try adding more detail.");
        return;
      }
      setStep("generate", "done", `${cases.length} test case(s)`);

      setStep("execute", "active");
      const runResults: RunResult[] = [];
      let testsPassed = 0;
      let testsFailed = 0;
      let bugsFound = 0;
      let costAccumulated = 0;
      let lastRunIdTracked = "";

      for (let i = 0; i < cases.length; i++) {
        if (stopRequestedRef.current) break;
        const tc = cases[i];
        setStep("execute", "active", `${i + 1}/${cases.length}`);
        const result = await api.triggerUltrafast({ testCaseId: tc.id });
        
        // Show live view for first run
        if (result?.run?.id && i === 0) {
          setLiveRunId(result.run.id);
          setShowLiveView(true);
          lastRunIdTracked = result.run.id;
        }
        
        // Track metrics for summary
        if (result?.run?.status === "passed") {
          testsPassed++;
        } else if (result?.run?.status === "failed") {
          testsFailed++;
        }
        // Estimate cost: $0.50 per test on Ultrafast
        costAccumulated += 0.5;
        
        runResults.push({
          testCaseTitle: tc.title,
          status: result?.run?.status ?? null,
          reportUrl: result?.reportUrl ?? null,
          needsReview: !result?.run,
        });
      }
      
      if (stopRequestedRef.current) {
        setStoppedEarly(true);
        setStep("execute", "error", `Stopped — ${runResults.length}/${cases.length} run`);
      } else {
        setStep("execute", "done", `${runResults.length}/${cases.length} run`);
        setStep("report", "done");
      }
      
      // Create execution summary
      setExecutionSummary({
        testsPassed,
        testsFailed,
        totalTests: cases.length,
        bugsFound: bugsFound, // Will be fetched from API in feature #3
        costAccumulated,
        bugsByCriticality: { critical: 0, high: 0, medium: 0, low: 0 },
      });
      setLastRunId(lastRunIdTracked);
      setResults(runResults);
    });
  }

  async function stopRun() {
    stopRequestedRef.current = true;
    setStopRequested(true);
    await api.stopAllExecutions().catch(() => undefined);
  }

  const isRunning = busy === "ultrafast-run";

  return (
    <div className="space-y-5">
      <div className="flex items-center rounded-full border border-line bg-white/60 p-0.5 text-xs w-fit">
        <button
          className={`rounded-full px-3.5 py-1.5 font-medium ${source === "text" ? "bg-ink text-paper" : "text-ink/60"}`}
          onClick={() => setSource("text")}
        >
          Describe a scenario
        </button>
        <button
          className={`rounded-full px-3.5 py-1.5 font-medium ${source === "crawl" ? "bg-ink text-paper" : "text-ink/60"}`}
          onClick={() => setSource("crawl")}
        >
          Crawl a website
        </button>
      </div>

      {source === "crawl" ? (
        <Crawler />
      ) : (
        <>
          <div className="rounded-lg border border-line bg-white/60 shadow-panel p-4 space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">Describe what to test</p>
            <textarea
              className="w-full rounded-md border border-line bg-white/60 p-3 text-sm"
              rows={4}
              placeholder="e.g. The login page has a Username field, a Password field, and a Log in button. Valid credentials reach the dashboard; invalid ones show an inline error."
              value={draftInput}
              onChange={(e) => setDraftInput(e.target.value)}
              disabled={isRunning}
            />
            <div className="flex items-center gap-3">
              <button
                className="rounded-md bg-ink text-paper px-4 py-2 text-sm font-medium disabled:opacity-50"
                disabled={isRunning || !draftInput.trim()}
                onClick={runNow}
              >
                {isRunning ? "Running…" : "Run — no further clicks needed"}
              </button>
              {isRunning && (
                <button
                  className="rounded-md border border-alert text-alert px-4 py-2 text-sm font-medium disabled:opacity-50"
                  disabled={stopRequested}
                  onClick={stopRun}
                >
                  {stopRequested ? "Stopping…" : "Stop"}
                </button>
              )}
              <span className="text-xs text-ink/50">Generates test cases, runs them, and delivers a report automatically.</span>
            </div>
            {error && <p className="text-sm text-alert">{error}</p>}
            {stoppedEarly && <p className="text-sm text-alert">Stopped by request — remaining test cases were not run.</p>}
          </div>

          {executionSummary && results && (
            <ExecutionSummaryCard 
              result={executionSummary} 
              runId={lastRunId || ""}
              testCaseTitle={results[0]?.testCaseTitle}
            />
          )}

          {(isRunning || results) && (
            <div className="rounded-lg border border-line bg-white/60 shadow-panel p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink/60 mb-3">Progress</p>
              <div className="flex items-center">
                {steps.map((s, idx) => (
                  <div key={s.key} className="flex items-center flex-1 last:flex-none">
                    <div className="flex flex-col items-center gap-1">
                      <div
                        className={`h-8 w-8 rounded-full flex items-center justify-center text-xs font-display border ${
                          s.status === "done"
                            ? "bg-signal text-white border-signal"
                            : s.status === "active"
                            ? "bg-warn/20 text-warn border-warn animate-pulse"
                            : s.status === "error"
                            ? "bg-alert/10 text-alert border-alert"
                            : "bg-white text-ink/40 border-line"
                        }`}
                      >
                        {s.status === "done" ? "✓" : idx + 1}
                      </div>
                      <span className={`text-xs text-center max-w-[6.5rem] ${s.status === "pending" ? "text-ink/40" : "text-ink"}`}>{s.label}</span>
                      {s.detail && <span className="text-[10px] text-ink/40">{s.detail}</span>}
                    </div>
                    {idx < steps.length - 1 && <div className={`flex-1 h-px mx-2 ${s.status === "done" ? "bg-signal" : "bg-line"}`} />}
                  </div>
                ))}
              </div>
            </div>
          )}

          {results && (
            <div className="rounded-lg border border-line bg-white/60 shadow-panel p-4 space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">Results</p>
              {results.map((r, idx) => (
                <div key={idx} className="flex items-center justify-between gap-3 rounded-md border border-line bg-white/50 p-2.5 text-sm">
                  <span className="flex-1 truncate">{r.testCaseTitle}</span>
                  {r.needsReview ? (
                    <Pill tone="warn">needs review</Pill>
                  ) : (
                    <Pill tone={r.status === "passed" ? "good" : "bad"}>{r.status}</Pill>
                  )}
                  {r.reportUrl && (
                    <a className="rounded-md bg-signal text-white px-3 py-1 text-xs font-medium" href={r.reportUrl} target="_blank" rel="noreferrer">
                      View report
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}

          {needsReviewLaterCases.length > 0 && (
            <div className="rounded-lg border border-alert/40 bg-alert/5 p-4 space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-alert">{needsReviewLaterCases.length} test case(s) need a quick look</p>
              <p className="text-xs text-ink/60">Generated below the auto-accept confidence threshold — they weren't run automatically, but nothing else was blocked. Switch to Fast Mode to review them.</p>
            </div>
          )}
        </>
      )}

      {/* Real-time execution live view modal */}
      <UltrafastLiveModal 
        runId={liveRunId} 
        isOpen={showLiveView} 
        onClose={() => setShowLiveView(false)} 
      />
    </div>
  );
}
