import { Router } from "express";
import { verifyFinding, type VerifyFindingOptions } from "../services/bugVerificationService.js";
import { errBody } from "../errorCodes.js";

export const bugVerificationRouter = Router();

// Playbook §38/§39 -- Bug Verification Engine (reset/replay/repeat) +
// FLAKY/ENV/NOT_A_BUG classification.
bugVerificationRouter.post("/:findingId/verify", async (req, res) => {
  const options = req.body as VerifyFindingOptions;
  try {
    res.json(await verifyFinding(req.params.findingId, options));
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message || "Bug verification failed."));
  }
});
