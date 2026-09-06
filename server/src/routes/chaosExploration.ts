import { Router } from "express";
import { runChaosExploration, type ChaosExplorationOptions } from "../services/chaosExplorationService.js";
import { errBody } from "../errorCodes.js";

export const chaosExplorationRouter = Router();

// Playbook §35 -- Chaos Exploration Engine. Runs immediately rather than
// being persisted as a stored entity, same as this engine's other active
// scenario endpoints -- the "definition" here is just a URL plus an
// optional seed/budget, not app-specific selectors, so there's nothing
// worth saving beyond the returned seed (which the caller can pass back in
// to replay the exact same run).
chaosExplorationRouter.post("/run", async (req, res) => {
  const options = req.body as ChaosExplorationOptions;
  if (!options?.url) {
    return res.status(400).json(errBody(400, "url is required."));
  }
  try {
    const result = await runChaosExploration(options);
    res.status(201).json(result);
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message || "Chaos exploration run failed."));
  }
});
