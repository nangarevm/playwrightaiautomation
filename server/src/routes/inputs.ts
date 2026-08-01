import { Router } from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { nanoid } from "nanoid";
import { db } from "../db.js";
import { generateTestCasesForInput } from "../services/generationService.js";
import {
  buildBatchUploadSummary,
  crawlUrl,
  importExternalWorkItems,
  parseOpenApiSpec,
  parsePostmanCollection,
  redactLikelyPii,
} from "../services/ingestionService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_ROOT = path.join(__dirname, "..", "uploads");

if (!fs.existsSync(UPLOAD_ROOT)) {
  fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
}

export const inputsRouter = Router();

inputsRouter.get("/", (_req, res) => {
  const rows = db.prepare("SELECT * FROM inputs ORDER BY created_at DESC").all();
  res.json(rows);
});

// FR-1.7: accept free-text scenario descriptions as an input type
inputsRouter.post("/", (req, res) => {
  const { content, type, businessRules } = req.body as { content?: string; type?: string; businessRules?: string };
  if (!content || content.trim().length === 0) {
    return res.status(400).json({ error: "content is required" }); // FR-1.9: clear user-facing error
  }
  const id = nanoid(10);
  const now = new Date().toISOString();
  const safeContent = redactLikelyPii(content.trim(), Boolean((req.body as any)?.disable_redaction));
  const enrichedContent = businessRules ? `${safeContent}\n\nBusiness rules:\n${businessRules}` : safeContent;
  db.prepare("INSERT INTO inputs (id, type, content, created_at) VALUES (?, ?, ?, ?)").run(
    id,
    type ?? "free_text",
    enrichedContent,
    now
  );
  res.status(201).json({ id, type: type ?? "free_text", content: enrichedContent, created_at: now });
});

inputsRouter.post("/batch-upload", (req, res) => {
  try {
    const files = Array.isArray(req.body?.files) ? req.body.files : [];
    if (!files.length) {
      return res.status(400).json({ error: "At least one file is required for batch upload." });
    }

    const summary = buildBatchUploadSummary(files.map((file: any) => ({
      originalName: file.originalName || file.name || "upload",
      mimeType: file.mimeType || file.type || "application/octet-stream",
      size: Number(file.size || 0),
      savedPath: file.savedPath,
      content: file.content,
      disableRedaction: Boolean(file.disableRedaction),
    })));

    const id = nanoid(10);
    const now = new Date().toISOString();
    db.prepare("INSERT INTO inputs (id, type, content, created_at) VALUES (?, ?, ?, ?)").run(
      id,
      "batch_upload",
      summary.content,
      now
    );

    res.status(201).json({ id, type: "batch_upload", content: summary.content, created_at: now, artifacts: summary.artifacts });
  } catch (error: any) {
    res.status(400).json({ error: error.message || "Batch upload failed." });
  }
});

inputsRouter.post("/url-crawl", async (req, res) => {
  try {
    const { url, maxPages = 2 } = req.body as { url?: string; maxPages?: number };
    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "A valid URL is required." });
    }

    const result = await crawlUrl(url, Number(maxPages) || 2);
    const id = nanoid(10);
    const now = new Date().toISOString();
    db.prepare("INSERT INTO inputs (id, type, content, created_at) VALUES (?, ?, ?, ?)").run(
      id,
      "url_crawl",
      result.summary,
      now
    );

    res.status(201).json({ id, type: "url_crawl", content: result.summary, created_at: now, pages: result.pages });
  } catch (error: any) {
    res.status(400).json({ error: error.message || "URL crawl failed." });
  }
});

inputsRouter.post("/import-openapi", (req, res) => {
  try {
    const { content } = req.body as { content?: string };
    if (!content || typeof content !== "string") {
      return res.status(400).json({ error: "OpenAPI/Swagger content is required." });
    }

    const result = parseOpenApiSpec(content);
    const id = nanoid(10);
    const now = new Date().toISOString();
    db.prepare("INSERT INTO inputs (id, type, content, created_at) VALUES (?, ?, ?, ?)").run(
      id,
      "openapi_spec",
      result.summary,
      now
    );

    res.status(201).json({ id, type: "openapi_spec", content: result.summary, created_at: now, endpoints: result.endpoints });
  } catch (error: any) {
    res.status(400).json({ error: error.message || "OpenAPI import failed." });
  }
});

inputsRouter.post("/import-postman", (req, res) => {
  try {
    const { content } = req.body as { content?: string };
    if (!content || typeof content !== "string") {
      return res.status(400).json({ error: "Postman collection content is required." });
    }

    const result = parsePostmanCollection(content);
    const id = nanoid(10);
    const now = new Date().toISOString();
    db.prepare("INSERT INTO inputs (id, type, content, created_at) VALUES (?, ?, ?, ?)").run(
      id,
      "postman_collection",
      result.summary,
      now
    );

    res.status(201).json({ id, type: "postman_collection", content: result.summary, created_at: now, ...result });
  } catch (error: any) {
    res.status(400).json({ error: error.message || "Postman import failed." });
  }
});

inputsRouter.post("/import-external", async (req, res) => {
  try {
    const { provider, baseUrl, token, issueIds, project } = req.body as { provider?: "jira" | "azure"; baseUrl?: string; token?: string; issueIds?: string[] | string; project?: string };
    if (!provider || !baseUrl || !token || !issueIds) {
      return res.status(400).json({ error: "Provider, base URL, token, and issue IDs are required." });
    }

    const result = await importExternalWorkItems(provider, { baseUrl, token, issueIds, project });
    const id = nanoid(10);
    const now = new Date().toISOString();
    db.prepare("INSERT INTO inputs (id, type, content, created_at) VALUES (?, ?, ?, ?)").run(
      id,
      `external_${provider}`,
      result.summary,
      now
    );

    res.status(201).json({ id, type: `external_${provider}`, content: result.summary, created_at: now, items: result.items });
  } catch (error: any) {
    res.status(400).json({ error: error.message || "External import failed." });
  }
});

// Trigger generation for a given input (Module 2)
inputsRouter.post("/:id/generate", async (req, res) => {
  const input = db.prepare("SELECT * FROM inputs WHERE id = ?").get(req.params.id) as any;
  if (!input) return res.status(404).json({ error: "input not found" });

  try {
    const businessRules = (req.body as { businessRules?: string }).businessRules;
    const cases = await generateTestCasesForInput(input.id, input.content, businessRules);
    res.json(cases);
  } catch (err: any) {
    // FR-9.3: degrade gracefully -- surface a queued status with a retry path instead of a bare failure
    if (err?.queued) {
      return res.status(503).json({ error: err.message, queued: true, retryUrl: `/api/inputs/${input.id}/retry-generation` });
    }
    res.status(502).json({ error: `Generation failed: ${err.message}` });
  }
});

// FR-9.3: manual/automatic retry path for generation requests that were queued after an LLM outage
inputsRouter.post("/:id/retry-generation", async (req, res) => {
  const input = db.prepare("SELECT * FROM inputs WHERE id = ?").get(req.params.id) as any;
  if (!input) return res.status(404).json({ error: "input not found" });

  try {
    const businessRules = (req.body as { businessRules?: string }).businessRules;
    const cases = await generateTestCasesForInput(input.id, input.content, businessRules);
    res.json(cases);
  } catch (err: any) {
    if (err?.queued) {
      return res.status(503).json({ error: err.message, queued: true });
    }
    res.status(502).json({ error: `Generation failed: ${err.message}` });
  }
});
