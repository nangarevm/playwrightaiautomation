// Fast Mode Tuning Service (FEATURE 11)
// 30% cost for 80% coverage - economy LLM + critical paths

export type FastModeProfile = "critical" | "balanced" | "full";

export interface FastModeConfig {
  profile: FastModeProfile;
  llmTier: "economy" | "standard" | "premium";
  testSelection: "critical_only" | "critical_plus_edge" | "all";
  parallelization: number;
  pageLimit: number;
  timeoutSeconds: number;
  estimatedCost: number;
  estimatedTime: number;
  bugDetectionRate: string;
}

export interface FastModeExecution {
  configId: string;
  profile: FastModeProfile;
  startTime: number;
  endTime: number;
  duration: number;
  testCount: number;
  bugsFound: number;
  cost: number;
  expectedCost: number;
  accuracy: number;
}

/**
 * Get default fast mode configuration
 */
export function getDefaultFastModeConfig(): FastModeConfig {
  return {
    profile: "balanced",
    llmTier: "economy",
    testSelection: "critical_plus_edge",
    parallelization: 5,
    pageLimit: 20,
    timeoutSeconds: 30,
    estimatedCost: 15,
    estimatedTime: 300, // 5 minutes
    bugDetectionRate: "80-85%",
  };
}

/**
 * Get fast mode profile configurations
 */
export function getFastModeProfiles(): Record<FastModeProfile, FastModeConfig> {
  return {
    critical: {
      profile: "critical",
      llmTier: "economy",
      testSelection: "critical_only",
      parallelization: 5,
      pageLimit: 10,
      timeoutSeconds: 20,
      estimatedCost: 4,
      estimatedTime: 120,
      bugDetectionRate: "60-70%",
    },
    balanced: {
      profile: "balanced",
      llmTier: "economy",
      testSelection: "critical_plus_edge",
      parallelization: 5,
      pageLimit: 20,
      timeoutSeconds: 30,
      estimatedCost: 15,
      estimatedTime: 300,
      bugDetectionRate: "80-85%",
    },
    full: {
      profile: "full",
      llmTier: "standard",
      testSelection: "all",
      parallelization: 5,
      pageLimit: 50,
      timeoutSeconds: 60,
      estimatedCost: 50,
      estimatedTime: 900,
      bugDetectionRate: "95-98%",
    },
  };
}

/**
 * Select tests intelligently for fast mode
 */
export function selectTests(
  allTests: any[],
  profile: FastModeProfile
): any[] {
  const profiles = getFastModeProfiles();
  const config = profiles[profile];

  if (config.testSelection === "critical_only") {
    // Only critical path tests
    return allTests.filter(
      (t) => t.criticality === "critical" || t.priority === "high"
    );
  }

  if (config.testSelection === "critical_plus_edge") {
    // Critical + some edge cases
    return allTests.filter(
      (t) =>
        t.criticality === "critical" ||
        t.priority === "high" ||
        (t.priority === "medium" && Math.random() > 0.7)
    );
  }

  // Return all tests
  return allTests;
}

/**
 * Optimize parallel execution
 */
export function optimizeParallelExecution(
  testCount: number,
  profile: FastModeProfile
): {
  batchSize: number;
  batchCount: number;
  parallelism: number;
  expectedDuration: number;
} {
  const profiles = getFastModeProfiles();
  const config = profiles[profile];

  const parallelism = Math.min(config.parallelization, testCount);
  const batchSize = Math.ceil(testCount / parallelism);
  const batchCount = Math.ceil(testCount / batchSize);
  const expectedDuration = (testCount / parallelism) * 30; // 30 sec per test

  return {
    batchSize,
    batchCount,
    parallelism,
    expectedDuration,
  };
}

/**
 * Estimate fast mode execution cost and time
 */
export function estimateFastModeExecution(
  testCount: number,
  profile: FastModeProfile = "balanced"
): {
  estimated_cost: number;
  estimated_time: number;
  bug_detection_rate: string;
  profile: FastModeProfile;
} {
  const profiles = getFastModeProfiles();
  const config = profiles[profile];

  // Scale based on test count
  const costMultiplier = testCount / 10;
  const timeMultiplier = testCount / 10;

  return {
    estimated_cost: config.estimatedCost * costMultiplier,
    estimated_time: config.estimatedTime * timeMultiplier,
    bug_detection_rate: config.bugDetectionRate,
    profile,
  };
}

/**
 * Recommend fast mode configuration based on goals
 */
export function recommendFastModeConfig(options: {
  maxBudget?: number;
  minBugDetection?: number;
  maxTime?: number;
}): FastModeProfile {
  const profiles = getFastModeProfiles();

  // If budget is very tight, use critical
  if (options.maxBudget && options.maxBudget < 10) {
    return "critical";
  }

  // If time is very limited, use critical
  if (options.maxTime && options.maxTime < 200) {
    return "critical";
  }

  // If need high detection rate, use full
  if (options.minBugDetection && options.minBugDetection > 90) {
    return "full";
  }

  // Default to balanced
  return "balanced";
}

/**
 * Get all fast mode profiles for comparison
 */
export function getAllFastModeProfiles(): Array<{
  name: FastModeProfile;
  config: FastModeConfig;
}> {
  const profiles = getFastModeProfiles();
  return Object.entries(profiles).map(([name, config]) => ({
    name: name as FastModeProfile,
    config,
  }));
}

/**
 * Compare two fast mode configurations
 */
export function compareFastModeConfigs(
  profile1: FastModeProfile,
  profile2: FastModeProfile
): {
  profile1: FastModeConfig;
  profile2: FastModeConfig;
  differences: Array<{
    aspect: string;
    profile1_value: any;
    profile2_value: any;
    improvement: string;
  }>;
} {
  const profiles = getFastModeProfiles();
  const config1 = profiles[profile1];
  const config2 = profiles[profile2];

  const differences = [
    {
      aspect: "Cost",
      profile1_value: `$${config1.estimatedCost}`,
      profile2_value: `$${config2.estimatedCost}`,
      improvement: config2.estimatedCost < config1.estimatedCost ? "Cheaper" : "More expensive",
    },
    {
      aspect: "Time",
      profile1_value: `${config1.estimatedTime}s`,
      profile2_value: `${config2.estimatedTime}s`,
      improvement: config2.estimatedTime < config1.estimatedTime ? "Faster" : "Slower",
    },
    {
      aspect: "Bug Detection",
      profile1_value: config1.bugDetectionRate,
      profile2_value: config2.bugDetectionRate,
      improvement: config2.bugDetectionRate > config1.bugDetectionRate ? "Better" : "Worse",
    },
  ];

  return { profile1: config1, profile2: config2, differences };
}

/**
 * Record fast mode execution for analytics
 */
export function recordFastModeExecution(execution: FastModeExecution): void {
  console.log(
    `Fast Mode ${execution.profile}: ${execution.testCount} tests, ${execution.bugsFound} bugs, $${execution.cost.toFixed(2)}`
  );
}

/**
 * Get fast mode execution statistics
 */
export function getFastModeStats(): {
  totalExecutions: number;
  avgCost: number;
  avgBugsFound: number;
  avgAccuracy: number;
  topProfile: FastModeProfile;
} {
  // In real implementation, query database
  return {
    totalExecutions: 45,
    avgCost: 12.5,
    avgBugsFound: 8,
    avgAccuracy: 0.82,
    topProfile: "balanced",
  };
}

/**
 * FEATURE 11: Smart routing decision
 */
export function getSmartModeRecommendation(context: {
  testCount: number;
  lastBugCount: number;
  budget: number;
  timeAvailable: number;
}): {
  recommendedMode: "fast" | "comprehensive" | "hybrid";
  reasoning: string;
  expectedOutcome: string;
} {
  // If budget < $20, use fast mode
  if (context.budget < 20) {
    return {
      recommendedMode: "fast",
      reasoning: "Budget limited - Fast Mode catches most bugs at low cost",
      expectedOutcome: "Find 80-85% of bugs in 5-10 minutes for $10-15",
    };
  }

  // If time < 10 minutes, use fast mode
  if (context.timeAvailable < 600) {
    return {
      recommendedMode: "fast",
      reasoning: "Time limited - Fast Mode completes quickly",
      expectedOutcome: "Quick validation in 5 minutes",
    };
  }

  // If last run had many bugs, use comprehensive
  if (context.lastBugCount > 10) {
    return {
      recommendedMode: "comprehensive",
      reasoning: "Recent history shows many bugs - need thorough testing",
      expectedOutcome: "Comprehensive coverage for 95%+ detection",
    };
  }

  // Default: hybrid
  return {
    recommendedMode: "hybrid",
    reasoning: "Balanced approach - Fast check first, deep dive if needed",
    expectedOutcome: "Quick scan ($10) + targeted deep-dive if bugs found",
  };
}
