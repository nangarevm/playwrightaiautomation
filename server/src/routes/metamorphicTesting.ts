import { Router } from "express";
import {
  runSortPermutationScenario,
  runFilterOrderIndependenceScenario,
  runSearchNarrowingScenario,
  type SortPermutationScenario,
  type FilterOrderIndependenceScenario,
  type SearchNarrowingScenario,
} from "../services/metamorphicTestingService.js";
import { errBody } from "../errorCodes.js";

export const metamorphicTestingRouter = Router();

// Playbook §34 -- Metamorphic Testing Engine. Declarative and app-specific
// (which selectors), so -- same as this engine's other active scenario
// services -- each POST both defines and immediately runs one scenario.
metamorphicTestingRouter.post("/sort-permutation/run", async (req, res) => {
  const scenario = req.body as SortPermutationScenario;
  if (!scenario?.name || !scenario?.url || !scenario?.sortControlSelector || !scenario?.itemSelector) {
    return res.status(400).json(errBody(400, "name, url, sortControlSelector, and itemSelector are required."));
  }
  try {
    res.json({ findings: await runSortPermutationScenario(scenario) });
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message || "Sort-permutation scenario run failed."));
  }
});

metamorphicTestingRouter.post("/filter-order-independence/run", async (req, res) => {
  const scenario = req.body as FilterOrderIndependenceScenario;
  if (!scenario?.name || !scenario?.url || !scenario?.filterASelector || !scenario?.filterBSelector || !scenario?.itemSelector) {
    return res.status(400).json(errBody(400, "name, url, filterASelector, filterBSelector, and itemSelector are required."));
  }
  try {
    res.json({ findings: await runFilterOrderIndependenceScenario(scenario) });
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message || "Filter-order-independence scenario run failed."));
  }
});

metamorphicTestingRouter.post("/search-narrowing/run", async (req, res) => {
  const scenario = req.body as SearchNarrowingScenario;
  if (!scenario?.name || !scenario?.url || !scenario?.searchInputSelector || !scenario?.broaderQuery || !scenario?.narrowerQuery || !scenario?.itemSelector) {
    return res.status(400).json(errBody(400, "name, url, searchInputSelector, broaderQuery, narrowerQuery, and itemSelector are required."));
  }
  try {
    res.json({ findings: await runSearchNarrowingScenario(scenario) });
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message || "Search-narrowing scenario run failed."));
  }
});
