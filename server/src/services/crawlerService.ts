// AI Crawler service layer: owns persistence (crawl_sites/crawl_pages/crawl_scenarios),
// bridges into the existing test_cases/automation_scripts pipeline for "Generate Tests"
// (Phase 8, step 4) so execution/reporting/self-healing all keep working unmodified, and
// implements the Phase 7 test-case-management deletion cascade.

import fs from "fs";
import { nanoid } from "nanoid";
import { db } from "../db.js";
import { runCrawl, type CrawlRunOutput } from "../crawler/index.js";
import type { ElementRecord } from "../crawler/types.js";
import { catalogScreen } from "./screensService.js";
import { generateAutomationScript } from "./codegenService.js";
import { logAudit } from "./adminService.js";

function normalizeUrl(raw: string): string {
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

// FR-8: repeat visits auto-detect a known site and switch to diff mode --
// no manual toggle required by the caller.
export function findSiteByUrl(url: string) {
  return db.prepare("SELECT * FROM crawl_sites WHERE url = ?").get(normalizeUrl(url)) as any;
}

export function listSites() {
  return db.prepare("SELECT * FROM crawl_sites ORDER BY created_at DESC").all();
}

export function getSite(siteId: string) {
  return db.prepare("SELECT * FROM crawl_sites WHERE id = ?").get(siteId) as any;
}

function upsertSiteRow(url: string, captureApi: boolean): { site: any; isRerun: boolean } {
  const normalized = normalizeUrl(url);
  const existing = findSiteByUrl(normalized);
  const now = new Date().toISOString();
  if (existing) {
    db.prepare(
      "UPDATE crawl_sites SET status = 'running', current_page = NULL, error = NULL, is_rerun = 1, capture_api = ? WHERE id = ?"
    ).run(captureApi ? 1 : 0, existing.id);
    return { site: getSite(existing.id), isRerun: true };
  }
  const id = nanoid(10);
  db.prepare(
    `INSERT INTO crawl_sites (id, url, status, pages_discovered, forms_discovered, scenarios_discovered, is_rerun, capture_api, created_at)
     VALUES (?, ?, 'running', 0, 0, 0, 0, ?, ?)`
  ).run(id, normalized, captureApi ? 1 : 0, now);
  return { site: getSite(id), isRerun: false };
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
}): Promise<{ siteId: string; isRerun: boolean }> {
  const { site, isRerun } = upsertSiteRow(params.url, Boolean(params.captureApi));
  const siteId = site.id;

  const getBaseline = (url: string): { hash: string; elements: ElementRecord[] } | null => {
    const row = db.prepare("SELECT dom_hash, elements_json FROM crawl_pages WHERE site_id = ? AND url = ?").get(siteId, url) as any;
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
    .then((result) => persistCrawlResult(siteId, result))
    .catch((err: any) => {
      db.prepare("UPDATE crawl_sites SET status = 'failed', error = ? WHERE id = ?").run(err.message || String(err), siteId);
    });

  return { siteId, isRerun };
}

function persistCrawlResult(siteId: string, result: CrawlRunOutput) {
  const now = new Date().toISOString();
  let totalScenarios = 0;
  let totalForms = 0;
  let totalSpellingIssues = 0;

  const tx = db.transaction(() => {
    for (const page of result.pages) {
      const existingPage = db.prepare("SELECT id FROM crawl_pages WHERE site_id = ? AND url = ?").get(siteId, page.url) as any;
      const pageId = existingPage?.id || nanoid(10);
      const formCount = page.elements.filter((e) => ["input", "textarea", "dropdown"].includes(e.type)).length > 0 ? 1 : 0;
      totalForms += formCount;
      totalSpellingIssues += page.spellingIssues.length;

      if (existingPage) {
        db.prepare(
          `UPDATE crawl_pages SET title = ?, dom_hash = ?, elements_json = ?, apis_json = ?, change_status = ?, diff_json = ?, spelling_issues_json = ?, updated_at = ? WHERE id = ?`
        ).run(page.title, page.hash, JSON.stringify(page.elements), JSON.stringify(page.apis), page.changeStatus, page.diff ? JSON.stringify(page.diff) : null, JSON.stringify(page.spellingIssues), now, pageId);
      } else {
        db.prepare(
          `INSERT INTO crawl_pages (id, site_id, url, title, dom_hash, screenshot_hash, elements_json, apis_json, change_status, diff_json, spelling_issues_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`
        ).run(pageId, siteId, page.url, page.title, page.hash, JSON.stringify(page.elements), JSON.stringify(page.apis), page.changeStatus, page.diff ? JSON.stringify(page.diff) : null, JSON.stringify(page.spellingIssues), now, now);
      }

      // Phase 4: unchanged pages keep whatever scenarios they already have --
      // only new/changed pages get fresh scenario rows inserted here.
      if (page.changeStatus !== "unchanged") {
        for (const scenario of page.scenarios) {
          db.prepare(
            `INSERT INTO crawl_scenarios (id, site_id, page_id, title, type, flow_group, steps_json, locators_json, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`
          ).run(scenario.id, siteId, pageId, scenario.title, scenario.type, scenario.flowGroup, JSON.stringify(scenario.steps), JSON.stringify(scenario.locators), now, now);
        }
      }

      const activeScenarioCount = (db.prepare("SELECT COUNT(*) as c FROM crawl_scenarios WHERE page_id = ? AND status = 'active'").get(pageId) as any).c;
      totalScenarios += activeScenarioCount;

      // FR-1.10 parity: catalog every crawled page as a first-class Screen too,
      // so it participates in the existing Screen Explorer / screen-scoped runs.
      catalogScreen({ name: page.title || page.url, sourceInputId: siteId, urlOrPath: page.url, content: page.hash });
    }

    db.prepare(
      "UPDATE crawl_sites SET status = 'completed', pages_discovered = ?, forms_discovered = ?, scenarios_discovered = ?, spelling_issues_found = ?, current_page = NULL, last_crawled_at = ? WHERE id = ?"
    ).run(result.pages.length, totalForms, totalScenarios, totalSpellingIssues, now, siteId);
  });

  tx();
}

export function getSiteDetail(siteId: string) {
  const site = getSite(siteId);
  if (!site) return null;
  const pages = (db.prepare("SELECT * FROM crawl_pages WHERE site_id = ? ORDER BY created_at ASC").all(siteId) as any[]).map((p) => ({
    ...p,
    elements: JSON.parse(p.elements_json),
    apis: JSON.parse(p.apis_json),
    diff: p.diff_json ? JSON.parse(p.diff_json) : null,
    spellingIssues: JSON.parse(p.spelling_issues_json || "[]"),
    scenarios: (db.prepare("SELECT * FROM crawl_scenarios WHERE page_id = ? AND status = 'active' ORDER BY created_at ASC").all(p.id) as any[]).map(parseScenarioRow),
  }));
  return { site, pages };
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
    try {
      if (script.file_path && fs.existsSync(script.file_path)) fs.rmSync(script.file_path, { force: true });
    } catch {
      /* best-effort file cleanup */
    }
    db.prepare("DELETE FROM automation_scripts WHERE id = ?").run(script.id);
  }
  db.prepare("DELETE FROM execution_runs WHERE script_id IN (SELECT id FROM automation_scripts WHERE test_case_id = ?)").run(scenario.generated_test_case_id);
  db.prepare("DELETE FROM test_cases WHERE id = ?").run(scenario.generated_test_case_id);
}

function scenarioCategoryFor(type: string): string {
  if (type === "api") return "API";
  if (type === "negative") return "Negative";
  if (type === "flow") return "Regression";
  return "Smoke";
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
      const testCaseId = nanoid(10);
      db.prepare(`
        INSERT INTO test_cases
          (id, input_id, title, category, steps, expected_result, confidence_score, source_rationale, status, authorship_type, version, priority, created_at, updated_at)
        VALUES (@id, @input_id, @title, @category, @steps, @expected_result, 0.9, @rationale, 'accepted', 'ai', 1, 'Medium', @created_at, @updated_at)
      `).run({
        id: testCaseId,
        input_id: input.id,
        title: scenario.title,
        category: scenarioCategoryFor(scenario.type),
        steps: JSON.stringify(steps),
        expected_result: steps[steps.length - 1] || "The scenario completes as described.",
        // API scenarios: codegenService passes source_rationale straight through as
        // apiSpecHint, and its "METHOD /path" regex takes the first non-whitespace
        // run after the method -- so the hint must END on the path with nothing
        // trailing (no parenthesis/period), unlike the UI-scenario rationale below.
        rationale:
          scenario.type === "api"
            ? `Discovered by the AI crawler on ${page?.url ?? site.url} -- API endpoint ${scenario.flow_group}`
            : `Discovered by the AI crawler on ${page?.url ?? site.url} (${scenario.flow_group}).`,
        created_at: now,
        updated_at: now,
      });

      // FR-2.14 parity: tag the generated test case to the Screen the crawler
      // already catalogued for this page.
      const screen = db.prepare("SELECT id FROM screens WHERE url_or_path = ? ORDER BY updated_at DESC LIMIT 1").get(page?.url) as any;
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
