// Real-Time Execution API Route
// Server-Sent Events (SSE) endpoint for live execution updates
// Part of Feature 1: Real-Time Execution Dashboard

import { Router, Request, Response } from "express";
import { executionEmitter, ExecutionEvent } from "../services/realtimeExecutionEventService.js";

const router = Router();

/**
 * SSE endpoint for real-time execution updates
 * Client: GET /api/execution/live/:runId
 * Returns: Server-Sent Events stream
 */
router.get("/live/:runId", (req: Request, res: Response) => {
  const runId = req.params.runId;

  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");

  // Send initial data (current progress if available)
  const progress = executionEmitter.getProgress(runId);
  if (progress) {
    const event: ExecutionEvent = {
      type: "progress_update",
      timestamp: Date.now(),
      runId,
      data: progress,
    };
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  } else {
    res.write(`:Connected but run not found yet\n\n`);
  }

  // Subscribe to events for this run
  const unsubscribe = executionEmitter.subscribeToRun(
    runId,
    (event: ExecutionEvent) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  );

  // Cleanup on disconnect
  req.on("close", () => {
    unsubscribe();
    res.end();
  });

  // Heartbeat every 30 seconds to keep connection alive
  const heartbeat = setInterval(() => {
    res.write(`:heartbeat\n\n`);
  }, 30000);

  req.on("close", () => {
    clearInterval(heartbeat);
  });
});

/**
 * Get current progress for a run (REST endpoint)
 * GET /api/execution/progress/:runId
 */
router.get("/progress/:runId", (req: Request, res: Response) => {
  const runId = req.params.runId;
  const progress = executionEmitter.getProgress(runId);

  if (!progress) {
    return res.status(404).json({ error: "Run not found" });
  }

  res.json(progress);
});

/**
 * Get all active runs
 * GET /api/execution/active
 */
router.get("/active", (req: Request, res: Response) => {
  const activeRuns = executionEmitter.getActiveRuns();
  res.json(activeRuns);
});

/**
 * Control execution (pause/resume/stop)
 * POST /api/execution/:runId/control
 */
router.post("/:runId/control", (req: Request, res: Response) => {
  const runId = req.params.runId;
  const { action } = req.body; // "pause", "resume", "stop"

  const progress = executionEmitter.getProgress(runId);
  if (!progress) {
    return res.status(404).json({ error: "Run not found" });
  }

  switch (action) {
    case "pause":
      executionEmitter.pauseExecution(runId);
      break;
    case "resume":
      executionEmitter.resumeExecution(runId);
      break;
    case "stop":
      executionEmitter.failExecution(runId, "User stopped execution");
      break;
    default:
      return res.status(400).json({ error: "Invalid action" });
  }

  res.json({ success: true, progress: executionEmitter.getProgress(runId) });
});

export default router;
