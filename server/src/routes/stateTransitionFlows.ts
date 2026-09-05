import { Router } from "express";
import {
  defineFlow,
  getFlow,
  listFlows,
  deleteFlow,
  listRunsForFlow,
  runFlow,
  buildCreateEditDeleteRefreshTemplate,
  buildDuplicateSubmitTemplate,
  buildRapidClickTemplate,
  buildBackForwardAfterMutationTemplate,
  buildSessionExpiryMidFlowTemplate,
} from "../services/stateTransitionService.js";
import { errBody } from "../errorCodes.js";

export const stateTransitionFlowsRouter = Router();

// Phase 3b -- state-transition testing. A flow is defined once (steps +
// invariants, or built from one of the named templates below) and can be
// re-run on demand; each run records bug_findings for any invariant violated.
stateTransitionFlowsRouter.get("/", (req, res) => {
  res.json(listFlows(req.query.screenId as string | undefined));
});

stateTransitionFlowsRouter.get("/:id", (req, res) => {
  const flow = getFlow(req.params.id);
  if (!flow) return res.status(404).json(errBody(404, "Flow not found."));
  res.json({ ...flow, runs: listRunsForFlow(flow.id) });
});

stateTransitionFlowsRouter.post("/", (req, res) => {
  const { name, steps, invariants, screenId } = req.body as { name?: string; steps?: any[]; invariants?: any[]; screenId?: string };
  if (!name || !steps || !invariants) return res.status(400).json(errBody(400, "name, steps, and invariants are required."));
  try {
    res.status(201).json(defineFlow({ name, steps, invariants, screenId }));
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message));
  }
});

// Named template builders (master prompt #10's own worked patterns) --
// returns a ready {steps, invariants} pair a client can review/tweak before
// POSTing it to / above, without hand-assembling the arrays from scratch.
stateTransitionFlowsRouter.post("/templates/create-edit-delete-refresh", (req, res) => {
  try {
    res.json(buildCreateEditDeleteRefreshTemplate(req.body));
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message));
  }
});
stateTransitionFlowsRouter.post("/templates/duplicate-submit", (req, res) => {
  try {
    res.json(buildDuplicateSubmitTemplate(req.body));
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message));
  }
});
stateTransitionFlowsRouter.post("/templates/rapid-click", (req, res) => {
  try {
    res.json(buildRapidClickTemplate(req.body));
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message));
  }
});
stateTransitionFlowsRouter.post("/templates/back-forward-after-mutation", (req, res) => {
  try {
    res.json(buildBackForwardAfterMutationTemplate(req.body));
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message));
  }
});
stateTransitionFlowsRouter.post("/templates/session-expiry-mid-flow", (req, res) => {
  try {
    res.json(buildSessionExpiryMidFlowTemplate(req.body));
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message));
  }
});

stateTransitionFlowsRouter.post("/:id/run", async (req, res) => {
  try {
    const result = await runFlow(req.params.id, req.body?.runId);
    res.json(result);
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message || "Flow run failed."));
  }
});

stateTransitionFlowsRouter.delete("/:id", (req, res) => {
  deleteFlow(req.params.id);
  res.status(204).end();
});
