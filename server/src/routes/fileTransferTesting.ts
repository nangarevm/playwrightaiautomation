import { Router } from "express";
import { runFileUploadScenario, runFileDownloadScenario, type FileUploadScenario, type FileDownloadScenario } from "../services/fileTransferTestingService.js";
import { errBody } from "../errorCodes.js";

export const fileTransferTestingRouter = Router();

// Playbook §T/§U -- File Upload / Download testing. Declarative and
// app-specific (which selectors, which local file), so -- same as the other
// active scenario engines in this codebase -- each POST both defines and
// immediately runs one scenario rather than persisting it.
fileTransferTestingRouter.post("/upload/run", async (req, res) => {
  const scenario = req.body as FileUploadScenario;
  if (!scenario?.name || !scenario?.url || !scenario?.fileInputSelector || !scenario?.filePath || typeof scenario?.expectSuccess !== "boolean") {
    return res.status(400).json(errBody(400, "name, url, fileInputSelector, filePath, and expectSuccess (boolean) are required."));
  }
  try {
    res.json({ findings: await runFileUploadScenario(scenario) });
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message || "File upload scenario run failed."));
  }
});

fileTransferTestingRouter.post("/download/run", async (req, res) => {
  const scenario = req.body as FileDownloadScenario;
  if (!scenario?.name || !scenario?.url || !scenario?.downloadTriggerSelector) {
    return res.status(400).json(errBody(400, "name, url, and downloadTriggerSelector are required."));
  }
  try {
    res.json({ findings: await runFileDownloadScenario(scenario) });
  } catch (err: any) {
    res.status(400).json(errBody(400, err.message || "File download scenario run failed."));
  }
});
