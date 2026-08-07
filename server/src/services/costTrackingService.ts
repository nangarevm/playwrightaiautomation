// Cost Tracking Service
// Tracks and calculates execution costs in real-time

import { db } from "../db.js";

export interface CostBreakdown {
  llmCost: number;
  assertionCost: number;
  interactionCost: number;
  crawlCost: number;
  totalCost: number;
  costPerTest?: number;
}

export interface CostMetrics {
  runId: string;
  estimatedCost: number;
  actualCost: number;
  costsAccumulated: number;
  testCount: number;
  costPerTest: number;
  breakdown: CostBreakdown;
  timestamp: number;
}

// Cost rates per operation (configurable)
const COST_RATES = {
  LLM_GENERATION: 0.02,      // $0.02 per test case generated
  ASSERTION_EXECUTION: 0.001,  // $0.001 per assertion
  INTERACTION_VALIDATION: 0.0005, // $0.0005 per interaction
  PAGE_CRAWL: 0.01,           // $0.01 per page crawled
  SCREENSHOT: 0.002,          // $0.002 per screenshot
  VIDEO_RECORDING: 0.005,     // $0.005 per minute
  BROWSER_INSTANCE: 0.003,    // $0.003 per instance per minute
};

/**
 * Calculates cost for test case generation
 */
export function calculateGenerationCost(testCount: number): number {
  return testCount * COST_RATES.LLM_GENERATION;
}

/**
 * Calculates cost for assertions executed
 */
export function calculateAssertionCost(assertionCount: number): number {
  return assertionCount * COST_RATES.ASSERTION_EXECUTION;
}

/**
 * Calculates cost for interactions validated
 */
export function calculateInteractionCost(interactionCount: number): number {
  return interactionCount * COST_RATES.INTERACTION_VALIDATION;
}

/**
 * Calculates cost for crawling
 */
export function calculateCrawlCost(pageCount: number, screenshotCount: number = 0, videoMinutes: number = 0): number {
  const pageCost = pageCount * COST_RATES.PAGE_CRAWL;
  const screenshotCost = screenshotCount * COST_RATES.SCREENSHOT;
  const videoCost = videoMinutes * COST_RATES.VIDEO_RECORDING;
  return pageCost + screenshotCost + videoCost;
}

/**
 * Calculates total execution cost
 */
export function calculateExecutionCost(metrics: {
  testCount: number;
  assertionCount: number;
  interactionCount: number;
  pageCount: number;
  screenshotCount: number;
  videoMinutes: number;
  parallelWorkers: number;
  durationMinutes: number;
}): CostBreakdown {
  const llmCost = calculateGenerationCost(metrics.testCount);
  const assertionCost = calculateAssertionCost(metrics.assertionCount);
  const interactionCost = calculateInteractionCost(metrics.interactionCount);
  const crawlCost = calculateCrawlCost(metrics.pageCount, metrics.screenshotCount, metrics.videoMinutes);
  const browserCost = metrics.parallelWorkers * metrics.durationMinutes * COST_RATES.BROWSER_INSTANCE;

  const totalCost = llmCost + assertionCost + interactionCost + crawlCost + browserCost;

  return {
    llmCost,
    assertionCost,
    interactionCost,
    crawlCost,
    totalCost,
    costPerTest: metrics.testCount > 0 ? totalCost / metrics.testCount : 0,
  };
}

/**
 * Estimates cost before execution
 */
export function estimateExecutionCost(options: {
  testCountEstimate: number;
  assertionCountEstimate: number;
  interactionCountEstimate: number;
  pageCountEstimate: number;
  parallelWorkers: number;
  estimatedDurationMinutes: number;
}): { estimate: CostBreakdown; confidence: number } {
  const estimate = calculateExecutionCost({
    testCount: options.testCountEstimate,
    assertionCount: options.assertionCountEstimate,
    interactionCount: options.interactionCountEstimate,
    pageCount: options.pageCountEstimate,
    screenshotCount: Math.ceil(options.pageCountEstimate * 0.2), // 20% of pages have screenshots
    videoMinutes: 0, // Optional
    parallelWorkers: options.parallelWorkers,
    durationMinutes: options.estimatedDurationMinutes,
  });

  // Confidence decreases with larger estimates
  const confidence = Math.max(0.7, 1 - options.testCountEstimate * 0.01);

  return { estimate, confidence };
}

/**
 * Stores cost metrics in database
 */
export function recordCostMetrics(runId: string, metrics: CostMetrics): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR REPLACE INTO execution_costs (
      id, run_id, estimated_cost, actual_cost, costs_accumulated,
      test_count, cost_per_test, breakdown_json, timestamp, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `${runId}-${Date.now()}`,
    runId,
    metrics.estimatedCost,
    metrics.actualCost,
    metrics.costsAccumulated,
    metrics.testCount,
    metrics.costPerTest,
    JSON.stringify(metrics.breakdown),
    metrics.timestamp,
    now
  );
}

/**
 * Gets cost metrics for a run
 */
export function getCostMetrics(runId: string): CostMetrics[] {
  const rows = db.prepare(`
    SELECT * FROM execution_costs WHERE run_id = ? ORDER BY timestamp ASC
  `).all(runId) as any[];

  return rows.map(row => ({
    runId: row.run_id,
    estimatedCost: row.estimated_cost,
    actualCost: row.actual_cost,
    costsAccumulated: row.costs_accumulated,
    testCount: row.test_count,
    costPerTest: row.cost_per_test,
    breakdown: JSON.parse(row.breakdown_json),
    timestamp: row.timestamp,
  }));
}

/**
 * Gets current accumulated cost for a run
 */
export function getAccumulatedCost(runId: string): number {
  const row = db.prepare(`
    SELECT costs_accumulated FROM execution_costs
    WHERE run_id = ? ORDER BY timestamp DESC LIMIT 1
  `).get(runId) as any;

  return row?.costs_accumulated ?? 0;
}

/**
 * Calculates cost savings (actual vs estimated)
 */
export function calculateCostSavings(runId: string): {
  estimatedCost: number;
  actualCost: number;
  savings: number;
  savingsPercent: number;
} {
  const metrics = getCostMetrics(runId);
  if (metrics.length === 0) return { estimatedCost: 0, actualCost: 0, savings: 0, savingsPercent: 0 };

  const first = metrics[0];
  const last = metrics[metrics.length - 1];

  const estimatedCost = first.estimatedCost;
  const actualCost = last.actualCost;
  const savings = estimatedCost - actualCost;
  const savingsPercent = estimatedCost > 0 ? (savings / estimatedCost) * 100 : 0;

  return { estimatedCost, actualCost, savings, savingsPercent };
}

/**
 * Compares actual cost vs manual QA cost
 */
export function calculateManualQACostSavings(automatedCost: number, testCount: number): {
  automatedCost: number;
  manualQACost: number;
  savings: number;
  savingsPercent: number;
} {
  // Manual QA costs ~$10 per test on average
  const MANUAL_QA_COST_PER_TEST = 10;
  const manualQACost = testCount * MANUAL_QA_COST_PER_TEST;
  const savings = manualQACost - automatedCost;
  const savingsPercent = (savings / manualQACost) * 100;

  return {
    automatedCost,
    manualQACost,
    savings,
    savingsPercent,
  };
}

/**
 * Gets cost trends over time
 */
export function getCostTrends(timeframeHours: number = 24): {
  timestamp: number;
  averageCost: number;
  count: number;
}[] {
  const since = new Date(Date.now() - timeframeHours * 60 * 60 * 1000).toISOString();

  const rows = db.prepare(`
    SELECT 
      DATE(datetime(created_at)) as date_key,
      AVG(actual_cost) as avg_cost,
      COUNT(*) as count
    FROM execution_costs
    WHERE created_at >= ?
    GROUP BY date_key
    ORDER BY created_at ASC
  `).all(since) as any[];

  return rows.map(row => ({
    timestamp: new Date(row.date_key).getTime(),
    averageCost: row.avg_cost,
    count: row.count,
  }));
}

/**
 * Gets high-cost tests for optimization
 */
export function getHighCostTests(limit: number = 10): Array<{
  runId: string;
  costPerTest: number;
  testCount: number;
  totalCost: number;
  createdAt: string;
}> {
  const rows = db.prepare(`
    SELECT 
      run_id,
      cost_per_test,
      test_count,
      actual_cost as total_cost,
      created_at
    FROM execution_costs
    ORDER BY cost_per_test DESC
    LIMIT ?
  `).all(limit) as any[];

  return rows.map(row => ({
    runId: row.run_id,
    costPerTest: row.cost_per_test,
    testCount: row.test_count,
    totalCost: row.total_cost,
    createdAt: row.created_at,
  }));
}

/**
 * Generates cost optimization recommendations
 */
export function generateCostRecommendations(runId: string): string[] {
  const metrics = getCostMetrics(runId);
  if (metrics.length === 0) return [];

  const lastMetric = metrics[metrics.length - 1];
  const recommendations: string[] = [];

  // High cost per test
  if (lastMetric.costPerTest > 0.15) {
    recommendations.push("💡 High cost per test detected. Consider using Fast Mode or Balanced Speed preset.");
  }

  // High assertion count
  if (lastMetric.breakdown.assertionCost > lastMetric.breakdown.totalCost * 0.3) {
    recommendations.push("💡 Assertions are consuming 30%+ of cost. Review and optimize custom assertions.");
  }

  // High crawl cost
  if (lastMetric.breakdown.crawlCost > lastMetric.breakdown.totalCost * 0.4) {
    recommendations.push("💡 Crawling is expensive. Use Incremental Crawling Mode for repeat runs.");
  }

  // High interaction validation cost
  if (lastMetric.breakdown.interactionCost > lastMetric.breakdown.totalCost * 0.2) {
    recommendations.push("💡 Interaction validation is costly. Consider reducing validation scope.");
  }

  return recommendations;
}
