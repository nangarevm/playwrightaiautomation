import { Router } from "express";
import {
  createEnvironment,
  deleteEnvironment,
  listEnvironments,
  preflightHealthCheck,
  revokeEnvironmentCredentials,
  rotateEnvironmentCredentials,
} from "../services/environmentsService.js";
import { requireRole } from "../services/adminService.js";
import { errBody } from "../errorCodes.js";

export const environmentsRouter = Router();

environmentsRouter.get("/", (_req, res) => {
  res.json(listEnvironments());
});

// FR-4.19: create a named Environment; QA Lead-gated since it stores credentials
environmentsRouter.post("/", requireRole("QA Lead"), (req, res) => {
  try {
    res.status(201).json(createEnvironment(req.body));
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message));
  }
});

environmentsRouter.delete("/:id", requireRole("QA Lead"), (req, res) => {
  deleteEnvironment(req.params.id);
  res.json({ ok: true });
});

// FR-1.3c: revoke/rotate credentials at any time
environmentsRouter.post("/:id/credentials/revoke", requireRole("QA Lead"), (req, res) => {
  try {
    res.json(revokeEnvironmentCredentials(req.params.id));
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
});

environmentsRouter.post("/:id/credentials/rotate", requireRole("QA Lead"), (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };
  if (!username || !password) return res.status(400).json(errBody(400, "username and password are required"));
  try {
    res.json(rotateEnvironmentCredentials(req.params.id, username, password));
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
});

// FR-4.20: pre-flight health check before a scheduled/webhook-triggered run
environmentsRouter.post("/:id/health-check", async (req, res) => {
  try {
    res.json(await preflightHealthCheck(req.params.id));
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
});
