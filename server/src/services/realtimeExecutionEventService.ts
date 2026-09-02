// Real-Time Execution Events Service
// Manages real-time updates for Ultrafast Mode execution
// Part of Feature 1: Real-Time Execution Dashboard

import { EventEmitter } from "events";

export interface ExecutionProgress {
  runId: string;
  status: "running" | "paused" | "completed" | "failed";
  totalTests: number;
  completedTests: number;
  currentTestName?: string;
  bugsFoundCount: number;
  estimatedTimeRemaining?: number; // milliseconds
  costSoFar?: number;
  startedAt: number;
  pausedAt?: number;
}

export interface BugUpdate {
  runId: string;
  bugId: string;
  severity: "critical" | "high" | "medium" | "low";
  title: string;
  category: string;
  foundAt: number;
}

export interface ExecutionEvent {
  type:
    | "progress_update"
    | "bug_found"
    | "test_completed"
    | "execution_paused"
    | "execution_resumed"
    | "execution_completed"
    | "execution_failed";
  timestamp: number;
  runId: string;
  data: any;
}

class RealtimeExecutionEmitter extends EventEmitter {
  private activeRuns: Map<string, ExecutionProgress> = new Map();
  private runClients: Map<string, Set<any>> = new Map(); // runId -> clients

  /**
   * Start tracking a new execution run
   */
  startTracking(runId: string, totalTests: number): void {
    const progress: ExecutionProgress = {
      runId,
      status: "running",
      totalTests,
      completedTests: 0,
      bugsFoundCount: 0,
      startedAt: Date.now(),
    };

    this.activeRuns.set(runId, progress);
    this.runClients.set(runId, new Set());

    this.emitEvent({
      type: "progress_update",
      timestamp: Date.now(),
      runId,
      data: progress,
    });
  }

  /**
   * Update progress for a run
   */
  updateProgress(
    runId: string,
    completedTests: number,
    currentTestName?: string,
    costSoFar?: number
  ): void {
    const progress = this.activeRuns.get(runId);
    if (!progress) return;

    progress.completedTests = completedTests;
    progress.currentTestName = currentTestName;
    if (costSoFar !== undefined) progress.costSoFar = costSoFar;

    // Calculate estimated time remaining
    if (progress.completedTests > 0) {
      const elapsed = Date.now() - progress.startedAt;
      const avgTimePerTest = elapsed / progress.completedTests;
      const remainingTests =
        progress.totalTests - progress.completedTests;
      progress.estimatedTimeRemaining = Math.round(
        avgTimePerTest * remainingTests
      );
    }

    this.emitEvent({
      type: "progress_update",
      timestamp: Date.now(),
      runId,
      data: progress,
    });
  }

  /**
   * Report a bug found during execution
   */
  reportBugFound(
    runId: string,
    bugId: string,
    title: string,
    severity: "critical" | "high" | "medium" | "low",
    category: string
  ): void {
    const progress = this.activeRuns.get(runId);
    if (!progress) return;

    progress.bugsFoundCount++;

    const bugUpdate: BugUpdate = {
      runId,
      bugId,
      severity,
      title,
      category,
      foundAt: Date.now(),
    };

    this.emitEvent({
      type: "bug_found",
      timestamp: Date.now(),
      runId,
      data: bugUpdate,
    });

    // Also emit progress update with new count
    this.emitEvent({
      type: "progress_update",
      timestamp: Date.now(),
      runId,
      data: progress,
    });
  }

  /**
   * Mark execution as completed
   */
  completeExecution(runId: string): void {
    const progress = this.activeRuns.get(runId);
    if (!progress) return;

    progress.status = "completed";

    this.emitEvent({
      type: "execution_completed",
      timestamp: Date.now(),
      runId,
      data: progress,
    });

    // Cleanup after 5 minutes
    setTimeout(() => {
      this.activeRuns.delete(runId);
      this.runClients.delete(runId);
    }, 5 * 60 * 1000);
  }

  /**
   * Mark execution as failed
   */
  failExecution(runId: string, error: string): void {
    const progress = this.activeRuns.get(runId);
    if (!progress) return;

    progress.status = "failed";

    this.emitEvent({
      type: "execution_failed",
      timestamp: Date.now(),
      runId,
      data: { ...progress, error },
    });

    // Cleanup after 5 minutes
    setTimeout(() => {
      this.activeRuns.delete(runId);
      this.runClients.delete(runId);
    }, 5 * 60 * 1000);
  }

  /**
   * Pause execution
   */
  pauseExecution(runId: string): void {
    const progress = this.activeRuns.get(runId);
    if (!progress) return;

    progress.status = "paused";
    progress.pausedAt = Date.now();

    this.emitEvent({
      type: "execution_paused",
      timestamp: Date.now(),
      runId,
      data: progress,
    });
  }

  /**
   * Resume execution
   */
  resumeExecution(runId: string): void {
    const progress = this.activeRuns.get(runId);
    if (!progress) return;

    if (progress.pausedAt) {
      // Add paused time to startedAt to maintain correct elapsed time
      const pausedDuration = Date.now() - progress.pausedAt;
      progress.startedAt += pausedDuration;
      progress.pausedAt = undefined;
    }

    progress.status = "running";

    this.emitEvent({
      type: "execution_resumed",
      timestamp: Date.now(),
      runId,
      data: progress,
    });
  }

  /**
   * Get current progress for a run
   */
  getProgress(runId: string): ExecutionProgress | undefined {
    return this.activeRuns.get(runId);
  }

  /**
   * Get all active runs
   */
  getActiveRuns(): ExecutionProgress[] {
    return Array.from(this.activeRuns.values());
  }

  /**
   * Emit event to all listeners
   */
  private emitEvent(event: ExecutionEvent): void {
    this.emit("execution-event", event);
    this.emit(`run:${event.runId}`, event);
  }

  /**
   * Subscribe to events for a specific run
   */
  subscribeToRun(
    runId: string,
    callback: (event: ExecutionEvent) => void
  ): () => void {
    this.on(`run:${runId}`, callback);
    return () => this.removeListener(`run:${runId}`, callback);
  }

  /**
   * Subscribe to all events
   */
  subscribeToAll(callback: (event: ExecutionEvent) => void): () => void {
    this.on("execution-event", callback);
    return () => this.removeListener("execution-event", callback);
  }
}

// Export singleton instance
export const executionEmitter = new RealtimeExecutionEmitter();

/**
 * Helper to format duration
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return `${hours}h`;
}

/**
 * Helper to get color for severity
 */
export function getSeverityColor(
  severity: "critical" | "high" | "medium" | "low"
): string {
  switch (severity) {
    case "critical":
      return "#DC2626"; // red-600
    case "high":
      return "#F97316"; // orange-500
    case "medium":
      return "#EAB308"; // yellow-400
    case "low":
      return "#3B82F6"; // blue-500
    default:
      return "#6B7280"; // gray-500
  }
}
