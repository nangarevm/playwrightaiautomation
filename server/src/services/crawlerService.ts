// AI Crawler service layer: owns persistence (crawl_sites/crawl_pages/crawl_scenarios),
// bridges into the existing test_cases/automation_scripts pipeline for "Generate Tests"
// (Phase 8, step 4) so execution/reporting/self-healing all keep working unmodified, and
// implements the Phase 7 test-case-management deletion cascade.

import fs from "fs";
import { nanoid } from "nanoid";
import { db } from "../db.js";
import { runCrawl, type CrawlRunOutput } from "../crawler/index.js";
import type { ElementRecord } from "../crawler/types.js";
import { scenarioFingerprint } from "../crawler/scenarioDedup.js";
import { dedupeKey, normalizeUrl } from "../crawler/urlUtils.js";
import { catalogScreen } from "./screensService.js";
import { generateAutomationScript } from "./codegenService.js";
import { logAudit, type CurrentUser } from "./adminService.js";
import { runPostCrawlBugScan } from "./bugDetectionService.js";

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
  const rows = db.prepare(
    "SELECT title, flow_group, type, steps_json FROM crawl_scenarios WHERE site_id = ? AND status = 'active'"
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
  return (db.prepare("SELECT url FROM crawl_pages WHERE site_id = ? AND change_status != 'removed'").all(siteId) as Array<{ url: string }>).map(
    (r) => r.url
  );
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
}): Promise<{ siteId: string; isRerun: boolean; mode: "incremental" | "full" }> {
  const existing = findSiteByUrl(params.url);
  const mode: "incremental" | "full" = params.mode ?? (existing ? "incremental" : "full");
  const { site, isRerun } = upsertSiteRow(params.url, Boolean(params.captureApi), mode);
  const siteId = site.id;

  const getBaseline = (url: string): { hash: string; elements: ElementRecord[] } | null => {
    const page = findPageByUrl(siteId, url);
    if (!page) return null;
    const row = db.prepare("SELECT dom_hash, elements_json FROM crawl_pages WHERE id = ?").get(page.id) as any;
    if (!row || !row.dom_hash) return null;
    return { hash: row.dom_hash, elements: JSON.parse(row.elements_json) };
  };

  runCrawl(
    {
      url: params.url,
      username: params.username,
      password: params.password,
      maxPages: params.maxPages,
      captureApi: params.captureApi,
      concurrency: params.concurrency,
      mode,
      knownUrls: isRerun ? knownUrlsForSite(siteId) : [],
      onProgress: (p) => {
        db.prepare("UPDATE crawl_sites SET pages_discovered = ?, forms_discovered = ?, current_page = ? WHERE id = ?").run(
          p.pagesDiscovered,
          p.formsDiscovered,
          p.currentPage,
          siteId
        );
      },
    },
    getBaseline
  )
    .then((result) => {
      const summary = persistCrawlResult(siteId, result, isRerun);
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

  return { siteId, isRerun, mode };
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
      siteFingerprints.add(fp);
      continue;
    }
    if (siteFingerprints.has(fp)) continue; // duplicate of another page's scenario
    siteFingerprints.add(fp);
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

function persistCrawlResult(siteId: string, result: CrawlRunOutput, isRerun: boolean) {
  const now = new Date().toISOString();
  let totalScenarios = 0;
  let totalForms = 0;
  let totalSpellingIssues = 0;
  let removedPages = 0;

  const tx = db.transaction(() => {
    const siteFingerprints = loadSiteScenarioFingerprints(siteId);
    const seenKeys = new Set<string>();

    for (const page of result.pages) {
      const existingPage = findPageByUrl(siteId, page.url);
      const pageId = existingPage?.id || nanoid(10);
      seenKeys.add(dedupeKey(page.url));
      const formCount = page.elements.filter((e) => ["input", "textarea", "dropdown"].includes(e.type)).length > 0 ? 1 : 0;
      totalForms += formCount;
      totalSpellingIssues += page.spellingIssues.length;

      if (existingPage) {
        // Unchanged pages: refresh last_seen/change_status but keep elements/apis/spelling unless we have fresher data.
        if (page.changeStatus === "unchanged") {
          db.prepare(
            `UPDATE crawl_pages SET title = ?, change_status = 'unchanged', last_seen_at = ?, updated_at = ? WHERE id = ?`
          ).run(page.title, now, now, pageId);
        } else {
          db.prepare(
            `UPDATE crawl_pages SET title = ?, dom_hash = ?, elements_json = ?, apis_json = ?, change_status = ?, diff_json = ?, spelling_issues_json = ?, component_inventory_json = ?, last_seen_at = ?, updated_at = ? WHERE id = ?`
          ).run(
            page.title,
            page.hash,
            JSON.stringify(page.elements),
            page.apis.length ? JSON.stringify(page.apis) : (db.prepare("SELECT apis_json FROM crawl_pages WHERE id = ?").get(pageId) as any)?.apis_json ?? "[]",
            page.changeStatus,
            page.diff ? JSON.stringify(page.diff) : null,
            JSON.stringify(page.spellingIssues),
            JSON.stringify(page.componentInventory),
            now,
            now,
            pageId
          );
        }
      } else {
        db.prepare(
          `INSERT INTO crawl_pages (id, site_id, url, title, dom_hash, screenshot_hash, elements_json, apis_json, change_status, diff_json, spelling_issues_json, component_inventory_json, last_seen_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          pageId,
          siteId,
          page.url,
          page.title,
          page.hash,
          JSON.stringify(page.elements),
          JSON.stringify(page.apis),
          page.changeStatus,
          page.diff ? JSON.stringify(page.diff) : null,
          JSON.stringify(page.spellingIssues),
          JSON.stringify(page.componentInventory),
          now,
          now,
          now
        );
      }

      if (page.changeStatus !== "unchanged") {
        mergeScenariosForPage(siteId, pageId, page.scenarios, siteFingerprints, now);
      } else if (isRerun && existingPage) {
        db.prepare("UPDATE crawl_scenarios SET tier = 'regression', updated_at = ? WHERE page_id = ? AND status = 'active'").run(now, pageId);
      }

      const activeScenarioCount = (db.prepare("SELECT COUNT(*) as c FROM crawl_scenarios WHERE page_id = ? AND status = 'active'").get(pageId) as any).c;
      totalScenarios += activeScenarioCount;

      catalogScreen({ name: page.title || page.url, sourceInputId: siteId, urlOrPath: page.url, content: page.hash });
    }

    // Pages present in prior crawls but missing this run → marked removed (and their
    // ungenerated scenarios retired). Generated test cases are left alone.
    if (isRerun) {
      const priorPages = db.prepare("SELECT id, url FROM crawl_pages WHERE site_id = ? AND change_status != 'removed'").all(siteId) as Array<{
        id: string;
        url: string;
      }>;
      for (const prior of priorPages) {
        if (seenKeys.has(dedupeKey(prior.url))) continue;
        removedPages++;
        db.prepare("UPDATE crawl_pages SET change_status = 'removed', updated_at = ? WHERE id = ?").run(now, prior.id);
        db.prepare(
          "UPDATE crawl_scenarios SET status = 'soft_deleted', deleted_at = ?, updated_at = ? WHERE page_id = ? AND status = 'active' AND generated_test_case_id IS NULL"
        ).run(now, now, prior.id);
      }
    }

    const summary = {
      ...(result.summary ?? { mode: isRerun ? "incremental" : "full", newPages: 0, changedPages: 0, unchangedPages: 0, reusedBaselines: 0 }),
      removedPages,
      scenariosActive: totalScenarios,
    };

    db.prepare(
      "UPDATE crawl_sites SET status = 'completed', pages_discovered = ?, forms_discovered = ?, scenarios_discovered = ?, spelling_issues_found = ?, current_page = NULL, last_crawled_at = ?, recrawl_summary_json = ? WHERE id = ?"
    ).run(result.pages.length, totalForms, totalScenarios, totalSpellingIssues, now, JSON.stringify(summary), siteId);

    return summary;
  });

  return tx();
}

const SYSTEM_CRAWLER_ACTOR: CurrentUser = { id: "crawler-system", name: "Crawler System", role: "QA Lead" };

/** After crawl: generate smoke, flow, regression, negative, and edge tests — no empty slots. */
export async function autoGenerateRegressionTests(siteId: string, limit = 150): Promise<{ generated: number; skipped: number }> {
  const scenarios = db
    .prepare(
      `SELECT id FROM crawl_scenarios
       WHERE site_id = ? AND status = 'active' AND generated_test_case_id IS NULL
         AND (
           tier IN ('regression', 'smoke')
           OR type IN ('flow', 'negative', 'edge')
         )
       ORDER BY CASE
         WHEN tier = 'smoke' THEN 0
         WHEN type = 'flow' THEN 1
         WHEN tier = 'regression' THEN 2
         WHEN type = 'negative' THEN 3
         WHEN type = 'edge' THEN 4
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
    scenarios: (db.prepare("SELECT * FROM crawl_scenarios WHERE page_id = ? AND status = 'active' ORDER BY created_at ASC").all(p.id) as any[]).map(parseScenarioRow),
  }));
  const recrawlSummary = site.recrawl_summary_json ? JSON.parse(site.recrawl_summary_json) : null;
  return { site: { ...site, recrawl_summary: recrawlSummary }, pages };
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
      results.push({
        scenarioId,
        ok: true,
        testCaseId: scenario.generated_test_case_id,
        error: "Test case already generated for this scenario (skipped duplicate)",
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

      const steps: string[] = JSON.parse(scenario.steps_json);
      const locators: string[] = JSON.parse(scenario.locators_json || "[]");
      const screen = db.prepare("SELECT id FROM screens WHERE url_or_path = ? ORDER BY updated_at DESC LIMIT 1").get(page?.url) as any;
      const pageUrl = page?.url ?? site.url;
      const crawlMetaSuffix = ` CRAWL_URL=${pageUrl}${locators.length ? ` LOCATORS=${JSON.stringify(locators)}` : ""}`;

      // Skip if an equivalent test case already exists for this screen (title + steps match).
      if (screen) {
        const existingCase = db.prepare(
          "SELECT id FROM test_cases WHERE screen_id = ? AND title = ? AND steps = ? AND status != 'rejected' LIMIT 1"
        ).get(screen.id, scenario.title, JSON.stringify(steps)) as { id: string } | undefined;
        if (existingCase) {
          db.prepare("UPDATE crawl_scenarios SET generated_test_case_id = ?, updated_at = ? WHERE id = ?").run(existingCase.id, now, scenarioId);
          results.push({
            scenarioId,
            ok: true,
            testCaseId: existingCase.id,
            error: "Linked to existing equivalent test case (skipped duplicate)",
          });
          continue;
        }
      }

      const testCaseId = nanoid(10);
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

      const generation = await generateAutomationScript(testCaseId);
      db.prepare("UPDATE crawl_scenarios SET generated_test_case_id = ?, updated_at = ? WHERE id = ?").run(testCaseId, now, scenarioId);

      logAudit(actorUser, "crawl_scenario_test_generated", "crawl_scenario", scenarioId, { testCaseId, title: scenario.title });
      results.push({ scenarioId, ok: true, testCaseId, scriptFile: generation.artifacts[0]?.fileName });
    } catch (err: any) {
      results.push({ scenarioId, ok: false, error: err.message });
    }
  }

  return results;
}
