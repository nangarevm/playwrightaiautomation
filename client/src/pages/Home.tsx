import { useEffect, useState } from "react";
import { useApp, View } from "../context/AppState.js";
import { api } from "../api.js";
import { Pill } from "../components/Pill.js";
import { StatTile } from "../components/StatTile.js";

const STEPS = ["Upload", "Analysis", "Generate", "Review", "Execute", "Report"];

// FR-6.1: dashboard date-range presets. "all" sends no start/end and shows full history.
const RANGE_PRESETS: Array<{ key: string; label: string; days: number | null }> = [
  { key: "7d", label: "7d", days: 7 },
  { key: "30d", label: "30d", days: 30 },
  { key: "90d", label: "90d", days: 90 },
  { key: "all", label: "All", days: null },
];

function presetToRange(days: number | null): { startDate?: string; endDate?: string } {
  if (days == null) return {};
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
}

export default function Home() {
  const {
    inputs,
    testCases,
    scripts,
    runs,
    dashboard: allTimeDashboard,
    hoursSaved: allTimeHoursSaved,
    flakyTests,
    coverage,
    profiles,
    environments,
    needsReviewLaterCases,
    setView,
  } = useApp();

  // Fetched locally (not in global AppState) purely for the recommendations panel below --
  // both are cheap, infrequently-changing lists so a one-shot fetch on mount is enough.
  const [coverageGaps, setCoverageGaps] = useState<any[]>([]);
  const [duplicateFlags, setDuplicateFlags] = useState<any[]>([]);
  useEffect(() => {
    api.getCoverageGaps().then(setCoverageGaps).catch(() => undefined);
    api.listDuplicateFlags().then(setDuplicateFlags).catch(() => undefined);
  }, []);

  // FR-6.1: date-range control for the dashboard tiles -- previously a static, unfiltered
  // pass-rate/time-saved tile with no way to pick a window. Defaults to "all" (same numbers
  // AppState already loaded), re-fetches scoped numbers from the server on preset change.
  const [rangePreset, setRangePreset] = useState("all");
  const [rangedDashboard, setRangedDashboard] = useState<any>(null);
  const [rangedHoursSaved, setRangedHoursSaved] = useState<any>(null);

  useEffect(() => {
    if (rangePreset === "all") {
      setRangedDashboard(null);
      setRangedHoursSaved(null);
      return;
    }
    const preset = RANGE_PRESETS.find((p) => p.key === rangePreset);
    const range = presetToRange(preset?.days ?? null);
    api.getDashboard(range).then(setRangedDashboard).catch(() => undefined);
    api.getHoursSaved(range).then(setRangedHoursSaved).catch(() => undefined);
  }, [rangePreset]);

  const dashboard = rangedDashboard ?? allTimeDashboard;
  const hoursSaved = rangedHoursSaved ?? allTimeHoursSaved;

  const uploadDone = inputs.length > 0;
  const analysisDone = uploadDone; // ingestion implies analysis in this pipeline
  const generateDone = testCases.length > 0;
  const reviewDone = testCases.some((t) => t.status === "accepted" || t.status === "edited");
  const executeDone = runs.length > 0;
  const reportDone = !!dashboard && dashboard.totalRuns > 0;
  const doneFlags = [uploadDone, analysisDone, generateDone, reviewDone, executeDone, reportDone];
  const activeIdx = doneFlags.lastIndexOf(true);

  const withScript = testCases.filter((t) => scripts.some((s) => s.test_case_id === t.id)).length;
  const automationCoverage = testCases.length > 0 ? Math.round((withScript / testCases.length) * 100) : 0;
  const avgConfidence =
    testCases.length > 0
      ? Math.round((testCases.reduce((sum, t) => sum + (t.confidence_score ?? 0), 0) / testCases.length) * 100)
      : 0;

  const recommendations: { tag: string; tone: "warn" | "bad" | "neutral"; text: string; view?: View }[] = [];

  // Onboarding nudge: Ultrafast still runs with neither configured (falls back gracefully),
  // but Fast Mode's per-script "Run test" stays disabled until at least one of each exists --
  // surfaced here since a fresh workspace has zero of both and nothing else points this out.
  if (profiles.length === 0 || environments.length === 0) {
    const missing = [profiles.length === 0 && "Execution Profile", environments.length === 0 && "Environment"].filter(Boolean).join(" or ");
    recommendations.push({
      tag: "SETUP",
      tone: "neutral",
      text: `No ${missing} configured yet — Ultrafast runs will still work, but Fast Mode's "Run test" stays disabled until you add one.`,
      view: "run",
    });
  }
  if (needsReviewLaterCases.length > 0) {
    recommendations.push({
      tag: "REVIEW",
      tone: "warn",
      text: `${needsReviewLaterCases.length} test case(s) were auto-queued below the Ultrafast confidence threshold and still need a human look.`,
      view: "run",
    });
  }
  const pendingDuplicates = duplicateFlags.filter((f: any) => f.resolution === "pending");
  if (pendingDuplicates.length > 0) {
    recommendations.push({
      tag: "DUPLICATE",
      tone: "warn",
      text: `${pendingDuplicates.length} possible duplicate test case(s) detected and awaiting resolution.`,
      view: "library",
    });
  }
  if (flakyTests.length > 0) {
    recommendations.push({
      tag: "FLAKY",
      tone: "warn",
      text: `${flakyTests.length} test(s) show inconsistent pass/fail results across runs — investigate before release.`,
      view: "reports",
    });
  }
  if (coverage && coverage.coveragePercent < 70) {
    recommendations.push({
      tag: "GAP",
      tone: "bad",
      text: `Requirement coverage is at ${coverage.coveragePercent}% — some referenced tickets have no approved test case.`,
      view: "run",
    });
  }
  if (coverageGaps.length > 0) {
    recommendations.push({
      tag: "SCREEN GAP",
      tone: "bad",
      text: `${coverageGaps.length} screen(s) have no test cases, or only stale ones not re-approved in 90+ days.`,
      view: "library",
    });
  }
  const healFlags = testCases.filter((t: any) => t.flagged_for_re_review);
  if (healFlags.length > 0) {
    recommendations.push({
      tag: "LOCATOR",
      tone: "warn",
      text: `${healFlags.length} test case(s) flagged for re-review after a self-healing change.`,
      view: "library",
    });
  }
  if (dashboard && dashboard.totalRuns > 0 && dashboard.passRate < 50) {
    recommendations.push({
      tag: "FAILURES",
      tone: "bad",
      text: `Execution success rate is ${dashboard.passRate}% over ${dashboard.totalRuns} run(s) — worth a look before trusting the suite.`,
      view: "run",
    });
  }

  const activity: { text: string; at: string }[] = [];
  for (const i of inputs.slice(-5)) activity.push({ text: `Input added: ${i.type}`, at: i.created_at });
  for (const s of scripts.slice(-5)) activity.push({ text: `Script generated: ${s.file_path.split(/[\\/]/).pop()}`, at: s.created_at });
  for (const r of runs.slice(0, 5)) activity.push({ text: `Run ${r.status}: ${r.id}`, at: r.created_at });
  activity.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="font-display text-xl tracking-tight">Home</h2>
          <p className="text-sm text-ink/60">Your personal QA workspace</p>
        </div>
        <button
          className="rounded-md bg-signal text-white px-4 py-2 text-sm font-medium hover:bg-signal/90"
          onClick={() => setView("run")}
        >
          {uploadDone ? "Go to Run →" : "Start a run →"}
        </button>
      </div>

      <div className="rounded-lg border border-line bg-white/60 shadow-panel p-5">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink/60 mb-4">Project progress</p>
        <div className="flex items-center">
          {STEPS.map((step, idx) => (
            <div key={step} className="flex items-center flex-1 last:flex-none">
              <div className="flex flex-col items-center gap-1">
                <div
                  className={`h-8 w-8 rounded-full flex items-center justify-center text-xs font-display border ${
                    idx <= activeIdx ? "bg-signal text-white border-signal" : "bg-white text-ink/40 border-line"
                  }`}
                >
                  {idx + 1}
                </div>
                <span className={`text-xs ${idx <= activeIdx ? "text-ink" : "text-ink/40"}`}>{step}</span>
              </div>
              {idx < STEPS.length - 1 && (
                <div className={`flex-1 h-px mx-2 ${idx < activeIdx ? "bg-signal" : "bg-line"}`} />
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">Pass rate / time saved window (FR-6.1)</p>
        <div className="flex items-center rounded-full border border-line bg-white/60 p-0.5 text-xs">
          {RANGE_PRESETS.map((p) => (
            <button
              key={p.key}
              className={`rounded-full px-3 py-1 font-medium ${rangePreset === p.key ? "bg-ink text-paper" : "text-ink/60"}`}
              onClick={() => setRangePreset(p.key)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-5">
        <StatTile label="Tests generated" value={String(testCases.length)} />
        <StatTile label="Automation coverage" value={`${automationCoverage}%`} sub={`${withScript}/${testCases.length} test cases`} />
        <StatTile label="Execution success rate" value={dashboard ? `${dashboard.passRate}%` : "—"} sub={dashboard ? `${dashboard.totalRuns} run(s)` : "no runs yet"} />
        <StatTile label="AI confidence" value={`${avgConfidence}%`} />
        <StatTile
          label="Time saved"
          value={hoursSaved ? `${hoursSaved.hoursSaved}h` : "—"}
          sub={hoursSaved?.isPeriodBreakdown ? "for selected window" : "all time"}
        />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-line bg-white/60 shadow-panel p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">AI recommendations</p>
            {recommendations.length > 0 && <Pill tone="neutral">{recommendations.length}</Pill>}
          </div>
          {recommendations.length === 0 ? (
            <p className="text-sm text-ink/50">No issues detected — everything looks healthy.</p>
          ) : (
            <div className="space-y-2">
              {recommendations.map((r, idx) => {
                const content = (
                  <>
                    <Pill tone={r.tone}>{r.tag}</Pill>
                    <span className="text-ink/70 flex-1">{r.text}</span>
                    {r.view && <span className="text-ink/30 text-xs shrink-0">→</span>}
                  </>
                );
                return r.view ? (
                  <button
                    key={idx}
                    className="w-full flex items-start gap-2 rounded-md border border-line bg-white/50 p-2 text-sm text-left hover:bg-ink/5 hover:border-ink/20 transition-colors"
                    onClick={() => setView(r.view as View)}
                  >
                    {content}
                  </button>
                ) : (
                  <div key={idx} className="flex items-start gap-2 rounded-md border border-line bg-white/50 p-2 text-sm">
                    {content}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="rounded-lg border border-line bg-white/60 shadow-panel p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink/60 mb-3">Recent activity</p>
          {activity.length === 0 ? (
            <p className="text-sm text-ink/50">No activity yet — add an input to get started.</p>
          ) : (
            <ul className="space-y-2 text-sm text-ink/70">
              {activity.slice(0, 8).map((a, idx) => (
                <li key={idx} className="flex items-center justify-between gap-2 border-b border-line/50 pb-1">
                  <span>{a.text}</span>
                  <span className="text-xs text-ink/40">{new Date(a.at).toLocaleString()}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
