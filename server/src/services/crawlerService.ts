// AI Crawler service layer: owns persistence (crawl_sites/crawl_pages/crawl_scenarios),
// bridges into the existing test_cases/automation_scripts pipeline for "Generate Tests"
// (Phase 8, step 4) so execution/reporting/self-healing all keep working unmodified, and
// implements the Phase 7 test-case-management deletion cascade.

import fs from "fs";
import path from "path";
import { customAlphabet, nanoid } from "nanoid";
import { db } from "../db.js";
import { runCrawl, type CrawlRunOutput } from "../crawler/index.js";
import { KNOWN_COMPONENT_KINDS } from "../crawler/componentInventory.js";
import { buildConsolidatedComponentScenario, buildScenariosForPage } from "../crawler/scenarios.js";
import type { CoverageMode, ElementRecord } from "../crawler/types.js";
import { scenarioFingerprint } from "../crawler/scenarioDedup.js";
import { dedupeKey, normalizeUrl } from "../crawler/urlUtils.js";
import { catalogScreen } from "./screensService.js";
import { generateAutomationScript } from "./codegenService.js";
import { logAudit, type CurrentUser } from "./adminService.js";
import { runPostCrawlBugScan } from "./bugDetectionService.js";
import { computePageFingerprint, getTestCaseFromCache, cacheTestCase, isCacheEnabled } from "./cacheService.js";
import {
  isIncrementalCrawlEnabled,
  recordIncrementalCrawlCompletion,
  shouldPerformFullCrawl,
} from "./incrementalCrawlService.js";
import { healScriptsForSiteDelta } from "./locatorHealService.js";
import {
  buildPageTitleUrlIndex,
  normalizeFlowStepsForCodegen,
} from "./flowStepNormalize.js";

export { normalizeFlowStepsForCodegen, buildPageTitleUrlIndex } from "./flowStepNormalize.js";

// Nanoid's default alphabet includes `-`, which Playwright treats as a CLI flag
// when the spec filename is passed as `playwright test -abc.spec.ts`.
const fileSafeId = customAlphabet("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", 10);

function daysSinceIso(iso?: string | null): number {
  if (!iso) return 999;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 999;
  return Math.floor(ms / 86400000);
}

function lastChangedPagePercent(site: any): number {
  try {
    const summary = site?.recrawl_summary_json ? JSON.parse(site.recrawl_summary_json) : null;
    if (!summary) return 0;
    const changed = Number(summary.changedPages || 0) + Number(summary.newPages || 0);
    const unchanged = Number(summary.unchangedPages || 0);
    const counted = changed + unchanged;
    const total = Math.max(1, counted > 0 ? counted : Number(site.pages_discovered || 1));
    return Math.round((changed / total) * 100);
  } catch {
    return 0;
  }
}

function resolveRecrawlMode(
  existing: any | undefined,
  requested?: "incremental" | "full"
): { mode: "incremental" | "full"; reason: string } {
  if (requested === "full" || requested === "incremental") {
    return { mode: requested, reason: "explicit" };
  }
  if (!existing) {
    return { mode: "full", reason: "first-crawl" };
  }
  if (!isIncrementalCrawlEnabled()) {
    return { mode: "full", reason: "incremental-disabled" };
  }
  const days = daysSinceIso(existing.last_crawled_at);
  const changedPct = lastChangedPagePercent(existing);
  if (shouldPerformFullCrawl(changedPct, days)) {
    return {
      mode: "full",
      reason: days > 7 ? "stale-baseline" : "high-change-rate",
    };
  }
  return { mode: "incremental", reason: "auto-diff" };
}

function normalizeUrlLocal(raw: string): string {
  return normalizeUrl(raw);
}

// FR-8: repeat visits auto-detect a known site and switch to diff mode --
// no manual toggle required by the caller.
export function findSiteByUrl(url: string) {
  return db.prepare("SELECT * FROM crawl_sites WHERE url = ?").get(normalizeUrlLocal(url)) as any;
}

function findPageByUrl(siteId: string, url: string): { id: string; url: string } | undefined {
  const key = dedupeKey(url);
  const pages = db.prepare("SELECT id, url FROM crawl_pages WHERE site_id = ?").all(siteId) as Array<{ id: string; url: string }>;
  return pages.find((p) => dedupeKey(p.url) === key);
}

function loadSiteScenarioFingerprints(siteId: string): Set<string> {
  // Only flow/API journeys are deduped site-wide. Per-page smoke/regression/
  // negative/edge baselines must stay even when many pages share a title
  // (e.g. "SmartAPI" on dozens of docs URLs).
  const rows = db.prepare(
    "SELECT title, flow_group, type, steps_json FROM crawl_scenarios WHERE site_id = ? AND status = 'active' AND type IN ('flow', 'api')"
  ).all(siteId) as Array<{ title: string; flow_group: string; type: string; steps_json: string }>;
  const fingerprints = new Set<string>();
  for (const row of rows) {
    fingerprints.add(
      scenarioFingerprint({
        title: row.title,
        flowGroup: row.flow_group,
        type: row.type,
        steps: JSON.parse(row.steps_json),
      })
    );
  }
  return fingerprints;
}

export function listSites() {
  return db.prepare("SELECT * FROM crawl_sites ORDER BY created_at DESC").all();
}

export function getSite(siteId: string) {
  return db.prepare("SELECT * FROM crawl_sites WHERE id = ?").get(siteId) as any;
}

function upsertSiteRow(url: string, captureApi: boolean, mode: "incremental" | "full"): { site: any; isRerun: boolean } {
  const normalized = normalizeUrlLocal(url);
  const existing = findSiteByUrl(normalized);
  const now = new Date().toISOString();
  if (existing) {
    if (existing.status === "running") {
      throw new Error("A crawl is already running for this site. Wait for it to finish or retry later.");
    }
    db.prepare(
      "UPDATE crawl_sites SET status = 'running', current_page = NULL, error = NULL, is_rerun = 1, capture_api = ?, crawl_mode = ? WHERE id = ?"
    ).run(captureApi ? 1 : 0, mode, existing.id);
    return { site: getSite(existing.id), isRerun: true };
  }
  const id = nanoid(10);
  db.prepare(
    `INSERT INTO crawl_sites (id, url, status, pages_discovered, forms_discovered, scenarios_discovered, is_rerun, capture_api, crawl_mode, created_at)
     VALUES (?, ?, 'running', 0, 0, 0, 0, ?, ?, ?)`
  ).run(id, normalized, captureApi ? 1 : 0, mode, now);
  return { site: getSite(id), isRerun: false };
}

function knownUrlsForSite(siteId: string): string[] {
  return (
    db
      .prepare("SELECT url FROM crawl_pages WHERE site_id = ? AND change_status != 'removed' ORDER BY url ASC")
      .all(siteId) as Array<{ url: string }>
  ).map((r) => r.url);
}

function safeParseArray<T>(raw: string | null | undefined): T[] {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

// Headline site counters are an INVENTORY of everything currently known for the
// site, read back from the DB after persistence -- not "what this run happened to
// touch". An incremental re-crawl that legitimately skips unchanged pages must
// still report the same totals as the full crawl before it.
function siteInventoryCounts(siteId: string): {
  pages: number;
  forms: number;
  scenarios: number;
  spellingIssues: number;
} {
  const rows = db
    .prepare("SELECT elements_json, spelling_issues_json FROM crawl_pages WHERE site_id = ? AND change_status != 'removed'")
    .all(siteId) as Array<{ elements_json: string; spelling_issues_json: string }>;
  let forms = 0;
  let spellingIssues = 0;
  for (const row of rows) {
    const elements = safeParseArray<ElementRecord>(row.elements_json);
    if (elements.some((e) => ["input", "textarea", "dropdown"].includes(e.type))) forms += 1;
    spellingIssues += safeParseArray(row.spelling_issues_json).length;
  }
  const scenarios = (
    db.prepare("SELECT COUNT(*) as c FROM crawl_scenarios WHERE site_id = ? AND status = 'active'").get(siteId) as any
  ).c as number;
  return { pages: rows.length, forms, scenarios, spellingIssues };
}

// Runs the crawl to completion and persists everything. Callers (the route)
// invoke this without awaiting so progress can be polled via getSite() while
// it runs -- crawl_sites.status/current_page/*_discovered are updated live via
// the onProgress callback below.
export async function startCrawl(params: {
  url: string;
  username?: string;
  password?: string;
  maxPages?: number;
  captureApi?: boolean;
  concurrency?: number;
  /** incremental (default on re-run) skips deep interaction for unchanged pages; full always deep-scans. */
  mode?: "incremental" | "full";
  /** Scenario depth — default minimal to limit LLM token/capacity usage. */
  coverageMode?: CoverageMode;
}): Promise<{ siteId: string; isRerun: boolean; mode: "incremental" | "full"; modeReason: string }> {
  const existing = findSiteByUrl(params.url);
  const { mode, reason: modeReason } = resolveRecrawlMode(existing, params.mode);
  const { site, isRerun } = upsertSiteRow(params.url, Boolean(params.captureApi), mode);
  const siteId = site.id;
  const knownUrls = isRerun ? knownUrlsForSite(siteId) : [];

  // Re-crawls must cover prior inventory (+ a small buffer for new pages).
  // Otherwise a lower maxPages falsely marks unvisited pages as removed.
  const requestedMax =
    params.maxPages && params.maxPages >= 999999
      ? 999999
      : Math.max(1, params.maxPages ?? 50);
  let effectiveMaxPages = requestedMax;
  if (isRerun && requestedMax < 999999) {
    const buffer = Math.min(20, Math.max(5, Math.ceil(knownUrls.length * 0.15)));
    effectiveMaxPages = Math.max(requestedMax, knownUrls.length + buffer);
  }

  const getBaseline = (url: string): import("../crawler/types.js").PageBaselineMeta | null => {
    const page = findPageByUrl(siteId, url);
    if (!page) return null;
    const row = db
      .prepare(
        `SELECT dom_hash, elements_json, links_json, etag, last_modified, last_seen_at, title, a11y_hash, screenshot_hash, change_status, change_signals_json, http_status, miss_count
         FROM crawl_pages WHERE id = ?`
      )
      .get(page.id) as any;
    if (!row || !row.dom_hash) return null;
    return {
      hash: row.dom_hash,
      elements: JSON.parse(row.elements_json || "[]"),
      etag: row.etag,
      lastModified: row.last_modified,
      lastSeenAt: row.last_seen_at,
      title: row.title,
      a11yHash: row.a11y_hash,
      screenshotHash: row.screenshot_hash,
      links: safeParseArray(row.links_json),
      httpStatus: row.http_status ?? null,
      priorChangeStatus: row.change_status ?? null,
      missCount: row.miss_count ?? 0,
      snapshot: (() => {
        try {
          const signals = row.change_signals_json ? JSON.parse(row.change_signals_json) : null;
          return signals?.snapshot ?? null;
        } catch {
          return null;
        }
      })(),
    };
  };

  const startedAt = Date.now();
  console.info(
    `[crawler] start site=${siteId} mode=${mode} (${modeReason}) isRerun=${isRerun} maxPages=${effectiveMaxPages} known=${knownUrls.length}`
  );

  runCrawl(
    {
      url: params.url,
      username: params.username,
      password: params.password,
      maxPages: effectiveMaxPages,
      captureApi: params.captureApi,
      concurrency: params.concurrency,
      mode,
      coverageMode: params.coverageMode || (process.env.CRAWL_COVERAGE_MODE as CoverageMode) || "full",
      knownUrls,
      onProgress: (p) => {
        db.prepare(
          "UPDATE crawl_sites SET pages_discovered = ?, forms_discovered = ?, current_page = ?, last_progress_json = ? WHERE id = ?"
        ).run(
          p.pagesDiscovered,
          p.formsDiscovered,
          p.currentPage,
          JSON.stringify({
            skippedHttp: p.skippedHttp ?? 0,
            scannedBrowser: p.scannedBrowser ?? 0,
            deepScans: p.deepScans ?? 0,
            reusedBaselines: p.reusedBaselines ?? 0,
            currentPage: p.currentPage,
            at: new Date().toISOString(),
          }),
          siteId
        );
      },
    },
    getBaseline
  )
    .then((result) => {
      const summary = persistCrawlResult(siteId, result, isRerun, {
        knownUrls,
        maxPages: effectiveMaxPages,
        elapsedMs: Date.now() - startedAt,
        modeReason,
      });
      // P1: self-heal locators on changed/new pages
      try {
        const heal = healScriptsForSiteDelta(siteId);
        if (heal.healed > 0) {
          console.info(`[crawler] self-healed ${heal.healed}/${heal.checked} scripts for site ${siteId}`);
        }
      } catch (err: any) {
        console.warn(`[crawler] locator heal skipped: ${err?.message || err}`);
      }
      // On re-crawl, only scan pages that are new or changed -- unchanged pages were
      // already scanned (or unchanged) and re-scanning every page is wasteful.
      const scanStatuses = isRerun ? (["new", "changed"] as const) : undefined;
      runPostCrawlBugScan(siteId, { changeStatuses: scanStatuses ? [...scanStatuses] : undefined }).catch((err) => {
        console.warn(`[crawler] post-crawl bug scan failed for site ${siteId}: ${err?.message ?? err}`);
      });
      // Auto-generate regression/smoke test cases so the client gets a runnable baseline suite.
      autoGenerateRegressionTests(siteId).catch((err) => {
        console.warn(`[crawler] auto regression test generation failed for site ${siteId}: ${err?.message ?? err}`);
      });
      return summary;
    })
    .catch((err: any) => {
      db.prepare("UPDATE crawl_sites SET status = 'failed', error = ? WHERE id = ?").run(err.message || String(err), siteId);
    });

  return { siteId, isRerun, mode, modeReason };
}

function mergeScenariosForPage(
  siteId: string,
  pageId: string,
  incoming: Array<{ id: string; title: string; type: string; tier: string; flowGroup: string; steps: string[]; locators: string[] }>,
  siteFingerprints: Set<string>,
  now: string
) {
  const existing = db.prepare(
    "SELECT id, title, type, flow_group, steps_json, locators_json, generated_test_case_id, status FROM crawl_scenarios WHERE page_id = ? AND status = 'active'"
  ).all(pageId) as Array<{
    id: string;
    title: string;
    type: string;
    flow_group: string;
    steps_json: string;
    locators_json: string;
    generated_test_case_id: string | null;
    status: string;
  }>;

  const existingByFp = new Map<string, (typeof existing)[0]>();
  for (const row of existing) {
    const fp = scenarioFingerprint({
      title: row.title,
      flowGroup: row.flow_group,
      type: row.type,
      steps: JSON.parse(row.steps_json),
    });
    existingByFp.set(fp, row);
  }

  const keptFps = new Set<string>();
  for (const scenario of incoming) {
    const fp = scenarioFingerprint(scenario);
    keptFps.add(fp);
    const prior = existingByFp.get(fp);
    if (prior) {
      // Same scenario still present -- refresh locators/steps in place (keeps generated_test_case_id).
      db.prepare(
        "UPDATE crawl_scenarios SET steps_json = ?, locators_json = ?, tier = ?, updated_at = ? WHERE id = ?"
      ).run(JSON.stringify(scenario.steps), JSON.stringify(scenario.locators), scenario.tier, now, prior.id);
      if (scenario.type === "flow" || scenario.type === "api") siteFingerprints.add(fp);
      continue;
    }
    // Cross-page skip only for journeys/APIs -- never drop another page's smoke/negative/edge.
    if ((scenario.type === "flow" || scenario.type === "api") && siteFingerprints.has(fp)) continue;
    if (scenario.type === "flow" || scenario.type === "api") siteFingerprints.add(fp);
    db.prepare(
      `INSERT INTO crawl_scenarios (id, site_id, page_id, title, type, tier, flow_group, steps_json, locators_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`
    ).run(scenario.id, siteId, pageId, scenario.title, scenario.type, scenario.tier, scenario.flowGroup, JSON.stringify(scenario.steps), JSON.stringify(scenario.locators), now, now);
  }

  // Retire scenarios that no longer apply to this page.
  for (const [fp, row] of existingByFp) {
    if (keptFps.has(fp)) continue;
    if (row.generated_test_case_id) {
      // Keep the linked test case, but mark the crawl scenario soft-deleted so
      // Review & curate doesn't keep offering a stale discovery.
      db.prepare(
        "UPDATE crawl_scenarios SET status = 'soft_deleted', deleted_at = ?, updated_at = ? WHERE id = ?"
      ).run(now, now, row.id);
    } else {
      db.prepare(
        "UPDATE crawl_scenarios SET status = 'soft_deleted', deleted_at = ?, updated_at = ? WHERE id = ?"
      ).run(now, now, row.id);
    }
    siteFingerprints.delete(fp);
  }
}

function pageSignalsJson(page: CrawlRunOutput["pages"][number], previousJson?: string | null): string {
  let previous: Record<string, unknown> = {};
  try {
    previous = previousJson ? JSON.parse(previousJson) : {};
  } catch {
    previous = {};
  }
  return JSON.stringify({
    ...previous,
    ...(page.changeSignals || {}),
    snapshot: page.snapshot || previous.snapshot,
    events: page.diff?.events || previous.events,
    httpStatus: page.httpStatus ?? previous.httpStatus ?? null,
  });
}

function persistCrawlResult(
  siteId: string,
  result: CrawlRunOutput,
  isRerun: boolean,
  opts?: {
    knownUrls?: string[];
    maxPages?: number;
    elapsedMs?: number;
    modeReason?: string;
  }
) {
  const now = new Date().toISOString();
  let removedPages = 0;
  let preservedUnvisited = 0;
  const priorSummaryRow = db.prepare("SELECT recrawl_summary_json FROM crawl_sites WHERE id = ?").get(siteId) as
    | { recrawl_summary_json?: string }
    | undefined;
  let priorSitemapKeys: string[] = [];
  try {
    priorSitemapKeys = JSON.parse(priorSummaryRow?.recrawl_summary_json || "{}")?.coverage?.sitemapKeys || [];
  } catch {
    priorSitemapKeys = [];
  }

  const tx = db.transaction(() => {
    const siteFingerprints = loadSiteScenarioFingerprints(siteId);
    const seenKeys = new Set<string>();

    for (const page of result.pages) {
      const existingPage = findPageByUrl(siteId, page.url);
      const pageId = existingPage?.id || nanoid(10);
      seenKeys.add(dedupeKey(page.url));

      if (existingPage) {
        const prevSignals = (db.prepare("SELECT change_signals_json FROM crawl_pages WHERE id = ?").get(pageId) as { change_signals_json?: string } | undefined)
          ?.change_signals_json;
        // Unchanged pages: refresh last_seen/change_status but keep elements/apis/spelling unless we have fresher data.
        if (page.changeStatus === "unchanged") {
          // Never zero out stored inventory (spelling issues, adjacency) for a page
          // we deliberately didn't re-scan -- only refresh it when this run actually
          // produced something.
          const spellingJson = JSON.stringify(page.spellingIssues);
          const linksJson = JSON.stringify(page.links ?? []);
          db.prepare(
            `UPDATE crawl_pages SET title = ?, change_status = 'unchanged', last_seen_at = ?, updated_at = ?,
             etag = COALESCE(?, etag), last_modified = COALESCE(?, last_modified),
             a11y_hash = COALESCE(?, a11y_hash), screenshot_hash = COALESCE(?, screenshot_hash),
             spelling_issues_json = CASE WHEN ? = '[]' THEN spelling_issues_json ELSE ? END,
             links_json = CASE WHEN ? = '[]' THEN links_json ELSE ? END,
             change_signals_json = ?, is_persisted_from_previous_crawl = 1
             WHERE id = ?`
          ).run(
            page.title,
            now,
            now,
            page.etag ?? null,
            page.lastModified ?? null,
            page.a11yHash ?? null,
            page.screenshotHash ?? null,
            spellingJson,
            spellingJson,
            linksJson,
            linksJson,
            pageSignalsJson(
              {
                ...page,
                changeSignals: page.changeSignals || { structure: "same", http: page.skippedHttp ? "not-modified" : "unknown" },
              },
              prevSignals
            ),
            pageId
          );
        } else {
          db.prepare(
            `UPDATE crawl_pages SET title = ?, dom_hash = ?, elements_json = ?, apis_json = ?, change_status = ?, diff_json = ?, spelling_issues_json = ?, component_inventory_json = ?, links_json = ?, last_seen_at = ?, updated_at = ?,
             etag = ?, last_modified = ?, a11y_hash = ?, screenshot_hash = ?, change_signals_json = ?, is_persisted_from_previous_crawl = 0
             WHERE id = ?`
          ).run(
            page.title,
            page.hash,
            JSON.stringify(page.elements),
            page.apis.length ? JSON.stringify(page.apis) : (db.prepare("SELECT apis_json FROM crawl_pages WHERE id = ?").get(pageId) as any)?.apis_json ?? "[]",
            page.changeStatus,
            page.diff ? JSON.stringify(page.diff) : null,
            JSON.stringify(page.spellingIssues),
            JSON.stringify(page.componentInventory),
            JSON.stringify(page.links ?? []),
            now,
            now,
            page.etag ?? null,
            page.lastModified ?? null,
            page.a11yHash ?? null,
            page.screenshotHash ?? null,
            pageSignalsJson(page, prevSignals),
            pageId
          );
        }
      } else {
        db.prepare(
          `INSERT INTO crawl_pages (id, site_id, url, title, dom_hash, screenshot_hash, elements_json, apis_json, change_status, diff_json, spelling_issues_json, component_inventory_json, links_json, last_seen_at, created_at, updated_at, etag, last_modified, a11y_hash, change_signals_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          pageId,
          siteId,
          page.url,
          page.title,
          page.hash,
          page.screenshotHash ?? null,
          JSON.stringify(page.elements),
          JSON.stringify(page.apis),
          page.changeStatus,
          page.diff ? JSON.stringify(page.diff) : null,
          JSON.stringify(page.spellingIssues),
          JSON.stringify(page.componentInventory),
          JSON.stringify(page.links ?? []),
          now,
          now,
          now,
          page.etag ?? null,
          page.lastModified ?? null,
          page.a11yHash ?? null,
          pageSignalsJson(page)
        );
      }

      if (page.changeStatus !== "unchanged") {
        mergeScenariosForPage(siteId, pageId, page.scenarios, siteFingerprints, now);
      } else if (isRerun && existingPage) {
        db.prepare("UPDATE crawl_scenarios SET tier = 'regression', updated_at = ? WHERE page_id = ? AND status = 'active'").run(now, pageId);
      }

      // Phase 2 cache: fingerprint page elements so repeat crawls can reuse scenario sets.
      if (isCacheEnabled() && page.elements?.length) {
        try {
          const fp = computePageFingerprint(JSON.stringify({ url: page.url, elements: page.elements }));
          const cached = getTestCaseFromCache(fp.hash);
          if (cached?.length && page.changeStatus === "unchanged") {
            console.info(`[crawler] cache hit for ${page.url} (${cached.length} scenarios)`);
          }
          if (page.scenarios?.length) {
            cacheTestCase(fp.hash, page.scenarios, 86400);
          }
        } catch {
          /* non-blocking */
        }
      }

      catalogScreen({ name: page.title || page.url, sourceInputId: siteId, urlOrPath: page.url, content: page.hash });
      db.prepare("UPDATE crawl_pages SET miss_count = 0, http_status = COALESCE(?, http_status) WHERE id = ?").run(
        page.httpStatus ?? null,
        pageId
      );
    }

    // Only mark pages removed when we actually covered the prior inventory.
    // If maxPages truncated the run, leave unvisited pages alone (not "removed").
    const knownKeys = new Set((opts?.knownUrls || []).map((u) => dedupeKey(u)));
    const visitedAllKnown =
      knownKeys.size === 0 || [...knownKeys].every((k) => seenKeys.has(k));
    const hitMaxPagesCap =
      typeof opts?.maxPages === "number" &&
      opts.maxPages < 999999 &&
      result.pages.length >= opts.maxPages;
    const safeToMarkRemoved = isRerun && visitedAllKnown && !hitMaxPagesCap;

    let temporarilyUnavailable = 0;
    if (isRerun) {
      const priorPages = db
        .prepare("SELECT id, url, miss_count FROM crawl_pages WHERE site_id = ? AND change_status != 'removed'")
        .all(siteId) as Array<{ id: string; url: string; miss_count?: number }>;
      for (const prior of priorPages) {
        if (seenKeys.has(dedupeKey(prior.url))) continue;
        if (!safeToMarkRemoved) {
          preservedUnvisited++;
          continue;
        }
        const misses = (prior.miss_count ?? 0) + 1;
        if (misses < 2) {
          temporarilyUnavailable++;
          db.prepare("UPDATE crawl_pages SET change_status = 'temporarily_unavailable', miss_count = ?, updated_at = ? WHERE id = ?").run(
            misses,
            now,
            prior.id
          );
        } else {
          removedPages++;
          db.prepare("UPDATE crawl_pages SET change_status = 'removed', miss_count = ?, updated_at = ? WHERE id = ?").run(misses, now, prior.id);
          db.prepare(
            "UPDATE crawl_scenarios SET status = 'soft_deleted', deleted_at = ?, updated_at = ? WHERE page_id = ? AND status = 'active' AND generated_test_case_id IS NULL"
          ).run(now, now, prior.id);
        }
      }
    }

    const elapsedMs = opts?.elapsedMs || 0;
    const inventory = siteInventoryCounts(siteId);
    const currentSitemapKeys: string[] = result.summary?.coverage?.sitemapKeys || [];
    const priorSet = new Set(priorSitemapKeys);
    const currentSet = new Set(currentSitemapKeys);
    const sitemapAdded = currentSitemapKeys.filter((k) => !priorSet.has(k)).length;
    const sitemapRemoved = priorSitemapKeys.filter((k) => !currentSet.has(k)).length;

    const summary = {
      ...(result.summary ?? { mode: isRerun ? "incremental" : "full", newPages: 0, changedPages: 0, unchangedPages: 0, reusedBaselines: 0 }),
      removedPages,
      temporarilyUnavailable,
      restoredPages: result.summary?.restoredPages ?? result.pages.filter((p) => p.changeStatus === "restored").length,
      preservedUnvisited,
      truncatedByMaxPages: hitMaxPagesCap && !visitedAllKnown,
      pagesVisitedThisRun: result.pages.length,
      scenariosActive: inventory.scenarios,
      elapsedMs,
      modeReason: opts?.modeReason || null,
      effectiveMaxPages: opts?.maxPages ?? null,
      skippedHttp: result.summary?.skippedHttp ?? 0,
      scannedBrowser: result.summary?.scannedBrowser ?? result.pages.length,
      deepScans: result.summary?.deepScans ?? 0,
      coverage: result.summary?.coverage ?? null,
      sitemapAdded,
      sitemapRemoved,
    };

    db.prepare(
      "UPDATE crawl_sites SET status = 'completed', pages_discovered = ?, forms_discovered = ?, scenarios_discovered = ?, spelling_issues_found = ?, current_page = NULL, last_crawled_at = ?, recrawl_summary_json = ? WHERE id = ?"
    ).run(inventory.pages, inventory.forms, inventory.scenarios, inventory.spellingIssues, now, JSON.stringify(summary), siteId);

    // Feature 10: feed live incremental stats for Costs hub
    try {
      const unchanged = Number(summary.unchangedPages || 0);
      const changed = Number(summary.changedPages || 0) + Number(summary.newPages || 0);
      const total = Math.max(1, unchanged + changed);
      recordIncrementalCrawlCompletion({
        totalPages: total,
        changedPages: changed,
        unchangedPages: unchanged,
        skippedPages: unchanged,
        pagesScanned: total,
        timeElapsed: elapsedMs,
        costSavings: Number(((unchanged / total) * 2.5).toFixed(2)),
        hasCriticalChanges: changed > total * 0.3,
      });
    } catch {
      /* non-blocking */
    }

    return summary;
  });

  return tx();
}

const SYSTEM_CRAWLER_ACTOR: CurrentUser = { id: "crawler-system", name: "Crawler System", role: "QA Lead" };

/** After crawl: generate only smoke + flow scripts by default (token-efficient). */
export async function autoGenerateRegressionTests(siteId: string, limit = 60): Promise<{ generated: number; skipped: number }> {
  const scenarios = db
    .prepare(
      `SELECT id FROM crawl_scenarios
       WHERE site_id = ? AND status = 'active' AND generated_test_case_id IS NULL
         AND (
           tier = 'smoke'
           OR type = 'flow'
           OR (tier = 'regression' AND type = 'positive')
         )
       ORDER BY CASE
         WHEN tier = 'smoke' THEN 0
         WHEN type = 'flow' THEN 1
         WHEN tier = 'regression' THEN 2
         ELSE 5
       END, created_at ASC
       LIMIT ?`
    )
    .all(siteId, limit) as Array<{ id: string }>;

  if (scenarios.length === 0) return { generated: 0, skipped: 0 };

  const results = await generateTestsFromScenarios(
    scenarios.map((s) => s.id),
    SYSTEM_CRAWLER_ACTOR
  );
  const generated = results.filter((r) => r.ok && r.testCaseId && !r.error?.includes("skipped")).length;
  const skipped = results.length - generated;
  logAudit(SYSTEM_CRAWLER_ACTOR, "crawl_auto_coverage_generated", "crawl_site", siteId, { generated, skipped, total: results.length });
  return { generated, skipped };
}

export function getSiteDetail(siteId: string, opts?: { includeRemoved?: boolean }) {
  const site = getSite(siteId);
  if (!site) return null;
  const pageRows = opts?.includeRemoved
    ? (db.prepare("SELECT * FROM crawl_pages WHERE site_id = ? ORDER BY created_at ASC").all(siteId) as any[])
    : (db.prepare("SELECT * FROM crawl_pages WHERE site_id = ? AND change_status != 'removed' ORDER BY created_at ASC").all(siteId) as any[]);
  const pages = pageRows.map((p) => ({
    ...p,
    elements: JSON.parse(p.elements_json),
    apis: JSON.parse(p.apis_json),
    diff: p.diff_json ? JSON.parse(p.diff_json) : null,
    spellingIssues: JSON.parse(p.spelling_issues_json || "[]"),
    componentInventory: JSON.parse(p.component_inventory_json || "[]"),
    changeSignals: (() => {
      try {
        return JSON.parse(p.change_signals_json || "{}");
      } catch {
        return {};
      }
    })(),
    scenarios: (db.prepare("SELECT * FROM crawl_scenarios WHERE page_id = ? AND status = 'active' ORDER BY created_at ASC").all(p.id) as any[]).map(parseScenarioRow),
  }));
  const recrawlSummary = site.recrawl_summary_json ? JSON.parse(site.recrawl_summary_json) : null;
  let progress = null;
  try {
    progress = site.last_progress_json ? JSON.parse(site.last_progress_json) : null;
  } catch {
    progress = null;
  }
  return {
    site: { ...site, recrawl_summary: recrawlSummary, progress },
    pages,
    componentCoverage: buildComponentCoverageSummary(pages),
  };
}

/** Site-wide rollup of inventory kinds + how many component scenarios already exist. */
function buildComponentCoverageSummary(
  pages: Array<{
    id: string;
    url: string;
    title: string;
    componentInventory: Array<{ kind: string; label: string; count: number; samples: string[] }>;
    scenarios: Array<{ flow_group?: string; title?: string }>;
  }>
) {
  const byKind = new Map<
    string,
    { kind: string; label: string; totalCount: number; pageCount: number; pages: string[]; scenarioCount: number }
  >();

  for (const page of pages) {
    const pageLabel = page.title || page.url;
    const componentScenarioCount = (page.scenarios || []).filter((s) =>
      String(s.flow_group || "").startsWith("Components:")
    ).length;
    for (const item of page.componentInventory || []) {
      const prev = byKind.get(item.kind) || {
        kind: item.kind,
        label: item.label,
        totalCount: 0,
        pageCount: 0,
        pages: [] as string[],
        scenarioCount: 0,
      };
      prev.totalCount += Number(item.count) || 0;
      prev.pageCount += 1;
      if (prev.pages.length < 8) prev.pages.push(pageLabel);
      // Attribute page's component scenarios once per inventory row on that page
      // would double-count; instead we add them after the inventory loop below.
      byKind.set(item.kind, prev);
    }
    // Distribute this page's component scenario count across kinds present on the page
    // (equal split is fine for the UI "has tests?" signal; exact mapping is per-title).
    const kindsOnPage = (page.componentInventory || []).map((i) => i.kind);
    if (kindsOnPage.length && componentScenarioCount > 0) {
      for (const kind of kindsOnPage) {
        const row = byKind.get(kind);
        if (row) row.scenarioCount += 1; // mark kind covered on this page
      }
    }
  }

  const kinds = Array.from(byKind.values()).sort((a, b) => b.totalCount - a.totalCount || a.label.localeCompare(b.label));
  return {
    kinds,
    knownKinds: KNOWN_COMPONENT_KINDS,
    pagesWithInventory: pages.filter((p) => (p.componentInventory || []).length > 0).length,
    pagesTotal: pages.length,
  };
}

/**
 * Backfill one consolidated component scenario per page (minimal coverage).
 * Merges into existing scenarios; does not retire curated ones.
 */
export function ensureComponentCoverageScenarios(siteId: string) {
  const site = getSite(siteId);
  if (!site) throw new Error("Site not found.");
  const pages = db
    .prepare("SELECT * FROM crawl_pages WHERE site_id = ? AND change_status != 'removed' ORDER BY created_at ASC")
    .all(siteId) as any[];
  const now = new Date().toISOString();
  let added = 0;
  let pagesUpdated = 0;

  const tx = db.transaction(() => {
    const siteFingerprints = loadSiteScenarioFingerprints(siteId);
    for (const page of pages) {
      const inventory = JSON.parse(page.component_inventory_json || "[]");
      const elements = JSON.parse(page.elements_json || "[]") as ElementRecord[];
      if (!Array.isArray(inventory) || inventory.length === 0) continue;

      const existingRows = db
        .prepare("SELECT * FROM crawl_scenarios WHERE page_id = ? AND status = 'active'")
        .all(page.id) as any[];
      const existingRecords = existingRows.map((row) => ({
        id: row.id,
        title: row.title,
        type: row.type as any,
        tier: (row.tier || "functional") as any,
        flowGroup: row.flow_group,
        steps: JSON.parse(row.steps_json),
        locators: JSON.parse(row.locators_json),
      }));
      // Already has a consolidated Components: scenario — skip.
      if (existingRecords.some((s) => String(s.flowGroup || "").startsWith("Components:"))) continue;

      const beforeFps = new Set(existingRecords.map((s) => scenarioFingerprint(s)));
      const consolidated = buildConsolidatedComponentScenario(page.title, elements, inventory, page.url);
      if (!consolidated) continue;

      mergeScenariosForPage(siteId, page.id, [...existingRecords, consolidated], siteFingerprints, now);

      const afterRows = db
        .prepare("SELECT title, flow_group, type, steps_json FROM crawl_scenarios WHERE page_id = ? AND status = 'active'")
        .all(page.id) as any[];
      const newlyAdded = afterRows.filter((row) => {
        const fp = scenarioFingerprint({
          title: row.title,
          flowGroup: row.flow_group,
          type: row.type,
          steps: JSON.parse(row.steps_json),
        });
        return !beforeFps.has(fp);
      }).length;
      if (newlyAdded > 0) {
        added += newlyAdded;
        pagesUpdated += 1;
      }
    }

    const totalScenarios = (
      db.prepare("SELECT COUNT(*) as c FROM crawl_scenarios WHERE site_id = ? AND status = 'active'").get(siteId) as any
    ).c;
    db.prepare("UPDATE crawl_sites SET scenarios_discovered = ? WHERE id = ?").run(totalScenarios, siteId);
  });
  tx();

  return { siteId, added, pagesUpdated };
}

/**
 * Rebuild each page's scenarios to the requested coverage mode (default minimal).
 * Soft-deletes excess scenarios that were never turned into test cases.
 * Keeps scenarios that already have generated_test_case_id.
 */
export function rebuildCoverageScenarios(siteId: string, coverageMode: CoverageMode = "minimal") {
  const site = getSite(siteId);
  if (!site) throw new Error("Site not found.");
  const pages = db
    .prepare("SELECT * FROM crawl_pages WHERE site_id = ? AND change_status != 'removed' ORDER BY created_at ASC")
    .all(siteId) as any[];
  const now = new Date().toISOString();
  let added = 0;
  let retired = 0;
  let pagesUpdated = 0;

  const tx = db.transaction(() => {
    const siteFingerprints = loadSiteScenarioFingerprints(siteId);
    for (const page of pages) {
      const inventory = JSON.parse(page.component_inventory_json || "[]");
      const elements = JSON.parse(page.elements_json || "[]") as ElementRecord[];
      const formCount = elements.some((e) => ["input", "textarea", "dropdown"].includes(e.type)) ? 1 : 0;
      const desired = buildScenariosForPage(page.title, elements, formCount, page.url, inventory, coverageMode);

      const existingRows = db
        .prepare("SELECT * FROM crawl_scenarios WHERE page_id = ? AND status = 'active'")
        .all(page.id) as any[];

      const desiredFps = new Set(desired.map((s) => scenarioFingerprint(s)));

      // Soft-delete excess scenarios (including ones already codegen'd) so the
      // active review list stays minimal. Do NOT cascade-delete test artifacts —
      // those scripts remain on disk but are no longer offered for re-generation.
      const flowRows = existingRows.filter((row) => row.type === "flow");
      const flowKeepIds = new Set(
        flowRows
          .slice()
          .sort((a, b) => {
            const aJourney = String(a.flow_group || "").startsWith("Journey:") ? 0 : 1;
            const bJourney = String(b.flow_group || "").startsWith("Journey:") ? 0 : 1;
            return aJourney - bJourney || String(a.created_at).localeCompare(String(b.created_at));
          })
          .slice(0, coverageMode === "minimal" ? 5 : coverageMode === "standard" ? 10 : 20)
          .map((r) => r.id)
      );

      for (const row of existingRows) {
        const fp = scenarioFingerprint({
          title: row.title,
          flowGroup: row.flow_group,
          type: row.type,
          steps: JSON.parse(row.steps_json),
        });
        if (desiredFps.has(fp)) continue;
        // Keep a small set of existing flows (nav graph isn't rebuilt here).
        if (row.type === "flow" && flowKeepIds.has(row.id)) continue;
        db.prepare(
          "UPDATE crawl_scenarios SET status = 'soft_deleted', deleted_at = ?, updated_at = ? WHERE id = ?"
        ).run(now, now, row.id);
        siteFingerprints.delete(fp);
        retired += 1;
      }

      const beforeCount = (
        db.prepare("SELECT COUNT(*) as c FROM crawl_scenarios WHERE page_id = ? AND status = 'active'").get(page.id) as any
      ).c;

      const surviving = db
        .prepare("SELECT * FROM crawl_scenarios WHERE page_id = ? AND status = 'active'")
        .all(page.id) as any[];
      const survivingRecords = surviving.map((row) => ({
        id: row.id,
        title: row.title,
        type: row.type as any,
        tier: (row.tier || "functional") as any,
        flowGroup: row.flow_group,
        steps: JSON.parse(row.steps_json),
        locators: JSON.parse(row.locators_json),
      }));

      const toAdd = desired.filter((s) => {
        const fp = scenarioFingerprint(s);
        return !survivingRecords.some((e) => scenarioFingerprint(e) === fp);
      });

      if (toAdd.length > 0) {
        mergeScenariosForPage(siteId, page.id, [...survivingRecords, ...toAdd], siteFingerprints, now);
      }

      const afterCount = (
        db.prepare("SELECT COUNT(*) as c FROM crawl_scenarios WHERE page_id = ? AND status = 'active'").get(page.id) as any
      ).c;
      if (afterCount !== beforeCount || toAdd.length > 0) {
        pagesUpdated += 1;
        added += Math.max(0, afterCount - beforeCount);
      }
    }

    const totalScenarios = (
      db.prepare("SELECT COUNT(*) as c FROM crawl_scenarios WHERE site_id = ? AND status = 'active'").get(siteId) as any
    ).c;
    db.prepare("UPDATE crawl_sites SET scenarios_discovered = ? WHERE id = ?").run(totalScenarios, siteId);
  });
  tx();

  return { siteId, coverageMode, added, retired, pagesUpdated };
}

function parseScenarioRow(row: any) {
  return { ...row, steps: JSON.parse(row.steps_json), locators: JSON.parse(row.locators_json) };
}

export function listScenariosForSite(siteId: string, includeDeleted = false) {
  const query = includeDeleted
    ? "SELECT * FROM crawl_scenarios WHERE site_id = ? ORDER BY created_at ASC"
    : "SELECT * FROM crawl_scenarios WHERE site_id = ? AND status = 'active' ORDER BY created_at ASC";
  return (db.prepare(query).all(siteId) as any[]).map(parseScenarioRow);
}

// Phase 7: cascading delete. The scenario record itself is soft-deleted
// (undoable for the session via restoreScenario); if it had already been
// turned into a real test case + automation script (via generateTestsForScenarios),
// those ARE hard-removed immediately -- including the .spec.ts file on disk --
// so no orphaned test code lingers to fail CI. API-capture data on the
// underlying page is left untouched since it may be shared with sibling
// scenarios on the same page (only the scenario's own steps/locators are scenario-scoped).
export function deleteScenario(scenarioId: string, actorUser: any) {
  const scenario = db.prepare("SELECT * FROM crawl_scenarios WHERE id = ?").get(scenarioId) as any;
  if (!scenario) throw new Error("Scenario not found");

  cascadeRemoveGeneratedArtifacts(scenario);

  const now = new Date().toISOString();
  db.prepare("UPDATE crawl_scenarios SET status = 'soft_deleted', deleted_at = ?, updated_at = ? WHERE id = ?").run(now, now, scenarioId);
  logAudit(actorUser, "crawl_scenario_deleted", "crawl_scenario", scenarioId, { title: scenario.title });
  return { ok: true };
}

export function bulkDeleteScenarios(scenarioIds: string[], actorUser: any) {
  const results = scenarioIds.map((id) => {
    try {
      deleteScenario(id, actorUser);
      return { id, ok: true };
    } catch (err: any) {
      return { id, ok: false, error: err.message };
    }
  });
  logAudit(actorUser, "crawl_scenarios_bulk_deleted", "crawl_scenario", null, { ids: scenarioIds, count: scenarioIds.length });
  return results;
}

// Undo, for the current session only (Phase 7): restores the scenario row.
// Note this does NOT resurrect an already-cascaded test case/script/file --
// those were genuinely removed; re-selecting "Generate Tests" for the restored
// scenario creates fresh ones.
export function restoreScenario(scenarioId: string, actorUser: any) {
  const scenario = db.prepare("SELECT * FROM crawl_scenarios WHERE id = ?").get(scenarioId) as any;
  if (!scenario) throw new Error("Scenario not found");
  const now = new Date().toISOString();
  db.prepare("UPDATE crawl_scenarios SET status = 'active', deleted_at = NULL, generated_test_case_id = NULL, updated_at = ? WHERE id = ?").run(now, scenarioId);
  logAudit(actorUser, "crawl_scenario_restored", "crawl_scenario", scenarioId, { title: scenario.title });
  return { ok: true };
}

function cascadeRemoveGeneratedArtifacts(scenario: any) {
  if (!scenario.generated_test_case_id) return;
  const scripts = db.prepare("SELECT * FROM automation_scripts WHERE test_case_id = ?").all(scenario.generated_test_case_id) as any[];
  for (const script of scripts) {
    // Runs (and their per-test evidence rows -- execution_evidence.run_id has a
    // FK to execution_runs with no ON DELETE CASCADE, so evidence must go first
    // or the run delete below fails with SQLITE_CONSTRAINT_FOREIGNKEY) must be
    // removed before the script/test_case they reference, and this whole lookup
    // has to happen BEFORE the automation_scripts delete a few lines down --
    // doing it after would make the "WHERE script_id IN automation_scripts"
    // subquery match nothing, since those rows would already be gone.
    const runs = db.prepare("SELECT id FROM execution_runs WHERE script_id = ?").all(script.id) as Array<{ id: string }>;
    for (const run of runs) {
      db.prepare("DELETE FROM execution_evidence WHERE run_id = ?").run(run.id);
      db.prepare("DELETE FROM bug_findings WHERE run_id = ?").run(run.id);
    }
    db.prepare("DELETE FROM execution_runs WHERE script_id = ?").run(script.id);
    try {
      if (script.file_path && fs.existsSync(script.file_path)) fs.rmSync(script.file_path, { force: true });
    } catch {
      /* best-effort file cleanup */
    }
    db.prepare("DELETE FROM automation_scripts WHERE id = ?").run(script.id);
  }
  db.prepare("DELETE FROM test_cases WHERE id = ?").run(scenario.generated_test_case_id);
}

// Maps a crawl_scenarios row onto the platform-wide test_cases.category enum.
// `tier` (smoke/functional/regression -- see types.ts's ScenarioRecord) is the
// primary signal now; `type` still refines "functional" into the more specific
// API/Negative buckets the rest of the platform already filters/reports on.
function scenarioCategoryFor(scenario: { type: string; tier?: string }): string {
  if (scenario.type === "api") return "API";
  if (scenario.type === "negative") return "Negative";
  if (scenario.type === "edge") return "Edge Case";
  if (scenario.tier === "smoke") return "Smoke";
  if (scenario.tier === "regression") return "Regression";
  return "Functional";
}

// Phase 8 step 4 ("Generate Tests"): turns curated/selected scenarios into a
// real test_case + automation_script (real Playwright .spec.ts on disk),
// reusing the existing generation/codegen/execution/reporting pipeline
// end-to-end rather than building a parallel one.
export async function generateTestsFromScenarios(scenarioIds: string[], actorUser: any) {
  const results: Array<{ scenarioId: string; ok: boolean; testCaseId?: string; scriptFile?: string; error?: string }> = [];

  for (const scenarioId of scenarioIds) {
    const scenario = db.prepare("SELECT * FROM crawl_scenarios WHERE id = ? AND status = 'active'").get(scenarioId) as any;
    if (!scenario) {
      results.push({ scenarioId, ok: false, error: "Scenario not found or already deleted" });
      continue;
    }

    if (scenario.generated_test_case_id) {
      let scriptFile: string | undefined;
      let existingScript = db
        .prepare(
          `SELECT id, file_path, code, framework, language FROM automation_scripts WHERE test_case_id = ?
           ORDER BY needs_regeneration ASC,
                    (CASE WHEN framework = 'playwright' AND language IN ('typescript', 'javascript') THEN 0 ELSE 1 END),
                    created_at DESC
           LIMIT 1`
        )
        .get(scenario.generated_test_case_id) as
        | { id: string; file_path: string; code: string; framework: string; language: string }
        | undefined;
      const currentGeneratorMarker =
        scenario.type === "api" ? /durationMs.*Expected HTTP/s.test(existingScript?.code || "") : /__productIssues/.test(existingScript?.code || "");
      if (
        existingScript &&
        existingScript.framework === "playwright" &&
        ["typescript", "javascript"].includes(existingScript.language) &&
        (!currentGeneratorMarker || /report-email|report-msg|report-abuse|go to homepage/i.test(existingScript.code || ""))
      ) {
        try {
          db.prepare("UPDATE automation_scripts SET needs_regeneration = 1 WHERE id = ?").run(existingScript.id);
          const generation = await generateAutomationScript(scenario.generated_test_case_id);
          existingScript = db
            .prepare(
              `SELECT id, file_path, code, framework, language FROM automation_scripts
               WHERE test_case_id = ? AND needs_regeneration = 0
               ORDER BY created_at DESC LIMIT 1`
            )
            .get(scenario.generated_test_case_id) as typeof existingScript;
          scriptFile = generation.artifacts[0]?.fileName || (existingScript ? path.basename(existingScript.file_path) : undefined);
        } catch (err: any) {
          db.prepare("UPDATE automation_scripts SET needs_regeneration = 0 WHERE id = ?").run(existingScript.id);
          results.push({
            scenarioId,
            ok: false,
            testCaseId: scenario.generated_test_case_id,
            error: err.message || "Failed to upgrade stale automation script",
          });
          continue;
        }
      }
      if (existingScript) {
        scriptFile ||= path.basename(existingScript.file_path);
      } else {
        try {
          const generation = await generateAutomationScript(scenario.generated_test_case_id);
          scriptFile = generation.artifacts[0]?.fileName;
        } catch (err: any) {
          results.push({
            scenarioId,
            ok: false,
            testCaseId: scenario.generated_test_case_id,
            error: err.message || "Failed to generate missing automation script for existing test case",
          });
          continue;
        }
      }
      results.push({
        scenarioId,
        ok: true,
        testCaseId: scenario.generated_test_case_id,
        scriptFile,
        error: existingScript
          ? currentGeneratorMarker
            ? "Test case already generated for this scenario (current generator)"
            : "Regenerated stale automation with real product oracles"
          : "Regenerated missing automation script for existing test case",
      });
      continue;
    }

    try {
      const page = db.prepare("SELECT * FROM crawl_pages WHERE id = ?").get(scenario.page_id) as any;
      const site = db.prepare("SELECT * FROM crawl_sites WHERE id = ?").get(scenario.site_id) as any;

      let input = db.prepare("SELECT * FROM inputs WHERE type = 'url_crawl_scenario' AND content LIKE ?").get(`%${site.url}%`) as any;
      const now = new Date().toISOString();
      if (!input) {
        const inputId = nanoid(10);
        db.prepare("INSERT INTO inputs (id, type, content, created_at) VALUES (?, ?, ?, ?)").run(
          inputId,
          "url_crawl_scenario",
          `AI-crawler-discovered scenarios for ${site.url}`,
          now
        );
        input = { id: inputId };
      }

      const rawSteps: string[] = JSON.parse(scenario.steps_json);
      // Prefer URL navigation over brittle "click link X to reach Y" hops (cards/carousels/truncated titles).
      const steps = normalizeFlowStepsForCodegen(rawSteps, {
        titleToUrl: buildPageTitleUrlIndex(scenario.site_id),
      });
      if (JSON.stringify(steps) !== JSON.stringify(rawSteps)) {
        db.prepare("UPDATE crawl_scenarios SET steps_json = ?, updated_at = ? WHERE id = ?").run(
          JSON.stringify(steps),
          now,
          scenarioId
        );
      }
      const locators: string[] = JSON.parse(scenario.locators_json || "[]");
      const screen = db.prepare("SELECT id FROM screens WHERE url_or_path = ? ORDER BY updated_at DESC LIMIT 1").get(page?.url) as any;
      const pageUrl = page?.url ?? site.url;
      const crawlMetaSuffix = ` CRAWL_URL=${pageUrl} SITE_URL=${site.url}${locators.length ? ` LOCATORS=${JSON.stringify(locators)}` : ""}`;

      // Skip if an equivalent test case already exists for this screen (title + steps match).
      // Still ensure a runnable automation script exists -- prior security-scan failures
      // left orphaned test cases with no script, which broke Generate+Run.
      if (screen) {
        const existingCase = db.prepare(
          "SELECT id FROM test_cases WHERE screen_id = ? AND title = ? AND steps = ? AND status != 'rejected' LIMIT 1"
        ).get(screen.id, scenario.title, JSON.stringify(steps)) as { id: string } | undefined;
        if (existingCase) {
          let scriptFile: string | undefined;
          const existingScript = db
            .prepare(
              `SELECT id, file_path FROM automation_scripts WHERE test_case_id = ?
               ORDER BY (CASE WHEN framework = 'playwright' AND language IN ('typescript', 'javascript') THEN 0 ELSE 1 END), created_at DESC
               LIMIT 1`
            )
            .get(existingCase.id) as { id: string; file_path: string } | undefined;
          if (existingScript) {
            scriptFile = path.basename(existingScript.file_path);
          } else {
            const generation = await generateAutomationScript(existingCase.id);
            scriptFile = generation.artifacts[0]?.fileName;
          }
          db.prepare("UPDATE crawl_scenarios SET generated_test_case_id = ?, updated_at = ? WHERE id = ?").run(existingCase.id, now, scenarioId);
          results.push({
            scenarioId,
            ok: true,
            testCaseId: existingCase.id,
            scriptFile,
            error: existingScript
              ? "Linked to existing equivalent test case (skipped duplicate)"
              : "Linked to existing test case and generated missing automation script",
          });
          continue;
        }
      }

      const testCaseId = fileSafeId();
      db.prepare(`
        INSERT INTO test_cases
          (id, input_id, title, category, steps, expected_result, confidence_score, source_rationale, status, authorship_type, version, priority, created_at, updated_at)
        VALUES (@id, @input_id, @title, @category, @steps, @expected_result, 0.9, @rationale, 'accepted', 'ai', 1, 'Medium', @created_at, @updated_at)
      `).run({
        id: testCaseId,
        input_id: input.id,
        title: scenario.title,
        category: scenarioCategoryFor(scenario),
        steps: JSON.stringify(steps),
        expected_result: steps[steps.length - 1] || "The scenario completes as described.",
        // API scenarios: codegenService passes source_rationale straight through as
        // apiSpecHint, and its "METHOD /path" regex takes the first non-whitespace
        // run after the method -- so the hint must END on the path with nothing
        // trailing (no parenthesis/period), unlike the UI-scenario rationale below.
        rationale:
          scenario.type === "api"
            ? `Discovered by the AI crawler on ${pageUrl} -- API endpoint ${scenario.flow_group}`
            : `Discovered by the AI crawler on ${pageUrl} (${scenario.flow_group}).${crawlMetaSuffix}`,
        created_at: now,
        updated_at: now,
      });

      // FR-2.14 parity: tag the generated test case to the Screen the crawler
      // already catalogued for this page.
      if (screen) db.prepare("UPDATE test_cases SET screen_id = ? WHERE id = ?").run(screen.id, testCaseId);

      try {
        const generation = await generateAutomationScript(testCaseId);
        db.prepare("UPDATE crawl_scenarios SET generated_test_case_id = ?, updated_at = ? WHERE id = ?").run(testCaseId, now, scenarioId);

        logAudit(actorUser, "crawl_scenario_test_generated", "crawl_scenario", scenarioId, { testCaseId, title: scenario.title });
        results.push({ scenarioId, ok: true, testCaseId, scriptFile: generation.artifacts[0]?.fileName });
      } catch (genErr: any) {
        // Roll back the orphaned test case so a later Generate+Run can retry cleanly
        // instead of linking to a case with no automation script.
        db.prepare("DELETE FROM test_cases WHERE id = ?").run(testCaseId);
        // Report the failure, don't throw -- allow batch processing to continue
        results.push({
          scenarioId,
          ok: false,
          testCaseId,
          error: genErr.message || "Failed to generate automation script (test case deleted, can retry)",
        });
        continue;
      }
    } catch (err: any) {
      results.push({ scenarioId, ok: false, error: err.message });
    }
  }

  return results;
}

export async function tickWatchedSites(): Promise<Array<{ siteId: string; started: boolean; reason?: string }>> {
  const rows = db
    .prepare(
      `SELECT id, url, status, schedule_cron, last_crawled_at FROM crawl_sites WHERE watch_enabled = 1`
    )
    .all() as Array<{
    id: string;
    url: string;
    status: string;
    schedule_cron: string | null;
    last_crawled_at: string | null;
  }>;

  const out: Array<{ siteId: string; started: boolean; reason?: string }> = [];
  for (const row of rows) {
    if (row.status === "running") {
      out.push({ siteId: row.id, started: false, reason: "already-running" });
      continue;
    }
    const last = row.last_crawled_at ? new Date(row.last_crawled_at).getTime() : 0;
    const hours = (Date.now() - last) / 3600000;
    if (hours < 20) {
      out.push({ siteId: row.id, started: false, reason: "not-due" });
      continue;
    }
    try {
      await startCrawl({ url: row.url, mode: "incremental" });
      out.push({ siteId: row.id, started: true });
    } catch (err: any) {
      out.push({ siteId: row.id, started: false, reason: err?.message || String(err) });
    }
  }
  return out;
}
