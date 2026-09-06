import { Router } from "express";
import {
  runMultiTabScenario,
  buildLogoutInOneTabTemplate,
  buildConcurrentEditLostUpdateTemplate,
  buildSessionExpiryOtherTabTemplate,
  type MultiTabScenario,
} from "../services/multiTabTestingService.js";
import { errBody } from "../errorCodes.js";

export const multiTabTestingRouter = Router();

// Playbook §N -- Multi-Tab / Multi-Context Testing. A scenario is
// declarative and app-specific (which selectors, which URL), so -- same as
// /api/network-failure-injection -- each POST both defines and immediately
// runs one scenario rather than persisting it as its own stored entity.
multiTabTestingRouter.post("/run", async (req, res) => {
  const scenario = req.body as MultiTabScenario;
  if (!scenario?.name || !scenario?.steps?.length || !scenario?.invariants?.length) {
    return res.status(400).json(errBody(400, "name, steps, and invariants are required."));
  }
  try {
    const findings = await runMultiTabScenario(scenario);
    res.json({ findings });
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message || "Multi-tab scenario run failed."));
  }
});

// Named template builders -- returns a ready scenario a client can
// review/tweak before POSTing it to /run above.
multiTabTestingRouter.post("/templates/logout-in-one-tab", (req, res) => {
  try {
    res.json(buildLogoutInOneTabTemplate(req.body));
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message));
  }
});
multiTabTestingRouter.post("/templates/concurrent-edit-lost-update", (req, res) => {
  try {
    res.json(buildConcurrentEditLostUpdateTemplate(req.body));
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message));
  }
});
multiTabTestingRouter.post("/templates/session-expiry-other-tab", (req, res) => {
  try {
    res.json(buildSessionExpiryOtherTabTemplate(req.body));
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message));
  }
});
