import { Router } from "express";
import { db } from "../db.js";
import {
  createExecutionProfile,
  deleteExecutionProfile,
  listExecutionProfiles,
  listExecutionProfileVersions,
  suggestExecutionProfile,
  updateExecutionProfile,
  runExecution,
  runExecutionBatch,
  listExecutionQueues,
  queueExecution,
  cleanupExpiredArtifacts,
  runScheduledProfiles,
  preflightGuardEnvironment,
  stopExecution,
  stopAllExecutions,
  summarizeRunForClient,
} from "../services/executionService.js";
import { requireRole, getUltrafastConfidenceThreshold, setUltrafastConfidenceThreshold } from "../services/adminService.js";
import { createPlatformSecret, listPlatformSecrets, deletePlatformSecret } from "../services/secretsRegistryService.js";
import { getPoolStatus } from "../services/runnerPoolService.js";
import { getEnvironment } from "../services/environmentsService.js";
import { triggerUltrafastRun } from "../services/ultrafastService.js";
import { SecurityScanFailedError } from "../services/codegenService.js";
import { errBody } from "../errorCodes.js";

export const executionRouter = Router();

executionRouter.get("/", (_req, res) => {
  const rows = db.prepare("SELECT * FROM execution_runs ORDER BY created_at DESC").all();
  res.json(rows);
});

// FR-6.5: per-failed-test evidence entries for a run (test-level granularity -- see
// executionService.ts's runExecution completion handler for why not per-step).
executionRouter.get("/:runId/evidence", (req, res) => {
  res.json(db.prepare("SELECT * FROM execution_evidence WHERE run_id = ? ORDER BY created_at ASC").all(req.params.runId));
});

executionRouter.get("/profiles", (_req, res) => {
  res.json(listExecutionProfiles());
});

executionRouter.post("/profiles", (req, res) => {
  try {
    res.status(201).json(createExecutionProfile(req.body));
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message));
  }
});

executionRouter.patch("/profiles/:id", (req, res) => {
  try {
    res.json(updateExecutionProfile(req.params.id, req.body, req.user?.id));
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message));
  }
});

// FR-4.23: version history for a saved Execution Profile
executionRouter.get("/profiles/:id/versions", (req, res) => {
  res.json(listExecutionProfileVersions(req.params.id));
});

// FR-4.21: named secrets registry, QA Lead-gated since it manages script credentials
executionRouter.get("/secrets", requireRole("QA Lead"), (_req, res) => {
  res.json(listPlatformSecrets());
});

executionRouter.post("/secrets", requireRole("QA Lead"), (req, res) => {
  const { name, value } = req.body as { name?: string; value?: string };
  try {
    res.status(201).json(createPlatformSecret(name!, value!));
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message));
  }
});

executionRouter.delete("/secrets/:name", requireRole("QA Lead"), (req, res) => {
  deletePlatformSecret(req.params.name);
  res.json({ ok: true });
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

// Stop a single run in flight -- kills its process if it's already running,
// or just marks it stopped before the queue processor ever picks it up.
executionRouter.post("/:runId/stop", (req, res) => {
  const result = stopExecution(req.params.runId);
  if (!result.ok) return res.status(400).json(errBody(400, result.reason || "could not stop this run"));
  res.json(result);
});

// Stop everything currently running or queued -- the "abandon this batch" action
// for e.g. a large "Run all" that queued far more scripts than intended.
executionRouter.post("/stop-all", (_req, res) => {
  res.json(stopAllExecutions());
});

// FR-4.3/FR-4.17: current shared-pool size/utilization and per-profile reserved-lane usage
executionRouter.get("/pool-status", (_req, res) => {
  res.json(getPoolStatus());
});

// FR-4.26: view/edit the Ultrafast Mode auto-accept confidence threshold. Viewable by anyone
// (the Execution Settings Panel needs to show it), editable only by QA Lead -- mirrors the
// FR-5.4 self-heal threshold route pattern in routes/selfHealing.ts.
executionRouter.get("/ultrafast-threshold", (_req, res) => {
  res.json({ threshold: getUltrafastConfidenceThreshold() });
});

executionRouter.put("/ultrafast-threshold", requireRole("QA Lead"), (req, res) => {
  const { threshold } = req.body as { threshold?: number };
  try {
    const result = setUltrafastConfidenceThreshold(Number(threshold), req.user);
    res.json(result);
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message));
  }
});

// FR-4.24/FR-4.25/FR-4.26/FR-4.27/FR-4.30: Ultrafast Mode trigger -- given just a script or
// test-case reference (no profile/environment params required), auto-resolves the default
// Execution Profile + Environment, auto-accepts/queues test-case review, starts the run
// immediately, and returns a direct link to the FR-6.11 report on completion.
executionRouter.post("/ultrafast", async (req, res) => {
  try {
    const { script_id, test_case_id, target_url } = req.body as { script_id?: string; test_case_id?: string; target_url?: string };
    const result = await triggerUltrafastRun({ script_id, test_case_id, target_url });
    try {
      res.json(result);
    } catch (jsonErr: any) {
      console.error("[ultrafast] failed to serialize trigger response:", jsonErr);
      res.status(500).json(errBody(500, "Run completed but the response could not be serialized -- check server logs"));
    }
  } catch (err: any) {
    if (err instanceof SecurityScanFailedError) {
      return res.status(422).json(errBody(422, err.message, { notes: err.notes }));
    }
    res.status(400).json(errBody(400, err.message));
  }
});

// FR-4.28: a Fast Mode run (i.e. anything not explicitly the Ultrafast trigger) may not
// proceed past this route without an explicit profile_id and environment_id in the request --
// that's the server-side enforcement of "cannot proceed past the Execution Settings Panel
// without an explicit user confirmation of profile and environment." Ultrafast is exempt by
// design (FR-4.25): it legitimately auto-resolves both with zero user input, and it never
// reaches this route anyway (it goes through POST /ultrafast -> triggerUltrafastRun, which
// calls runExecution() directly).
executionRouter.post("/:scriptId/run", async (req, res) => {
  try {
    const body = req.body || {};
    if (body.speed_mode !== "ultrafast" && (!body.profile_id || !body.environment_id)) {
      return res.status(400).json(errBody(400, "Fast Mode requires an explicit profile_id and environment_id (FR-4.28)"));
    }
    const targetUrl =
      (req.body?.target_url as string) || `http://localhost:${process.env.PORT || 4100}/demo/login.html`;
    const result = await runExecution(req.params.scriptId, targetUrl, body);
    res.json(summarizeRunForClient(result));
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message));
  }
});

executionRouter.post("/:scriptId/queue", async (req, res) => {
  try {
    const targetUrl =
      (req.body?.target_url as string) || `http://localhost:${process.env.PORT || 4100}/demo/login.html`;
    const result = await queueExecution(req.params.scriptId, targetUrl, req.body || {});
    res.json(result);
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message));
  }
});

// FR-4.2: run multiple scripts together so concurrency has more than one test
// to parallelize, and get a real sequential-baseline duration to compare against
executionRouter.post("/batch-run", async (req, res) => {
  try {
    const { script_ids, target_url, ...runOptions } = req.body as { script_ids?: string[]; target_url?: string; [key: string]: any };
    if (!Array.isArray(script_ids) || script_ids.length === 0) {
      return res.status(400).json(errBody(400, "script_ids (non-empty array) is required"));
    }
    const url = target_url || `http://localhost:${process.env.PORT || 4100}/demo/login.html`;
    const result = await runExecutionBatch(script_ids, url, runOptions);
    res.json(result);
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message));
  }
});

// FR-4.16: inbound webhook trigger (e.g. from GitHub Actions/Jenkins), invoking a specified Execution Profile
executionRouter.post("/webhook/:profileId/:scriptId", async (req, res) => {
  try {
    const profile = db.prepare("SELECT * FROM execution_profiles WHERE id = ?").get(req.params.profileId) as any;
    const environmentId = (req.body?.environment_id as string) || profile?.default_environment_id || null;

    // FR-4.20: pre-flight health check the target Environment before a webhook-triggered
    // run starts -- on failure hold/alert instead of executing against an unreachable target.
    const guard = await preflightGuardEnvironment(environmentId, {
      triggerSource: "webhook",
      profileId: req.params.profileId,
      scriptId: req.params.scriptId,
    });
    if (guard.held) {
      return res.status(200).json({
        status: "held",
        reason: "preflight_health_check_failed",
        healthCheck: guard.healthCheck,
      });
    }

    const environment = environmentId ? (getEnvironment(environmentId) as any) : null;
    const targetUrl =
      (req.body?.target_url as string) || environment?.target_url || `http://localhost:${process.env.PORT || 4100}/demo/login.html`;
    // FR-4.4: accept a `source` field/header identifying which CI/CD tool triggered
    // this run (GitHub Actions/Jenkins/Azure Pipelines/GitLab CI). This is still a
    // single generic webhook endpoint -- not native per-vendor marketplace plugins --
    // but the triggering tool is now captured and attributable per-run/audit entry.
    const ciSource = (req.body?.source as string) || (req.header("x-ci-source") as string) || "unknown";

    const result = await runExecution(req.params.scriptId, targetUrl, {
      ...req.body,
      profile_id: req.params.profileId,
      trigger_source: "webhook",
      ci_source: ciSource,
    });

    // FR-4.22: a CI caller that only checks HTTP status (not the JSON body) must see
    // a non-2xx response when the gate blocks the pipeline -- previously this always
    // returned 200 even when blocksPipeline was true.
    if (result?.blocksPipeline) {
      return res.status(422).json(result);
    }
    res.json(result);
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message));
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
