import { Router } from "express";
import { db } from "../db.js";
import { generateAutomationScript, SecurityScanFailedError } from "../services/codegenService.js";
import { errBody } from "../errorCodes.js";

export const codegenRouter = Router();

codegenRouter.get("/", (_req, res) => {
  const rows = db.prepare("SELECT * FROM automation_scripts ORDER BY created_at DESC").all();
  res.json(rows);
});

codegenRouter.post("/:testCaseId/generate", async (req, res) => {
  try {
    const { framework, language } = req.body as {
      framework?: "playwright" | "selenium" | "cypress";
      language?: "typescript" | "javascript" | "python";
    };
    const result = await generateAutomationScript(req.params.testCaseId, { framework, language });
    res.status(201).json(result);
  } catch (err: any) {
    if (err instanceof SecurityScanFailedError) {
      return res.status(422).json(errBody(422, err.message, { notes: err.notes }));
    }
    res.status(400).json(errBody(400, err.message));
  }
});
