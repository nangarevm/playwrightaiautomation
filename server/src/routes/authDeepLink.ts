import { Router } from "express";
import { runAuthDeepLinkScenario, type AuthDeepLinkScenario } from "../services/authDeepLinkService.js";
import { errBody } from "../errorCodes.js";

export const authDeepLinkRouter = Router();

// Playbook §B -- Auth deep-link probe: does a completely unauthenticated
// browser navigating directly to a protected URL get correctly gated.
authDeepLinkRouter.post("/run", async (req, res) => {
  const scenario = req.body as AuthDeepLinkScenario;
  if (!scenario?.name || !scenario?.protectedUrl || !scenario?.protectedContentSelector) {
    return res.status(400).json(errBody(400, "name, protectedUrl, and protectedContentSelector are required."));
  }
  try {
    res.json({ findings: await runAuthDeepLinkScenario(scenario) });
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message || "Auth deep-link scenario run failed."));
  }
});
