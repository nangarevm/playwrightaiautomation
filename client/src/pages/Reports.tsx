import { useApp } from "../context/AppState.js";
import { Pill } from "../components/Pill.js";
import { StatTile } from "../components/StatTile.js";
import { api } from "../api.js";

export default function Reports() {
  const { testCases, scripts, dashboard, hoursSaved, flakyTests, withBusy } = useApp();

  const withScript = testCases.filter((t) => scripts.some((s) => s.test_case_id === t.id)).length;
  const automationCoverage = testCases.length > 0 ? Math.round((withScript / testCases.length) * 100) : 0;
  const avgConfidence =
    testCases.length > 0
      ? Math.round((testCases.reduce((sum, t) => sum + (t.confidence_score ?? 0), 0) / testCases.length) * 100)
      : 0;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-xl tracking-tight">Reports</h2>
        <p className="text-sm text-ink/60">Release-ready summary and exports</p>
      </div>

      <div className="grid gap-3 md:grid-cols-5">
        <StatTile label="Tests generated" value={String(testCases.length)} />
        <StatTile label="Automation coverage" value={`${automationCoverage}%`} />
        <StatTile label="Execution success rate" value={dashboard ? `${dashboard.passRate}%` : "—"} />
        <StatTile label="AI confidence" value={`${avgConfidence}%`} />
        <StatTile label="Time saved" value={hoursSaved ? `${hoursSaved.hoursSaved}h` : "—"} />
      </div>

      <div className="flex flex-wrap gap-2">
        <button className="rounded-md border border-signal text-signal px-3 py-1.5 text-sm font-medium hover:bg-signal-soft" onClick={() => withBusy("export-pdf", api.exportReleaseReportPdf)}>
          Export PDF
        </button>
        <button className="rounded-md border border-signal text-signal px-3 py-1.5 text-sm font-medium hover:bg-signal-soft" onClick={() => withBusy("export-report-xlsx", api.exportReleaseReportXlsx)}>
          Export XLSX
        </button>
      </div>

      <div className="rounded-lg border border-line bg-white/60 shadow-panel p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink/60 mb-2">Flaky tests</p>
        {flakyTests.length === 0 ? (
          <p className="text-sm text-ink/50">None detected.</p>
        ) : (
          <div className="space-y-1 text-xs text-ink/70">
            {flakyTests.map((f) => (
              <div key={f.scriptId} className="flex items-center justify-between">
                <span className="font-mono text-ink/40">{f.scriptId}</span>
                <Pill tone="warn">
                  {f.passCount} pass / {f.failCount} fail
                </Pill>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
