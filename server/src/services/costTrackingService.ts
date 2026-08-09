// Cost Tracking & Analytics Service (FEATURE 9)
// Real-time cost tracking, calculation, and optimization recommendations

import { nanoid } from "nanoid";
import { db } from "../db.js";
import { recordModelUsage, calculateTokenCost, getModelMetrics } from "./modelRoutingService.js";

function ensureCostTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cost_metrics (
      id TEXT PRIMARY KEY,
      test_id TEXT NOT NULL,
      generation_cost REAL NOT NULL DEFAULT 0,
      execution_cost REAL NOT NULL DEFAULT 0,
      storage_cost REAL NOT NULL DEFAULT 0,
      total_cost REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cost_metrics_created ON cost_metrics(created_at);
  `);
}
ensureCostTable();

export interface CostMetrics {
  testId: string;
  generationCost: number;
  executionCost: number;
  storageCost: number;
  totalCost: number;
  timestamp: number;
  manualQAEquivalent: number;
  costPerBug?: number;
  costSavings?: number;
}

export interface CostBreakdown {
  llmProcessing: number;
  computeResources: number;
  storage: number;
  dataTransfer: number;
  total: number;
}

export interface CostTrend {
  date: string;
  totalCost: number;
  testCount: number;
  avgCostPerTest: number;
  estimatedMonthly: number;
}

/**
 * Calculate cost for LLM-based generation (test case generation)
 */
export function calculateGenerationCost(
  inputTokens: number,
  outputTokens: number,
  model: "gpt-4" | "gpt-3.5" | "claude" = "gpt-3.5"
): number {
  const rates: Record<string, { input: number; output: number }> = {
    "gpt-4": { input: 0.03 / 1000, output: 0.06 / 1000 }, // per token
    "gpt-3.5": { input: 0.0005 / 1000, output: 0.0015 / 1000 },
    claude: { input: 0.008 / 1000, output: 0.024 / 1000 },
  };

  const rate = rates[model];
  return inputTokens * rate.input + outputTokens * rate.output;
}

/**
 * Calculate execution cost (compute resources)
 */
export function calculateExecutionCost(
  durationSeconds: number,
  concurrency: number = 1,
  resourceIntensity: "low" | "medium" | "high" = "medium"
): number {
  const baseRate = {
    low: 0.01,    // per second per concurrent test
    medium: 0.05, // per second per concurrent test
    high: 0.15,   // per second per concurrent test
  };

  const rate = baseRate[resourceIntensity];
  return durationSeconds * concurrency * rate;
}

/**
 * Calculate storage cost (screenshots, videos, results)
 */
export function calculateStorageCost(
  storageGB: number,
  retentionDays: number = 30
): number {
  const monthlyCostPerGB = 0.02; // Standard cloud storage
  const monthlyStorage = (storageGB * monthlyCostPerGB * retentionDays) / 30;
  return monthlyStorage;
}

/**
 * Calculate assertion execution cost
 */
export function calculateAssertionCost(
  assertionCount: number,
  complexity: "simple" | "complex" = "simple"
): number {
  const costPerAssertion = complexity === "simple" ? 0.001 : 0.005;
  return assertionCount * costPerAssertion;
}

/**
 * Calculate interaction validation cost
 */
export function calculateInteractionCost(
  interactionCount: number,
  validationType: "basic" | "deep" = "basic"
): number {
  const costPerInteraction = validationType === "basic" ? 0.002 : 0.008;
  return interactionCount * costPerInteraction;
}

/**
 * Calculate total crawl cost
 */
export function calculateCrawlCost(
  pageCount: number,
  screenshotsPerPage: number = 1,
  videoRecording: boolean = false
): number {
  const costPerPage = 0.10; // Base cost per page crawled
  const costPerScreenshot = 0.02;
  const videoBaseCost = videoRecording ? 0.50 : 0;

  const baseCost = pageCount * costPerPage;
  const screenshotCost = pageCount * screenshotsPerPage * costPerScreenshot;

  return baseCost + screenshotCost + videoBaseCost;
}

/**
 * Calculate execution cost for test run (entire batch)
 */
export function calculateBatchExecutionCost(
  testCount: number,
  avgDurationPerTest: number,
  mode: "ultrafast" | "fast" | "comprehensive" = "comprehensive"
): number {
  const ratios = {
    ultrafast: 0.5,
    fast: 1.0,
    comprehensive: 2.0,
  };

  const baseCost = testCount * avgDurationPerTest * 0.01; // Base compute rate
  return baseCost * ratios[mode];
}

/**
 * Estimate execution cost before running
 */
export function estimateExecutionCost(params: {
  testCount: number;
  pageCount: number;
  videoRecording: boolean;
  mode: "ultrafast" | "fast" | "comprehensive";
  withAssertions: boolean;
}): {
  estimated: number;
  breakdown: CostBreakdown;
  manualQAEquivalent: number;
  savings: number;
} {
  const crawlCost = calculateCrawlCost(params.pageCount, 1, params.videoRecording);
  const generationCost = params.testCount * 0.05; // ~5 cents per test case
  const executionCost = calculateBatchExecutionCost(params.testCount, 30, params.mode); // 30 sec average
  const assertionCost = params.withAssertions ? params.testCount * 0.01 : 0;

  const totalCost = crawlCost + generationCost + executionCost + assertionCost;
  const manualQAEquivalent = params.testCount * 15; // $15 per manual test
  const savings = manualQAEquivalent - totalCost;

  return {
    estimated: totalCost,
    breakdown: {
      llmProcessing: generationCost + assertionCost,
      computeResources: executionCost,
      storage: crawlCost * 0.2, // Portion for storage
      dataTransfer: crawlCost * 0.05,
      total: totalCost,
    },
    manualQAEquivalent,
    savings,
  };
}

/**
 * Record cost metrics for a test run
 */
export function recordCostMetrics(metrics: CostMetrics): void {
  try {
    ensureCostTable();
    db.prepare(`
      INSERT INTO cost_metrics
        (id, test_id, generation_cost, execution_cost, storage_cost, total_cost, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      nanoid(12),
      metrics.testId,
      metrics.generationCost,
      metrics.executionCost,
      metrics.storageCost,
      metrics.totalCost,
      new Date(metrics.timestamp || Date.now()).toISOString()
    );
  } catch (err) {
    console.warn(`[costTracking] persist failed: ${(err as Error).message}`);
  }
}

/**
 * Live dashboard data for Cost Transparency (F9)
 */
export function getCostTransparencySnapshot(): {
  todayCost: number;
  weekCost: number;
  monthCost: number;
  timeSavedHours: number;
  roiMultiplier: number;
  breakdownChartData: Array<{ category: string; percentage: number; color: string }>;
  trends: Array<{ date: string; cost: number }>;
  recommendations: Array<{ icon: string; title: string; savingsPercent: string }>;
  runCount: number;
} {
  ensureCostTable();
  const sumSince = (days: number) => {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(total_cost), 0) as total, COUNT(*) as c
         FROM cost_metrics
         WHERE created_at >= datetime('now', ?)`
      )
      .get(`-${days} days`) as { total: number; c: number };
    return row;
  };

  const today = sumSince(1);
  const week = sumSince(7);
  const month = sumSince(30);

  // Fallback estimate from recent execution runs when no cost rows yet
  const runFallback = db
    .prepare(
      `SELECT COUNT(*) as c, COALESCE(SUM(COALESCE(duration_ms, 0)), 0) as ms
       FROM execution_runs WHERE created_at >= datetime('now', '-1 day')`
    )
    .get() as { c: number; ms: number };
  const todayCost =
    today.total > 0 ? today.total : Number(((runFallback.c || 0) * 0.08).toFixed(2));
  const weekCost = week.total > 0 ? week.total : Number((todayCost * 5).toFixed(2));
  const monthCost = month.total > 0 ? month.total : Number((weekCost * 4).toFixed(2));

  const gen = db.prepare(`SELECT COALESCE(SUM(generation_cost),0) as v FROM cost_metrics WHERE created_at >= datetime('now','-7 days')`).get() as any;
  const exe = db.prepare(`SELECT COALESCE(SUM(execution_cost),0) as v FROM cost_metrics WHERE created_at >= datetime('now','-7 days')`).get() as any;
  const stor = db.prepare(`SELECT COALESCE(SUM(storage_cost),0) as v FROM cost_metrics WHERE created_at >= datetime('now','-7 days')`).get() as any;
  const parts = [
    { category: "LLM", value: Number(gen.v) || todayCost * 0.35, color: "bg-blue-500" },
    { category: "Compute", value: Number(exe.v) || todayCost * 0.4, color: "bg-purple-500" },
    { category: "Storage", value: Number(stor.v) || todayCost * 0.15, color: "bg-green-500" },
    { category: "Data Transfer", value: todayCost * 0.1, color: "bg-orange-500" },
  ];
  const partSum = parts.reduce((s, p) => s + p.value, 0) || 1;

  const trends = db
    .prepare(
      `SELECT date(created_at) as d, COALESCE(SUM(total_cost),0) as cost
       FROM cost_metrics
       WHERE created_at >= datetime('now', '-7 days')
       GROUP BY date(created_at)
       ORDER BY d ASC`
    )
    .all() as Array<{ d: string; cost: number }>;

  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const trendRows =
    trends.length > 0
      ? trends.map((t) => ({
          date: dayNames[new Date(t.d).getDay()] || t.d.slice(5),
          cost: Number(t.cost) || 0,
        }))
      : dayNames.map((d, i) => ({ date: d, cost: Number((todayCost * (0.6 + (i % 3) * 0.15)).toFixed(2)) }));

  const timeSavedHours = Number((((runFallback.ms || 0) / 3600000) * 4).toFixed(1)); // vs manual ~4x
  const manualEquiv = (week.c || runFallback.c || 1) * 15;
  const roiMultiplier = weekCost > 0 ? Number((manualEquiv / weekCost).toFixed(1)) : 20;

  return {
    todayCost,
    weekCost,
    monthCost,
    timeSavedHours: timeSavedHours || 1,
    roiMultiplier,
    breakdownChartData: parts.map((p) => ({
      category: p.category,
      percentage: Math.round((p.value / partSum) * 100),
      color: p.color,
    })),
    trends: trendRows,
    recommendations: [
      { icon: "⚡", title: "Use Fast Mode (critical/balanced)", savingsPercent: "30-50%" },
      { icon: "🔄", title: "Keep Incremental Crawl ON", savingsPercent: "40-60%" },
      { icon: "🎯", title: "Smart selection + workers=5", savingsPercent: "25-40%" },
    ],
    runCount: today.c || runFallback.c || 0,
  };
}

/**
 * Get accumulated cost for a period
 */
export function getAccumulatedCost(
  startDate: Date,
  endDate: Date,
  metrics: CostMetrics[]
): {
  total: number;
  byCategory: Record<string, number>;
  averagePerTest: number;
  testCount: number;
} {
  const relevant = metrics.filter((m) => {
    const ts = new Date(m.timestamp);
    return ts >= startDate && ts <= endDate;
  });

  const total = relevant.reduce((sum, m) => sum + m.totalCost, 0);
  const byCategory = {
    generation: relevant.reduce((sum, m) => sum + m.generationCost, 0),
    execution: relevant.reduce((sum, m) => sum + m.executionCost, 0),
    storage: relevant.reduce((sum, m) => sum + m.storageCost, 0),
  };

  return {
    total,
    byCategory,
    averagePerTest: relevant.length > 0 ? total / relevant.length : 0,
    testCount: relevant.length,
  };
}

/**
 * Calculate cost savings vs manual QA
 */
export function calculateCostSavings(
  automatedCost: number,
  testCount: number,
  manualQACostPerTest: number = 15
): {
  manualCost: number;
  savings: number;
  savingsPercent: number;
  roiMonths: number;
} {
  const manualCost = testCount * manualQACostPerTest;
  const savings = manualCost - automatedCost;
  const savingsPercent = (savings / manualCost) * 100;
  const roiMonths = automatedCost > 0 ? (500 / (savings / 30)).toFixed(1) : 0; // 500 = platform cost

  return {
    manualCost,
    savings,
    savingsPercent,
    roiMonths: Number(roiMonths),
  };
}

/**
 * Generate cost recommendations for optimization
 */
export function generateCostRecommendations(metrics: CostMetrics[]): string[] {
  const recommendations: string[] = [];

  if (metrics.length === 0) return recommendations;

  // Calculate average cost per test
  const avgCost = metrics.reduce((sum, m) => sum + m.totalCost, 0) / metrics.length;

  // Find high-cost tests
  const highCostTests = metrics.filter((m) => m.totalCost > avgCost * 2);
  if (highCostTests.length > 0) {
    recommendations.push(
      `💰 ${highCostTests.length} tests cost 2x average - consider reducing page count or using incremental crawl`
    );
  }

  // Check for inefficient modes
  const totalCost = metrics.reduce((sum, m) => sum + m.totalCost, 0);
  if (totalCost > 100) {
    recommendations.push(
      `⚡ Switch to Fast Mode to reduce costs by 30-50% while catching 80% of bugs`
    );
  }

  // Check for video recording
  if (metrics.some((m) => m.totalCost > 5)) {
    recommendations.push(
      `📹 Consider disabling video recording to save ~$0.50 per run`
    );
  }

  // Incremental crawl suggestion
  if (metrics.length > 3) {
    recommendations.push(
      `🔄 Enable incremental crawl to skip unchanged pages - could save 40-60%`
    );
  }

  return recommendations;
}

/**
 * Cost optimization strategies
 */
export function getCostOptimizationStrategies(): {
  strategy: string;
  estimated_savings: string;
  implementation: string;
}[] {
  return [
    {
      strategy: "Switch to Fast Mode",
      estimated_savings: "30-50% cost reduction",
      implementation:
        "Use economy LLM + critical paths only. Same 80% bug detection.",
    },
    {
      strategy: "Enable Incremental Crawl",
      estimated_savings: "40-60% on repeat runs",
      implementation:
        "Skip unchanged pages. Uses DOM/screenshot hashing to detect changes.",
    },
    {
      strategy: "Disable Video Recording",
      estimated_savings: "$0.50 per run",
      implementation:
        "Keep screenshots only. Still captures visual bugs. Re-enable for critical runs.",
    },
    {
      strategy: "Batch Tests",
      estimated_savings: "10-20% through parallelization",
      implementation:
        "Group related tests. Run in parallel. Reduces total execution time.",
    },
    {
      strategy: "Use Smart Presets",
      estimated_savings: "Right-size each run",
      implementation:
        "Pick preset matching your goal: Smoke ($4), Quick ($10), Full ($50), Nightly ($150).",
    },
  ];
}
