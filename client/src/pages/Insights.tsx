import { useEffect, useState } from "react";
import { useApp } from "../context/AppState.js";
import { Pill } from "../components/Pill.js";
import { api } from "../api.js";

interface LlmUsageSummary {
  total_calls: number;
  cache_hits: number;
  cache_hit_rate_pct: number;
  total_cost_usd: number;
  total_cost_without_optimization_usd: number;
  savings_usd: number;
  savings_pct: number;
  calls_by_model_tier: Record<string, number>;
}

export default function Insights() {
  const { coverage, dashboard, flakyTests, testCases } = useApp();
  const [llmUsage, setLlmUsage] = useState<LlmUsageSummary | null>(null);

  useEffect(() => {
    api.getLlmUsage().then(setLlmUsage).catch(() => setLlmUsage(null));
  }, []);

  const avgConfidence =
    testCases.length > 0
      ? Math.round((testCases.reduce((sum, t) => sum + (t.confidence_score ?? 0), 0) / testCases.length) * 100)
      : 0;
  const passRate = dashboard?.passRate ?? 0;
  const coveragePercent = coverage?.coveragePercent ?? 0;
  const readiness = Math.round(passRate * 0.4 + coveragePercent * 0.35 + avgConfidence * 0.25);
  const onTrack = readiness >= 70;

  const riskAreas: { area: string; level: "HIGH" | "MEDIUM" }[] = [];
  if (flakyTests.length > 0) riskAreas.push({ area: `${flakyTests.length} flaky test(s)`, level: "HIGH" });
  if (dashboard && dashboard.totals?.failed > 0) riskAreas.push({ area: `${dashboard.totals.failed} failed run(s)`, level: "HIGH" });
  if (coveragePercent < 70 && coverage) riskAreas.push({ area: "Requirement coverage below target", level: "MEDIUM" });

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-xl tracking-tight">Insights</h2>
        <p className="text-sm text-ink/60">Coverage gaps, risk analysis, and release readiness</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-line bg-white/60 shadow-panel p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">Coverage gaps</p>
          {coverage ? (
            <>
              <p className="mt-2 text-2xl font-display">{coverage.coveragePercent}%</p>
              <p className="text-xs text-ink/50 mt-1">
                {coverage.coveredByApprovedTestCase} of {coverage.totalTicketsReferenced} referenced ticket(s) have an approved test case
              </p>
              {coverage.coveragePercent < 70 ? (
                <p className="mt-3 text-sm text-alert">
                  Coverage is below the 70% target — {coverage.totalTicketsReferenced - coverage.coveredByApprovedTestCase} ticket(s) still need
                  an approved test case before release.
                </p>
              ) : (
                <p className="mt-3 text-sm text-signal">Coverage looks healthy.</p>
              )}
            </>
          ) : (
            <p className="mt-2 text-sm text-ink/50">No coverage data yet.</p>
          )}
        </div>

        <div className="rounded-lg border border-line bg-white/60 shadow-panel p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">Risk analysis</p>
          {riskAreas.length === 0 ? (
            <p className="mt-2 text-sm text-ink/50">No elevated risk areas detected.</p>
          ) : (
            <div className="mt-2 space-y-2">
              {riskAreas.map((r, idx) => (
                <div key={idx} className="flex items-center justify-between gap-2 rounded-md border border-line bg-white/50 p-2 text-sm">
                  <span>{r.area}</span>
                  <Pill tone={r.level === "HIGH" ? "bad" : "warn"}>{r.level}</Pill>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="rounded-lg border border-line bg-white/60 shadow-panel p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">LLM usage &amp; cost (FR-6.10)</p>
        {llmUsage ? (
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <p className="text-2xl font-display">{llmUsage.total_calls}</p>
              <p className="text-xs text-ink/50">Generation calls</p>
            </div>
            <div>
              <p className="text-2xl font-display">{llmUsage.cache_hit_rate_pct.toFixed(0)}%</p>
              <p className="text-xs text-ink/50">Cache hit rate ({llmUsage.cache_hits} hits, FR-9.5)</p>
            </div>
            <div>
              <p className="text-2xl font-display">${llmUsage.total_cost_usd.toFixed(4)}</p>
              <p className="text-xs text-ink/50">Actual cost incurred</p>
            </div>
            <div>
              <p className="text-2xl font-display text-signal">{llmUsage.savings_pct.toFixed(0)}%</p>
              <p className="text-xs text-ink/50">
                Saved vs. no optimization (${llmUsage.savings_usd.toFixed(4)})
              </p>
            </div>
            <div className="col-span-2 sm:col-span-4 flex gap-4 text-xs text-ink/60">
              <span>Model routing (FR-9.7):</span>
              {Object.entries(llmUsage.calls_by_model_tier).map(([tier, count]) => (
                <Pill key={tier} tone={tier === "economy" ? "good" : undefined}>{tier}: {count}</Pill>
              ))}
            </div>
          </div>
        ) : (
          <p className="mt-2 text-sm text-ink/50">No LLM usage recorded yet.</p>
        )}
      </div>

      <div className="rounded-lg border border-line bg-white/60 shadow-panel p-5">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink/60">Release readiness</p>
        <div className="mt-3 flex items-center gap-4">
          <p className="font-display text-4xl">{readiness}</p>
          <Pill tone={onTrack ? "good" : "bad"}>{onTrack ? "On track for release" : "At risk"}</Pill>
        </div>
        <p className="mt-2 text-xs text-ink/50">
          Composite score from pass rate ({passRate}%), coverage ({coveragePercent}%), and AI confidence ({avgConfidence}%).
        </p>
      </div>
    </div>
  );
}
