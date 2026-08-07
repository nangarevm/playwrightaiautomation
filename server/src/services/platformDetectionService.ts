// Platform Detection Service
// Auto-detects website platform (WordPress, SPA, E-commerce) and applies optimized settings
// Part of Phase 2: Adaptive Intelligence

export type PlatformType = "wordpress" | "spa" | "ecommerce" | "custom";

export interface PlatformProfile {
  type: PlatformType;
  label: string;
  description: string;
  indicators: string[];
  pageLoadTimeout: number;
  networkIdleTimeout: number;
  concurrencyFactor: number; // Multiplier for base concurrency
  expectedLoadTime: string;
}

export interface DetectionResult {
  platform: PlatformType;
  confidence: number; // 0-1
  indicators: string[];
  profile: PlatformProfile;
}

// Platform profiles with optimized timeouts for each
export const PLATFORM_PROFILES: Record<PlatformType, PlatformProfile> = {
  wordpress: {
    type: "wordpress",
    label: "WordPress",
    description: "WordPress with plugins, often heavier and slower",
    indicators: ["wp-content", "wp-includes", "wp-json", "WordPress", "wp-admin"],
    pageLoadTimeout: 25000, // Generous timeout for heavy frameworks
    networkIdleTimeout: 7000, // Wait for plugin requests
    concurrencyFactor: 0.7, // Reduce concurrency (shared hosting often can't handle much)
    expectedLoadTime: "25-35 seconds per page",
  },

  spa: {
    type: "spa",
    label: "Single Page Application (SPA)",
    description: "Modern SPA/headless - React, Vue, Angular, etc.",
    indicators: ["React", "Vue", "Angular", "__NUXT__", "next", "_app", "index.html", "spa"],
    pageLoadTimeout: 15000, // Fast, modern frameworks
    networkIdleTimeout: 3000, // APIs respond quickly
    concurrencyFactor: 1.2, // Can handle more concurrency
    expectedLoadTime: "12-18 seconds per page",
  },

  ecommerce: {
    type: "ecommerce",
    label: "E-commerce Platform",
    description: "E-commerce with product catalogs and heavy assets",
    indicators: ["Shopify", "product", "/products/", "cart.js", "WooCommerce", "Magento", "/shop/"],
    pageLoadTimeout: 20000, // Handle product images and variants
    networkIdleTimeout: 6000, // Multiple product images loading
    concurrencyFactor: 0.9, // Moderate concurrency
    expectedLoadTime: "18-28 seconds per page",
  },

  custom: {
    type: "custom",
    label: "Custom Build",
    description: "Unknown or custom framework",
    indicators: [],
    pageLoadTimeout: 20000, // Safe default
    networkIdleTimeout: 5000, // Balanced
    concurrencyFactor: 1.0, // Standard concurrency
    expectedLoadTime: "15-25 seconds per page",
  },
};

// Detect platform from page content and headers
export function detectPlatform(
  pageContent: string,
  pageHeaders: Record<string, string> = {},
  pageUrl: string = ""
): DetectionResult {
  const results: { platform: PlatformType; matches: number }[] = [];

  // Check each platform
  for (const [platformType, profile] of Object.entries(PLATFORM_PROFILES)) {
    if (platformType === "custom") continue; // Skip default, use as fallback

    let matches = 0;
    const detectedIndicators: string[] = [];

    for (const indicator of profile.indicators) {
      // Check in page content (case-insensitive)
      if (pageContent.toLowerCase().includes(indicator.toLowerCase())) {
        matches++;
        detectedIndicators.push(indicator);
      }

      // Check in headers
      const headerValue = Object.entries(pageHeaders)
        .find(([k]) => k.toLowerCase() === "server" || k.toLowerCase() === "x-powered-by")?.[1] || "";
      if (headerValue.toLowerCase().includes(indicator.toLowerCase())) {
        matches++;
        detectedIndicators.push(`${indicator} (header)`);
      }

      // Check in URL for specific patterns
      if (platformType === "ecommerce") {
        if (pageUrl.includes("/products") || pageUrl.includes("/shop")) {
          matches++;
          detectedIndicators.push("URL pattern match");
        }
      }
    }

    if (matches > 0) {
      results.push({ platform: platformType as PlatformType, matches });
    }
  }

  // Find best match
  if (results.length > 0) {
    const best = results.sort((a, b) => b.matches - a.matches)[0];
    const profile = PLATFORM_PROFILES[best.platform];
    const detectedIndicators = profile.indicators.filter((ind) =>
      pageContent.toLowerCase().includes(ind.toLowerCase()) ||
      Object.values(pageHeaders).some((val) => val.toLowerCase().includes(ind.toLowerCase()))
    );

    return {
      platform: best.platform,
      confidence: Math.min(best.matches / Math.max(profile.indicators.length, 1), 1),
      indicators: detectedIndicators,
      profile,
    };
  }

  // Default to custom
  return {
    platform: "custom",
    confidence: 0,
    indicators: [],
    profile: PLATFORM_PROFILES.custom,
  };
}

// Get timeout settings based on detected platform
export function getOptimizedTimeouts(detection: DetectionResult) {
  return {
    pageLoadTimeout: detection.profile.pageLoadTimeout,
    networkIdleTimeout: detection.profile.networkIdleTimeout,
  };
}

// Get concurrency factor for platform (to be multiplied by base concurrency)
export function getConcurrencyFactor(detection: DetectionResult): number {
  return detection.profile.concurrencyFactor;
}

// Get recommended concurrency based on platform and page count
export function getRecommendedConcurrency(
  pageCount: number,
  detection: DetectionResult,
  baseConcurrency: number = 5
): number {
  let concurrency = baseConcurrency * detection.profile.concurrencyFactor;

  // Further adjust based on page count
  if (pageCount <= 20) {
    concurrency = Math.max(concurrency * 0.8, 3); // Lighter load for small sites
  } else if (pageCount > 500) {
    concurrency = Math.min(concurrency * 1.2, 8); // Maximize for large sites
  }

  return Math.round(concurrency);
}

// Get human-readable platform name
export function getPlatformName(detection: DetectionResult): string {
  return detection.profile.label;
}

// Get platform description with confidence
export function getPlatformDescription(detection: DetectionResult): string {
  if (detection.confidence === 0) {
    return `${detection.profile.description} (No specific platform detected)`;
  }
  return `${detection.profile.description} (Confidence: ${Math.round(detection.confidence * 100)}%)`;
}

// Sample usage for logging
export function logDetectionResult(url: string, detection: DetectionResult): void {
  console.log(`[Platform Detection] ${url}`);
  console.log(`  Platform: ${detection.profile.label}`);
  console.log(`  Confidence: ${Math.round(detection.confidence * 100)}%`);
  console.log(`  Indicators: ${detection.indicators.join(", ") || "None"}`);
  console.log(`  Timeouts: ${detection.profile.pageLoadTimeout}ms / ${detection.profile.networkIdleTimeout}ms`);
  console.log(`  Expected load time: ${detection.profile.expectedLoadTime}`);
}
