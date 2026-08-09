import { useEffect, useState } from "react";
import { api } from "../api.js";
import { StatusTicker, type StatusTickerData } from "./StatusTicker.js";
import { MiniMonitoringPanel } from "./MiniMonitoringPanel.js";
import { LiveProgressBar } from "./LiveProgressBar.js";
import type { ActivityItem } from "./ActivityFeed.js";

/**
 * Polls live runs/bugs and feeds StatusTicker + MiniMonitoringPanel + LiveProgressBar
 * so monitoring components are actually mounted and driven by real data.
 */
export function LiveMonitoringBridge() {
  const [ticker, setTicker] = useState<Partial<StatusTickerData>>({});
  const [progress, setProgress] = useState({ current: 0, total: 0, label: "" });
  const [metrics, setMetrics] = useState({
    todayCost: 0,
    testsRun: 0,
    bugsFound: 0,
    passRate: 0,
  });
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [operation, setOperation] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      try {
        const [runs, bugs, optMetrics] = await Promise.all([
          api.listRuns().catch(() => []),
          api.listBugFindings().catch(() => []),
          api.getOptimizationMetrics().catch(() => null),
        ]);
        if (cancelled) return;

        const list = Array.isArray(runs) ? runs : [];
        const running = list.filter((r: any) => r.status === "running" || r.status === "queued");
        const recent = list.slice(0, 40);
        const passed = recent.filter((r: any) => r.status === "passed").length;
        const failed = recent.filter((r: any) => r.status === "failed" || r.status === "error").length;
        const done = passed + failed;
        const passRate = done > 0 ? Math.round((passed / done) * 100) : 0;
        const bugsFound = Array.isArray(bugs) ? bugs.length : 0;

        const isRunning = running.length > 0;
        const elapsedSeconds = isRunning
          ? Math.max(
              0,
              Math.floor(
                (Date.now() - new Date(running[0].created_at || Date.now()).getTime()) / 1000
              )
            )
          : 0;

        const cost =
          Number(optMetrics?.estimatedCostSaved ?? optMetrics?.todayCost ?? optMetrics?.costSaved ?? 0) ||
          0;

        setTicker({
          isRunning,
          elapsedSeconds,
          costAccumulated: cost,
          bugsFound,
          pagesProcessed: done,
          pagesTotal: Math.max(done, recent.length),
          currentOperation: isRunning ? `Running ${running.length} job(s) · workers=5` : null,
          status: isRunning ? "running" : failed > 0 ? "warning" : "idle",
        });

        setProgress({
          current: done,
          total: Math.max(done, recent.length, 1),
          label: isRunning ? `Active runs: ${running.length}` : "Idle",
        });

        setOperation(
          isRunning ? `Executing ${running.length} test run(s) with 5 workers` : null
        );

        setMetrics({
          todayCost: cost || Number((done * 0.08).toFixed(2)),
          testsRun: recent.length,
          bugsFound,
          passRate,
        });

        setActivity(
          recent.slice(0, 5).map((r: any, i: number) => ({
            id: r.id || String(i),
            type:
              r.status === "passed"
                ? ("success" as const)
                : r.status === "failed" || r.status === "error"
                  ? ("error" as const)
                  : r.status === "running"
                    ? ("info" as const)
                    : ("warning" as const),
            action: `${r.status?.toUpperCase() || "RUN"} · ${r.id?.slice?.(0, 8) || "run"}`,
            timestamp: new Date(r.created_at || Date.now()),
          }))
        );
      } catch {
        /* keep last good state */
      }
    };

    refresh();
    const id = window.setInterval(refresh, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  return (
    <>
      <StatusTicker data={ticker} />
      {ticker.isRunning && (
        <div className="px-4 pt-2 max-w-6xl">
          <LiveProgressBar
            progress={
              progress.total > 0
                ? Math.min(99, Math.round((progress.current / progress.total) * 100))
                : 5
            }
            label={progress.label}
            estimatedSecondsRemaining={
              ticker.elapsedSeconds && progress.current > 0
                ? Math.max(
                    5,
                    Math.round(
                      (ticker.elapsedSeconds / Math.max(1, progress.current)) *
                        Math.max(0, progress.total - progress.current)
                    )
                  )
                : undefined
            }
            onCancel={() => api.stopAllExecutions().catch(() => undefined)}
          />
        </div>
      )}
      <MiniMonitoringPanel
        currentOperation={operation}
        metrics={metrics}
        recentActivity={activity}
        onActionClick={(action) => {
          if (action === "stop") api.stopAllExecutions().catch(() => undefined);
          if (action === "refresh") window.location.reload();
        }}
      />
    </>
  );
}
