import { db } from "../db.js";

export interface ExecutionMetrics {
  testId: string;
  duration: number;
  result: "pass" | "fail";
  timestamp: number;
  pageType: string;
}

export interface LearningData {
  averageDuration: Record<string, number>;
  timeoutAdaptations: number;
  strategyChanges: number;
  improvementScore: number;
}

export interface AdaptationRecommendation {
  strategy: string;
  parameter: string;
  currentValue: any;
  recommendedValue: any;
  expectedImprovement: number;
  confidence: number;
}

function ensureSelfLearningTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS learning_executions (
      id TEXT PRIMARY KEY,
      test_id TEXT,
      page_type TEXT,
      duration INTEGER,
      result TEXT,
      timeout_ms INTEGER,
      timestamp INTEGER,
      UNIQUE(test_id, timestamp)
    );
    CREATE TABLE IF NOT EXISTS timeout_adaptations (
      id TEXT PRIMARY KEY,
      page_type TEXT UNIQUE,
      base_timeout INTEGER,
      adapted_timeout INTEGER,
      adjustment_count INTEGER,
      last_updated INTEGER
    );
    CREATE TABLE IF NOT EXISTS learning_metrics (
      id TEXT PRIMARY KEY,
      metric_name TEXT UNIQUE,
      value REAL,
      updated_at INTEGER
    );
  `);
}

const defaultTimeouts: Record<string, number> = {
  static: 5000,
  dynamic: 10000,
  api: 8000,
  ecommerce: 15000,
  saas: 12000,
};

export function recordTestExecution(
  testId: string,
  pageType: string,
  duration: number,
  result: "pass" | "fail",
  timeoutMs: number
): void {
  try {
    ensureSelfLearningTable();

    db.prepare(`
      INSERT INTO learning_executions
      (id, test_id, page_type, duration, result, timeout_ms, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      `${testId}_${Date.now()}`,
      testId,
      pageType,
      duration,
      result,
      timeoutMs,
      Date.now()
    );

    updateLearningMetrics(pageType, duration, result);
  } catch (error) {
    console.error("[selfLearningService] Error recording execution:", error);
  }
}

function updateLearningMetrics(
  pageType: string,
  duration: number,
  result: string
): void {
  try {
    ensureSelfLearningTable();

    const existing = db.prepare(
      "SELECT * FROM learning_metrics WHERE metric_name = ?"
    ).get(`avg_duration_${pageType}`) as any;

    const avgDuration = existing
      ? (existing.value * 0.8 + duration * 0.2)
      : duration;

    db.prepare(`
      INSERT OR REPLACE INTO learning_metrics
      (id, metric_name, value, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(`avg_duration_${pageType}`, `avg_duration_${pageType}`, avgDuration, Date.now());
  } catch (error) {
    console.error("[selfLearningService] Error updating metrics:", error);
  }
}

export function adaptTimeout(pageType: string, newDuration: number): void {
  try {
    ensureSelfLearningTable();

    const existing = db.prepare(
      "SELECT * FROM timeout_adaptations WHERE page_type = ?"
    ).get(pageType) as any;

    const adaptedTimeout = existing
      ? Math.round(existing.adapted_timeout * 0.7 + newDuration * 0.3)
      : Math.round(newDuration * 1.2);

    db.prepare(`
      INSERT OR REPLACE INTO timeout_adaptations
      (id, page_type, base_timeout, adapted_timeout, adjustment_count, last_updated)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      pageType,
      pageType,
      defaultTimeouts[pageType] || 10000,
      adaptedTimeout,
      (existing?.adjustment_count || 0) + 1,
      Date.now()
    );
  } catch (error) {
    console.error("[selfLearningService] Error adapting timeout:", error);
  }
}

export function optimizeStrategy(currentMetrics: {
  successRate: number;
  averageDuration: number;
  failureCount: number;
}): AdaptationRecommendation[] {
  const recommendations: AdaptationRecommendation[] = [];

  if (currentMetrics.successRate < 0.85) {
    recommendations.push({
      strategy: "timeout",
      parameter: "maxWaitTime",
      currentValue: 5000,
      recommendedValue: 7500,
      expectedImprovement: 0.15,
      confidence: 0.8,
    });
  }

  if (currentMetrics.averageDuration > 30000) {
    recommendations.push({
      strategy: "parallelization",
      parameter: "concurrency",
      currentValue: 2,
      recommendedValue: 4,
      expectedImprovement: 0.4,
      confidence: 0.85,
    });
  }

  if (currentMetrics.failureCount > 5) {
    recommendations.push({
      strategy: "retryPolicy",
      parameter: "maxRetries",
      currentValue: 1,
      recommendedValue: 3,
      expectedImprovement: 0.2,
      confidence: 0.7,
    });
  }

  return recommendations;
}

export function predictOptimalConfig(): {
  timeout: number;
  concurrency: number;
  retryCount: number;
  batchSize: number;
} {
  try {
    ensureSelfLearningTable();

    const executions = db.prepare(`
      SELECT page_type, duration, result 
      FROM learning_executions 
      WHERE timestamp > datetime('now', '-7 days')
    `).all() as any[];

    const avgDuration =
      executions.reduce((sum, e) => sum + e.duration, 0) / Math.max(1, executions.length) || 8000;

    const successRate =
      executions.filter((e) => e.result === "pass").length / Math.max(1, executions.length) || 0.9;

    return {
      timeout: Math.ceil(avgDuration * 1.5),
      concurrency: successRate > 0.95 ? 4 : successRate > 0.8 ? 3 : 2,
      retryCount: successRate > 0.9 ? 1 : 3,
      batchSize: successRate > 0.85 ? 10 : 5,
    };
  } catch (error) {
    console.error("[selfLearningService] Error predicting config:", error);
    return {
      timeout: 10000,
      concurrency: 2,
      retryCount: 1,
      batchSize: 5,
    };
  }
}

export function confidenceScore(prediction: any): number {
  const hasHistory = prediction.executionCount && prediction.executionCount > 5;
  const hasVariance = prediction.variance && prediction.variance < 2000;
  const recentData = prediction.lastUpdate && Date.now() - prediction.lastUpdate < 86400000;

  let score = 0.5;
  if (hasHistory) score += 0.2;
  if (hasVariance) score += 0.15;
  if (recentData) score += 0.15;

  return Math.min(1, score);
}

export function getLearningData(): LearningData {
  try {
    ensureSelfLearningTable();

    const executions = db.prepare("SELECT * FROM learning_executions").all() as any[];
    const successCount = executions.filter((e) => e.result === "pass").length;

    const averageDuration: Record<string, number> = {};
    for (const exec of executions) {
      if (!averageDuration[exec.page_type]) {
        averageDuration[exec.page_type] = 0;
      }
      averageDuration[exec.page_type] = (averageDuration[exec.page_type] + exec.duration) / 2;
    }

    const adaptations = db.prepare(
      "SELECT COUNT(*) as cnt FROM timeout_adaptations"
    ).get() as any;

    return {
      averageDuration,
      timeoutAdaptations: adaptations.cnt,
      strategyChanges: 0,
      improvementScore: executions.length > 0 ? successCount / executions.length : 0,
    };
  } catch (error) {
    console.error("[selfLearningService] Error getting learning data:", error);
    return {
      averageDuration: {},
      timeoutAdaptations: 0,
      strategyChanges: 0,
      improvementScore: 0,
    };
  }
}

export function setSelfLearningFeatureFlag(enabled: boolean): void {
  process.env.SELF_LEARNING_ENABLED = String(enabled);
}

export function isSelfLearningEnabled(): boolean {
  return process.env.SELF_LEARNING_ENABLED !== "false";
}

export function resetLearningData(): void {
  try {
    ensureSelfLearningTable();
    db.prepare("DELETE FROM learning_executions").run();
    db.prepare("DELETE FROM timeout_adaptations").run();
    db.prepare("DELETE FROM learning_metrics").run();
  } catch (error) {
    console.error("[selfLearningService] Error resetting data:", error);
  }
}
