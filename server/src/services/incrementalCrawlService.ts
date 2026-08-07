// Incremental Crawl Service
// Optimizes repeat crawls by detecting and skipping unchanged pages

import { db } from "../db.js";
import crypto from "crypto";

export interface CrawlState {
  siteId: string;
  pageId: string;
  url: string;
  domHash: string;
  screenshotHash: string;
  componentInventory: any[];
  elementsJson: any[];
  apisJson: any[];
  lastCrawledAt: string;
}

export interface IncrementalCrawlResult {
  siteId: string;
  mode: "full" | "incremental";
  pagesScanned: number;
  pagesUnchanged: number;
  pagesChanged: number;
  pagesNew: number;
  scenariosCarriedForward: number;
  scenariosNew: number;
  timeSaved: number;
  costSaved: number;
  durationMs: number;
}

export interface PageChangeDetection {
  pageId: string;
  url: string;
  status: "unchanged" | "changed" | "new";
  domHashOld?: string;
  domHashNew?: string;
  screenshotHashOld?: string;
  screenshotHashNew?: string;
  changesDetected?: string[];
}

/**
 * Computes SHA256 hash of content
 */
export function computeHash(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * Computes DOM hash for page content
 */
export function computeDomHash(dom: string): string {
  // Normalize DOM: remove whitespace, scripts, styles that don't affect functionality
  const normalized = dom
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/\s+/g, " ")
    .toLowerCase();

  return computeHash(normalized);
}

/**
 * Computes screenshot hash (simplified image comparison)
 */
export function computeScreenshotHash(screenshotBuffer: Buffer): string {
  // In production, would use perceptual hashing (pHash/dHash)
  // For now, use SHA256 of image data
  return computeHash(screenshotBuffer);
}

/**
 * Gets baseline state of a page from last crawl
 */
export function getPageBaseline(pageId: string): CrawlState | null {
  const row = db.prepare(`
    SELECT 
      id, site_id, url, dom_hash, screenshot_hash,
      component_inventory_json, elements_json, apis_json,
      last_seen_at
    FROM crawl_pages WHERE id = ?
  `).get(pageId) as any;

  if (!row) return null;

  return {
    siteId: row.site_id,
    pageId: row.id,
    url: row.url,
    domHash: row.dom_hash || "",
    screenshotHash: row.screenshot_hash || "",
    componentInventory: JSON.parse(row.component_inventory_json || "[]"),
    elementsJson: JSON.parse(row.elements_json || "[]"),
    apisJson: JSON.parse(row.apis_json || "[]"),
    lastCrawledAt: row.last_seen_at,
  };
}

/**
 * Detects changes in a page
 */
export function detectPageChanges(
  oldState: CrawlState | null,
  newDom: string,
  newScreenshot: Buffer,
  newComponents: any[]
): PageChangeDetection {
  const newDomHash = computeDomHash(newDom);
  const newScreenshotHash = computeScreenshotHash(newScreenshot);

  if (!oldState) {
    return {
      pageId: "",
      url: "",
      status: "new",
      domHashNew: newDomHash,
      screenshotHashNew: newScreenshotHash,
    };
  }

  const changes: string[] = [];

  // Check DOM changes
  if (newDomHash !== oldState.domHash) {
    changes.push("DOM structure changed");
  }

  // Check screenshot changes
  if (newScreenshotHash !== oldState.screenshotHash) {
    changes.push("Visual changes detected");
  }

  // Check component changes
  const oldComponentCount = oldState.componentInventory.length;
  const newComponentCount = newComponents.length;
  if (oldComponentCount !== newComponentCount) {
    changes.push(`Component count changed (${oldComponentCount} → ${newComponentCount})`);
  }

  const status = changes.length === 0 ? "unchanged" : "changed";

  return {
    pageId: oldState.pageId,
    url: oldState.url,
    status,
    domHashOld: oldState.domHash,
    domHashNew: newDomHash,
    screenshotHashOld: oldState.screenshotHash,
    screenshotHashNew: newScreenshotHash,
    changesDetected: changes.length > 0 ? changes : undefined,
  };
}

/**
 * Determines if full crawl is needed despite incremental being possible
 */
export function shouldPerformFullCrawl(siteId: string): boolean {
  const site = db.prepare("SELECT last_full_crawl_date FROM crawl_sites WHERE id = ?").get(siteId) as any;

  if (!site) return true;

  // Perform full crawl if:
  // 1. Never done before
  // 2. More than 7 days since last full crawl
  // 3. User explicitly requested it

  if (!site.last_full_crawl_date) return true;

  const lastFullCrawl = new Date(site.last_full_crawl_date);
  const daysSinceLastFull = (Date.now() - lastFullCrawl.getTime()) / (1000 * 60 * 60 * 24);

  return daysSinceLastFull > 7;
}

/**
 * Marks pages as seen in current crawl
 */
export function markPagesAsSeen(pageIds: string[]): void {
  const now = new Date().toISOString();
  const stmt = db.prepare("UPDATE crawl_pages SET last_seen_at = ? WHERE id = ?");

  for (const pageId of pageIds) {
    stmt.run(now, pageId);
  }
}

/**
 * Persists scenarios from unchanged pages
 */
export function persistScenariosFromUnchangedPages(pageIds: string[], newCrawlId: string): number {
  // Get scenarios from unchanged pages
  const scenarios = db.prepare(`
    SELECT * FROM crawl_scenarios
    WHERE page_id IN (${pageIds.map(() => "?").join(",")})
    AND status = 'active'
  `).all(...pageIds) as any[];

  if (scenarios.length === 0) return 0;

  const stmt = db.prepare(`
    INSERT INTO crawl_scenarios (
      id, site_id, page_id, title, type, steps_json, locators_json,
      status, is_persisted_from_previous_crawl, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let persistedCount = 0;
  for (const scenario of scenarios) {
    const newId = `${scenario.id}-persisted-${Date.now()}`;
    stmt.run(
      newId,
      scenario.site_id,
      scenario.page_id,
      scenario.title,
      scenario.type,
      scenario.steps_json,
      scenario.locators_json,
      "active",
      1, // is_persisted_from_previous_crawl
      new Date().toISOString(),
      new Date().toISOString()
    );
    persistedCount++;
  }

  return persistedCount;
}

/**
 * Generates incremental crawl report
 */
export function generateIncrementalCrawlReport(
  siteId: string,
  detections: PageChangeDetection[],
  durationMs: number,
  costPerPage: number = 0.01
): IncrementalCrawlResult {
  const pagesScanned = detections.length;
  const pagesUnchanged = detections.filter((d) => d.status === "unchanged").length;
  const pagesChanged = detections.filter((d) => d.status === "changed").length;
  const pagesNew = detections.filter((d) => d.status === "new").length;

  // Full crawl would scan all pages
  const fullCrawlPages = pagesScanned;
  const incrementalPages = pagesChanged + pagesNew;

  const pagesSaved = fullCrawlPages - incrementalPages;
  const costFull = fullCrawlPages * costPerPage;
  const costIncremental = incrementalPages * costPerPage;
  const costSaved = costFull - costIncremental;

  // Time estimation: ~0.5s per page
  const fullCrawlMs = fullCrawlPages * 500;
  const incrementalMs = durationMs;
  const timeSaved = fullCrawlMs - incrementalMs;

  return {
    siteId,
    mode: "incremental",
    pagesScanned,
    pagesUnchanged,
    pagesChanged,
    pagesNew,
    scenariosCarriedForward: pagesUnchanged * 5, // Estimate
    scenariosNew: (pagesChanged + pagesNew) * 5, // Estimate
    timeSaved: Math.max(0, timeSaved),
    costSaved: Math.max(0, costSaved),
    durationMs,
  };
}

/**
 * Checks if any critical page changed (triggers full recrawl)
 */
export function hasCriticalChanges(detections: PageChangeDetection[]): boolean {
  // Critical changes: homepage, login page, core flows
  const criticalPaths = ["/", "/login", "/auth", "/dashboard", "/home"];

  const criticalChanges = detections.filter((d) => {
    const isCritical = criticalPaths.some((path) => d.url.includes(path));
    return isCritical && d.status !== "unchanged";
  });

  return criticalChanges.length > 0;
}

/**
 * Records incremental crawl completion
 */
export function recordIncrementalCrawlCompletion(
  siteId: string,
  report: IncrementalCrawlResult,
  detections: PageChangeDetection[]
): void {
  const now = new Date().toISOString();

  // Update site crawl summary
  db.prepare(`
    UPDATE crawl_sites
    SET 
      recrawl_summary_json = ?,
      crawl_mode = 'incremental',
      updated_at = ?
    WHERE id = ?
  `).run(
    JSON.stringify({
      lastIncrementalCrawl: now,
      pagesScanned: report.pagesScanned,
      pagesUnchanged: report.pagesUnchanged,
      pagesChanged: report.pagesChanged,
      pagesNew: report.pagesNew,
      timeSaved: report.timeSaved,
      costSaved: report.costSaved,
    }),
    now,
    siteId
  );

  // Update page detection results
  const stmt = db.prepare(`
    INSERT INTO page_change_detections (
      id, site_id, page_id, url, status, old_dom_hash, new_dom_hash,
      changes_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const detection of detections) {
    stmt.run(
      `detect-${detection.pageId}-${Date.now()}`,
      siteId,
      detection.pageId,
      detection.url,
      detection.status,
      detection.domHashOld || null,
      detection.domHashNew || null,
      JSON.stringify(detection.changesDetected || []),
      now
    );
  }
}

/**
 * Gets incremental crawl statistics
 */
export function getIncrementalCrawlStats(siteId: string, daysBack: number = 30): {
  totalIncremental: number;
  avgTimesSaved: number;
  avgCostsSaved: number;
  totalCostSaved: number;
  efficiency: number; // Percentage saved on average
} {
  const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();

  const rows = db.prepare(`
    SELECT recrawl_summary_json FROM crawl_sites
    WHERE id = ? AND updated_at >= ?
  `).all(siteId, since) as any[];

  if (rows.length === 0) {
    return {
      totalIncremental: 0,
      avgTimesSaved: 0,
      avgCostsSaved: 0,
      totalCostSaved: 0,
      efficiency: 0,
    };
  }

  let totalTime = 0;
  let totalCost = 0;
  let totalRuns = 0;

  for (const row of rows) {
    const summary = JSON.parse(row.recrawl_summary_json || "{}");
    totalTime += summary.timeSaved || 0;
    totalCost += summary.costSaved || 0;
    totalRuns++;
  }

  const avgTimeSaved = totalTime / totalRuns;
  const avgCostSaved = totalCost / totalRuns;
  const efficiency = (totalTime / (totalRuns * 5000)) * 100; // Assuming 5s per page

  return {
    totalIncremental: totalRuns,
    avgTimesSaved: avgTimeSaved,
    avgCostsSaved: avgCostSaved,
    totalCostSaved: totalCost,
    efficiency: Math.min(100, efficiency),
  };
}
