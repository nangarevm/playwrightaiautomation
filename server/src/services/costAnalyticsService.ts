// Cost Analytics Service
// Analyzes cost patterns and generates reports

import { db } from "../db.js";
import type { CostBreakdown } from "./costTrackingService.js";

export interface CostReport {
  period: string;
  totalCost: number;
  averageCostPerTest: number;
  totalTests: number;
  costBreakdown: CostBreakdown;
  trends: CostTrend[];
  recommendations: string[];
  topExpensiveTests: ExpensiveTest[];
}

export interface CostTrend {
  date: string;
  cost: number;
  testCount: number;
  costPerTest: number;
}

export interface ExpensiveTest {
  testId: string;
  cost: number;
  category: string;
  savings?: number;
}

export interface CostOptimization {
  name: string;
  currentCost: number;
  optimizedCost: number;
  savings: number;
  savingsPercent: number;
  effort: "low" | "medium" | "high";
  description: string;
}

/**
 * Generates daily cost report
 */
export function generateDailyCostReport(dateStr: string = new Date().toISOString().split('T')[0]): CostReport {
  const rows = db.prepare(`
    SELECT 
      SUM(actual_cost) as total_cost,
      AVG(cost_per_test) as avg_cost_per_test,
      COUNT(*) as test_count,
      SUM(breakdown_json) as breakdown
    FROM execution_costs
    WHERE DATE(created_at) = ?
  `).get(dateStr) as any;

  const totalCost = rows?.total_cost ?? 0;
  const averageCostPerTest = rows?.avg_cost_per_test ?? 0;
  const totalTests = rows?.test_count ?? 0;

  // Parse breakdown (simplified for now)
  const breakdown: CostBreakdown = {
    llmProcessing: totalCost * 0.3,
    computeResources: totalCost * 0.35,
    storage: totalCost * 0.2,
    dataTransfer: totalCost * 0.15,
    total: totalCost,
  };

  const trends = getDailyCostTrends(30);
  const recommendations = generateCostRecommendations();
  const topExpensiveTests = getTopExpensiveTests(5);

  return {
    period: `Daily (${dateStr})`,
    totalCost,
    averageCostPerTest,
    totalTests,
    costBreakdown: breakdown,
    trends,
    recommendations,
    topExpensiveTests,
  };
}

/**
 * Generates weekly cost report
 */
export function generateWeeklyCostReport(weekOffset: number = 0): CostReport {
  const now = new Date();
  const weekStart = new Date(now.getTime() - (now.getDay() + 7 * weekOffset) * 24 * 60 * 60 * 1000);
  const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);

  const startStr = weekStart.toISOString().split('T')[0];
  const endStr = weekEnd.toISOString().split('T')[0];

  const rows = db.prepare(`
    SELECT 
      SUM(actual_cost) as total_cost,
      AVG(cost_per_test) as avg_cost_per_test,
      COUNT(*) as test_count
    FROM execution_costs
    WHERE created_at BETWEEN ? AND ?
  `).get(startStr, endStr) as any;

  const totalCost = rows?.total_cost ?? 0;
  const averageCostPerTest = rows?.avg_cost_per_test ?? 0;
  const totalTests = rows?.test_count ?? 0;

  const breakdown: CostBreakdown = {
    llmProcessing: totalCost * 0.3,
    computeResources: totalCost * 0.35,
    storage: totalCost * 0.2,
    dataTransfer: totalCost * 0.15,
    total: totalCost,
  };

  const trends = getDailyCostTrends(60);
  const recommendations = generateCostRecommendations();
  const topExpensiveTests = getTopExpensiveTests(5);

  return {
    period: `Weekly (${startStr} to ${endStr})`,
    totalCost,
    averageCostPerTest,
    totalTests,
    costBreakdown: breakdown,
    trends,
    recommendations,
    topExpensiveTests,
  };
}

/**
 * Generates monthly cost report
 */
export function generateMonthlyCostReport(monthOffset: number = 0): CostReport {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth() - monthOffset, 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() - monthOffset + 1, 0);

  const startStr = monthStart.toISOString().split('T')[0];
  const endStr = monthEnd.toISOString().split('T')[0];

  const rows = db.prepare(`
    SELECT 
      SUM(actual_cost) as total_cost,
      AVG(cost_per_test) as avg_cost_per_test,
      COUNT(*) as test_count
    FROM execution_costs
    WHERE created_at BETWEEN ? AND ?
  `).get(startStr, endStr) as any;

  const totalCost = rows?.total_cost ?? 0;
  const averageCostPerTest = rows?.avg_cost_per_test ?? 0;
  const totalTests = rows?.test_count ?? 0;

  const breakdown: CostBreakdown = {
    llmProcessing: totalCost * 0.3,
    computeResources: totalCost * 0.35,
    storage: totalCost * 0.2,
    dataTransfer: totalCost * 0.15,
    total: totalCost,
  };

  const trends = getDailyCostTrends(90);
  const recommendations = generateCostRecommendations();
  const topExpensiveTests = getTopExpensiveTests(5);

  return {
    period: `Monthly (${monthStart.toLocaleDateString()})`,
    totalCost,
    averageCostPerTest,
    totalTests,
    costBreakdown: breakdown,
    trends,
    recommendations,
    topExpensiveTests,
  };
}

/**
 * Gets daily cost trends
 */
export function getDailyCostTrends(days: number = 30): CostTrend[] {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const rows = db.prepare(`
    SELECT 
      DATE(created_at) as date_key,
      SUM(actual_cost) as total_cost,
      COUNT(*) as test_count,
      AVG(cost_per_test) as avg_cost_per_test
    FROM execution_costs
    WHERE DATE(created_at) >= ?
    GROUP BY date_key
    ORDER BY date_key ASC
  `).all(since) as any[];

  return rows.map(row => ({
    date: row.date_key,
    cost: row.total_cost,
    testCount: row.test_count,
    costPerTest: row.avg_cost_per_test,
  }));
}

/**
 * Gets top expensive tests
 */
export function getTopExpensiveTests(limit: number = 10): ExpensiveTest[] {
  const rows = db.prepare(`
    SELECT 
      run_id,
      actual_cost as cost
    FROM execution_costs
    ORDER BY actual_cost DESC
    LIMIT ?
  `).all(limit) as any[];

  return rows.map((row, idx) => ({
    testId: row.run_id,
    cost: row.cost,
    category: "Execution",
    savings: undefined,
  }));
}

/**
 * Analyzes cost per test category
 */
export function analyzeCostByCategory(): Record<string, { totalCost: number; testCount: number; avgCost: number }> {
  // This would need to be enhanced with actual test category tracking
  const rows = db.prepare(`
    SELECT 
      COUNT(*) as test_count,
      SUM(actual_cost) as total_cost,
      AVG(cost_per_test) as avg_cost_per_test
    FROM execution_costs
    GROUP BY strftime('%Y-%m-%d', created_at)
  `).all() as any[];

  const result: Record<string, any> = {
    Smoke: { totalCost: 0, testCount: 0, avgCost: 0 },
    Functional: { totalCost: 0, testCount: 0, avgCost: 0 },
    Regression: { totalCost: 0, testCount: 0, avgCost: 0 },
  };

  for (const row of rows) {
    const category = 'Smoke'; // Placeholder
    result[category].totalCost += row.total_cost || 0;
    result[category].testCount += row.test_count || 0;
    result[category].avgCost = result[category].testCount > 0 
      ? result[category].totalCost / result[category].testCount 
      : 0;
  }

  return result;
}

/**
 * Generates cost optimization opportunities
 */
export function generateCostOptimizations(): CostOptimization[] {
  const optimizations: CostOptimization[] = [];

  // Get current average cost
  const stats = db.prepare(`
    SELECT AVG(cost_per_test) as avg_cost FROM execution_costs
  `).get() as any;

  const currentAvgCost = stats?.avg_cost ?? 0.15;

  // Optimization 1: Use Incremental Crawling
  optimizations.push({
    name: "Enable Incremental Crawling",
    currentCost: currentAvgCost * 10,
    optimizedCost: currentAvgCost * 4,
    savings: currentAvgCost * 6,
    savingsPercent: 60,
    effort: "low",
    description: "Skip unchanged pages on repeat crawls. Saves 60% cost on repeat runs.",
  });

  // Optimization 2: Use Fast Mode
  optimizations.push({
    name: "Switch to Fast Mode",
    currentCost: currentAvgCost * 100,
    optimizedCost: currentAvgCost * 25,
    savings: currentAvgCost * 75,
    savingsPercent: 75,
    effort: "low",
    description: "Reduce test scope intelligently. Maintains 70% coverage.",
  });

  // Optimization 3: Reduce Assertions
  optimizations.push({
    name: "Optimize Assertions",
    currentCost: currentAvgCost * 100,
    optimizedCost: currentAvgCost * 85,
    savings: currentAvgCost * 15,
    savingsPercent: 15,
    effort: "medium",
    description: "Remove redundant assertions. Keep critical validations.",
  });

  // Optimization 4: Use Smoke Preset
  optimizations.push({
    name: "Use Smoke Test Preset",
    currentCost: currentAvgCost * 100,
    optimizedCost: currentAvgCost * 20,
    savings: currentAvgCost * 80,
    savingsPercent: 80,
    effort: "low",
    description: "Run only smoke tests for quick feedback. Fast and cheap.",
  });

  return optimizations;
}

/**
 * Generates cost recommendations based on analysis
 */
export function generateCostRecommendations(): string[] {
  const recommendations: string[] = [];

  // Get cost statistics
  const stats = db.prepare(`
    SELECT 
      AVG(cost_per_test) as avg_cost,
      MAX(cost_per_test) as max_cost,
      COUNT(*) as run_count
    FROM execution_costs
    WHERE created_at >= datetime('now', '-7 days')
  `).get() as any;

  const avgCost = stats?.avg_cost ?? 0;
  const maxCost = stats?.max_cost ?? 0;

  // Recommendation 1: Cost trending
  if (maxCost > avgCost * 1.5) {
    recommendations.push("⚠️ Some tests are significantly more expensive. Review and optimize them.");
  }

  // Recommendation 2: Volume
  if (stats?.run_count > 50) {
    recommendations.push("💡 High test volume detected. Consider using Fast Mode for cost control.");
  }

  // Recommendation 3: Incremental crawling
  if (stats?.run_count > 20) {
    recommendations.push("💡 Frequent runs detected. Enable Incremental Crawling to save 60% on repeats.");
  }

  return recommendations;
}

/**
 * Calculates cost forecast for next period
 */
export function forecastCost(daysAhead: number = 7): {
  forecastedCost: number;
  confidence: number;
  trend: "increasing" | "decreasing" | "stable";
} {
  const recentCosts = db.prepare(`
    SELECT actual_cost FROM execution_costs
    WHERE created_at >= datetime('now', '-7 days')
    ORDER BY created_at DESC
  `).all() as any[];

  if (recentCosts.length < 3) {
    return { forecastedCost: 0, confidence: 0, trend: "stable" };
  }

  const avgCost = recentCosts.reduce((sum, r) => sum + r.actual_cost, 0) / recentCosts.length;
  const trend = recentCosts[0].actual_cost > avgCost ? "increasing" : "decreasing";

  return {
    forecastedCost: avgCost * daysAhead,
    confidence: 0.75,
    trend,
  };
}
