// Adaptive Concurrency Service
// Dynamically adjusts concurrency based on page count, platform, and system resources
// Part of Phase 2: Adaptive Intelligence

export interface ConcurrencyConfig {
  baseConcurrency: number;
  minConcurrency: number;
  maxConcurrency: number;
  pageCount: number;
  platformFactor: number;
  memoryAvailableMB: number;
  estimatedTotalTime: string;
}

export interface ConcurrencyRecommendation {
  recommended: number;
  reasoning: string;
  estimatedTime: string;
  riskLevel: "low" | "medium" | "high"; // Resource risk
}

// Memory requirements per concurrent page (rough estimate)
const MEMORY_PER_PAGE_MB = 80; // Each headless browser instance ~80MB

// Time per page (average, will vary by platform)
const AVG_TIME_PER_PAGE_MS = 25000; // 25 seconds average

/**
 * Calculate optimal concurrency based on page count
 * Follows this logic:
 * - Small sites (1-20 pages): Use low concurrency (3-4) for fast per-page feedback
 * - Medium sites (21-100): Use medium concurrency (5-6) for balance
 * - Large sites (101-500): Use higher concurrency (6-7) for faster overall time
 * - Enterprise (500+): Use maximum concurrency (7-8) to minimize total time
 */
export function calculateConcurrency(pageCount: number): number {
  if (pageCount <= 20) return 4; // Small: lighter load
  if (pageCount <= 100) return 5; // Medium-small: balanced
  if (pageCount <= 500) return 6; // Medium-large: higher parallelism
  return 8; // Enterprise: maximum parallelism
}

/**
 * Adjust concurrency based on platform factor
 * WordPress: 0.7x (shared hosting, heavy plugins)
 * SPA: 1.2x (modern, fast)
 * E-commerce: 0.9x (heavy assets)
 * Custom: 1.0x (baseline)
 */
export function applyPlatformFactor(baseConcurrency: number, platformFactor: number): number {
  return Math.round(baseConcurrency * platformFactor);
}

/**
 * Get recommended concurrency with safety limits
 */
export function getRecommendedConcurrency(
  pageCount: number,
  platformFactor: number = 1.0,
  availableMemoryMB: number = 2048
): ConcurrencyRecommendation {
  // Calculate base concurrency from page count
  const baseConcurrency = calculateConcurrency(pageCount);

  // Apply platform factor
  let recommended = applyPlatformFactor(baseConcurrency, platformFactor);

  // Clamp to safe range
  recommended = Math.max(3, Math.min(recommended, 8));

  // Check memory constraints
  const memoryRequired = recommended * MEMORY_PER_PAGE_MB;
  let riskLevel: "low" | "medium" | "high" = "low";
  let reasoning = `Calculated for ${pageCount} pages with platform factor ${platformFactor.toFixed(1)}x`;

  if (memoryRequired > availableMemoryMB) {
    // Reduce concurrency if memory constrained
    recommended = Math.max(3, Math.floor(availableMemoryMB / MEMORY_PER_PAGE_MB));
    riskLevel = "high";
    reasoning += ` - REDUCED for memory constraints (${memoryRequired}MB needed, ${availableMemoryMB}MB available)`;
  } else if (memoryRequired > availableMemoryMB * 0.8) {
    riskLevel = "medium";
    reasoning += ` - Using ${Math.round((memoryRequired / availableMemoryMB) * 100)}% of available memory`;
  } else {
    riskLevel = "low";
    reasoning += ` - Safe memory usage (${memoryRequired}MB / ${availableMemoryMB}MB available)`;
  }

  // Estimate total crawl time
  const estimatedTotalTimeMs = Math.ceil((pageCount * AVG_TIME_PER_PAGE_MS) / recommended);
  const estimatedTime = formatDuration(estimatedTotalTimeMs);

  return {
    recommended,
    reasoning,
    estimatedTime,
    riskLevel,
  };
}

/**
 * Format milliseconds to readable duration
 */
function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return `${hours}h`;
}

/**
 * Get concurrency profile with detailed breakdown
 */
export function getConcurrencyProfile(
  pageCount: number,
  platformFactor: number = 1.0,
  availableMemoryMB: number = 2048
): ConcurrencyConfig & ConcurrencyRecommendation {
  const baseConcurrency = calculateConcurrency(pageCount);
  const withPlatform = applyPlatformFactor(baseConcurrency, platformFactor);
  const rec = getRecommendedConcurrency(pageCount, platformFactor, availableMemoryMB);

  return {
    baseConcurrency,
    minConcurrency: 3,
    maxConcurrency: 8,
    pageCount,
    platformFactor,
    memoryAvailableMB: availableMemoryMB,
    estimatedTotalTime: rec.estimatedTime,
    recommended: rec.recommended,
    reasoning: rec.reasoning,
    estimatedTime: rec.estimatedTime,
    riskLevel: rec.riskLevel,
  };
}

/**
 * Get concurrency recommendations for different scenarios
 */
export function getConcurrencyScenarios(pageCount: number) {
  const scenarios = [
    {
      platform: "WordPress (0.7x factor)",
      concurrency: applyPlatformFactor(calculateConcurrency(pageCount), 0.7),
      time: formatDuration((pageCount * AVG_TIME_PER_PAGE_MS) / applyPlatformFactor(calculateConcurrency(pageCount), 0.7)),
    },
    {
      platform: "SPA (1.2x factor)",
      concurrency: applyPlatformFactor(calculateConcurrency(pageCount), 1.2),
      time: formatDuration((pageCount * AVG_TIME_PER_PAGE_MS) / applyPlatformFactor(calculateConcurrency(pageCount), 1.2)),
    },
    {
      platform: "E-commerce (0.9x factor)",
      concurrency: applyPlatformFactor(calculateConcurrency(pageCount), 0.9),
      time: formatDuration((pageCount * AVG_TIME_PER_PAGE_MS) / applyPlatformFactor(calculateConcurrency(pageCount), 0.9)),
    },
    {
      platform: "Custom (1.0x factor)",
      concurrency: calculateConcurrency(pageCount),
      time: formatDuration((pageCount * AVG_TIME_PER_PAGE_MS) / calculateConcurrency(pageCount)),
    },
  ];

  return scenarios;
}

/**
 * Logging utility
 */
export function logConcurrencyDecision(
  pageCount: number,
  platformFactor: number,
  recommendedConcurrency: number,
  estimatedTime: string
): void {
  console.log(`[Adaptive Concurrency] Decision for ${pageCount} pages (platform factor: ${platformFactor}x)`);
  console.log(`  Recommended concurrency: ${recommendedConcurrency}`);
  console.log(`  Estimated total time: ${estimatedTime}`);
}
