import { Router } from "express";
import { db } from "../db.js";
import {
  createExecutionProfile,
  deleteExecutionProfile,
  listExecutionProfiles,
  suggestExecutionProfile,
  updateExecutionProfile,
  runExecution,
  listExecutionQueues,
  queueExecution,
  cleanupExpiredArtifacts,
  runScheduledProfiles,
} from "../services/executionService.js";
import { requireRole } from "../services/adminService.js";

export const executionRouter = Router();

executionRouter.get("/", (_req, res) => {
  const rows = db.prepare("SELECT * FROM execution_runs ORDER BY created_at DESC").all();
  res.json(rows);
});

executionRouter.get("/profiles", (_req, res) => {
  res.json(listExecutionProfiles());
});

executionRouter.post("/profiles", (req, res) => {
  try {
    res.status(201).json(createExecutionProfile(req.body));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

executionRouter.patch("/profiles/:id", (req, res) => {
  try {
    res.json(updateExecutionProfile(req.params.id, req.body));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

executionRouter.delete("/profiles/:id", (req, res) => {
  deleteExecutionProfile(req.params.id);
  res.json({ ok: true });
});

executionRouter.get("/profiles/suggest", (req, res) => {
  res.json(suggestExecutionProfile(req.query as Record<string, string>));
});

executionRouter.get("/queue", (_req, res) => {
  res.json(listExecutionQueues());
});

executionRouter.post("/:scriptId/run", async (req, res) => {
  try {
    const targetUrl =
      (req.body?.target_url as string) || `http://localhost:${process.env.PORT || 4100}/demo/login.html`;
    const result = await runExecution(req.params.scriptId, targetUrl, req.body || {});
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

executionRouter.post("/:scriptId/queue", async (req, res) => {
  try {
    const targetUrl =
      (req.body?.target_url as string) || `http://localhost:${process.env.PORT || 4100}/demo/login.html`;
    const result = await queueExecution(req.params.scriptId, targetUrl, req.body || {});
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// FR-4.16: inbound webhook trigger (e.g. from GitHub Actions/Jenkins), invoking a specified Execution Profile
executionRouter.post("/webhook/:profileId/:scriptId", async (req, res) => {
  try {
    const targetUrl =
      (req.body?.target_url as string) || `http://localhost:${process.env.PORT || 4100}/demo/login.html`;
    const result = await runExecution(req.params.scriptId, targetUrl, {
      ...req.body,
      profile_id: req.params.profileId,
      trigger_source: "webhook",
    });
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// FR-4.16: manually invoke the scheduler tick (also runs automatically every minute in the background)
executionRouter.post("/scheduler/tick", requireRole("QA Lead"), async (_req, res) => {
  const result = await runScheduledProfiles();
  res.json({ triggered: result });
});

// FR-4.8: manually trigger retention-based artifact cleanup (also runs automatically on an interval)
executionRouter.post("/artifacts/cleanup", requireRole("QA Lead"), (_req, res) => {
  res.json(cleanupExpiredArtifacts());
});
