import { Router } from "express";
import { errBody } from "../errorCodes.js";
import {
  bulkDeleteScenarios,
  deleteScenario,
  ensureComponentCoverageScenarios,
  findSiteByUrl,
  generateTestsFromScenarios,
  getSite,
  getSiteDetail,
  listScenariosForSite,
  listSites,
  rebuildCoverageScenarios,
  restoreScenario,
  startCrawl,
} from "../services/crawlerService.js";
import type { CoverageMode } from "../crawler/types.js";
import { planImpactSuite, startImpactSuite, getImpactSuiteJob, getLatestImpactSuiteJob, type ImpactTier } from "../services/impactSuiteService.js";
import { db } from "../db.js";
import { daysSinceIsoHint, estimateRecrawlEta } from "../services/recrawlCockpitService.js";
import { exportCrawlScenariosToPdf, exportCrawlScenariosToXlsx } from "../services/testCaseFeatures.js";

export const crawlerRouter = Router();

crawlerRouter.post("/run", async (req, res) => {
  const { url, username, password, maxPages, captureApi, concurrency, mode, coverageMode } = req.body as {
    url?: string;
    username?: string;
    password?: string;
    maxPages?: number;
    captureApi?: boolean;
    concurrency?: number;
    mode?: "incremental" | "full";
    coverageMode?: CoverageMode;
  };
  if (!url || typeof url !== "string") {
    return res.status(400).json(errBody(400, "A valid URL is required."));
  }
  if (mode && mode !== "incremental" && mode !== "full") {
    return res.status(400).json(errBody(400, "mode must be 'incremental' or 'full'."));
  }
  if (coverageMode && coverageMode !== "minimal" && coverageMode !== "standard" && coverageMode !== "full") {
    return res.status(400).json(errBody(400, "coverageMode must be 'minimal', 'standard', or 'full'."));
  }

  try {
    const { siteId, isRerun, mode: resolvedMode, modeReason } = await startCrawl({
      url,
      username,
      password,
      maxPages,
      captureApi,
      concurrency,
      mode,
      coverageMode,
    });
    res.status(202).json({ siteId, isRerun, mode: resolvedMode, modeReason, status: "running", coverageMode: coverageMode || "full" });
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message || "Failed to start crawl."));
  }
});

crawlerRouter.get("/known-site", (req, res) => {
  const url = req.query.url as string | undefined;
  if (!url) return res.status(400).json(errBody(400, "url query param is required."));
  const site = findSiteByUrl(url);
  res.json({ known: Boolean(site), site: site ?? null });
});

crawlerRouter.get("/sites", (_req, res) => {
  res.json(listSites());
});

crawlerRouter.get("/sites/:id", (req, res) => {
  const site = getSite(req.params.id);
  if (!site) return res.status(404).json(errBody(404, "Site not found."));
  let progress = null;
  try {
    progress = site.last_progress_json ? JSON.parse(site.last_progress_json) : null;
  } catch {
    progress = null;
  }
  res.json({ ...site, progress });
});

crawlerRouter.get("/sites/:id/cockpit", (req, res) => {
  const site = getSite(req.params.id);
  if (!site) return res.status(404).json(errBody(404, "Site not found."));
  const pageCount = (
    db.prepare("SELECT COUNT(*) as c FROM crawl_pages WHERE site_id = ? AND change_status != 'removed'").get(req.params.id) as any
  ).c;
  let progress = null;
  try {
    progress = site.last_progress_json ? JSON.parse(site.last_progress_json) : null;
  } catch {
    progress = null;
  }
  let summary = null;
  try {
    summary = site.recrawl_summary_json ? JSON.parse(site.recrawl_summary_json) : null;
  } catch {
    summary = null;
  }
  const eta = estimateRecrawlEta({
    pageCount,
    mode: site.crawl_mode === "full" ? "full" : "incremental",
    lastSummary: summary,
  });
  res.json({
    siteId: site.id,
    url: site.url,
    status: site.status,
    baselineAge: daysSinceIsoHint(site.last_crawled_at),
    pageCount,
    watchEnabled: Boolean(site.watch_enabled),
    scheduleCron: site.schedule_cron || null,
    modeRecommendation:
      !site.last_crawled_at || daysSinceIsoHint(site.last_crawled_at).days > 7
        ? "full"
        : "incremental",
    honestCopy:
      "Cheap HTTP skip (ETag/Last-Modified/sitemap lastmod) avoids Playwright when unchanged; otherwise shallow probe, then deep only when structure drifts.",
    progress,
    lastSummary: summary,
    eta,
  });
});

crawlerRouter.get("/sites/:id/impact-suite", (req, res) => {
  const tier = ((req.query.tier as string) || "critical") as ImpactTier;
  if (!["smoke", "critical", "full-delta"].includes(tier)) {
    return res.status(400).json(errBody(400, "tier must be smoke|critical|full-delta"));
  }
  const site = getSite(req.params.id);
  if (!site) return res.status(404).json(errBody(404, "Site not found."));
  const jobId = typeof req.query.jobId === "string" ? req.query.jobId : undefined;
  const job = jobId ? getImpactSuiteJob(jobId) : getLatestImpactSuiteJob(req.params.id);
  res.json({ ok: true, plan: planImpactSuite(req.params.id, tier), job: job || null });
});

crawlerRouter.get("/sites/:id/impact-suite/jobs/:jobId", (req, res) => {
  const site = getSite(req.params.id);
  if (!site) return res.status(404).json(errBody(404, "Site not found."));
  const job = getImpactSuiteJob(req.params.jobId);
  if (!job || job.siteId !== req.params.id) return res.status(404).json(errBody(404, "Impact suite job not found."));
  res.json({ ok: true, job });
});

crawlerRouter.post("/sites/:id/impact-suite", async (req, res) => {
  const tier = ((req.body?.tier as string) || "critical") as ImpactTier;
  if (!["smoke", "critical", "full-delta"].includes(tier)) {
    return res.status(400).json(errBody(400, "tier must be smoke|critical|full-delta"));
  }
  try {
    const site = getSite(req.params.id);
    if (!site) return res.status(404).json(errBody(404, "Site not found."));
    // Return immediately; batch runs in background. Poll GET .../impact-suite?jobId= or /jobs/:jobId
    const job = await startImpactSuite(req.params.id, {
      tier,
      actor: req.user,
      concurrency: 5,
    });
    res.status(job.plan.scenarioIds.length === 0 ? 400 : 202).json({
      ok: job.plan.scenarioIds.length > 0,
      jobId: job.id,
      job,
      plan: job.plan,
      generated: job.generated,
      healed: job.healed,
      scriptIds: job.scriptIds,
      message: job.message,
    });
  } catch (err: any) {
    res.status(500).json(errBody(500, err.message || String(err)));
  }
});

crawlerRouter.post("/sites/:id/watch", (req, res) => {
  const site = getSite(req.params.id);
  if (!site) return res.status(404).json(errBody(404, "Site not found."));
  const enabled = Boolean(req.body?.enabled);
  const cron = typeof req.body?.cron === "string" ? req.body.cron : "0 2 * * *";
  db.prepare("UPDATE crawl_sites SET watch_enabled = ?, schedule_cron = ? WHERE id = ?").run(
    enabled ? 1 : 0,
    cron,
    req.params.id
  );
  res.json({ ok: true, watchEnabled: enabled, scheduleCron: cron });
});

crawlerRouter.post("/ci/delta", async (req, res) => {
  const { url, paths, secret, mode } = req.body as {
    url?: string;
    paths?: string[];
    secret?: string;
    mode?: "incremental" | "full";
  };
  if (!url) return res.status(400).json(errBody(400, "url is required"));
  const site = findSiteByUrl(url);
  if (site?.ci_webhook_secret && secret !== site.ci_webhook_secret) {
    return res.status(401).json(errBody(401, "invalid webhook secret"));
  }
  try {
    if (Array.isArray(paths) && paths.length) {
      console.info(`[crawler/ci] delta paths for ${url}: ${paths.slice(0, 20).join(", ")}`);
    }
    const result = await startCrawl({
      url,
      mode: mode || "incremental",
      maxPages: site ? undefined : 50,
    });
    res.status(202).json({ ok: true, ...result, triggeredBy: "ci-webhook" });
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message || String(err)));
  }
});

crawlerRouter.post("/sites/:id/ci-secret", (req, res) => {
  const site = getSite(req.params.id);
  if (!site) return res.status(404).json(errBody(404, "Site not found."));
  const secret =
    typeof req.body?.secret === "string" && req.body.secret
      ? req.body.secret
      : `wh_${Math.random().toString(36).slice(2, 12)}`;
  db.prepare("UPDATE crawl_sites SET ci_webhook_secret = ? WHERE id = ?").run(secret, req.params.id);
  res.json({ ok: true, secret });
});

crawlerRouter.get("/sites/:id/detail", (req, res) => {
  const detail = getSiteDetail(req.params.id);
  if (!detail) return res.status(404).json(errBody(404, "Site not found."));
  res.json(detail);
});

/** Backfill one consolidated component scenario per page from the last crawl (no re-crawl). */
crawlerRouter.post("/sites/:id/component-coverage/ensure", (req, res) => {
  try {
    const result = ensureComponentCoverageScenarios(req.params.id);
    res.json(result);
  } catch (err: any) {
    res.status(404).json(errBody(404, err.message || "Site not found."));
  }
});

/** Rebuild active scenarios to minimal/standard/full coverage without a full re-crawl. */
crawlerRouter.post("/sites/:id/coverage/rebuild", (req, res) => {
  const coverageMode = (req.body?.coverageMode || "full") as CoverageMode;
  if (coverageMode !== "minimal" && coverageMode !== "standard" && coverageMode !== "full") {
    return res.status(400).json(errBody(400, "coverageMode must be 'minimal', 'standard', or 'full'."));
  }
  try {
    const result = rebuildCoverageScenarios(req.params.id, coverageMode);
    res.json(result);
  } catch (err: any) {
    res.status(404).json(errBody(404, err.message || "Site not found."));
  }
});

crawlerRouter.get("/sites/:id/scenarios", (req, res) => {
  res.json(listScenariosForSite(req.params.id, req.query.includeDeleted === "true"));
});

crawlerRouter.get("/sites/:id/export", async (req, res) => {
  const format = String(req.query.format || "xlsx").toLowerCase();
  if (format !== "xlsx" && format !== "pdf") {
    return res.status(400).json(errBody(400, "format must be xlsx or pdf."));
  }
  const site = getSite(req.params.id);
  if (!site) return res.status(404).json(errBody(404, "Site not found."));
  const rows = db
    .prepare(
      `SELECT s.id, s.title, s.type, s.tier, s.steps_json, p.title as page_title, p.url as page_url
       FROM crawl_scenarios s
       JOIN crawl_pages p ON p.id = s.page_id
       WHERE s.site_id = ? AND s.status = 'active'
       ORDER BY p.url ASC, s.created_at ASC`
    )
    .all(req.params.id) as Array<{
    id: string;
    title: string;
    type: string;
    tier: string;
    steps_json: string;
    page_title: string;
    page_url: string;
  }>;
  if (rows.length === 0) return res.status(404).json(errBody(404, "No test cases to export yet. Finish a crawl first."));
  const mapped = rows.map((r) => {
    let steps: string[] = [];
    try {
      steps = JSON.parse(r.steps_json || "[]");
    } catch {
      steps = [];
    }
    return {
      id: r.id,
      title: r.title,
      type: r.type,
      tier: r.tier,
      pageTitle: r.page_title,
      pageUrl: r.page_url,
      steps,
    };
  });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  try {
    if (format === "xlsx") {
      const exportPath = await exportCrawlScenariosToXlsx(mapped, `site-${req.params.id}-test-cases-${stamp}.xlsx`);
      return res.download(exportPath);
    }
    const buffer = await exportCrawlScenariosToPdf(mapped);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="site-${req.params.id}-test-cases-${stamp}.pdf"`);
    return res.send(buffer);
  } catch (err: any) {
    res.status(500).json(errBody(500, err.message || "Export failed."));
  }
});

crawlerRouter.delete("/scenarios/:id", (req, res) => {
  try {
    res.json(deleteScenario(req.params.id, req.user));
  } catch (err: any) {
    res.status(404).json(errBody(404, err.message));
  }
});

crawlerRouter.post("/scenarios/bulk-delete", (req, res) => {
  const { ids } = req.body as { ids?: string[] };
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json(errBody(400, "ids (non-empty array) is required."));
  }
  res.json({ results: bulkDeleteScenarios(ids, req.user) });
});

crawlerRouter.post("/scenarios/:id/restore", (req, res) => {
  try {
    res.json(restoreScenario(req.params.id, req.user));
  } catch (err: any) {
    res.status(404).json(errBody(404, err.message));
  }
});

crawlerRouter.post("/scenarios/generate-tests", async (req, res) => {
  const { scenarioIds } = req.body as { scenarioIds?: string[] };
  if (!Array.isArray(scenarioIds) || scenarioIds.length === 0) {
    return res.status(400).json(errBody(400, "scenarioIds (non-empty array) is required."));
  }
  try {
    const results = await generateTestsFromScenarios(scenarioIds, req.user);
    res.json({ results });
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message));
  }
});
