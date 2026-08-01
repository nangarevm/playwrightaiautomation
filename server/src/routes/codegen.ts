import { Router } from "express";
import { db } from "../db.js";
import { generateAutomationScript } from "../services/codegenService.js";

export const codegenRouter = Router();

codegenRouter.get("/", (_req, res) => {
  const rows = db.prepare("SELECT * FROM automation_scripts ORDER BY created_at DESC").all();
  res.json(rows);
});

codegenRouter.post("/:testCaseId/generate", async (req, res) => {
  try {
    const { framework } = req.body as { framework?: "playwright" | "selenium" | "cypress" };
    const result = await generateAutomationScript(req.params.testCaseId, { framework });
    res.status(201).json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});
