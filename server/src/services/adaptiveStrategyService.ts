import { db } from "../db.js";

export interface Strategy {
  name: string;
  enabled: boolean;
  priority: number;
  successRate: number;
  parameters: Record<string, any>;
}

export interface StrategyContext {
  pageType: string;
  complexity: number;
  previousSuccessRate: number;
  availableResources: number;
  timeConstraints: number;
}

export interface StrategyHealth {
  strategy: string;
  health: number;
  lastUsed: number;
  successCount: number;
  failureCount: number;
  performance: string;
}

function ensureAdaptiveTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS adaptive_strategies (
      id TEXT PRIMARY KEY,
      strategy_name TEXT UNIQUE,
      enabled INTEGER DEFAULT 1,
      priority INTEGER,
      success_rate REAL,
      parameters_json TEXT,
      last_used INTEGER,
      success_count INTEGER DEFAULT 0,
      failure_count INTEGER DEFAULT 0,
      created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS strategy_switches (
      id TEXT PRIMARY KEY,
      from_strategy TEXT,
      to_strategy TEXT,
      reason TEXT,
      timestamp INTEGER,
      success INTEGER
    );
  `);
}

const DEFAULT_STRATEGIES: Strategy[] = [
  {
    name: "aggressive",
    enabled: true,
    priority: 1,
    successRate: 0.85,
    parameters: { timeout: 3000, concurrency: 4, retries: 1 },
  },
  {
    name: "balanced",
    enabled: true,
    priority: 2,
    successRate: 0.92,
    parameters: { timeout: 5000, concurrency: 2, retries: 2 },
  },
  {
    name: "conservative",
    enabled: true,
    priority: 3,
    successRate: 0.98,
    parameters: { timeout: 10000, concurrency: 1, retries: 3 },
  },
  {
    name: "adaptive",
    enabled: true,
    priority: 4,
    successRate: 0.9,
    parameters: { timeout: 7000, concurrency: 2, retries: 2 },
  },
];

let currentStrategy = "balanced";

export function selectStrategy(context: StrategyContext): string {
  let selectedStrategy = "balanced";

  if (context.complexity > 0.7) {
    selectedStrategy = "conservative";
  } else if (context.complexity < 0.3) {
    selectedStrategy = "aggressive";
  } else if (context.previousSuccessRate < 0.8) {
    selectedStrategy = "conservative";
  } else if (context.previousSuccessRate > 0.95 && context.availableResources > 4) {
    selectedStrategy = "aggressive";
  } else {
    selectedStrategy = "adaptive";
  }

  return selectedStrategy;
}

export function switchStrategy(
  newStrategy: string,
  graceful: boolean = true
): { success: boolean; previousStrategy: string; newStrategy: string; reason?: string } {
  try {
    ensureAdaptiveTable();

    const strategy = DEFAULT_STRATEGIES.find((s) => s.name === newStrategy);
    if (!strategy) {
      return {
        success: false,
        previousStrategy: currentStrategy,
        newStrategy: currentStrategy,
        reason: "Strategy not found",
      };
    }

    const previousStrategy = currentStrategy;
    currentStrategy = newStrategy;

    db.prepare(`
      INSERT INTO strategy_switches
      (id, from_strategy, to_strategy, reason, timestamp, success)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run(
      `switch_${Date.now()}`,
      previousStrategy,
      newStrategy,
      graceful ? "graceful" : "forced",
      Date.now()
    );

    return {
      success: true,
      previousStrategy,
      newStrategy,
    };
  } catch (error) {
    console.error("[adaptiveStrategyService] Error switching strategy:", error);
    return {
      success: false,
      previousStrategy: currentStrategy,
      newStrategy: currentStrategy,
      reason: String(error),
    };
  }
}

export function evaluateStrategy(
  strategy: string,
  metrics: { successRate: number; averageTime: number; resourceUsage: number }
): number {
  let score = 50;

  score += metrics.successRate * 50;

  if (metrics.averageTime < 5000) {
    score += 10;
  } else if (metrics.averageTime < 10000) {
    score += 5;
  }

  if (metrics.resourceUsage < 0.5) {
    score += 10;
  } else if (metrics.resourceUsage < 0.8) {
    score += 5;
  }

  return Math.min(100, score);
}

export function blendStrategies(
  strategy1: string,
  strategy2: string,
  ratio: number
): {
  blendedStrategy: string;
  parameters: Record<string, any>;
  expectedPerformance: string;
} {
  const s1 = DEFAULT_STRATEGIES.find((s) => s.name === strategy1);
  const s2 = DEFAULT_STRATEGIES.find((s) => s.name === strategy2);

  if (!s1 || !s2) {
    return {
      blendedStrategy: "balanced",
      parameters: DEFAULT_STRATEGIES.find((s) => s.name === "balanced")?.parameters || {},
      expectedPerformance: "fallback",
    };
  }

  const blendedParams: Record<string, any> = {};
  for (const key in s1.parameters) {
    const v1 = s1.parameters[key];
    const v2 = s2.parameters[key];

    if (typeof v1 === "number" && typeof v2 === "number") {
      blendedParams[key] = Math.round(v1 * ratio + v2 * (1 - ratio));
    } else {
      blendedParams[key] = ratio > 0.5 ? v1 : v2;
    }
  }

  return {
    blendedStrategy: `blend_${strategy1}_${strategy2}`,
    parameters: blendedParams,
    expectedPerformance: "blended",
  };
}

export function strategyHealth(): StrategyHealth[] {
  try {
    ensureAdaptiveTable();

    const strategies = db.prepare("SELECT * FROM adaptive_strategies").all() as any[];

    return strategies.map((s) => {
      const total = s.success_count + s.failure_count;
      const successRate = total > 0 ? s.success_count / total : 0;

      let performance = "poor";
      if (successRate > 0.95) performance = "excellent";
      else if (successRate > 0.85) performance = "good";
      else if (successRate > 0.7) performance = "fair";

      return {
        strategy: s.strategy_name,
        health: successRate * 100,
        lastUsed: s.last_used,
        successCount: s.success_count,
        failureCount: s.failure_count,
        performance,
      };
    });
  } catch (error) {
    console.error("[adaptiveStrategyService] Error getting health:", error);
    return [];
  }
}

export function recordStrategyResult(
  strategyName: string,
  success: boolean
): void {
  try {
    ensureAdaptiveTable();

    db.prepare(`
      INSERT OR IGNORE INTO adaptive_strategies
      (id, strategy_name, enabled, priority, success_rate, parameters_json, last_used, success_count, failure_count, created_at)
      SELECT ?, strategy_name, enabled, priority, success_rate, parameters_json, ?, success_count + ?, failure_count + ?, created_at
      FROM adaptive_strategies WHERE strategy_name = ?
    `).run(
      strategyName,
      Date.now(),
      success ? 1 : 0,
      success ? 0 : 1,
      strategyName
    );
  } catch (error) {
    console.error("[adaptiveStrategyService] Error recording result:", error);
  }
}

export function getCurrentStrategy(): Strategy | null {
  const strategy = DEFAULT_STRATEGIES.find((s) => s.name === currentStrategy);
  return strategy || null;
}

export function getAllStrategies(): Strategy[] {
  return DEFAULT_STRATEGIES;
}

export function setAdaptiveStrategyFeatureFlag(enabled: boolean): void {
  process.env.ADAPTIVE_STRATEGY_ENABLED = String(enabled);
}

export function isAdaptiveStrategyEnabled(): boolean {
  return process.env.ADAPTIVE_STRATEGY_ENABLED !== "false";
}

export function resetStrategyMetrics(): void {
  try {
    ensureAdaptiveTable();
    db.prepare("DELETE FROM adaptive_strategies").run();
    db.prepare("DELETE FROM strategy_switches").run();
    currentStrategy = "balanced";
  } catch (error) {
    console.error("[adaptiveStrategyService] Error resetting metrics:", error);
  }
}
