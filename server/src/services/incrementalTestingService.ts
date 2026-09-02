import { db } from "../db.js";

export interface PageChange {
  pageId: string;
  url: string;
  hasChanged: boolean;
  changeType: "structural" | "content" | "style" | "script" | "none";
  changePercentage: number;
  affectedElements: string[];
}

export interface RegressionTest {
  pageId: string;
  testType: "visual" | "functional" | "api" | "performance";
  priority: "high" | "medium" | "low";
  affectedAreas: string[];
}

export interface IncrementalStrategy {
  skipUnchanged: boolean;
  focusChanged: boolean;
  adaptiveThreshold: number;
  lastFullTestTime: number;
}

function ensureIncrementalTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS page_history (
      id TEXT PRIMARY KEY,
      page_id TEXT NOT NULL,
      url TEXT NOT NULL,
      content_hash TEXT,
      element_count INTEGER,
      interactive_count INTEGER,
      timestamp INTEGER NOT NULL,
      UNIQUE(page_id)
    );
    CREATE TABLE IF NOT EXISTS incremental_strategy (
      id TEXT PRIMARY KEY,
      config_key TEXT UNIQUE,
      skip_unchanged INTEGER DEFAULT 1,
      focus_changed INTEGER DEFAULT 1,
      adaptive_threshold REAL DEFAULT 0.1,
      last_full_test INTEGER,
      created_at INTEGER
    );
  `);
}

export function detectChangedPages(
  baseline: Array<{ pageId: string; contentHash: string; elements: number }>,
  current: Array<{ pageId: string; contentHash: string; elements: number }>
): PageChange[] {
  const changedPages: PageChange[] = [];
  const baselineMap = new Map(baseline.map((p) => [p.pageId, p]));

  for (const curr of current) {
    const base = baselineMap.get(curr.pageId);

    if (!base) {
      changedPages.push({
        pageId: curr.pageId,
        url: "",
        hasChanged: true,
        changeType: "structural",
        changePercentage: 100,
        affectedElements: [],
      });
      continue;
    }

    const hashChanged = base.contentHash !== curr.contentHash;
    const elementChanged = Math.abs(base.elements - curr.elements) > 5;

    if (hashChanged || elementChanged) {
      const elementDiff = Math.abs(base.elements - curr.elements);
      const changePercentage = (elementDiff / Math.max(base.elements, curr.elements)) * 100;

      changedPages.push({
        pageId: curr.pageId,
        url: "",
        hasChanged: true,
        changeType: elementChanged ? "structural" : "content",
        changePercentage: Math.min(100, changePercentage),
        affectedElements: [],
      });
    }
  }

  return changedPages;
}

export function buildRegressionTestSuite(changedPages: PageChange[]): RegressionTest[] {
  const tests: RegressionTest[] = [];

  for (const page of changedPages) {
    if (page.changeType === "structural" || page.changeType === "content") {
      tests.push({
        pageId: page.pageId,
        testType: "functional",
        priority: page.changePercentage > 50 ? "high" : "medium",
        affectedAreas: page.affectedElements,
      });

      if (page.changePercentage > 30) {
        tests.push({
          pageId: page.pageId,
          testType: "visual",
          priority: "medium",
          affectedAreas: page.affectedElements,
        });
      }
    } else if (page.changeType === "script") {
      tests.push({
        pageId: page.pageId,
        testType: "api",
        priority: "high",
        affectedAreas: page.affectedElements,
      });
    }
  }

  return tests;
}

export function skipUnchangedPages(
  allPages: Array<{ id: string; url: string; hash: string }>,
  baseline: Array<{ id: string; hash: string }>
): Array<{ id: string; url: string; hash: string }> {
  const baselineMap = new Map(baseline.map((p) => [p.id, p.hash]));
  return allPages.filter((page) => {
    const baselineHash = baselineMap.get(page.id);
    return !baselineHash || baselineHash !== page.hash;
  });
}

export function shouldRunFullTest(
  changePercentage: number,
  lastFullTest: number,
  maxIntervalMs: number = 3600000
): boolean {
  const timeSinceLastFull = Date.now() - lastFullTest;
  
  if (changePercentage > 40) {
    return true;
  }

  if (timeSinceLastFull > maxIntervalMs) {
    return true;
  }

  if (changePercentage > 20 && timeSinceLastFull > maxIntervalMs / 2) {
    return true;
  }

  return false;
}

export function trackPageHistory(
  pageId: string,
  url: string,
  contentHash: string,
  elementCount: number,
  interactiveCount: number
): void {
  try {
    ensureIncrementalTable();

    db.prepare(`
      INSERT OR REPLACE INTO page_history
      (id, page_id, url, content_hash, element_count, interactive_count, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(pageId, pageId, url, contentHash, elementCount, interactiveCount, Date.now());
  } catch (error) {
    console.error("[incrementalTestingService] Error tracking history:", error);
  }
}

export function getPageHistory(pageId: string): any | null {
  try {
    ensureIncrementalTable();
    return db.prepare("SELECT * FROM page_history WHERE page_id = ?").get(pageId);
  } catch (error) {
    console.error("[incrementalTestingService] Error getting history:", error);
    return null;
  }
}

export function getIncrementalStrategy(): IncrementalStrategy {
  try {
    ensureIncrementalTable();
    const config = db.prepare(
      "SELECT * FROM incremental_strategy WHERE config_key = 'default'"
    ).get() as any;

    return (
      config || {
        skipUnchanged: true,
        focusChanged: true,
        adaptiveThreshold: 0.1,
        lastFullTestTime: 0,
      }
    );
  } catch (error) {
    console.error("[incrementalTestingService] Error getting strategy:", error);
    return {
      skipUnchanged: true,
      focusChanged: true,
      adaptiveThreshold: 0.1,
      lastFullTestTime: 0,
    };
  }
}

export function updateIncrementalStrategy(
  config: Partial<IncrementalStrategy>
): void {
  try {
    ensureIncrementalTable();

    db.prepare(`
      INSERT OR REPLACE INTO incremental_strategy
      (id, config_key, skip_unchanged, focus_changed, adaptive_threshold, last_full_test, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      "default",
      "default",
      config.skipUnchanged ? 1 : 0,
      config.focusChanged ? 1 : 0,
      config.adaptiveThreshold || 0.1,
      config.lastFullTestTime || Date.now(),
      Date.now()
    );
  } catch (error) {
    console.error("[incrementalTestingService] Error updating strategy:", error);
  }
}

export function estimateTestReduction(
  totalPages: number,
  changedPages: number
): { reduction: number; estimatedTime: string } {
  const reductionPercent = ((totalPages - changedPages) / totalPages) * 100;
  const estimatedMinutes = Math.ceil((totalPages * 0.5) / 60);

  return {
    reduction: Math.min(99, reductionPercent),
    estimatedTime: `${estimatedMinutes} min`,
  };
}

export function setIncrementalTestingFeatureFlag(enabled: boolean): void {
  process.env.INCREMENTAL_TESTING_ENABLED = String(enabled);
}

export function isIncrementalTestingEnabled(): boolean {
  return process.env.INCREMENTAL_TESTING_ENABLED !== "false";
}

export function getIncrementalStats(): {
  pagesTracked: number;
  changeDetections: number;
  testsSkipped: number;
  estimatedTimeSaved: number;
} {
  try {
    ensureIncrementalTable();
    const pageCount = db.prepare("SELECT COUNT(*) as cnt FROM page_history").get() as any;
    
    return {
      pagesTracked: pageCount.cnt,
      changeDetections: 0,
      testsSkipped: 0,
      estimatedTimeSaved: 0,
    };
  } catch (error) {
    console.error("[incrementalTestingService] Error getting stats:", error);
    return {
      pagesTracked: 0,
      changeDetections: 0,
      testsSkipped: 0,
      estimatedTimeSaved: 0,
    };
  }
}
