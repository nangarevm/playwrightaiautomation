// Fast Mode Tuning Service
// Intelligent test selection and parallel execution optimization

import { db } from "../db.js";

export type SpeedMode = "balanced" | "performance" | "thorough" | "custom";
export type ExecutionStrategy = "all-tests" | "critical-path" | "smoke-only" | "custom-selection";

export interface FastModeConfig {
  mode: SpeedMode;
  strategy: ExecutionStrategy;
  parallelWorkers: number;
  testSelectionPercentage: number;  // 0-100
  prioritizeSmoke: boolean;
  prioritizeCritical: boolean;
  timeoutSeconds: number;
  resourceLimit: "low" | "medium" | "high";
  estimatedDurationSeconds?: number;
  estimatedCost?: number;
}

export interface TestSelection {
  totalTests: number;
  selectedTests: number;
  skippedTests: number;
  selectionPercentage: number;
  selectedByCategory: Record<string, number>;
  priorityScore: number;  // 0-100, higher = more important
}

export interface ParallelExecutionPlan {
  parallelWorkers: number;
  cpuCores: number;
  memoryGbAvailable: number;
  testsPerWorker: number;
  estimatedDurationSeconds: number;
  expectedSpeedup: number;  // vs sequential
}

export interface FastModeProfile {
  name: SpeedMode;
  description: string;
  testSelectionPercent: number;
  parallelWorkers: number;
  expectedSpeedup: number;
  coveragePercent: number;
  costMultiplier: number;
  recommendedFor: string[];
}

// Predefined Fast Mode profiles
const FAST_MODE_PROFILES: Record<SpeedMode, FastModeProfile> = {
  balanced: {
    name: "balanced",
    description: "Balance between speed and coverage",
    testSelectionPercent: 70,
    parallelWorkers: 4,
    expectedSpeedup: 3.5,
    coveragePercent: 85,
    costMultiplier: 0.5,
    recommendedFor: ["CI/CD pipelines", "Daily regressions", "Feature development"],
  },
  performance: {
    name: "performance",
    description: "Maximum speed, reduced coverage",
    testSelectionPercent: 40,
    parallelWorkers: 8,
    expectedSpeedup: 6.5,
    coveragePercent: 65,
    costMultiplier: 0.25,
    recommendedFor: ["Quick feedback loops", "Pull request checks", "Development"],
  },
  thorough: {
    name: "thorough",
    description: "Maximum coverage, slower execution",
    testSelectionPercent: 100,
    parallelWorkers: 4,
    expectedSpeedup: 3.5,
    coveragePercent: 95,
    costMultiplier: 1.0,
    recommendedFor: ["Pre-release testing", "Weekly runs", "Production validation"],
  },
  custom: {
    name: "custom",
    description: "User-defined configuration",
    testSelectionPercent: 70,
    parallelWorkers: 4,
    expectedSpeedup: 3.5,
    coveragePercent: 85,
    costMultiplier: 0.5,
    recommendedFor: ["Advanced users", "Custom requirements"],
  },
};

/**
 * Gets default Fast Mode configuration
 */
export function getDefaultFastModeConfig(mode: SpeedMode = "balanced"): FastModeConfig {
  const profile = FAST_MODE_PROFILES[mode];

  return {
    mode,
    strategy: mode === "performance" ? "smoke-only" : mode === "thorough" ? "all-tests" : "critical-path",
    parallelWorkers: profile.parallelWorkers,
    testSelectionPercentage: profile.testSelectionPercent,
    prioritizeSmoke: true,
    prioritizeCritical: true,
    timeoutSeconds: mode === "performance" ? 30 : mode === "thorough" ? 120 : 60,
    resourceLimit: mode === "performance" ? "high" : mode === "thorough" ? "low" : "medium",
  };
}

/**
 * Selects tests based on strategy
 */
export function selectTests(
  allTests: any[],
  strategy: ExecutionStrategy,
  selectionPercentage: number
): TestSelection {
  let selectedIds: string[] = [];
  let selectedByCategory: Record<string, number> = {};

  switch (strategy) {
    case "smoke-only":
      // Select only smoke tests
      selectedIds = allTests
        .filter((t) => t.category === "Smoke")
        .map((t) => t.id);
      break;

    case "critical-path":
      // Select smoke + critical functional tests
      selectedIds = allTests
        .filter((t) => t.category === "Smoke" || (t.category === "Functional" && t.critical_path))
        .map((t) => t.id);
      break;

    case "all-tests":
      // Select all tests
      selectedIds = allTests.map((t) => t.id);
      break;

    case "custom-selection":
      // Select based on percentage
      const testsToSelect = Math.ceil((allTests.length * selectionPercentage) / 100);
      // Prioritize by: Smoke > Critical > Functional > Others
      const sorted = allTests.sort((a, b) => {
        const priorityA = getPriorityScore(a);
        const priorityB = getPriorityScore(b);
        return priorityB - priorityA;
      });
      selectedIds = sorted.slice(0, testsToSelect).map((t) => t.id);
      break;
  }

  // Count by category
  for (const test of allTests.filter((t) => selectedIds.includes(t.id))) {
    selectedByCategory[test.category] = (selectedByCategory[test.category] || 0) + 1;
  }

  // Calculate priority score
  const priorityScore = (selectedIds.length / allTests.length) * 100;

  return {
    totalTests: allTests.length,
    selectedTests: selectedIds.length,
    skippedTests: allTests.length - selectedIds.length,
    selectionPercentage: (selectedIds.length / allTests.length) * 100,
    selectedByCategory,
    priorityScore,
  };
}

/**
 * Calculates priority score for a test
 */
function getPriorityScore(test: any): number {
  let score = 0;

  // Category priority
  if (test.category === "Smoke") score += 100;
  else if (test.category === "Functional") score += 60;
  else if (test.category === "Regression") score += 40;
  else score += 20;

  // Critical path priority
  if (test.critical_path) score += 50;

  // Owner priority
  if (test.owner_user_id) score += 10;

  // Last run status
  if (test.last_run_status === "passed") score += 5;
  if (test.last_run_status === "failed") score += 15; // Rerun failures more often

  return score;
}

/**
 * Optimizes parallel execution
 */
export function optimizeParallelExecution(
  testCount: number,
  resourceLimit: "low" | "medium" | "high",
  availableCpuCores: number = 8
): ParallelExecutionPlan {
  let parallelWorkers = 1;
  let memoryPerWorker = 512; // MB

  switch (resourceLimit) {
    case "high":
      // Use all available cores
      parallelWorkers = Math.min(availableCpuCores, testCount);
      memoryPerWorker = 256; // MB per worker, 2GB+ total
      break;

    case "medium":
      // Use half cores
      parallelWorkers = Math.min(Math.ceil(availableCpuCores / 2), testCount);
      memoryPerWorker = 512; // MB per worker, 1-2GB total
      break;

    case "low":
      // Conservative approach
      parallelWorkers = Math.min(2, Math.ceil(availableCpuCores / 4));
      memoryPerWorker = 1024; // MB per worker, 2-3GB total
      break;
  }

  const testsPerWorker = Math.ceil(testCount / parallelWorkers);
  const timePerTest = 5; // seconds average
  const baselineSequentialTime = testCount * timePerTest;
  const parallelTime = testsPerWorker * timePerTest + 30; // 30s overhead
  const speedup = baselineSequentialTime / parallelTime;

  return {
    parallelWorkers,
    cpuCores: availableCpuCores,
    memoryGbAvailable: (parallelWorkers * memoryPerWorker) / 1024,
    testsPerWorker,
    estimatedDurationSeconds: parallelTime,
    expectedSpeedup: speedup,
  };
}

/**
 * Estimates execution parameters for Fast Mode
 */
export function estimateFastModeExecution(
  config: FastModeConfig,
  testCount: number,
  baseCost: number
): {
  estimatedTests: number;
  estimatedDuration: number;
  estimatedCost: number;
  speedupVsNormal: number;
  costSavings: number;
} {
  const profile = FAST_MODE_PROFILES[config.mode];

  const estimatedTests = Math.round((testCount * profile.testSelectionPercent) / 100);
  const executionPlan = optimizeParallelExecution(estimatedTests, config.resourceLimit);

  const estimatedDuration = executionPlan.estimatedDurationSeconds;
  const estimatedCost = baseCost * profile.costMultiplier;
  const speedupVsNormal = executionPlan.expectedSpeedup;
  const costSavings = baseCost - estimatedCost;

  return {
    estimatedTests,
    estimatedDuration,
    estimatedCost,
    speedupVsNormal,
    costSavings,
  };
}

/**
 * Recommends Fast Mode configuration
 */
export function recommendFastModeConfig(context: {
  timeConstraint?: "urgent" | "normal" | "relaxed";
  costConstraint?: "tight" | "normal" | "loose";
  coverageMinimum?: number; // percentage
}): FastModeConfig {
  let mode: SpeedMode = "balanced";

  if (context.timeConstraint === "urgent") {
    mode = context.costConstraint === "loose" ? "performance" : "balanced";
  } else if (context.timeConstraint === "relaxed" && context.coverageMinimum !== undefined && context.coverageMinimum > 90) {
    mode = "thorough";
  }

  return getDefaultFastModeConfig(mode);
}

/**
 * Gets all available Fast Mode profiles
 */
export function getAllFastModeProfiles(): FastModeProfile[] {
  return Object.values(FAST_MODE_PROFILES);
}

/**
 * Compares two Fast Mode configurations
 */
export function compareFastModeConfigs(
  config1: FastModeConfig,
  config2: FastModeConfig,
  baselines: { testCount: number; baseCost: number; baseDuration: number }
): Record<string, any> {
  const est1 = estimateFastModeExecution(config1, baselines.testCount, baselines.baseCost);
  const est2 = estimateFastModeExecution(config2, baselines.testCount, baselines.baseCost);

  return {
    config1: {
      mode: config1.mode,
      tests: est1.estimatedTests,
      duration: est1.estimatedDuration,
      cost: est1.estimatedCost,
      speedup: est1.speedupVsNormal,
    },
    config2: {
      mode: config2.mode,
      tests: est2.estimatedTests,
      duration: est2.estimatedDuration,
      cost: est2.estimatedCost,
      speedup: est2.speedupVsNormal,
    },
    differences: {
      testsDifference: est2.estimatedTests - est1.estimatedTests,
      durationDifference: est2.estimatedDuration - est1.estimatedDuration,
      costDifference: est2.estimatedCost - est1.estimatedCost,
      speedupDifference: est2.speedupVsNormal - est1.speedupVsNormal,
    },
  };
}

/**
 * Records Fast Mode execution
 */
export function recordFastModeExecution(
  runId: string,
  config: FastModeConfig,
  results: {
    actualTests: number;
    actualDuration: number;
    actualCost: number;
    testsPassed: number;
    testsFailed: number;
  }
): void {
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO fast_mode_executions (
      id, run_id, mode, strategy, parallel_workers, test_selection_percent,
      actual_tests, actual_duration_seconds, actual_cost,
      tests_passed, tests_failed, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `fm-${runId}-${Date.now()}`,
    runId,
    config.mode,
    config.strategy,
    config.parallelWorkers,
    config.testSelectionPercentage,
    results.actualTests,
    results.actualDuration,
    results.actualCost,
    results.testsPassed,
    results.testsFailed,
    now
  );
}

/**
 * Gets Fast Mode execution statistics
 */
export function getFastModeStats(daysBack: number = 30): {
  totalRuns: number;
  avgDurationReduction: number;
  avgCostReduction: number;
  avgTestCoverage: number;
  avgPassRate: number;
} {
  const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();

  const rows = db.prepare(`
    SELECT 
      COUNT(*) as total_runs,
      AVG((actual_duration_seconds / 300)) as avg_duration_ratio,  -- 300s baseline
      AVG((test_selection_percent / 100)) as avg_coverage,
      AVG((tests_passed / (tests_passed + tests_failed))) as avg_pass_rate
    FROM fast_mode_executions
    WHERE created_at >= ?
  `).get(since) as any;

  const totalRuns = rows?.total_runs || 0;
  const avgDurationReduction = rows?.avg_duration_ratio
    ? Math.round((1 - rows.avg_duration_ratio) * 100)
    : 0;
  const avgCostReduction = Math.round(avgDurationReduction * 0.8); // Cost correlates with duration
  const avgTestCoverage = rows?.avg_coverage ? Math.round(rows.avg_coverage * 100) : 0;
  const avgPassRate = rows?.avg_pass_rate ? Math.round(rows.avg_pass_rate * 100) : 0;

  return {
    totalRuns,
    avgDurationReduction,
    avgCostReduction,
    avgTestCoverage,
    avgPassRate,
  };
}
