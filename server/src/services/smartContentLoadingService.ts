// Smart Content Loading Service
// Handles lazy-loaded images, pagination, and infinite scroll
// Part of Phase 3: Smart Content Loading

import type { Page } from "playwright";

export interface ContentLoadingConfig {
  // Lazy loading
  detectLazyLoadedImages: boolean;
  lazyLoadScrollWait: number; // ms to wait after scroll for lazy loads

  // Pagination
  followPaginationLinks: boolean;
  maxPaginationPages: number; // Max pages to follow from pagination

  // Infinite scroll
  detectInfiniteScroll: boolean;
  maxInfiniteScrollLoads: number; // Max times to scroll
  scrollPauseTime: number; // ms between scrolls
}

export interface ContentLoadingResult {
  lazyImagesFound: number;
  paginationLinksFollowed: number;
  infiniteScrollLoads: number;
  additionalElementsDiscovered: number;
  additionalNetworkRequests: number;
}

// Default config: conservative to not over-crawl
export const DEFAULT_CONTENT_LOADING_CONFIG: ContentLoadingConfig = {
  detectLazyLoadedImages: true,
  lazyLoadScrollWait: 1000, // 1 second
  followPaginationLinks: true,
  maxPaginationPages: 10, // Limit to first 10 pages
  detectInfiniteScroll: true,
  maxInfiniteScrollLoads: 5, // Max 5 scroll loads
  scrollPauseTime: 800, // 800ms between scrolls
};

/**
 * Detect and handle lazy-loaded images by scrolling
 */
export async function handleLazyLoadedImages(
  page: Page,
  config: Partial<ContentLoadingConfig> = {}
): Promise<number> {
  const cfg = { ...DEFAULT_CONTENT_LOADING_CONFIG, ...config };

  if (!cfg.detectLazyLoadedImages) return 0;

  try {
    // Get initial image count
    const initialImages = await page.evaluate(() => {
      return document.querySelectorAll("img[src], img[data-src]").length;
    });

    // Scroll to trigger lazy loading
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });

    // Wait for lazy-loaded images to load
    await page.waitForTimeout(cfg.lazyLoadScrollWait);

    // Get final image count
    const finalImages = await page.evaluate(() => {
      return document.querySelectorAll("img[src], img[data-src]").length;
    });

    const newImages = Math.max(0, finalImages - initialImages);

    if (newImages > 0) {
      console.log(`[Content Loading] Found ${newImages} lazy-loaded images after scroll`);
    }

    return newImages;
  } catch (error) {
    console.warn(`[Content Loading] Error handling lazy images: ${error}`);
    return 0;
  }
}

/**
 * Detect pagination links and optionally follow them
 */
export async function detectPaginationLinks(page: Page): Promise<string[]> {
  try {
    const paginationLinks = await page.evaluate(() => {
      const links = new Set<string>();
      const pageUrl = window.location.href;

      // Look for common pagination patterns
      const selectors = [
        "a[rel='next']",
        "a.next",
        "a.pagination-next",
        "li.next a",
        "a[aria-label*='Next']",
        "[data-testid*='pagination'] a:not(.active)",
        "nav[aria-label*='pagination'] a",
      ];

      for (const selector of selectors) {
        document.querySelectorAll(selector).forEach((el) => {
          const href = el.getAttribute("href");
          if (href && !href.startsWith("#")) {
            try {
              const url = new URL(href, pageUrl);
              links.add(url.toString());
            } catch {
              // Skip invalid URLs
            }
          }
        });
      }

      return Array.from(links);
    });

    return paginationLinks;
  } catch (error) {
    console.warn(`[Content Loading] Error detecting pagination: ${error}`);
    return [];
  }
}

/**
 * Detect infinite scroll patterns
 */
export async function detectInfiniteScroll(page: Page): Promise<boolean> {
  try {
    const hasInfiniteScroll = await page.evaluate(() => {
      // Look for common infinite scroll indicators
      const indicators = [
        // Common libraries/frameworks
        document.querySelector("[data-infinite-scroll]"),
        document.querySelector(".infinite-scroll"),
        document.querySelector("[data-virtualized]"),
        
        // Common patterns
        document.querySelector("button:contains('Load more')"),
        document.querySelector("button[data-test*='load']"),
      ];

      const hasScrollArea = indicators.some((el) => el !== null);

      // Also check for dynamic content updates on scroll
      const originalInnerHTML = document.body.innerHTML.length;

      return hasScrollArea || originalInnerHTML > 100000; // Large initial DOM
    });

    return hasInfiniteScroll;
  } catch (error) {
    console.warn(`[Content Loading] Error detecting infinite scroll: ${error}`);
    return false;
  }
}

/**
 * Handle infinite scroll by scrolling and waiting for new content
 */
export async function handleInfiniteScroll(
  page: Page,
  config: Partial<ContentLoadingConfig> = {}
): Promise<number> {
  const cfg = { ...DEFAULT_CONTENT_LOADING_CONFIG, ...config };

  if (!cfg.detectInfiniteScroll) return 0;

  try {
    const hasInfiniteScroll = await detectInfiniteScroll(page);
    if (!hasInfiniteScroll) return 0;

    let scrollLoads = 0;
    let previousHeight = 0;

    for (let i = 0; i < cfg.maxInfiniteScrollLoads; i++) {
      // Get current height
      const currentHeight = await page.evaluate(() => document.body.scrollHeight);

      if (currentHeight === previousHeight) {
        // No new content loaded, stop
        break;
      }

      // Scroll to bottom
      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
      });

      // Wait for new content to load
      await page.waitForTimeout(cfg.scrollPauseTime);

      scrollLoads++;
      previousHeight = currentHeight;
    }

    if (scrollLoads > 0) {
      console.log(`[Content Loading] Handled infinite scroll with ${scrollLoads} scroll load(s)`);
    }

    return scrollLoads;
  } catch (error) {
    console.warn(`[Content Loading] Error handling infinite scroll: ${error}`);
    return 0;
  }
}

/**
 * Main orchestration function for smart content loading
 */
export async function loadSmartContent(
  page: Page,
  config: Partial<ContentLoadingConfig> = {}
): Promise<ContentLoadingResult> {
  const cfg = { ...DEFAULT_CONTENT_LOADING_CONFIG, ...config };

  const result: ContentLoadingResult = {
    lazyImagesFound: 0,
    paginationLinksFollowed: 0,
    infiniteScrollLoads: 0,
    additionalElementsDiscovered: 0,
    additionalNetworkRequests: 0,
  };

  try {
    // Step 1: Handle lazy-loaded images
    if (cfg.detectLazyLoadedImages) {
      result.lazyImagesFound = await handleLazyLoadedImages(page, cfg);
    }

    // Step 2: Detect infinite scroll
    if (cfg.detectInfiniteScroll) {
      result.infiniteScrollLoads = await handleInfiniteScroll(page, cfg);
    }

    // Step 3: Detect pagination (don't follow automatically, just detect)
    if (cfg.followPaginationLinks) {
      const paginationLinks = await detectPaginationLinks(page);
      result.paginationLinksFollowed = Math.min(paginationLinks.length, cfg.maxPaginationPages);
    }

    // Count additional elements discovered
    result.additionalElementsDiscovered = await page.evaluate(() => {
      return document.querySelectorAll("*").length;
    });

    return result;
  } catch (error) {
    console.error(`[Content Loading] Unexpected error: ${error}`);
    return result;
  }
}

/**
 * Get optimized config based on detected platform/site type
 */
export function getOptimizedContentLoadingConfig(siteType: string): ContentLoadingConfig {
  const baseConfig = DEFAULT_CONTENT_LOADING_CONFIG;

  switch (siteType) {
    case "ecommerce":
      // E-commerce sites often have lots of lazy-loaded product images
      return {
        ...baseConfig,
        detectLazyLoadedImages: true,
        lazyLoadScrollWait: 1500,
        maxInfiniteScrollLoads: 8, // More aggressive for e-commerce
      };

    case "spa":
      // SPAs often use infinite scroll
      return {
        ...baseConfig,
        maxInfiniteScrollLoads: 10, // Aggressive for SPA with lots of content
        scrollPauseTime: 500,
      };

    case "wordpress":
      // WordPress blogs often have pagination
      return {
        ...baseConfig,
        followPaginationLinks: true,
        maxPaginationPages: 15, // More pages for blog content
        detectInfiniteScroll: false, // Less common on WordPress
      };

    default:
      // Conservative for unknown sites
      return baseConfig;
  }
}

/**
 * Logging helper
 */
export function logContentLoadingResult(result: ContentLoadingResult): void {
  console.log("[Content Loading] Summary:");
  console.log(`  Lazy images found: ${result.lazyImagesFound}`);
  console.log(`  Pagination links: ${result.paginationLinksFollowed}`);
  console.log(`  Infinite scroll loads: ${result.infiniteScrollLoads}`);
  console.log(`  Total elements discovered: ${result.additionalElementsDiscovered}`);
}
