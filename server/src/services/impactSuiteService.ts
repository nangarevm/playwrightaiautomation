// Impact suite: heal + regenerate + run only tests for new/changed pages after a re-crawl.
// Runs the heavy Playwright batch asynchronously and exposes job status for the UI.

import { nanoid } from "nanoid";
import { db } from "../db.js";
import { generateTestsFromScenarios } from "./crawlerService.js";
import { healScriptsForSiteDelta } from "./locatorHealService.js";
import { runExecutionBatch } from "./executionService.js";
import type { CurrentUser } from "./adminService.js";

export type ImpactTier = "smoke" | "critical" | "full-delta";

const CRITICAL_HINT =
  /\b(login|sign[\s-]?in|checkout|payment|pay|cart|register|signup|auth|password|order|billing)\b/i;

export interface ImpactSuitePlan {
  siteId: string;
  tier: ImpactTier;
  pageIds: string[];
  scenarioIds: string[];
  existingScriptIds: string[];
  estimatedTests: number;
}

export type ImpactJobStatus = "queued" | "healing" | "generating" | "running" | "completed" | "failed";

export interface ImpactSuiteJob {
  id: string;
  siteId: string;
  tier: ImpactTier;
  status: ImpactJobStatus;
  plan: ImpactSuitePlan;
  generated: number;
  healed: number;
  checked: number;
  scriptIds: string[];
  suggestions?: Array<{ from: string; to: string; reason: string }>;
  batch?: {
    id?: string;
    passed?: number;
    failed?: number;
    concurrentDurationMs?: number;
    scriptCount?: number;
    fileChunks?: number;
  };
  message: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

const jobs = new Map<string, ImpactSuiteJob>();

function touch(job: ImpactSuiteJob, patch: Partial<ImpactSuiteJob>) {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  jobs.set(job.id, job);
  return job;
}

export function getImpactSuiteJob(jobId: string): ImpactSuiteJob | null {
  return jobs.get(jobId) || null;
}

export function getLatestImpactSuiteJob(siteId: string): ImpactSuiteJob | null {
  let latest: ImpactSuiteJob | null = null;
  for (const job of jobs.values()) {
    if (job.siteId !== siteId) continue;
    if (!latest || job.createdAt > latest.createdAt) latest = job;
  }
  return latest;
}

export function planImpactSuite(siteId: string, tier: ImpactTier = "critical"): ImpactSuitePlan {
  const pages = db
    .prepare(
      `SELECT id, url, title, change_status FROM crawl_pages
       WHERE site_id = ? AND change_status IN ('new', 'changed', 'restored')`
    )
    .all(siteId) as Array<{ id: string; url: string; title: string; change_status: string }>;

  let pageIds = pages.map((p) => p.id);
  if (tier === "smoke") {
    pageIds = pages
      .filter((p) => {
        try {
          return /\/(login|signin|home)?\/?$/i.test(new URL(p.url).pathname) || CRITICAL_HINT.test(p.title || "");
        } catch {
          return CRITICAL_HINT.test(p.title || "");
        }
      })
      .map((p) => p.id);
    if (pageIds.length === 0) pageIds = pages.slice(0, 5).map((p) => p.id);
  } else if (tier === "critical") {
    const critical = pages.filter((p) => CRITICAL_HINT.test(`${p.url} ${p.title}`));
    pageIds = (critical.length ? critical : pages).map((p) => p.id);
  }

  const placeholders = pageIds.map(() => "?").join(",") || "''";
  const scenarios = pageIds.length
    ? (db
        .prepare(
          `SELECT id, generated_test_case_id, title, tier, type FROM crawl_scenarios
           WHERE page_id IN (${placeholders}) AND status = 'active'
           ORDER BY CASE
             WHEN tier = 'smoke' THEN 0
             WHEN type = 'flow' THEN 1
             WHEN tier = 'regression' THEN 2
             ELSE 3
           END`
        )
        .all(...pageIds) as Array<{
        id: string;
        generated_test_case_id: string | null;
        title: string;
        tier: string;
        type: string;
      }>)
    : [];

  let filtered = scenarios;
  if (tier === "smoke") {
    filtered = scenarios.filter((s) => s.tier === "smoke" || /smoke|load/i.test(s.title));
  } else if (tier === "critical") {
    filtered = scenarios.filter(
      (s) => s.tier === "smoke" || s.type === "flow" || s.tier === "regression" || CRITICAL_HINT.test(s.title)
    );
  }

  const scenarioIds = filtered.map((s) => s.id);
  const tcIds = filtered.map((s) => s.generated_test_case_id).filter(Boolean) as string[];
  const existingScriptIds: string[] = [];
  for (const tcId of tcIds) {
    const row = db
      .prepare(
        `SELECT id FROM automation_scripts WHERE test_case_id = ? ORDER BY created_at DESC LIMIT 1`
      )
      .get(tcId) as { id: string } | undefined;
    if (row) existingScriptIds.push(row.id);
  }

  return {
    siteId,
    tier,
    pageIds,
    scenarioIds,
    existingScriptIds,
    estimatedTests: Math.max(scenarioIds.length, existingScriptIds.length),
  };
}

/**
 * Starts an impact-suite job and returns immediately. Heal/generate run first;
 * Playwright batch continues in the background. Poll getImpactSuiteJob(jobId).
 */
export async function startImpactSuite(
  siteId: string,
  opts: {
    tier?: ImpactTier;
    actor?: CurrentUser;
    targetUrl?: string;
    concurrency?: number;
  } = {}
): Promise<ImpactSuiteJob> {
  const tier = opts.tier || "critical";
  const plan = planImpactSuite(siteId, tier);
  const now = new Date().toISOString();
  const job: ImpactSuiteJob = {
    id: nanoid(10),
    siteId,
    tier,
    status: "queued",
    plan,
    generated: 0,
    healed: 0,
    checked: 0,
    scriptIds: [],
    message:
      plan.scenarioIds.length === 0
        ? "No new/changed page scenarios found. Run a re-crawl first."
        : `Impact suite (${tier}) queued for ~${plan.estimatedTests} test(s)`,
    createdAt: now,
    updatedAt: now,
  };
  jobs.set(job.id, job);

  if (plan.scenarioIds.length === 0) {
    return touch(job, { status: "failed", finishedAt: new Date().toISOString() });
  }

  // Kick off async pipeline on next tick so HTTP can return "queued" immediately.
  setImmediate(() => {
    void runImpactSuitePipeline(job.id, opts).catch((err) => {
      const current = jobs.get(job.id);
      if (!current) return;
      touch(current, {
        status: "failed",
        error: err?.message || String(err),
        message: `Impact suite failed: ${err?.message || err}`,
        finishedAt: new Date().toISOString(),
      });
    });
  });

  return job;
}

async function runImpactSuitePipeline(
  jobId: string,
  opts: {
    actor?: CurrentUser;
    targetUrl?: string;
    concurrency?: number;
  }
) {
  const job = jobs.get(jobId);
  if (!job) return;

  touch(job, { status: "healing", message: `Healing locators for ${job.tier} delta…` });
  // Heal only pages in this impact plan (not the entire site) so smoke/critical stay fast.
  const heal = healScriptsForSiteDelta(job.siteId, job.plan.pageIds);
  touch(job, {
    healed: heal.healed,
    checked: heal.checked,
    suggestions: heal.suggestions.slice(0, 12),
    message: `Healed ${heal.healed}/${heal.checked} script(s); checking generation…`,
  });

  const needGenerate = job.plan.scenarioIds.filter((id) => {
    const row = db.prepare("SELECT generated_test_case_id FROM crawl_scenarios WHERE id = ?").get(id) as any;
    return !row?.generated_test_case_id;
  });

  let generated = 0;
  if (needGenerate.length > 0) {
    touch(job, {
      status: "generating",
      message: `Generating ${needGenerate.length} missing test case(s)…`,
    });
    const actor: CurrentUser =
      opts.actor || ({ id: "impact-suite", name: "Impact Suite", role: "QA Lead" } as CurrentUser);
    const results = await generateTestsFromScenarios(needGenerate, actor);
    generated = results.filter((r) => r.ok && r.testCaseId).length;
    touch(job, { generated });
  }

  const refreshed = planImpactSuite(job.siteId, job.tier);
  const scriptIds = [...new Set(refreshed.existingScriptIds)];
  touch(job, {
    plan: refreshed,
    scriptIds,
    generated,
    healed: heal.healed,
    checked: heal.checked,
  });

  if (scriptIds.length === 0) {
    touch(job, {
      status: "completed",
      message: `Generated ${generated} test(s); no scripts ready to run yet.`,
      finishedAt: new Date().toISOString(),
    });
    return;
  }

  const site = db.prepare("SELECT url FROM crawl_sites WHERE id = ?").get(job.siteId) as { url: string } | undefined;
  const targetUrl = opts.targetUrl || site?.url || "";

  touch(job, {
    status: "running",
    message: `Impact suite (${job.tier}): healed ${heal.healed}, generated ${generated}, running ${scriptIds.length} script(s)…`,
  });

  const batch = await runExecutionBatch(scriptIds, targetUrl, {
    concurrency: Math.min(5, opts.concurrency ?? 5),
    execution_context: `impact-suite:${job.id}`,
  });

  touch(job, {
    status: "completed",
    batch: {
      id: batch?.id,
      passed: batch?.passed,
      failed: batch?.failed,
      concurrentDurationMs: batch?.concurrentDurationMs,
      scriptCount: batch?.scriptCount,
      fileChunks: batch?.fileChunks,
    },
    message: `Impact suite (${job.tier}) done: healed ${heal.healed}, generated ${generated}, passed ${batch?.passed ?? 0}, failed ${batch?.failed ?? 0} (${scriptIds.length} scripts)`,
    finishedAt: new Date().toISOString(),
  });
}

/** @deprecated Prefer startImpactSuite — kept for callers that still await full completion. */
export async function runImpactSuite(
  siteId: string,
  opts: {
    tier?: ImpactTier;
    actor?: CurrentUser;
    targetUrl?: string;
    concurrency?: number;
  } = {}
): Promise<{
  ok: boolean;
  jobId: string;
  plan: ImpactSuitePlan;
  generated: number;
  healed: number;
  scriptIds: string[];
  batch?: any;
  message: string;
  status: ImpactJobStatus;
}> {
  const job = await startImpactSuite(siteId, opts);
  // Wait until background pipeline finishes (or fails) for sync callers.
  const deadline = Date.now() + 6 * 60 * 60 * 1000;
  while (Date.now() < deadline) {
    const current = jobs.get(job.id)!;
    if (current.status === "completed" || current.status === "failed") {
      return {
        ok: current.status === "completed",
        jobId: current.id,
        plan: current.plan,
        generated: current.generated,
        healed: current.healed,
        scriptIds: current.scriptIds,
        batch: current.batch,
        message: current.message,
        status: current.status,
      };
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return {
    ok: false,
    jobId: job.id,
    plan: job.plan,
    generated: job.generated,
    healed: job.healed,
    scriptIds: job.scriptIds,
    message: "Impact suite timed out waiting for completion",
    status: "failed",
  };
}
