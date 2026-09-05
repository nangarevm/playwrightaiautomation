import { Router } from "express";
import { db } from "../db.js";
import {
  diffAgainstVisualBaseline,
  getScreenChangeSummary,
  getVisualIgnoreSelectors,
  listScreensWithCounts,
  resolveTestCaseIdsForScreens,
  saveVisualBaseline,
  setVisualIgnoreSelectors,
} from "../services/screensService.js";
import { getDomCheckIgnoreSelectors, setDomCheckIgnoreSelectors } from "../services/domChecksService.js";
import { queueExecution } from "../services/executionService.js";
import { getVisualDiffThresholdPercent } from "../services/adminService.js";
import { errBody } from "../errorCodes.js";

export const screensRouter = Router();

// FR-5.8: Screen Explorer -- every catalogued screen with Changed/Unchanged
// status and linked manual/automation test case counts.
screensRouter.get("/", (_req, res) => {
  res.json(listScreensWithCounts());
});

screensRouter.get("/:id", (req, res) => {
  const screen = db.prepare("SELECT * FROM screens WHERE id = ?").get(req.params.id);
  if (!screen) return res.status(404).json({ error: "Screen not found" });
  res.json(screen);
});

// FR-5.10: side-by-side before/after review view for a Screen flagged Changed
screensRouter.get("/:id/change-summary", (req, res) => {
  try {
    res.json(getScreenChangeSummary(req.params.id));
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
});

// FR-5.9: save a visual regression baseline for a screen. Pass `url` to capture a real
// Playwright screenshot (pixel-level baseline); pass `content` only for the legacy
// content-hash fallback (see screensService.ts's saveVisualBaseline for why).
screensRouter.post("/:id/visual-baseline", async (req, res) => {
  const { content, url } = req.body as { content?: string; url?: string };
  if (!content && !url) return res.status(400).json(errBody(400, "content or url is required to establish a visual baseline"));
  try {
    res.json(await saveVisualBaseline(req.params.id, { content, url }));
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message));
  }
});

// Deeper Bug Detection #3: known-noisy regions to mask (visibility: hidden)
// before every screenshot for this screen -- a timestamp, an ad slot, a live
// counter. Empty by default; add your own site's dynamic regions here rather
// than us guessing them.
screensRouter.get("/:id/visual-ignore-selectors", (req, res) => {
  res.json({ selectors: getVisualIgnoreSelectors(req.params.id) });
});

screensRouter.put("/:id/visual-ignore-selectors", (req, res) => {
  const { selectors } = req.body as { selectors?: string[] };
  try {
    setVisualIgnoreSelectors(req.params.id, selectors ?? []);
    res.json({ selectors: getVisualIgnoreSelectors(req.params.id) });
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message));
  }
});

// Deeper Bug Detection #4: known-intentional patterns to exclude from every
// DOM check for this screen (an off-canvas drawer, a deliberately overlapping
// badge). Empty by default; add your own rather than us guessing them.
screensRouter.get("/:id/dom-check-ignore-selectors", (req, res) => {
  res.json({ selectors: getDomCheckIgnoreSelectors(req.params.id) });
});

screensRouter.put("/:id/dom-check-ignore-selectors", (req, res) => {
  const { selectors } = req.body as { selectors?: string[] };
  try {
    setDomCheckIgnoreSelectors(req.params.id, selectors ?? []);
    res.json({ selectors: getDomCheckIgnoreSelectors(req.params.id) });
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message));
  }
});

screensRouter.post("/:id/visual-diff", async (req, res) => {
  const { content, url } = req.body as { content?: string; url?: string };
  if (!content && !url) return res.status(400).json(errBody(400, "content or url is required to diff against the baseline"));
  try {
    res.json(await diffAgainstVisualBaseline(req.params.id, { content, url, thresholdPercent: getVisualDiffThresholdPercent() }));
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
});

// FR-4.18 (RBAC: FR-8.12, enforced by the global enforceReadOnlyRoles gate on
// all mutating requests -- a Manager gets the same 403 here as on any other run
// trigger): select one or more screens from the Screen Explorer and run only
// the test cases/scripts tagged to those screens, optionally Changed-only.
screensRouter.post("/run", async (req, res) => {
  const { screen_ids, changed_only, target_url, ...runOptions } = req.body as {
    screen_ids?: string[];
    changed_only?: boolean;
    target_url?: string;
    [key: string]: any;
  };
  if (!Array.isArray(screen_ids) || screen_ids.length === 0) {
    return res.status(400).json(errBody(400, "screen_ids (non-empty array) is required"));
  }

  const testCaseIds = resolveTestCaseIdsForScreens(screen_ids, Boolean(changed_only));
  if (testCaseIds.length === 0) {
    return res.status(200).json({ queued: [], message: "No test cases are tagged to the selected screen(s)." });
  }

  const placeholders = testCaseIds.map(() => "?").join(",");
  const scripts = db.prepare(`SELECT id FROM automation_scripts WHERE test_case_id IN (${placeholders})`).all(...testCaseIds) as any[];

  const queued = [];
  for (const script of scripts) {
    try {
      const url = target_url || `http://localhost:${process.env.PORT || 4100}/demo/login.html`;
      const result = await queueExecution(script.id, url, { ...runOptions, trigger_source: "screen-scoped" });
      queued.push(result);
    } catch (err: any) {
      queued.push({ script_id: script.id, error: err.message });
    }
  }

  res.json({ queued, screen_count: screen_ids.length, test_case_count: testCaseIds.length, script_count: scripts.length });
});
