// Real-time execution event streaming service
// Provides live updates to clients watching test execution

import { EventEmitter } from "events";
import { db } from "../db.js";

export interface ExecutionProgressEvent {
  type: "start" | "test_started" | "test_completed" | "bug_found" | "cost_updated" | "complete" | "error";
  runId: string;
  timestamp: number;
  data?: {
    testName?: string;
    testsPassed?: number;
    testsFailed?: number;
    totalTests?: number;
    bugsFound?: number;
    costAccumulated?: number;
    errorMessage?: string;
    estimatedTimeRemaining?: number;
  };
}

// Global event emitters per run
const runEmitters = new Map<string, EventEmitter>();
const activeRuns = new Set<string>();

/**
 * Start tracking a run for real-time updates
 */
export function startRealtimeTracking(runId: string) {
  if (!runEmitters.has(runId)) {
    runEmitters.set(runId, new EventEmitter());
    activeRuns.add(runId);
  }
}

/**
 * Stop tracking a run
 */
export function stopRealtimeTracking(runId: string) {
  runEmitters.delete(runId);
  activeRuns.delete(runId);
}

/**
 * Get the emitter for a run
 */
export function getRunEmitter(runId: string): EventEmitter | null {
  return runEmitters.get(runId) || null;
}

/**
 * Emit a progress event for a run
 */
export function emitProgress(event: ExecutionProgressEvent) {
  const emitter = runEmitters.get(event.runId);
  if (emitter) {
    emitter.emit("progress", event);
  }
}

/**
 * Get current run progress from database
 */
export function getRunProgress(runId: string): {
  status: string;
  progress: number;
  testsPassed: number;
  testsFailed: number;
  totalTests: number;
  bugsFound: number;
  costAccumulated: number;
  estimatedTimeRemaining: number;
} | null {
  const run = db
    .prepare(
      `SELECT 
        status, 
        COUNT(CASE WHEN passed = 1 THEN 1 END) as tests_passed,
        COUNT(CASE WHEN passed = 0 THEN 1 END) as tests_failed,
        COUNT(*) as total_tests
       FROM execution_runs er
       LEFT JOIN execution_evidence ee ON er.id = ee.run_id
       WHERE er.id = ?
       GROUP BY er.id`
    )
    .get(runId) as any;

  if (!run) return null;

  const bugsFound = db.prepare("SELECT COUNT(*) as count FROM bug_findings WHERE run_id = ?").get(runId) as any;

  // Estimate cost: roughly $0.50 per test on Ultrafast
  const estimatedCostPerTest = 0.5;
  const costAccumulated = (run.total_tests || 0) * estimatedCostPerTest;

  // Estimate remaining time: roughly 30 seconds per test
  const estimatedTimePerTest = 30;
  const remainingTests = (run.total_tests || 0) - (run.tests_passed || 0) - (run.tests_failed || 0);
  const estimatedTimeRemaining = Math.max(0, remainingTests * estimatedTimePerTest);

  return {
    status: run.status,
    progress: run.total_tests ? Math.round(((run.tests_passed + run.tests_failed) / run.total_tests) * 100) : 0,
    testsPassed: run.tests_passed || 0,
    testsFailed: run.tests_failed || 0,
    totalTests: run.total_tests || 0,
    bugsFound: bugsFound.count || 0,
    costAccumulated,
    estimatedTimeRemaining,
  };
}

/**
 * Get all active runs being tracked
 */
export function getActiveRuns(): string[] {
  return Array.from(activeRuns);
}

/**
 * Check if a run is being tracked
 */
export function isRunTracked(runId: string): boolean {
  return activeRuns.has(runId);
}
