import { db } from "../db.js";

export interface ResourceForecast {
  estimatedCpuUsage: number;
  estimatedMemoryUsage: number;
  estimatedNetworkUsage: number;
  estimatedStorageUsage: number;
  executionTime: number;
  confidence: number;
}

export interface AnomalyDetection {
  isAnomaly: boolean;
  anomalyType?: "timeout_spike" | "memory_surge" | "failure_rate_increase" | "cost_spike";
  severity: "low" | "medium" | "high";
  recommendation?: string;
}

export interface OptimizationRecommendation {
  action: string;
  parameter: string;
  reason: string;
  expectedBenefit: string;
  riskLevel: "low" | "medium" | "high";
}

export interface BurndownPrediction {
  completionTime: number;
  estimatedTests: number;
  completedTests: number;
  remainingTests: number;
  testCompletionRate: number;
}

function ensurePredictiveTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS predictive_metrics (
      id TEXT PRIMARY KEY,
      metric_name TEXT UNIQUE,
      value REAL,
      timestamp INTEGER,
      window_days INTEGER DEFAULT 7
    );
    CREATE TABLE IF NOT EXISTS execution_baseline (
      id TEXT PRIMARY KEY,
      test_type TEXT,
      avg_duration REAL,
      std_deviation REAL,
      sample_count INTEGER,
      last_updated INTEGER
    );
    CREATE TABLE IF NOT EXISTS anomaly_detections (
      id TEXT PRIMARY KEY,
      metric TEXT,
      value REAL,
      expected_range_min REAL,
      expected_range_max REAL,
      severity TEXT,
      timestamp INTEGER
    );
  `);
}

export function predictResourceNeeds(
  testSuite: Array<{ id: string; type: string; complexity: number }>
): ResourceForecast {
  try {
    ensurePredictiveTable();

    let totalComplexity = 0;
    for (const test of testSuite) {
      totalComplexity += test.complexity;
    }

    const avgComplexity = testSuite.length > 0 ? totalComplexity / testSuite.length : 0.5;

    const baselineExecution = db.prepare(`
      SELECT * FROM execution_baseline
      LIMIT 10
    `).all() as any[];

    const avgDuration = baselineExecution.length > 0
      ? baselineExecution.reduce((sum, e) => sum + e.avg_duration, 0) / baselineExecution.length
      : 5000;

    const executionTime = (testSuite.length * avgDuration * avgComplexity) / 1000;

    const cpuUsage = Math.min(1, 0.3 + avgComplexity * 0.5);
    const memoryUsage = testSuite.length * 50 + avgComplexity * 200;
    const networkUsage = testSuite.length * 2 + avgComplexity * 10;
    const storageUsage = testSuite.length * 5;

    return {
      estimatedCpuUsage: cpuUsage,
      estimatedMemoryUsage: memoryUsage,
      estimatedNetworkUsage: networkUsage,
      estimatedStorageUsage: storageUsage,
      executionTime,
      confidence: 0.8,
    };
  } catch (error) {
    console.error("[predictiveOptimizationService] Error predicting resources:", error);
    return {
      estimatedCpuUsage: 0.5,
      estimatedMemoryUsage: 512,
      estimatedNetworkUsage: 10,
      estimatedStorageUsage: 100,
      executionTime: 300,
      confidence: 0.5,
    };
  }
}

export function detectAnomaly(
  currentMetrics: { duration: number; cpuUsage: number; memoryUsage: number; failureRate: number },
  history: Array<{ duration: number; cpuUsage: number; memoryUsage: number; failureRate: number }> = []
): AnomalyDetection {
  if (history.length < 3) {
    return {
      isAnomaly: false,
      severity: "low",
    };
  }

  const avgDuration = history.reduce((sum, h) => sum + h.duration, 0) / history.length;
  const stdDevDuration = Math.sqrt(
    history.reduce((sum, h) => sum + Math.pow(h.duration - avgDuration, 2), 0) / history.length
  );

  const durationThreshold = avgDuration + stdDevDuration * 2;
  if (currentMetrics.duration > durationThreshold) {
    return {
      isAnomaly: true,
      anomalyType: "timeout_spike",
      severity: currentMetrics.duration > durationThreshold * 1.5 ? "high" : "medium",
      recommendation: "Consider increasing timeout or reducing concurrency",
    };
  }

  const avgMemory = history.reduce((sum, h) => sum + h.memoryUsage, 0) / history.length;
  const memoryThreshold = avgMemory * 1.5;
  if (currentMetrics.memoryUsage > memoryThreshold) {
    return {
      isAnomaly: true,
      anomalyType: "memory_surge",
      severity: "high",
      recommendation: "Memory usage spike detected. Check for memory leaks.",
    };
  }

  const avgFailureRate = history.reduce((sum, h) => sum + h.failureRate, 0) / history.length;
  if (currentMetrics.failureRate > avgFailureRate * 2) {
    return {
      isAnomaly: true,
      anomalyType: "failure_rate_increase",
      severity: "high",
      recommendation: "Failure rate increased significantly. Review recent changes.",
    };
  }

  return {
    isAnomaly: false,
    severity: "low",
  };
}

export function forecastExecutionTime(
  tests: Array<{ id: string; type: string; estimatedDuration: number }>
): number {
  try {
    ensurePredictiveTable();

    const typeGroups: Record<string, number[]> = {};
    for (const test of tests) {
      if (!typeGroups[test.type]) {
        typeGroups[test.type] = [];
      }
      typeGroups[test.type].push(test.estimatedDuration);
    }

    let totalForecast = 0;
    for (const [type, durations] of Object.entries(typeGroups)) {
      const avgDuration = durations.reduce((sum, d) => sum + d, 0) / durations.length;
      const adjustmentFactor = 1.0 + Math.random() * 0.2;
      totalForecast += avgDuration * durations.length * adjustmentFactor;
    }

    return Math.ceil(totalForecast);
  } catch (error) {
    console.error("[predictiveOptimizationService] Error forecasting time:", error);
    return tests.reduce((sum, t) => sum + t.estimatedDuration, 0);
  }
}

export function recommendPreemptiveAction(context: {
  currentDuration: number;
  currentFailureRate: number;
  resourceUtilization: number;
  timeRemaining: number;
}): OptimizationRecommendation | null {
  if (context.resourceUtilization > 0.9) {
    return {
      action: "scale_resources",
      parameter: "concurrency",
      reason: "Resource utilization critical",
      expectedBenefit: "Improve execution time by 20-30%",
      riskLevel: "low",
    };
  }

  if (context.currentFailureRate > 0.15) {
    return {
      action: "increase_timeout",
      parameter: "timeout_ms",
      reason: "High failure rate detected",
      expectedBenefit: "Reduce failures by 40-50%",
      riskLevel: "low",
    };
  }

  if (context.timeRemaining < 300 && context.currentDuration > 60) {
    return {
      action: "reduce_complexity",
      parameter: "test_selection",
      reason: "Time constraint approaching",
      expectedBenefit: "Complete execution on time",
      riskLevel: "medium",
    };
  }

  return null;
}

export function burndownPrediction(
  currentProgress: { completed: number; total: number; velocity: number }
): BurndownPrediction {
  const remainingTests = currentProgress.total - currentProgress.completed;
  const testCompletionRate = currentProgress.velocity;

  const completionTime = remainingTests > 0 ? (remainingTests / testCompletionRate) * 60 : 0;

  return {
    completionTime: Math.ceil(completionTime),
    estimatedTests: currentProgress.total,
    completedTests: currentProgress.completed,
    remainingTests,
    testCompletionRate,
  };
}

export function recordBaseline(
  testType: string,
  duration: number
): void {
  try {
    ensurePredictiveTable();

    const existing = db.prepare(
      "SELECT * FROM execution_baseline WHERE test_type = ?"
    ).get(testType) as any;

    if (existing) {
      const newAvg = (existing.avg_duration * existing.sample_count + duration) / (existing.sample_count + 1);
      const newStdDev = Math.sqrt(
        (Math.pow(existing.std_deviation, 2) * existing.sample_count +
          Math.pow(duration - newAvg, 2)) /
        (existing.sample_count + 1)
      );

      db.prepare(`
        UPDATE execution_baseline
        SET avg_duration = ?, std_deviation = ?, sample_count = ?, last_updated = ?
        WHERE test_type = ?
      `).run(newAvg, newStdDev, existing.sample_count + 1, Date.now(), testType);
    } else {
      db.prepare(`
        INSERT INTO execution_baseline
        (id, test_type, avg_duration, std_deviation, sample_count, last_updated)
        VALUES (?, ?, ?, ?, 1, ?)
      `).run(testType, testType, duration, 0, Date.now());
    }
  } catch (error) {
    console.error("[predictiveOptimizationService] Error recording baseline:", error);
  }
}

export function setPredictiveOptimizationFeatureFlag(enabled: boolean): void {
  process.env.PREDICTIVE_OPTIMIZATION_ENABLED = String(enabled);
}

export function isPredictiveOptimizationEnabled(): boolean {
  return process.env.PREDICTIVE_OPTIMIZATION_ENABLED !== "false";
}

export function resetPredictiveData(): void {
  try {
    ensurePredictiveTable();
    db.prepare("DELETE FROM predictive_metrics").run();
    db.prepare("DELETE FROM execution_baseline").run();
    db.prepare("DELETE FROM anomaly_detections").run();
  } catch (error) {
    console.error("[predictiveOptimizationService] Error resetting data:", error);
  }
}
