import { Router } from "express";
import { runExplorationSession, getExplorationSession, listExplorationSessions, stopExplorationSession } from "../services/exploratoryAgentService.js";
import { requireRole } from "../services/adminService.js";
import { errBody } from "../errorCodes.js";

export const exploratoryAgentRouter = Router();

// Phase 4c -- exploratory AI agent. Restricted to QA Lead: this takes
// autonomous actions against a real target, not something any role should
// be able to trigger casually.
exploratoryAgentRouter.get("/", (req, res) => {
  res.json(listExplorationSessions(req.query.siteId as string | undefined));
});

exploratoryAgentRouter.get("/:id", (req, res) => {
  const session = getExplorationSession(req.params.id);
  if (!session) return res.status(404).json(errBody(404, "Session not found."));
  res.json(session);
});

exploratoryAgentRouter.post("/", requireRole("QA Lead"), async (req, res) => {
  const { startUrl, siteId, maxActions, maxDepth } = req.body as { startUrl?: string; siteId?: string; maxActions?: number; maxDepth?: number };
  if (!startUrl) return res.status(400).json(errBody(400, "startUrl is required."));
  try {
    const result = await runExplorationSession({ startUrl, siteId, maxActions, maxDepth });
    res.status(201).json(result);
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message || "Exploration session failed."));
  }
});

exploratoryAgentRouter.post("/:id/stop", requireRole("QA Lead"), (req, res) => {
  const session = stopExplorationSession(req.params.id);
  if (!session) return res.status(404).json(errBody(404, "Session not found."));
  res.json(session);
});
