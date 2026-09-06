import { Router } from "express";
import {
  runSearchScenario,
  runFilterScenario,
  runSortScenario,
  runPaginationScenario,
  type SearchScenario,
  type FilterScenario,
  type SortScenario,
  type PaginationScenario,
} from "../services/listBehaviorTestingService.js";
import { errBody } from "../errorCodes.js";

export const listBehaviorTestingRouter = Router();

// Playbook §F/§G/§H -- Search, Filter/Sort, and Pagination testing. Each
// scenario is declarative and app-specific (which selectors), so -- same as
// /api/network-failure-injection and /api/multi-tab-testing -- each POST
// both defines and immediately runs one scenario rather than persisting it.
listBehaviorTestingRouter.post("/search/run", async (req, res) => {
  const scenario = req.body as SearchScenario;
  if (!scenario?.name || !scenario?.url || !scenario?.searchInputSelector || !scenario?.searchTerm || !scenario?.itemSelector) {
    return res.status(400).json(errBody(400, "name, url, searchInputSelector, searchTerm, and itemSelector are required."));
  }
  try {
    res.json({ findings: await runSearchScenario(scenario) });
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message || "Search scenario run failed."));
  }
});

listBehaviorTestingRouter.post("/filter/run", async (req, res) => {
  const scenario = req.body as FilterScenario;
  if (!scenario?.name || !scenario?.url || !Array.isArray(scenario?.filterSelectors) || scenario.filterSelectors.length === 0 || !scenario?.itemSelector) {
    return res.status(400).json(errBody(400, "name, url, a non-empty filterSelectors array, and itemSelector are required."));
  }
  try {
    res.json({ findings: await runFilterScenario(scenario) });
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message || "Filter scenario run failed."));
  }
});

listBehaviorTestingRouter.post("/sort/run", async (req, res) => {
  const scenario = req.body as SortScenario;
  if (!scenario?.name || !scenario?.url || !scenario?.sortControlSelector || !scenario?.itemSelector || !scenario?.direction) {
    return res.status(400).json(errBody(400, "name, url, sortControlSelector, itemSelector, and direction are required."));
  }
  try {
    res.json({ findings: await runSortScenario(scenario) });
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message || "Sort scenario run failed."));
  }
});

listBehaviorTestingRouter.post("/pagination/run", async (req, res) => {
  const scenario = req.body as PaginationScenario;
  if (!scenario?.name || !scenario?.url || !scenario?.nextPageSelector || !scenario?.itemSelector) {
    return res.status(400).json(errBody(400, "name, url, nextPageSelector, and itemSelector are required."));
  }
  try {
    res.json({ findings: await runPaginationScenario(scenario) });
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message || "Pagination scenario run failed."));
  }
});
