// Smart Test Presets Service
// Pre-configured execution profiles for common scenarios

import { db } from "../db.js";
import type { FastModeConfig } from "./fastModeService.js";

export type PresetType = 
  | "smoke"
  | "regression"
  | "full"
  | "ci_cd"
  | "development"
  | "nightly"
  | "custom";

export interface ExecutionPreset {
  id: string;
  name: string;
  description: string;
  type: PresetType;
  isBuiltin: boolean;
  testSelectionStrategy: "smoke-only" | "critical-path" | "all-tests" | "custom";
  parallelWorkers: number;
  timeoutSeconds: number;
  fastModeConfig: FastModeConfig;
  captureArtifacts: "minimal" | "screenshots" | "full" | "video";
  gateOnFailure: boolean;
  retryStrategy: "no-retry" | "failed-only" | "all";
  notifyOnComplete: boolean;
  estimatedDurationSeconds?: number;
  estimatedCost?: number;
  bestFor: string[];
  createdBy?: string;
  isActive: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface PresetComparison {
  preset1: ExecutionPreset;
  preset2: ExecutionPreset;
  differences: Record<string, { preset1Value: any; preset2Value: any }>;
  recommendation: string;
}

// Built-in presets
const BUILTIN_PRESETS: Record<string, ExecutionPreset> = {
  smoke: {
    id: "preset-smoke-builtin",
    name: "Smoke Tests",
    description: "Quick smoke test run for instant feedback",
    type: "smoke",
    isBuiltin: true,
    testSelectionStrategy: "smoke-only",
    parallelWorkers: 2,
    timeoutSeconds: 30,
    fastModeConfig: {
      mode: "performance",
      strategy: "smoke-only",
      parallelWorkers: 2,
      testSelectionPercentage: 20,
      prioritizeSmoke: true,
      prioritizeCritical: false,
      timeoutSeconds: 30,
      resourceLimit: "high",
      estimatedDurationSeconds: 90,
      estimatedCost: 0.15,
    },
    captureArtifacts: "minimal",
    gateOnFailure: false,
    retryStrategy: "no-retry",
    notifyOnComplete: false,
    estimatedDurationSeconds: 90,
    estimatedCost: 0.15,
    bestFor: ["Quick checks", "Pre-commit testing", "Instant feedback"],
    isActive: true,
  },

  regression: {
    id: "preset-regression-builtin",
    name: "Regression Suite",
    description: "Comprehensive regression testing",
    type: "regression",
    isBuiltin: true,
    testSelectionStrategy: "all-tests",
    parallelWorkers: 4,
    timeoutSeconds: 60,
    fastModeConfig: {
      mode: "balanced",
      strategy: "critical-path",
      parallelWorkers: 4,
      testSelectionPercentage: 100,
      prioritizeSmoke: true,
      prioritizeCritical: true,
      timeoutSeconds: 60,
      resourceLimit: "medium",
      estimatedDurationSeconds: 300,
      estimatedCost: 0.60,
    },
    captureArtifacts: "screenshots",
    gateOnFailure: true,
    retryStrategy: "failed-only",
    notifyOnComplete: true,
    estimatedDurationSeconds: 300,
    estimatedCost: 0.60,
    bestFor: ["Daily testing", "Feature verification", "Quality assurance"],
    isActive: true,
  },

  full: {
    id: "preset-full-builtin",
    name: "Full Test Suite",
    description: "Comprehensive testing with all scenarios",
    type: "full",
    isBuiltin: true,
    testSelectionStrategy: "all-tests",
    parallelWorkers: 8,
    timeoutSeconds: 120,
    fastModeConfig: {
      mode: "thorough",
      strategy: "all-tests",
      parallelWorkers: 8,
      testSelectionPercentage: 100,
      prioritizeSmoke: true,
      prioritizeCritical: true,
      timeoutSeconds: 120,
      resourceLimit: "high",
      estimatedDurationSeconds: 300,
      estimatedCost: 1.20,
    },
    captureArtifacts: "video",
    gateOnFailure: true,
    retryStrategy: "all",
    notifyOnComplete: true,
    estimatedDurationSeconds: 300,
    estimatedCost: 1.20,
    bestFor: ["Pre-release validation", "Production readiness", "Complete coverage"],
    isActive: true,
  },

  ci_cd: {
    id: "preset-cicd-builtin",
    name: "CI/CD Pipeline",
    description: "Optimized for CI/CD with fast execution",
    type: "ci_cd",
    isBuiltin: true,
    testSelectionStrategy: "critical-path",
    parallelWorkers: 6,
    timeoutSeconds: 45,
    fastModeConfig: {
      mode: "balanced",
      strategy: "critical-path",
      parallelWorkers: 6,
      testSelectionPercentage: 70,
      prioritizeSmoke: true,
      prioritizeCritical: true,
      timeoutSeconds: 45,
      resourceLimit: "medium",
      estimatedDurationSeconds: 180,
      estimatedCost: 0.45,
    },
    captureArtifacts: "screenshots",
    gateOnFailure: true,
    retryStrategy: "failed-only",
    notifyOnComplete: true,
    estimatedDurationSeconds: 180,
    estimatedCost: 0.45,
    bestFor: ["PR validation", "Branch protection", "Automated checks"],
    isActive: true,
  },

  development: {
    id: "preset-dev-builtin",
    name: "Development Mode",
    description: "Fast testing for active development",
    type: "development",
    isBuiltin: true,
    testSelectionStrategy: "smoke-only",
    parallelWorkers: 3,
    timeoutSeconds: 30,
    fastModeConfig: {
      mode: "performance",
      strategy: "smoke-only",
      parallelWorkers: 3,
      testSelectionPercentage: 40,
      prioritizeSmoke: true,
      prioritizeCritical: false,
      timeoutSeconds: 30,
      resourceLimit: "medium",
      estimatedDurationSeconds: 120,
      estimatedCost: 0.25,
    },
    captureArtifacts: "minimal",
    gateOnFailure: false,
    retryStrategy: "no-retry",
    notifyOnComplete: false,
    estimatedDurationSeconds: 120,
    estimatedCost: 0.25,
    bestFor: ["Local development", "Quick iterations", "Test-driven development"],
    isActive: true,
  },

  nightly: {
    id: "preset-nightly-builtin",
    name: "Nightly Build",
    description: "Comprehensive nightly validation run",
    type: "nightly",
    isBuiltin: true,
    testSelectionStrategy: "all-tests",
    parallelWorkers: 12,
    timeoutSeconds: 180,
    fastModeConfig: {
      mode: "thorough",
      strategy: "all-tests",
      parallelWorkers: 12,
      testSelectionPercentage: 100,
      prioritizeSmoke: true,
      prioritizeCritical: true,
      timeoutSeconds: 180,
      resourceLimit: "high",
      estimatedDurationSeconds: 600,
      estimatedCost: 2.00,
    },
    captureArtifacts: "video",
    gateOnFailure: true,
    retryStrategy: "all",
    notifyOnComplete: true,
    estimatedDurationSeconds: 600,
    estimatedCost: 2.00,
    bestFor: ["Nightly validation", "Full regression", "End-of-day testing"],
    isActive: true,
  },
};

/**
 * Gets a built-in preset
 */
export function getBuiltinPreset(type: PresetType): ExecutionPreset | null {
  const preset = BUILTIN_PRESETS[type];
  return preset ? { ...preset } : null;
}

/**
 * Gets all built-in presets
 */
export function getAllBuiltinPresets(): ExecutionPreset[] {
  return Object.values(BUILTIN_PRESETS).map(p => ({ ...p }));
}

/**
 * Gets preset recommendations based on context
 */
export function recommendPresets(context: {
  timeAvailable?: number;  // seconds
  needsGating?: boolean;
  isScheduled?: boolean;
  isDevelopment?: boolean;
  isCICD?: boolean;
}): ExecutionPreset[] {
  const recommendations: ExecutionPreset[] = [];

  if (context.isDevelopment) {
    recommendations.push(BUILTIN_PRESETS["development"]);
    recommendations.push(BUILTIN_PRESETS["smoke"]);
  } else if (context.isCICD) {
    recommendations.push(BUILTIN_PRESETS["ci_cd"]);
    recommendations.push(BUILTIN_PRESETS["regression"]);
  } else if (context.isScheduled) {
    recommendations.push(BUILTIN_PRESETS["nightly"]);
    recommendations.push(BUILTIN_PRESETS["full"]);
  } else {
    // Default recommendations
    recommendations.push(BUILTIN_PRESETS["regression"]);
    recommendations.push(BUILTIN_PRESETS["smoke"]);
  }

  // Filter by time constraint if provided
  if (context.timeAvailable) {
    return recommendations.filter(p => (p.estimatedDurationSeconds || 0) <= context.timeAvailable!);
  }

  return recommendations;
}

/**
 * Saves custom preset
 */
export function saveCustomPreset(preset: ExecutionPreset): void {
  const now = new Date().toISOString();
  const id = preset.id || `preset-${Date.now()}`;

  db.prepare(`
    INSERT OR REPLACE INTO execution_presets (
      id, name, description, type, is_builtin, test_selection_strategy,
      parallel_workers, timeout_seconds, fast_mode_config_json,
      capture_artifacts, gate_on_failure, retry_strategy, notify_on_complete,
      estimated_duration_seconds, estimated_cost, best_for_json,
      created_by, is_active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    preset.name,
    preset.description,
    preset.type,
    0, // is_builtin = false
    preset.testSelectionStrategy,
    preset.parallelWorkers,
    preset.timeoutSeconds,
    JSON.stringify(preset.fastModeConfig),
    preset.captureArtifacts,
    preset.gateOnFailure ? 1 : 0,
    preset.retryStrategy,
    preset.notifyOnComplete ? 1 : 0,
    preset.estimatedDurationSeconds,
    preset.estimatedCost,
    JSON.stringify(preset.bestFor),
    preset.createdBy,
    preset.isActive ? 1 : 0,
    preset.createdAt || now,
    now
  );
}

/**
 * Gets custom presets
 */
export function getCustomPresets(): ExecutionPreset[] {
  const rows = db.prepare(`
    SELECT * FROM execution_presets WHERE is_builtin = 0 ORDER BY created_at DESC
  `).all() as any[];

  return rows.map(row => ({
    id: row.id,
    name: row.name,
    description: row.description,
    type: row.type,
    isBuiltin: false,
    testSelectionStrategy: row.test_selection_strategy,
    parallelWorkers: row.parallel_workers,
    timeoutSeconds: row.timeout_seconds,
    fastModeConfig: JSON.parse(row.fast_mode_config_json),
    captureArtifacts: row.capture_artifacts,
    gateOnFailure: row.gate_on_failure === 1,
    retryStrategy: row.retry_strategy,
    notifyOnComplete: row.notify_on_complete === 1,
    estimatedDurationSeconds: row.estimated_duration_seconds,
    estimatedCost: row.estimated_cost,
    bestFor: JSON.parse(row.best_for_json),
    createdBy: row.created_by,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

/**
 * Gets all available presets (built-in + custom)
 */
export function getAllPresets(): ExecutionPreset[] {
  const builtin = getAllBuiltinPresets();
  const custom = getCustomPresets();
  return [...builtin, ...custom];
}

/**
 * Deletes a custom preset
 */
export function deleteCustomPreset(presetId: string): void {
  db.prepare("DELETE FROM execution_presets WHERE id = ? AND is_builtin = 0").run(presetId);
}

/**
 * Compares two presets
 */
export function comparePresets(preset1Id: string, preset2Id: string): PresetComparison | null {
  const allPresets = getAllPresets();
  const p1 = allPresets.find(p => p.id === preset1Id);
  const p2 = allPresets.find(p => p.id === preset2Id);

  if (!p1 || !p2) return null;

  const differences: Record<string, any> = {};

  if (p1.testSelectionStrategy !== p2.testSelectionStrategy) {
    differences.strategy = { preset1Value: p1.testSelectionStrategy, preset2Value: p2.testSelectionStrategy };
  }
  if (p1.parallelWorkers !== p2.parallelWorkers) {
    differences.workers = { preset1Value: p1.parallelWorkers, preset2Value: p2.parallelWorkers };
  }
  if (p1.estimatedDurationSeconds !== p2.estimatedDurationSeconds) {
    differences.duration = { preset1Value: p1.estimatedDurationSeconds, preset2Value: p2.estimatedDurationSeconds };
  }
  if (p1.estimatedCost !== p2.estimatedCost) {
    differences.cost = { preset1Value: p1.estimatedCost, preset2Value: p2.estimatedCost };
  }
  if (p1.fastModeConfig.testSelectionPercentage !== p2.fastModeConfig.testSelectionPercentage) {
    differences.coverage = {
      preset1Value: p1.fastModeConfig.testSelectionPercentage,
      preset2Value: p2.fastModeConfig.testSelectionPercentage,
    };
  }

  let recommendation = "Both presets are equivalent";
  if (Object.keys(differences).length > 0) {
    if ((p1.estimatedDurationSeconds || 0) < (p2.estimatedDurationSeconds || 0)) {
      recommendation = `${p1.name} is faster (${p1.estimatedDurationSeconds}s vs ${p2.estimatedDurationSeconds}s)`;
    } else if ((p1.estimatedCost || 0) < (p2.estimatedCost || 0)) {
      recommendation = `${p1.name} is cheaper ($${p1.estimatedCost} vs $${p2.estimatedCost})`;
    }
  }

  return { preset1: p1, preset2: p2, differences, recommendation };
}

/**
 * Gets preset usage statistics
 */
export function getPresetStats(daysBack: number = 30): Record<string, { uses: number; avgDuration: number; avgCost: number }> {
  const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();

  const rows = db.prepare(`
    SELECT 
      'smoke' as preset_type,
      COUNT(*) as uses,
      AVG(duration_ms / 1000) as avg_duration,
      AVG(cost) as avg_cost
    FROM execution_runs
    WHERE created_at >= ?
  `).all(since) as any[];

  const stats: Record<string, any> = {};

  for (const row of rows) {
    stats[row.preset_type] = {
      uses: row.uses,
      avgDuration: row.avg_duration,
      avgCost: row.avg_cost,
    };
  }

  return stats;
}

/**
 * Applies preset to execution configuration
 */
export function applyPreset(presetId: string): ExecutionPreset | null {
  const preset = getAllPresets().find(p => p.id === presetId);
  
  if (!preset || !preset.isActive) {
    return null;
  }

  // Record usage
  db.prepare(`
    INSERT INTO preset_usage (id, preset_id, used_at)
    VALUES (?, ?, ?)
  `).run(`usage-${Date.now()}`, presetId, new Date().toISOString());

  return preset;
}
