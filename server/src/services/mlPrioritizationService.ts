import { db } from "../db.js";

export interface TestWithProbability {
  testId: string;
  testType: string;
  bugProbability: number;
  historicalSuccessRate: number;
  recommendedRun: boolean;
  estimatedValue: number;
}

export interface ExecutionHistory {
  testId: string;
  testType: string;
  passed: boolean;
  bugsFound: number;
  duration: number;
  timestamp: number;
  pageType: string;
}

export interface MLModel {
  name: string;
  accuracy: number;
  bugsDetected: number;
  totalPredictions: number;
}

function ensureMLTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ml_test_history (
      id TEXT PRIMARY KEY,
      test_id TEXT NOT NULL,
      test_type TEXT,
      passed INTEGER,
      bugs_found INTEGER,
      duration INTEGER,
      page_type TEXT,
      timestamp INTEGER,
      UNIQUE(test_id, timestamp)
    );
    CREATE TABLE IF NOT EXISTS ml_model_metrics (
      id TEXT PRIMARY KEY,
      model_name TEXT UNIQUE,
      accuracy REAL,
      bugs_detected INTEGER,
      total_predictions INTEGER,
      updated_at INTEGER
    );
  `);
}

const DEFAULT_BUG_PROBABILITY = 0.3;
let modelAccuracy = 0.75;

export function predictBugProbability(
  test: { testType: string; pageType?: string; complexity?: number },
  history: ExecutionHistory[] = []
): number {
  const sameTypeTests = history.filter((h) => h.testType === test.testType);

  if (sameTypeTests.length === 0) {
    return DEFAULT_BUG_PROBABILITY;
  }

  const failedTests = sameTypeTests.filter((h) => !h.passed || h.bugsFound > 0);
  const bugsPerTest = sameTypeTests.reduce((sum, h) => sum + h.bugsFound, 0) / sameTypeTests.length;

  const failureRate = failedTests.length / sameTypeTests.length;
  const bugImpact = Math.min(0.5, bugsPerTest * 0.1);

  let probability = failureRate * 0.7 + bugImpact * 0.3;

  if (test.complexity && test.complexity > 0.7) {
    probability *= 1.2;
  }

  return Math.min(1, probability);
}

export function rankTestsByLikelihood(
  tests: Array<{ id: string; testType: string; pageType?: string; complexity?: number }>,
  history: ExecutionHistory[] = []
): TestWithProbability[] {
  return tests
    .map((test) => {
      const probability = predictBugProbability(test, history);
      const historicalRate = calculateSuccessRate(test.id, history);
      const estimatedValue = probability * (1 - historicalRate);

      return {
        testId: test.id,
        testType: test.testType,
        bugProbability: probability,
        historicalSuccessRate: historicalRate,
        recommendedRun: probability > 0.4 || historicalRate < 0.8,
        estimatedValue,
      };
    })
    .sort((a, b) => b.estimatedValue - a.estimatedValue);
}

export function learnFromExecution(
  testId: string,
  testType: string,
  pageType: string,
  result: { passed: boolean; bugsFound: number; duration: number }
): void {
  try {
    ensureMLTable();

    db.prepare(`
      INSERT INTO ml_test_history
      (id, test_id, test_type, passed, bugs_found, duration, page_type, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `${testId}_${Date.now()}`,
      testId,
      testType,
      result.passed ? 0 : 1,
      result.bugsFound,
      result.duration,
      pageType,
      Date.now()
    );

    updateModelMetrics(result.passed, result.bugsFound);
  } catch (error) {
    console.error("[mlPrioritizationService] Error learning:", error);
  }
}

function calculateSuccessRate(
  testId: string,
  history: ExecutionHistory[] = []
): number {
  const testHistory = history.filter((h) => h.testId === testId);
  if (testHistory.length === 0) return 1.0;

  const passedCount = testHistory.filter((h) => h.passed).length;
  return passedCount / testHistory.length;
}

function updateModelMetrics(passed: boolean, bugsFound: number): void {
  try {
    ensureMLTable();

    const current = db.prepare(
      "SELECT * FROM ml_model_metrics WHERE model_name = 'primary'"
    ).get() as any;

    const newAccuracy = passed ? modelAccuracy + 0.01 : modelAccuracy - 0.02;
    const newBugsDetected = (current?.bugs_detected || 0) + bugsFound;
    const newPredictions = (current?.total_predictions || 0) + 1;

    modelAccuracy = Math.min(0.99, Math.max(0.5, newAccuracy));

    db.prepare(`
      INSERT OR REPLACE INTO ml_model_metrics
      (id, model_name, accuracy, bugs_detected, total_predictions, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      "primary",
      "primary",
      modelAccuracy,
      newBugsDetected,
      newPredictions,
      Date.now()
    );
  } catch (error) {
    console.error("[mlPrioritizationService] Error updating metrics:", error);
  }
}

export function recommendTestOrder(
  allTests: Array<{ id: string; testType: string; pageType?: string; complexity?: number }>,
  history: ExecutionHistory[] = []
): string[] {
  const ranked = rankTestsByLikelihood(allTests, history);
  return ranked
    .filter((t) => t.recommendedRun)
    .map((t) => t.testId);
}

export function getRecommendedTestCount(
  totalTests: number,
  history: ExecutionHistory[] = []
): { recommended: number; canSkip: number; skipRatio: string } {
  const avgBugProbability = 0.35;
  const recommended = Math.ceil(totalTests * avgBugProbability);
  const canSkip = totalTests - recommended;
  const ratio = `${((canSkip / totalTests) * 100).toFixed(1)}%`;

  return {
    recommended,
    canSkip,
    skipRatio: ratio,
  };
}

export function getModelAccuracy(): MLModel {
  try {
    ensureMLTable();
    const model = db.prepare(
      "SELECT * FROM ml_model_metrics WHERE model_name = 'primary'"
    ).get() as any;

    return {
      name: "primary",
      accuracy: model?.accuracy || modelAccuracy,
      bugsDetected: model?.bugs_detected || 0,
      totalPredictions: model?.total_predictions || 0,
    };
  } catch (error) {
    console.error("[mlPrioritizationService] Error getting accuracy:", error);
    return {
      name: "primary",
      accuracy: modelAccuracy,
      bugsDetected: 0,
      totalPredictions: 0,
    };
  }
}

export function improvementMetrics(): {
  modelAccuracy: number;
  bugsDetected: number;
  totalPredictions: number;
  predictionQuality: string;
} {
  const model = getModelAccuracy();
  const quality = model.accuracy > 0.85 ? "excellent" : model.accuracy > 0.75 ? "good" : "fair";

  return {
    modelAccuracy: model.accuracy,
    bugsDetected: model.bugsDetected,
    totalPredictions: model.totalPredictions,
    predictionQuality: quality,
  };
}

export function setMLPrioritizationFeatureFlag(enabled: boolean): void {
  process.env.ML_PRIORITIZATION_ENABLED = String(enabled);
}

export function isMLPrioritizationEnabled(): boolean {
  return process.env.ML_PRIORITIZATION_ENABLED !== "false";
}

export function resetMLModel(): void {
  try {
    ensureMLTable();
    db.prepare("DELETE FROM ml_test_history").run();
    db.prepare("DELETE FROM ml_model_metrics").run();
    modelAccuracy = 0.75;
  } catch (error) {
    console.error("[mlPrioritizationService] Error resetting model:", error);
  }
}
