/**
 * Optimization API Routes (Phases 1-4)
 * 
 * Phase 1: Quick Wins
 * - Timeout Optimization, Parallelization, Test Prioritization
 * 
 * Phase 2: Advanced Optimization
 * - Cache Service, Prompt Optimization, Model Routing
 * 
 * Phase 3: Intelligent Execution
 * - Incremental Testing, ML Prioritization, Distributed Execution
 * 
 * Phase 4: Advanced Features
 * - Self-Learning, Adaptive Strategy, Predictive Optimization
 */

import express, { Router } from "express";
import { getConcurrencyStats } from "../services/parallelExecutionService.js";
import { getTestSelectionStats, getDefaultPrioritizationConfig } from "../services/testPrioritizationService.js";
import { getTimeoutStats } from "../services/timeoutOptimizationService.js";
import { getCacheStats, isCacheEnabled, setCacheFeatureFlag } from "../services/cacheService.js";
import { isPromptOptimizationEnabled, setPromptOptimizationFeatureFlag, getOptimizationConfig } from "../services/promptOptimizationService.js";
import { getModelMetrics, isModelRoutingEnabled, setModelRoutingFeatureFlag, getModelComparison } from "../services/modelRoutingService.js";
import { getIncrementalStats, isIncrementalTestingEnabled, setIncrementalTestingFeatureFlag } from "../services/incrementalTestingService.js";
import { getModelAccuracy, isMLPrioritizationEnabled, setMLPrioritizationFeatureFlag } from "../services/mlPrioritizationService.js";
import { getNodeMetrics, isDistributedExecutionEnabled, setDistributedExecutionFeatureFlag } from "../services/distributedExecutionService.js";
import { getLearningData, isSelfLearningEnabled, setSelfLearningFeatureFlag } from "../services/selfLearningService.js";
import { getAllStrategies, isAdaptiveStrategyEnabled, setAdaptiveStrategyFeatureFlag } from "../services/adaptiveStrategyService.js";
import { isPredictiveOptimizationEnabled, setPredictiveOptimizationFeatureFlag } from "../services/predictiveOptimizationService.js";
import { getCostTransparencySnapshot } from "../services/costTrackingService.js";
import {
  getIncrementalCrawlStats,
  isIncrementalCrawlEnabled,
  setIncrementalCrawlEnabled,
} from "../services/incrementalCrawlService.js";
import {
  getAllFastModeProfiles,
  getFastModeProfiles,
  getFastModeStats,
  type FastModeProfile,
} from "../services/fastModeService.js";
import {
  getAllPresets,
  applyPreset,
  type PresetId,
} from "../services/testPresetService.js";
import { db } from "../db.js";

export const optimizationRouter = Router();

/**
 * GET /api/optimization/status
 * 
 * Returns current optimization status and configuration
 */
optimizationRouter.get("/status", (req, res) => {
  const enabled = process.env.OPTIMIZATION_ENABLED !== "false";
  const concurrencyStats = getConcurrencyStats();
  const timeoutStats = getTimeoutStats();

  res.json({
    ok: true,
    optimization: {
      enabled,
      phases: {
        phase1: {
          enabled,
          name: "Quick Wins",
          strategies: [
            { name: "Timeout Optimization", enabled, impact: "25-35% faster" },
            { name: "Parallelization", enabled, impact: "workers capped at 5" },
            { name: "Test Prioritization", enabled, impact: "30-40% fewer tests" },
          ],
        },
        phase2: {
          enabled: isCacheEnabled() || isPromptOptimizationEnabled() || isModelRoutingEnabled(),
          name: "Cache / Prompts / Model Routing",
        },
        phase3: {
          enabled:
            isIncrementalTestingEnabled() ||
            isMLPrioritizationEnabled() ||
            isDistributedExecutionEnabled(),
          name: "Incremental / ML / Distributed",
        },
        phase4: {
          enabled:
            isSelfLearningEnabled() ||
            isAdaptiveStrategyEnabled() ||
            isPredictiveOptimizationEnabled(),
          name: "Self-Learning / Adaptive / Predictive",
        },
      },
      performance: {
        concurrency: concurrencyStats,
        timeouts: {
          strategies: timeoutStats.length,
          estimatedSavings: `${timeoutStats.reduce((sum, s) => sum + s.estimatedSavingsMs, 0) / 1000}s total`,
        },
      },
      environment: {
        OPTIMIZATION_ENABLED: process.env.OPTIMIZATION_ENABLED ?? "true",
      },
    },
  });
});

/**
 * POST /api/optimization/toggle
 * 
 * Enable or disable Phase 1 optimizations
 * Body: { enabled: boolean }
 */
optimizationRouter.post("/toggle", (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== "boolean") {
    return res.status(400).json({ ok: false, error: "enabled must be boolean" });
  }

  // Note: In production, this should update persistent configuration
  // For now, we're updating the environment variable
  process.env.OPTIMIZATION_ENABLED = String(enabled);

  res.json({
    ok: true,
    optimization: {
      enabled,
      message: enabled ? "Phase 1 optimizations ENABLED" : "Phase 1 optimizations DISABLED",
      note: "Changes take effect on next run",
    },
  });
});

/**
 * GET /api/optimization/metrics
 * 
 * Get detailed performance metrics for Phase 1 optimizations
 */
optimizationRouter.get("/metrics", (req, res) => {
  const enabled = process.env.OPTIMIZATION_ENABLED !== "false";

  // Get execution statistics
  const recentRuns = db.prepare(`
    SELECT 
      duration_ms, 
      concurrency,
      selection_mode,
      actual_worker_count,
      created_at
    FROM execution_runs
    WHERE created_at > datetime('now', '-24 hours')
    ORDER BY created_at DESC
    LIMIT 100
  `).all() as any[];

  // Calculate metrics
  const avgDuration = recentRuns.length > 0 
    ? recentRuns.reduce((sum, r) => sum + (r.duration_ms || 0), 0) / recentRuns.length 
    : 0;

  const avgConcurrency = recentRuns.length > 0
    ? recentRuns.reduce((sum, r) => sum + (r.actual_worker_count || r.concurrency || 1), 0) / recentRuns.length
    : 1;

  // Calculate time savings (if we have baseline)
  const baselineEstimate = 3000000; // 50 minutes in milliseconds
  const timeSavings = Math.max(0, baselineEstimate - avgDuration);
  const timeSavingsPercent = Math.round((timeSavings / baselineEstimate) * 100);

  res.json({
    ok: true,
    metrics: {
      enabled,
      recentRuns: recentRuns.length,
      averageDurationMs: Math.round(avgDuration),
      averageDurationMinutes: Math.round(avgDuration / 60000 * 10) / 10,
      averageConcurrency: Math.round(avgConcurrency * 10) / 10,
      estimatedTimeSavingsMs: Math.round(timeSavings),
      estimatedTimeSavingsPercent: timeSavingsPercent,
      strategies: {
        timeoutOptimization: {
          status: enabled ? "active" : "inactive",
          expectedImprovement: "25-35% faster page loads",
        },
        parallelization: {
          status: enabled ? "active" : "inactive",
          expectedImprovement: "40-50% faster test execution",
          currentConcurrency: Math.round(avgConcurrency),
          maxConcurrency: 5,
        },
        testPrioritization: {
          status: enabled ? "active" : "inactive",
          expectedImprovement: "30-40% fewer tests, same bug detection",
        },
      },
    },
    // Flat fields consumed by LiveMonitoringBridge / Costs hub
    todayCost: Number(((recentRuns.length || 0) * 0.08).toFixed(2)),
    costSaved: Number((Math.max(0, timeSavings) / 3600000 * 40).toFixed(2)),
    estimatedCostSaved: Number((Math.max(0, timeSavings) / 3600000 * 40).toFixed(2)),
  });
});

/**
 * GET /api/optimization/config
 * 
 * Get current Phase 1 configuration
 */
optimizationRouter.get("/config", (req, res) => {
  const prioritizationConfig = getDefaultPrioritizationConfig();

  res.json({
    ok: true,
    config: {
      phase: 1,
      enabled: process.env.OPTIMIZATION_ENABLED !== "false",
      strategies: {
        timeoutOptimization: {
          enabled: true,
          description: "Smart page type detection and timeout optimization",
          pageTypes: ["api", "spa", "static", "slow", "unknown"],
        },
        parallelization: {
          enabled: true,
          description: "Dynamic concurrency management (capped at 5 workers)",
          minConcurrency: 5,
          maxConcurrency: 5,
          defaultConcurrency: 5,
        },
        testPrioritization: {
          enabled: true,
          description: "Smart test selection (100→30 tests)",
          weights: prioritizationConfig,
        },
      },
    },
  });
});

/**
 * GET /api/optimization/recommendations
 * 
 * Get optimization recommendations based on recent runs
 */
optimizationRouter.get("/recommendations", (req, res) => {
  const recentRuns = db.prepare(`
    SELECT 
      duration_ms, 
      status,
      actual_worker_count,
      browser_launch_count
    FROM execution_runs
    WHERE created_at > datetime('now', '-7 days')
    LIMIT 50
  `).all() as any[];

  const recommendations: string[] = [];

  if (recentRuns.length === 0) {
    recommendations.push("No recent runs to analyze. Run tests to generate recommendations.");
  } else {
    const avgDuration = recentRuns.reduce((sum, r) => sum + (r.duration_ms || 0), 0) / recentRuns.length;
    const avgWorkers = recentRuns.reduce((sum, r) => sum + (r.actual_worker_count || 1), 0) / recentRuns.length;

    if (avgDuration > 2400000) {
      recommendations.push("Increase parallelization: Tests running slower than expected");
    }

    if (avgWorkers < 5) {
      recommendations.push("Workers are below the project cap of 5 — set profile concurrency to 5 for full throughput");
    }

    const failedRuns = recentRuns.filter(r => r.status === "failed").length;
    if (failedRuns / recentRuns.length > 0.2) {
      recommendations.push("High failure rate detected. Consider disabling optimizations to troubleshoot.");
    }

    if (recommendations.length === 0) {
      recommendations.push("Performance is good! Phase 1 optimizations are working as expected.");
    }
  }

  res.json({
    ok: true,
    recommendations,
    analysisWindow: "7 days",
    runsAnalyzed: recentRuns.length,
  });
});

optimizationRouter.get("/phase2/cache", (req, res) => {
  const stats = getCacheStats();
  res.json({
    ok: true,
    phase2: {
      cache: {
        enabled: isCacheEnabled(),
        stats,
        expectedSavings: "50-70% on repeat crawls",
      },
    },
  });
});

optimizationRouter.get("/phase2/prompts", (req, res) => {
  const config = getOptimizationConfig();
  res.json({
    ok: true,
    phase2: {
      promptOptimization: {
        enabled: isPromptOptimizationEnabled(),
        config,
        expectedSavings: "20-30% token reduction",
      },
    },
  });
});

optimizationRouter.get("/phase2/models", (req, res) => {
  const metrics = getModelMetrics();
  const comparison = getModelComparison();
  res.json({
    ok: true,
    phase2: {
      modelRouting: {
        enabled: isModelRoutingEnabled(),
        metrics,
        comparison,
        expectedSavings: "40-50% cost reduction",
      },
    },
  });
});

optimizationRouter.get("/phase3/incremental", (req, res) => {
  const stats = getIncrementalStats();
  res.json({
    ok: true,
    phase3: {
      incrementalTesting: {
        enabled: isIncrementalTestingEnabled(),
        stats,
        expectedSavings: "60-70% on repeat crawls",
      },
    },
  });
});

optimizationRouter.get("/phase3/ml", (req, res) => {
  const accuracy = getModelAccuracy();
  res.json({
    ok: true,
    phase3: {
      mlPrioritization: {
        enabled: isMLPrioritizationEnabled(),
        accuracy,
        expectedImprovement: "5-10% bug detection",
      },
    },
  });
});

optimizationRouter.get("/phase3/distributed", (req, res) => {
  const nodeMetrics = getNodeMetrics();
  res.json({
    ok: true,
    phase3: {
      distributedExecution: {
        enabled: isDistributedExecutionEnabled(),
        nodes: nodeMetrics,
        expectedImprovement: "60%+ faster for large suites",
      },
    },
  });
});

optimizationRouter.get("/phase4/learning", (req, res) => {
  const data = getLearningData();
  res.json({
    ok: true,
    phase4: {
      selfLearning: {
        enabled: isSelfLearningEnabled(),
        learningData: data,
        expectedImprovement: "10-15% continuous improvement",
      },
    },
  });
});

optimizationRouter.get("/phase4/adaptive", (req, res) => {
  const strategies = getAllStrategies();
  res.json({
    ok: true,
    phase4: {
      adaptiveStrategy: {
        enabled: isAdaptiveStrategyEnabled(),
        strategies,
        expectedImprovement: "5-8% overall optimization",
      },
    },
  });
});

optimizationRouter.get("/phase4/predictive", (req, res) => {
  res.json({
    ok: true,
    phase4: {
      predictiveOptimization: {
        enabled: isPredictiveOptimizationEnabled(),
        expectedImprovement: "3-5% better resource allocation",
      },
    },
  });
});

optimizationRouter.post("/toggle-phase/:phase", (req, res) => {
  const { phase } = req.params;
  const { enabled } = req.body;

  if (typeof enabled !== "boolean") {
    return res.status(400).json({ ok: false, error: "enabled must be boolean" });
  }

  try {
    switch (phase) {
      case "2":
        setCacheFeatureFlag(enabled);
        setPromptOptimizationFeatureFlag(enabled);
        setModelRoutingFeatureFlag(enabled);
        break;
      case "3":
        setIncrementalTestingFeatureFlag(enabled);
        setMLPrioritizationFeatureFlag(enabled);
        setDistributedExecutionFeatureFlag(enabled);
        break;
      case "4":
        setSelfLearningFeatureFlag(enabled);
        setAdaptiveStrategyFeatureFlag(enabled);
        setPredictiveOptimizationFeatureFlag(enabled);
        break;
      default:
        return res.status(400).json({ ok: false, error: "Invalid phase" });
    }

    res.json({
      ok: true,
      phase,
      enabled,
      message: `Phase ${phase} optimizations ${enabled ? "ENABLED" : "DISABLED"}`,
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error) });
  }
});

optimizationRouter.get("/all-phases", (req, res) => {
  res.json({
    ok: true,
    phases: {
      phase1: {
        enabled: process.env.OPTIMIZATION_ENABLED !== "false",
        name: "Quick Wins (Timeout, Parallelization, Test Prioritization)",
        impact: "Workers=5 + smart selection + timeouts (live)",
      },
      phase2: {
        enabled:
          isCacheEnabled() ||
          isPromptOptimizationEnabled() ||
          isModelRoutingEnabled(),
        name: "Advanced Optimization (Cache, Prompts, Model Routing)",
        impact: "Wired into codegen + crawler cache (live)",
      },
      phase3: {
        enabled:
          isIncrementalTestingEnabled() ||
          isMLPrioritizationEnabled() ||
          isDistributedExecutionEnabled(),
        name: "Intelligent Execution (Incremental, ML Priority, Distributed)",
        impact: "Wired into smart-selection + post-run learning (live)",
      },
      phase4: {
        enabled:
          isSelfLearningEnabled() ||
          isAdaptiveStrategyEnabled() ||
          isPredictiveOptimizationEnabled(),
        name: "Advanced Features (Self-Learning, Adaptive, Predictive)",
        impact: "Post-run hooks on every completed execution (live)",
      },
    },
    note: "Percentages below are aspirational planning targets, not guaranteed E2E measurements.",
    combinedImpact: {
      time: "Target: large suite with workers=5 (not a fixed 6-minute claim)",
      cost: "Savings scale with cache hits + incremental + smart selection",
      bugDetection: "Improves as ML/self-learning accumulate outcomes",
      workersCap: 5,
    },
  });
});

// ─── Features 9–12 (Costs hub) ─────────────────────────────────────────────

optimizationRouter.get("/features/costs", (_req, res) => {
  const snapshot = getCostTransparencySnapshot();
  res.json({ ok: true, isLive: true, data: snapshot });
});

optimizationRouter.get("/features/incremental", (_req, res) => {
  const stats = getIncrementalCrawlStats();
  res.json({
    ok: true,
    isLive: true,
    data: {
      isEnabled: stats.isEnabled,
      pagesScanned: stats.pagesScanned,
      totalPages: stats.totalPages,
      changedPages: stats.changedPages,
      reusePercentage: stats.reusePercentage,
      costSavings: stats.totalCostSavings,
      lastBaselineDate: stats.lastBaselineDate,
      strategyRecommendation: stats.strategyRecommendation,
      isOptimal: stats.isOptimal,
      totalCrawls: stats.totalCrawls,
      incrementalCrawls: stats.incrementalCrawls,
    },
  });
});

optimizationRouter.post("/features/incremental/toggle", (req, res) => {
  const enabled = req.body?.enabled;
  if (typeof enabled !== "boolean") {
    return res.status(400).json({ ok: false, error: "enabled must be boolean" });
  }
  setIncrementalCrawlEnabled(enabled);
  res.json({
    ok: true,
    isEnabled: isIncrementalCrawlEnabled(),
    message: enabled
      ? "Incremental crawl ON — re-crawls will use diff mode by default"
      : "Incremental crawl OFF — re-crawls force full mode",
  });
});

optimizationRouter.get("/features/fast-mode", (_req, res) => {
  const profiles = getAllFastModeProfiles();
  const active = (process.env.FAST_MODE_PROFILE as FastModeProfile) || "balanced";
  res.json({
    ok: true,
    isLive: true,
    active,
    profiles,
    stats: getFastModeStats(),
    workersCap: 5,
  });
});

optimizationRouter.post("/features/fast-mode/apply", (req, res) => {
  const mode = req.body?.mode as FastModeProfile;
  if (!mode || !["critical", "balanced", "full"].includes(mode)) {
    return res.status(400).json({ ok: false, error: "mode must be critical|balanced|full" });
  }
  process.env.FAST_MODE_PROFILE = mode;
  const config = getFastModeProfiles()[mode];
  const selectionMode =
    mode === "full" ? "full-suite" : mode === "critical" ? "smart-selection" : "smart-selection";

  // Update default / first profile concurrency=5 and selection mode
  const profile = db
    .prepare("SELECT id FROM execution_profiles ORDER BY created_at ASC LIMIT 1")
    .get() as { id: string } | undefined;
  if (profile) {
    db.prepare(
      `UPDATE execution_profiles
       SET concurrency = 5, selection_mode = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(selectionMode, profile.id);
  }

  res.json({
    ok: true,
    applied: mode,
    config: { ...config, parallelization: 5 },
    profileUpdated: profile?.id || null,
    selectionMode,
    message: `Fast mode "${mode}" applied (workers capped at 5)`,
  });
});

optimizationRouter.get("/features/presets", (_req, res) => {
  res.json({ ok: true, isLive: true, presets: getAllPresets(), workersCap: 5 });
});

optimizationRouter.post("/features/presets/start", (req, res) => {
  const presetId = (req.body?.preset || "quick") as PresetId;
  try {
    const config = applyPreset(presetId);
    process.env.FAST_MODE_PROFILE =
      presetId === "smoke" || presetId === "quick" || presetId === "incremental"
        ? presetId === "smoke"
          ? "critical"
          : "balanced"
        : "full";
    if (config.withIncrementalCrawl) {
      setIncrementalCrawlEnabled(true);
    }

    const selectionMode =
      presetId === "full" || presetId === "nightly"
        ? "full-suite"
        : presetId === "incremental"
          ? "smart-selection"
          : "smart-selection";

    const profile = db
      .prepare("SELECT id FROM execution_profiles ORDER BY created_at ASC LIMIT 1")
      .get() as { id: string } | undefined;
    if (profile) {
      db.prepare(
        `UPDATE execution_profiles
         SET concurrency = 5, selection_mode = ?, updated_at = datetime('now')
         WHERE id = ?`
      ).run(selectionMode, profile.id);
    }

    // Queue a batch of latest scripts (non-blocking kickoff via IDs for client)
    const scripts = db
      .prepare(
        `SELECT a.id FROM automation_scripts a
         INNER JOIN (
           SELECT test_case_id, MAX(created_at) as latest
           FROM automation_scripts GROUP BY test_case_id
         ) t ON a.test_case_id = t.test_case_id AND a.created_at = t.latest
         ORDER BY a.created_at DESC LIMIT 200`
      )
      .all() as Array<{ id: string }>;

    res.json({
      ok: true,
      preset: presetId,
      config: { ...config, parallelism: 5 },
      selectionMode,
      profileId: profile?.id || null,
      scriptIds: scripts.map((s) => s.id),
      message: `Preset "${presetId}" ready — run with workers=5`,
    });
  } catch (err: any) {
    res.status(400).json({ ok: false, error: err?.message || String(err) });
  }
});

export default optimizationRouter;
