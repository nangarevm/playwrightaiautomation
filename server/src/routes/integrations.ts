import { Router } from "express";
import { db } from "../db.js";
import { logAudit, requireRole } from "../services/adminService.js";
import {
  createIntegration,
  deleteIntegration,
  getIntegration,
  listFailedDeliveries,
  listGitHistoryForScript,
  listIntegrations,
  pushRunResultToExternalTracker,
  pushTestCaseToAdditionalTracker,
  pushTestCaseToExternalTracker,
  rotateIntegrationToken,
  sendRunNotification,
} from "../services/integrationsService.js";
import { errBody } from "../errorCodes.js";

export const integrationsRouter = Router();

integrationsRouter.get("/", (req, res) => {
  res.json(listIntegrations(req.query.type as any));
});

// FR-8.1: only QA Lead manages integrations (create/delete/rotate); FR-8.4 covers token security itself
integrationsRouter.post("/", requireRole("QA Lead"), (req, res) => {
  try {
    const integration = createIntegration(req.body)!;
    logAudit(req.user, "integration_created", "integration", integration.id, { type: integration.type });
    res.status(201).json(integration);
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message));
  }
});

integrationsRouter.get("/:id", (req, res) => {
  const integration = getIntegration(req.params.id);
  if (!integration) return res.status(404).json({ error: "not found" });
  res.json(integration);
});

// FR-8.4: token rotation
integrationsRouter.post("/:id/rotate-token", requireRole("QA Lead"), (req, res) => {
  const { token } = req.body as { token?: string };
  if (!token) return res.status(400).json(errBody(400, "token is required"));
  try {
    const updated = rotateIntegrationToken(req.params.id, token);
    logAudit(req.user, "integration_token_rotated", "integration", req.params.id);
    res.json(updated);
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message));
  }
});

integrationsRouter.delete("/:id", requireRole("QA Lead"), (req, res) => {
  deleteIntegration(req.params.id);
  logAudit(req.user, "integration_deleted", "integration", req.params.id);
  res.json({ ok: true });
});

// FR-7.1/FR-7.2: push a test case to a connected Jira/Azure integration
integrationsRouter.post("/:id/push-test-case/:testCaseId", async (req, res) => {
  const row = db.prepare("SELECT * FROM test_cases WHERE id = ?").get(req.params.testCaseId) as any;
  if (!row) return res.status(404).json({ error: "test case not found" });

  try {
    const result = await pushTestCaseToExternalTracker(req.params.id, {
      id: row.id,
      title: row.title,
      expected_result: row.expected_result,
      steps: JSON.parse(row.steps),
      category: row.category,
    });
    logAudit(req.user, "test_case_pushed_to_tracker", "test_case", row.id, { integrationId: req.params.id });
    res.status(201).json(result);
  } catch (err: any) {
    res.status(502).json({ error: err.message });
  }
});

// FR-7.1/FR-7.2: push a run result back to the linked work item
integrationsRouter.post("/:id/push-result/:runId", async (req, res) => {
  const run = db.prepare("SELECT * FROM execution_runs WHERE id = ?").get(req.params.runId) as any;
  if (!run) return res.status(404).json({ error: "run not found" });

  const { externalId } = req.body as { externalId?: string };
  if (!externalId) return res.status(400).json(errBody(400, "externalId (the Jira/Azure work item id) is required"));

  try {
    const result = await pushRunResultToExternalTracker(req.params.id, externalId, run);
    res.json(result);
  } catch (err: any) {
    res.status(502).json({ error: err.message });
  }
});

// FR-7.5: push a test case to a connected TestRail/Zephyr/qTest integration
integrationsRouter.post("/:id/push-test-case-additional/:testCaseId", async (req, res) => {
  const row = db.prepare("SELECT * FROM test_cases WHERE id = ?").get(req.params.testCaseId) as any;
  if (!row) return res.status(404).json({ error: "test case not found" });

  try {
    const result = await pushTestCaseToAdditionalTracker(req.params.id, {
      id: row.id,
      title: row.title,
      expected_result: row.expected_result,
      steps: JSON.parse(row.steps),
      category: row.category,
    });
    logAudit(req.user, "test_case_pushed_to_additional_tracker", "test_case", row.id, { integrationId: req.params.id });
    res.status(201).json(result);
  } catch (err: any) {
    res.status(502).json({ error: err.message });
  }
});

// FR-7.3: manually trigger a Slack/Teams notification (also fires automatically post-run when notify_on_run is set)
integrationsRouter.post("/:id/notify", async (req, res) => {
  const { message } = req.body as { message?: string };
  if (!message) return res.status(400).json(errBody(400, "message is required"));

  try {
    const result = await sendRunNotification(req.params.id, message);
    res.json(result);
  } catch (err: any) {
    res.status(502).json({ error: err.message });
  }
});

// FR-7.4: git history for a generated script
integrationsRouter.get("/git/history/:fileName", async (req, res) => {
  res.json(await listGitHistoryForScript(req.params.fileName));
});

// SR-FR-7.2: outbound Slack/Teams notifications and Jira/Azure auto-bug-filing
// deliveries that exhausted all retry attempts -- the closest honest
// approximation of a DLQ view available without a real message queue.
integrationsRouter.get("/failed-deliveries", requireRole("QA Lead"), (req, res) => {
  res.json(listFailedDeliveries(req.query.type as string | undefined));
});
