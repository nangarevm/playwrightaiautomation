import { db } from "../db.js";

export type ModelType = "gpt-3.5" | "gpt-4" | "claude-haiku" | "claude-opus";

export interface ModelCost {
  inputTokens: number;
  outputTokens: number;
  model: ModelType;
  totalCost: number;
}

export interface ModelStats {
  model: ModelType;
  usageCount: number;
  totalTokens: number;
  totalCost: number;
  averageTokens: number;
  successRate: number;
}

export interface ModelRoutingDecision {
  model: ModelType;
  complexity: number;
  reason: string;
  estimatedCost: number;
  fallback: ModelType;
}

const MODEL_PRICING: Record<ModelType, { input: number; output: number }> = {
  "gpt-3.5": { input: 0.0005 / 1000, output: 0.0015 / 1000 },
  "gpt-4": { input: 0.03 / 1000, output: 0.06 / 1000 },
  "claude-haiku": { input: 0.008 / 1000, output: 0.024 / 1000 },
  "claude-opus": { input: 0.075 / 1000, output: 0.225 / 1000 },
};

const COMPLEXITY_THRESHOLDS = {
  simple: 0.3,
  moderate: 0.6,
  complex: 1.0,
};

let modelStats = new Map<ModelType, ModelStats>();

function ensureStatsTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_routing_stats (
      id TEXT PRIMARY KEY,
      model TEXT NOT NULL,
      usage_count INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      total_cost REAL DEFAULT 0,
      success_count INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      UNIQUE(model)
    );
  `);
}

export function estimateComplexity(pageContent: string): number {
  const elementCount = (pageContent.match(/<[^>]+>/g) || []).length;
  const interactiveCount = (pageContent.match(/<(button|input|select|textarea|form)/gi) || []).length;
  const scriptCount = (pageContent.match(/<script/gi) || []).length;
  const styleCount = (pageContent.match(/<style|<link[^>]*stylesheet/gi) || []).length;

  const elementDensity = Math.min(1, elementCount / 500);
  const interactiveDensity = Math.min(1, interactiveCount / 50);
  const dynamicComplexity = Math.min(1, (scriptCount + styleCount) / 20);

  const complexity = (elementDensity * 0.4 + interactiveDensity * 0.35 + dynamicComplexity * 0.25);
  return Math.min(1, complexity);
}

export function selectModel(
  pageType: "api" | "form" | "interactive" | "static" | "ecommerce" | "saas" = "static",
  complexity: number = 0.5
): ModelRoutingDecision {
  let selectedModel: ModelType;
  let reason = "";

  if (complexity < COMPLEXITY_THRESHOLDS.simple) {
    selectedModel = "gpt-3.5";
    reason = `Simple ${pageType} - using fastest/cheapest model`;
  } else if (complexity < COMPLEXITY_THRESHOLDS.moderate) {
    if (pageType === "api") {
      selectedModel = "claude-haiku";
      reason = "Moderate API complexity - Claude Haiku optimized for APIs";
    } else {
      selectedModel = "gpt-3.5";
      reason = `Moderate ${pageType} - GPT-3.5 sufficient`;
    }
  } else {
    if (pageType === "ecommerce" || pageType === "saas") {
      selectedModel = "gpt-4";
      reason = `Complex ${pageType} - GPT-4 for accuracy`;
    } else if (pageType === "api") {
      selectedModel = "claude-haiku";
      reason = "Complex API - Claude Haiku handles APIs well";
    } else {
      selectedModel = "gpt-4";
      reason = `Complex ${pageType} - need GPT-4 capability`;
    }
  }

  const estimatedCost = estimateModelCost("", selectedModel);
  const fallback = selectedModel === "gpt-4" ? "gpt-3.5" : "gpt-3.5";

  return {
    model: selectedModel,
    complexity,
    reason,
    estimatedCost,
    fallback,
  };
}

export function estimateModelCost(
  prompt: string,
  model: ModelType
): number {
  const avgInputTokens = prompt.split(/\s+/).length * 1.3;
  const estimatedOutputTokens = 500;

  const pricing = MODEL_PRICING[model];
  return avgInputTokens * pricing.input + estimatedOutputTokens * pricing.output;
}

export function calculateTokenCost(
  inputTokens: number,
  outputTokens: number,
  model: ModelType
): number {
  const pricing = MODEL_PRICING[model];
  return inputTokens * pricing.input + outputTokens * pricing.output;
}

export function recordModelUsage(
  model: ModelType,
  inputTokens: number,
  outputTokens: number,
  success: boolean = true
): void {
  try {
    ensureStatsTable();
    const cost = calculateTokenCost(inputTokens, outputTokens, model);

    db.prepare(`
      INSERT INTO model_routing_stats 
      (id, model, usage_count, total_tokens, total_cost, success_count, created_at)
      VALUES (?, ?, 1, ?, ?, ?, ?)
      ON CONFLICT(model) DO UPDATE SET
        usage_count = usage_count + 1,
        total_tokens = total_tokens + excluded.total_tokens,
        total_cost = total_cost + excluded.total_cost,
        success_count = CASE WHEN ? THEN success_count + 1 ELSE success_count END
    `).run(model, model, inputTokens + outputTokens, cost, success ? 1 : 0, Date.now(), success ? 1 : 0);

    modelStats.delete(model);
  } catch (error) {
    console.error("[modelRoutingService] Error recording usage:", error);
  }
}

export function fallbackModel(primaryModel: ModelType): ModelType {
  const fallbacks: Record<ModelType, ModelType> = {
    "gpt-4": "gpt-3.5",
    "gpt-3.5": "claude-haiku",
    "claude-opus": "claude-haiku",
    "claude-haiku": "gpt-3.5",
  };
  return fallbacks[primaryModel];
}

export function getModelMetrics(): Record<ModelType, ModelStats> {
  try {
    ensureStatsTable();
    const rows = db.prepare("SELECT * FROM model_routing_stats").all() as any[];

    const metrics: Record<ModelType, ModelStats> = {} as any;

    for (const row of rows) {
      const model = row.model as ModelType;
      metrics[model] = {
        model,
        usageCount: row.usage_count,
        totalTokens: row.total_tokens,
        totalCost: row.total_cost,
        averageTokens: row.usage_count > 0 ? row.total_tokens / row.usage_count : 0,
        successRate: row.usage_count > 0 ? row.success_count / row.usage_count : 0,
      };
    }

    return metrics;
  } catch (error) {
    console.error("[modelRoutingService] Error getting metrics:", error);
    return {} as any;
  }
}

export function getModelComparison(): {
  cheapest: ModelType;
  fastest: ModelType;
  mostAccurate: ModelType;
  recommended: ModelType;
} {
  const metrics = getModelMetrics();
  let cheapest = "gpt-3.5" as ModelType;
  let mostUsed = "gpt-3.5" as ModelType;

  let minCost = Infinity;
  let maxUsage = 0;

  for (const [model, stat] of Object.entries(metrics)) {
    if (stat.totalCost < minCost) {
      minCost = stat.totalCost;
      cheapest = model as ModelType;
    }
    if (stat.usageCount > maxUsage) {
      maxUsage = stat.usageCount;
      mostUsed = model as ModelType;
    }
  }

  return {
    cheapest,
    fastest: "gpt-3.5",
    mostAccurate: "gpt-4",
    recommended: mostUsed,
  };
}

export function resetModelStats(): void {
  try {
    ensureStatsTable();
    db.prepare("DELETE FROM model_routing_stats").run();
    modelStats.clear();
  } catch (error) {
    console.error("[modelRoutingService] Error resetting stats:", error);
  }
}

export function setModelRoutingFeatureFlag(enabled: boolean): void {
  process.env.MODEL_ROUTING_ENABLED = String(enabled);
}

export function isModelRoutingEnabled(): boolean {
  return process.env.MODEL_ROUTING_ENABLED !== "false";
}

export function getModelPricing(): Record<ModelType, { input: number; output: number }> {
  return MODEL_PRICING;
}
