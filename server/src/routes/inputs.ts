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
import { catalogScreen, deriveScreenNameFromText } from "../services/screensService.js";
import { getOrgRedactionSetting, getActiveBusinessRulesText } from "../services/adminService.js";
import { errBody } from "../errorCodes.js";

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

// FR-1.2: list extracted video frames, each traceable back to its source video
inputsRouter.get("/video-frames", (req, res) => {
  const sourceVideoName = req.query.source as string | undefined;
  const rows = sourceVideoName
    ? db.prepare("SELECT * FROM video_frames WHERE source_video_name = ? ORDER BY frame_index ASC").all(sourceVideoName)
    : db.prepare("SELECT * FROM video_frames ORDER BY created_at DESC").all();
  res.json(rows);
});

// FR-1.7: accept free-text scenario descriptions as an input type
inputsRouter.post("/", (req, res) => {
  const { content, type, businessRules } = req.body as { content?: string; type?: string; businessRules?: string };
  if (!content || content.trim().length === 0) {
    return res.status(400).json(errBody(400, "content is required")); // FR-1.9: clear user-facing error
  }
  const id = nanoid(10);
  const now = new Date().toISOString();
  // FR-1.8: org-level toggle is the single source of truth, not a per-request
  // client-supplied flag (which any caller could set regardless of org policy)
  const orgSetting = getOrgRedactionSetting();
  const safeContent = redactLikelyPii(content.trim(), Boolean(orgSetting.pii_redaction_disabled));
  // FR-2.11: active QA-Lead-managed business rules are pulled in automatically
  // in addition to any per-request rules text, so generation demonstrably
  // reflects them without the caller having to re-supply the rule every time
  const activeRules = getActiveBusinessRulesText();
  const combinedRules = [businessRules, activeRules].filter(Boolean).join("\n");
  const enrichedContent = combinedRules ? `${safeContent}\n\nBusiness rules:\n${combinedRules}` : safeContent;
  db.prepare("INSERT INTO inputs (id, type, content, created_at) VALUES (?, ?, ?, ?)").run(
    id,
    type ?? "free_text",
    enrichedContent,
    now
  );

  // FR-1.10/FR-2.14: catalog a Screen for this input too, same as url_crawl/batch_upload
  // already do, so free-text-sourced test cases are screen-tagged and show up in Screen
  // Explorer/coverage-gap views instead of only ever being reachable by input id.
  catalogScreen({ name: deriveScreenNameFromText(content, `Free-text input ${id}`), sourceInputId: id, content: safeContent });

  res.status(201).json({ id, type: type ?? "free_text", content: enrichedContent, created_at: now });
});

inputsRouter.post("/batch-upload", (req, res) => {
  try {
    const files = Array.isArray(req.body?.files) ? req.body.files : [];
    if (!files.length) {
      return res.status(400).json(errBody(400, "At least one file is required for batch upload."));
    }

    // FR-1.8: org-level toggle, not a per-file client-supplied flag
    const orgRedactionDisabled = Boolean(getOrgRedactionSetting().pii_redaction_disabled);
    const summary = buildBatchUploadSummary(files.map((file: any) => ({
      originalName: file.originalName || file.name || "upload",
      mimeType: file.mimeType || file.type || "application/octet-stream",
      size: Number(file.size || 0),
      savedPath: file.savedPath,
      content: file.content,
      disableRedaction: orgRedactionDisabled,
    })));

    const id = nanoid(10);
    const now = new Date().toISOString();
    db.prepare("INSERT INTO inputs (id, type, content, created_at) VALUES (?, ?, ?, ?)").run(
      id,
      "batch_upload",
      summary.content,
      now
    );

    // FR-1.10: catalog every distinct screen discovered from uploaded screenshots/video frames
    for (const artifact of summary.artifacts) {
      if (artifact.kind === "image" || artifact.kind === "video") {
        catalogScreen({
          name: artifact.originalName,
          sourceInputId: id,
          content: `${artifact.originalName}::${artifact.size}`,
        });
      }
    }

    res.status(201).json({ id, type: "batch_upload", content: summary.content, created_at: now, artifacts: summary.artifacts });
  } catch (error: any) {
    res.status(400).json(errBody(400, error.message || "Batch upload failed."));
  }
});

// FR-1.3/FR-1.3a/FR-1.3b: optional username/password or sessionToken authenticates
// into the target app before crawling, so pages behind a login wall are reachable.
// Credentials are used only in-memory for this request -- never logged, never
// persisted here (an Environment, created via /api/environments, is the
// encrypted-at-rest storage location per FR-1.3c if the user wants to reuse them).
inputsRouter.post("/url-crawl", async (req, res) => {
  try {
    const { url, maxPages = 2, username, password, sessionToken } = req.body as {
      url?: string;
      maxPages?: number;
      username?: string;
      password?: string;
      sessionToken?: string;
    };
    if (!url || typeof url !== "string") {
      return res.status(400).json(errBody(400, "A valid URL is required."));
    }

    const result = await crawlUrl(url, Number(maxPages) || 2, { username, password, sessionToken });
    const id = nanoid(10);
    const now = new Date().toISOString();
    db.prepare("INSERT INTO inputs (id, type, content, created_at) VALUES (?, ?, ?, ?)").run(
      id,
      "url_crawl",
      result.summary,
      now
    );

    // FR-1.10/FR-1.3b: catalog each crawled page as a first-class Screen,
    // discovered autonomously from navigation rather than pre-specified by the user
    for (const page of result.pages) {
      catalogScreen({
        name: page.title || page.url,
        sourceInputId: id,
        urlOrPath: page.url,
        content: `${page.title}::forms=${page.formCount}`,
      });
    }

    res.status(201).json({ id, type: "url_crawl", content: result.summary, created_at: now, pages: result.pages, authenticated: result.authenticated });
  } catch (error: any) {
    res.status(400).json(errBody(400, error.message || "URL crawl failed."));
  }
});

// FR-5.2: importing a spec also classifies it Changed/Unchanged/New against the
// most recent prior import that shares the same spec title -- a structural hash
// (title + version + sorted endpoint/method/param-count list) is compared so
// incidental formatting differences in the pasted text don't false-positive.
// `source_url` is optional and only present when the caller supplies a live URL
// this spec was fetched from -- that's what makes it eligible for the periodic
// re-fetch-and-diff in changeSchedulerService.runScheduledApiChangeDetection().
inputsRouter.post("/import-openapi", (req, res) => {
  try {
    const { content, source_url } = req.body as { content?: string; source_url?: string };
    if (!content || typeof content !== "string") {
      return res.status(400).json(errBody(400, "OpenAPI/Swagger content is required."));
    }

    const result = parseOpenApiSpec(content);
    const id = nanoid(10);
    const now = new Date().toISOString();

    const previous = db
      .prepare("SELECT * FROM inputs WHERE type = 'openapi_spec' AND spec_title = ? ORDER BY created_at DESC LIMIT 1")
      .get(result.title) as any;
    const changeStatus = !previous ? "new" : previous.content_hash === result.structureHash ? "unchanged" : "changed";

    db.prepare(
      "INSERT INTO inputs (id, type, content, created_at, spec_title, content_hash, change_status, source_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(id, "openapi_spec", result.summary, now, result.title, result.structureHash, changeStatus, source_url || null);

    // FR-1.10/FR-2.14: an API spec's title is its natural "screen" -- the same
    // grouping concept a crawled UI page or an uploaded screenshot gets.
    catalogScreen({ name: result.title || `API spec ${id}`, sourceInputId: id, urlOrPath: source_url, content: result.summary });

    res.status(201).json({
      id,
      type: "openapi_spec",
      content: result.summary,
      created_at: now,
      endpoints: result.endpoints,
      change_status: changeStatus,
    });
  } catch (error: any) {
    res.status(400).json(errBody(400, error.message || "OpenAPI import failed."));
  }
});

inputsRouter.post("/import-postman", (req, res) => {
  try {
    const { content } = req.body as { content?: string };
    if (!content || typeof content !== "string") {
      return res.status(400).json(errBody(400, "Postman collection content is required."));
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

    // FR-1.10/FR-2.14: name the screen from the collection's own `info.name` when
    // present (same field Postman itself shows in its UI) -- best-effort, a
    // malformed/missing name just falls back rather than blocking the import.
    let collectionName: string | undefined;
    try {
      collectionName = JSON.parse(content)?.info?.name;
    } catch {
      // already validated as JSON by parsePostmanCollection above; this is belt-and-suspenders
    }
    catalogScreen({ name: collectionName || `Postman collection ${id}`, sourceInputId: id, content: result.summary });

    res.status(201).json({ id, type: "postman_collection", content: result.summary, created_at: now, ...result });
  } catch (error: any) {
    res.status(400).json(errBody(400, error.message || "Postman import failed."));
  }
});

inputsRouter.post("/import-external", async (req, res) => {
  try {
    const { provider, baseUrl, token, issueIds, project } = req.body as { provider?: "jira" | "azure"; baseUrl?: string; token?: string; issueIds?: string[] | string; project?: string };
    if (!provider || !baseUrl || !token || !issueIds) {
      return res.status(400).json(errBody(400, "Provider, base URL, token, and issue IDs are required."));
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

    // FR-1.10/FR-2.14: group by the supplied project/component when given (the
    // natural "screen" for a batch of tickets); otherwise name it from the
    // imported ticket titles themselves so it's still identifiable in Screen
    // Explorer rather than an opaque "external_jira" bucket.
    const screenName = project || result.items.map((i) => i.title).slice(0, 2).join(", ") || `${provider} import ${id}`;
    catalogScreen({ name: screenName, sourceInputId: id, content: result.summary });

    res.status(201).json({ id, type: `external_${provider}`, content: result.summary, created_at: now, items: result.items });
  } catch (error: any) {
    res.status(400).json(errBody(400, error.message || "External import failed."));
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
      return res.status(503).json(errBody(503, err.message, { queued: true, retryUrl: `/api/inputs/${input.id}/retry-generation` }));
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
      return res.status(503).json(errBody(503, err.message, { queued: true }));
    }
    res.status(502).json({ error: `Generation failed: ${err.message}` });
  }
});
