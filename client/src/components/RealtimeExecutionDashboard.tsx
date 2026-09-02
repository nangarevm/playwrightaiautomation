// Real-Time Execution Dashboard Component
// Live progress tracking for Ultrafast Mode
// Part of Feature 1: Real-Time Execution Dashboard

import { useEffect, useState } from "react";

interface ExecutionProgress {
  runId: string;
  status: "running" | "paused" | "completed" | "failed";
  totalTests: number;
  completedTests: number;
  currentTestName?: string;
  bugsFoundCount: number;
  estimatedTimeRemaining?: number;
  costSoFar?: number;
  startedAt: number;
}

interface RealtimeBug {
  bugId: string;
  severity: "critical" | "high" | "medium" | "low";
  title: string;
  category: string;
  timestamp: number;
}

const getSeverityColor = (severity: string): string => {
  switch (severity) {
    case "critical":
      return "text-red-600 bg-red-50";
    case "high":
      return "text-orange-600 bg-orange-50";
    case "medium":
      return "text-yellow-600 bg-yellow-50";
    case "low":
      return "text-blue-600 bg-blue-50";
    default:
      return "text-gray-600 bg-gray-50";
  }
};

const formatDuration = (ms?: number): string => {
  if (!ms) return "--";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return `${hours}h`;
};

export interface RealtimeExecutionDashboardProps {
  runId: string;
  onComplete?: (progress: ExecutionProgress) => void;
}

export function RealtimeExecutionDashboard({
  runId,
  onComplete,
}: RealtimeExecutionDashboardProps) {
  const [progress, setProgress] = useState<ExecutionProgress | null>(null);
  const [bugs, setBugs] = useState<RealtimeBug[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Connect to SSE stream
    const eventSource = new EventSource(`/api/execution/live/${runId}`);

    eventSource.onopen = () => {
      setIsConnected(true);
      setError(null);
    };

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        switch (data.type) {
          case "progress_update":
            setProgress(data.data);
            break;

          case "bug_found":
            setBugs((prev) => [
              {
                bugId: data.data.bugId,
                severity: data.data.severity,
                title: data.data.title,
                category: data.data.category,
                timestamp: data.data.foundAt,
              },
              ...prev,
            ]);
            break;

          case "execution_completed":
            setProgress(data.data);
            onComplete?.(data.data);
            eventSource.close();
            break;

          case "execution_failed":
            setProgress(data.data);
            setError(data.data.error || "Execution failed");
            eventSource.close();
            break;
        }
      } catch (e) {
        // Comment or log silently to avoid cluttering
      }
    };

    eventSource.onerror = () => {
      setIsConnected(false);
      setError("Connection lost");
      eventSource.close();
    };

    return () => eventSource.close();
  }, [runId, onComplete]);

  if (!progress) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-ink"></div>
          <p className="mt-4 text-sm text-ink/60">Connecting to execution...</p>
        </div>
      </div>
    );
  }

  const progressPercent = Math.round(
    (progress.completedTests / progress.totalTests) * 100
  );
  const statusColors =
    progress.status === "completed"
      ? "bg-green-100 text-green-700"
      : progress.status === "failed"
        ? "bg-red-100 text-red-700"
        : progress.status === "paused"
          ? "bg-yellow-100 text-yellow-700"
          : "bg-blue-100 text-blue-700";

  return (
    <div className="space-y-6 p-6 bg-white rounded-lg border border-line shadow-panel">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="font-medium text-lg">Real-Time Execution</h2>
        <span
          className={`px-3 py-1 rounded-full text-xs font-medium ${statusColors}`}
        >
          {progress.status.toUpperCase()}
        </span>
      </div>

      {error && (
        <div className="p-3 rounded-md border border-alert bg-alert/5 text-xs text-alert">
          {error}
        </div>
      )}

      {/* Progress Bar */}
      <div className="space-y-2">
        <div className="flex justify-between items-center text-xs">
          <span className="text-ink/70">Tests Completed</span>
          <span className="font-medium">
            {progress.completedTests}/{progress.totalTests}
          </span>
        </div>
        <div className="w-full bg-line rounded-full h-2 overflow-hidden">
          <div
            className="h-full bg-signal transition-all duration-300"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
        <div className="text-xs text-ink/50 text-right">
          {progressPercent}% complete
        </div>
      </div>

      {/* Current Test */}
      {progress.currentTestName && (
        <div className="p-3 rounded-md border border-line/70 bg-ink/[0.02]">
          <p className="text-xs text-ink/60">Currently Testing</p>
          <p className="text-sm font-medium text-ink truncate mt-1">
            {progress.currentTestName}
          </p>
        </div>
      )}

      {/* Time & Cost */}
      <div className="grid grid-cols-3 gap-3">
        <div className="p-3 rounded-md border border-line/70 bg-white">
          <p className="text-xs text-ink/60">Elapsed</p>
          <p className="text-sm font-medium mt-1">
            {formatDuration(Date.now() - progress.startedAt)}
          </p>
        </div>
        <div className="p-3 rounded-md border border-line/70 bg-white">
          <p className="text-xs text-ink/60">Remaining</p>
          <p className="text-sm font-medium mt-1">
            {formatDuration(progress.estimatedTimeRemaining)}
          </p>
        </div>
        <div className="p-3 rounded-md border border-line/70 bg-white">
          <p className="text-xs text-ink/60">Cost So Far</p>
          <p className="text-sm font-medium mt-1">
            ${progress.costSoFar ? progress.costSoFar.toFixed(2) : "0.00"}
          </p>
        </div>
      </div>

      {/* Bug Ticker */}
      {bugs.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-ink/70">
              Bugs Found: {progress.bugsFoundCount}
            </p>
          </div>
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {bugs.slice(0, 5).map((bug) => (
              <div
                key={bug.bugId}
                className={`p-2 rounded text-xs border border-current/20 ${getSeverityColor(bug.severity)}`}
              >
                <div className="font-medium">{bug.severity.toUpperCase()}</div>
                <div className="text-current/70 truncate">{bug.title}</div>
              </div>
            ))}
            {bugs.length > 5 && (
              <div className="p-2 text-xs text-ink/60 text-center">
                +{bugs.length - 5} more bugs
              </div>
            )}
          </div>
        </div>
      )}

      {/* Controls */}
      {progress.status === "running" && (
        <div className="flex gap-2 pt-2 border-t border-line/70">
          <button className="flex-1 px-3 py-1.5 rounded text-xs font-medium bg-ink/10 text-ink hover:bg-ink/20">
            Pause
          </button>
          <button className="flex-1 px-3 py-1.5 rounded text-xs font-medium bg-alert/10 text-alert hover:bg-alert/20">
            Stop
          </button>
        </div>
      )}

      {progress.status === "paused" && (
        <button className="w-full px-3 py-1.5 rounded text-xs font-medium bg-ink text-paper hover:bg-ink/90">
          Resume
        </button>
      )}

      {/* Connection Status */}
      <div className="text-xs text-ink/40 flex items-center justify-center gap-1">
        <span
          className={`inline-block w-1.5 h-1.5 rounded-full ${isConnected ? "bg-signal" : "bg-alert"}`}
        ></span>
        {isConnected ? "Connected" : "Disconnected"}
      </div>
    </div>
  );
}
