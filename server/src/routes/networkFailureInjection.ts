import { Router } from "express";
import {
  runNetworkFailureScenario,
  buildOfflineDuringSubmitScenario,
  buildTimeoutDuringSubmitScenario,
  buildHttpErrorDuringSubmitScenario,
  type NetworkFailureScenario,
} from "../services/networkFailureInjectionService.js";
import { errBody } from "../errorCodes.js";

export const networkFailureInjectionRouter = Router();

// Playbook §L -- Network / Failure Injection. A scenario is declarative and
// app-specific (which URL, which endpoint pattern, which trigger, which
// failure mode) so there is no "list" endpoint here to persist against --
// each POST both defines and immediately runs one scenario, matching
// uiApiConsistencyService.ts's precedent for other declarative/human-
// configured checks that don't warrant their own stored-entity CRUD.
networkFailureInjectionRouter.post("/run", async (req, res) => {
  const scenario = req.body as NetworkFailureScenario;
  if (!scenario?.name || !scenario?.url || !scenario?.urlPattern || !scenario?.mode) {
    return res.status(400).json(errBody(400, "name, url, urlPattern, and mode are required."));
  }
  try {
    const findings = await runNetworkFailureScenario(scenario);
    res.json({ findings });
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message || "Network failure scenario run failed."));
  }
});

// Named template builders (mirrors state-transition-flows' own template
// endpoints) -- returns a ready scenario a client can review/tweak before
// POSTing it to /run above, without hand-assembling the object from scratch.
networkFailureInjectionRouter.post("/templates/offline-during-submit", (req, res) => {
  try {
    res.json(buildOfflineDuringSubmitScenario(req.body));
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message));
  }
});
networkFailureInjectionRouter.post("/templates/timeout-during-submit", (req, res) => {
  try {
    res.json(buildTimeoutDuringSubmitScenario(req.body));
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message));
  }
});
networkFailureInjectionRouter.post("/templates/http-error-during-submit", (req, res) => {
  try {
    res.json(buildHttpErrorDuringSubmitScenario(req.body));
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message));
  }
});
