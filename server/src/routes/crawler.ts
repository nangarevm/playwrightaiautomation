import { Router } from "express";
import { errBody } from "../errorCodes.js";
import {
  bulkDeleteScenarios,
  deleteScenario,
  findSiteByUrl,
  generateTestsFromScenarios,
  getSite,
  getSiteDetail,
  listScenariosForSite,
  listSites,
  restoreScenario,
  startCrawl,
} from "../services/crawlerService.js";

export const crawlerRouter = Router();

// Phase 8 step 1/6: onboarding + auto-detected re-run. A URL already known to
// the crawler is automatically treated as a diff-mode re-run -- no manual
// toggle required.
crawlerRouter.post("/run", async (req, res) => {
  const { url, username, password, maxPages, captureApi, concurrency } = req.body as {
    url?: string;
    username?: string;
    password?: string;
    maxPages?: number;
    captureApi?: boolean;
    concurrency?: number;
  };
  if (!url || typeof url !== "string") {
    return res.status(400).json(errBody(400, "A valid URL is required."));
  }

  try {
    const { siteId, isRerun } = await startCrawl({ url, username, password, maxPages, captureApi, concurrency });
    res.status(202).json({ siteId, isRerun, status: "running" });
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message || "Failed to start crawl."));
  }
});

// Phase 8 step 6: lets the client check "is this URL already known" before the
// user even submits, so the onboarding form can say "we'll diff against your
// last crawl" up front.
crawlerRouter.get("/known-site", (req, res) => {
  const url = req.query.url as string | undefined;
  if (!url) return res.status(400).json(errBody(400, "url query param is required."));
  const site = findSiteByUrl(url);
  res.json({ known: Boolean(site), site: site ?? null });
});

crawlerRouter.get("/sites", (_req, res) => {
  res.json(listSites());
});

// Phase 8 step 2: polled for live progress while a crawl is running.
crawlerRouter.get("/sites/:id", (req, res) => {
  const site = getSite(req.params.id);
  if (!site) return res.status(404).json(errBody(404, "Site not found."));
  res.json(site);
});

// Phase 8 step 3: full curate-before-generate view -- every page with its
// elements/scenarios/diff.
crawlerRouter.get("/sites/:id/detail", (req, res) => {
  const detail = getSiteDetail(req.params.id);
  if (!detail) return res.status(404).json(errBody(404, "Site not found."));
  res.json(detail);
});

crawlerRouter.get("/sites/:id/scenarios", (req, res) => {
  res.json(listScenariosForSite(req.params.id, req.query.includeDeleted === "true"));
});

// Phase 7: single-scenario delete (soft-delete + cascade of any already-generated test/script).
crawlerRouter.delete("/scenarios/:id", (req, res) => {
  try {
    res.json(deleteScenario(req.params.id, req.user));
  } catch (err: any) {
    res.status(404).json(errBody(404, err.message));
  }
});

// Phase 7: multi-select batch delete.
crawlerRouter.post("/scenarios/bulk-delete", (req, res) => {
  const { ids } = req.body as { ids?: string[] };
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json(errBody(400, "ids (non-empty array) is required."));
  }
  res.json({ results: bulkDeleteScenarios(ids, req.user) });
});

// Phase 7: session-scoped undo.
crawlerRouter.post("/scenarios/:id/restore", (req, res) => {
  try {
    res.json(restoreScenario(req.params.id, req.user));
  } catch (err: any) {
    res.status(404).json(errBody(404, err.message));
  }
});

// Phase 8 step 4: turn curated/selected scenarios into real runnable Playwright
// specs via the existing codegen pipeline.
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
