import { useState } from "react";
import { CompactMetricsCard } from "./CompactMetricsCard.js";
import { ActivityFeed, type ActivityItem } from "./ActivityFeed.js";

export interface MiniMonitoringPanelProps {
  currentOperation?: string | null;
  metrics?: {
    todayCost: number;
    testsRun: number;
    bugsFound: number;
    passRate: number;
  };
  recentActivity?: ActivityItem[];
  onActionClick?: (action: string) => void;
}

export function MiniMonitoringPanel({
  currentOperation,
  metrics = {
    todayCost: 0,
    testsRun: 0,
    bugsFound: 0,
    passRate: 0,
  },
  recentActivity = [],
  onActionClick,
}: MiniMonitoringPanelProps) {
  const [isExpanded, setIsExpanded] = useState(true);

  return (
    <div className="fixed bottom-6 right-6 w-80 z-50 shadow-lg rounded-lg border border-line bg-white">
      {/* Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between gap-2 px-4 py-3 hover:bg-gray-50 transition-colors border-b border-line"
      >
        <div className="flex items-center gap-2">
          <span className="text-lg">📊</span>
          <span className="font-semibold text-sm">Monitoring</span>
        </div>
        <span className="text-lg">{isExpanded ? "−" : "+"}</span>
      </button>

      {isExpanded && (
        <>
          {/* Current Operation */}
          {currentOperation && (
            <div className="px-4 py-3 border-b border-line/70 bg-signal/5">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-ink/60 mb-1">
                Current
              </p>
              <p className="text-sm font-medium text-signal truncate">
                {currentOperation}
              </p>
            </div>
          )}

          {/* Quick Metrics */}
          <div className="p-3 border-b border-line/70 space-y-2">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-ink/60">
              Today's Summary
            </p>
            <div className="grid grid-cols-2 gap-2">
              <CompactMetricsCard
                icon="💰"
                label="Cost"
                value={metrics.todayCost.toFixed(2)}
                unit="$"
              />
              <CompactMetricsCard
                icon="✓"
                label="Tests"
                value={metrics.testsRun}
                unit="run"
              />
              <CompactMetricsCard
                icon="🐛"
                label="Bugs"
                value={metrics.bugsFound}
              />
              <CompactMetricsCard
                icon="📊"
                label="Pass Rate"
                value={metrics.passRate}
                unit="%"
              />
            </div>
          </div>

          {/* Quick Actions */}
          <div className="px-3 py-2 border-b border-line/70 flex gap-2">
            <button
              onClick={() => onActionClick?.("pause")}
              className="flex-1 text-xs px-2 py-1.5 rounded border border-line hover:border-ink/30 hover:bg-gray-50 transition-colors"
            >
              ⏸ Pause
            </button>
            <button
              onClick={() => onActionClick?.("refresh")}
              className="flex-1 text-xs px-2 py-1.5 rounded border border-line hover:border-ink/30 hover:bg-gray-50 transition-colors"
            >
              🔄 Refresh
            </button>
            <button
              onClick={() => onActionClick?.("stop")}
              className="flex-1 text-xs px-2 py-1.5 rounded border border-alert/30 text-alert hover:bg-red-50 transition-colors"
            >
              ⏹ Stop
            </button>
          </div>

          {/* Recent Activity */}
          {recentActivity.length > 0 && (
            <div className="p-3 space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-ink/60">
                Recent Activity
              </p>
              <ActivityFeed items={recentActivity} maxItems={3} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
