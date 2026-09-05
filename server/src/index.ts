import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { nanoid } from "nanoid";
import { db } from "./db.js";
import { inputsRouter } from "./routes/inputs.js";
import { extractVideoFrames, recordVideoFrames, redactLikelyPii } from "./services/ingestionService.js";
import { extractDocumentText } from "./services/documentParsingService.js";
import { catalogScreen } from "./services/screensService.js";
import { getOrgRedactionSetting, getActiveBusinessRulesText } from "./services/adminService.js";
import { testCasesRouter } from "./routes/testcases.js";
import { codegenRouter } from "./routes/codegen.js";
import { executionRouter } from "./routes/execution.js";
import { selfHealingRouter } from "./routes/selfHealing.js";
import { reportingRouter } from "./routes/reporting.js";
import { integrationsRouter } from "./routes/integrations.js";
import { adminRouter } from "./routes/admin.js";
import { screensRouter } from "./routes/screens.js";
import { environmentsRouter } from "./routes/environments.js";
import { crawlerRouter } from "./routes/crawler.js";
import { allureRouter } from "./routes/allure.js";
import { bugsRouter } from "./routes/bugs.js";
import { apiSchemasRouter } from "./routes/apiSchemas.js";
import { attachUser, enforceReadOnlyRoles } from "./services/adminService.js";
import { cleanupExpiredArtifacts, runScheduledProfiles } from "./services/executionService.js";
import { runScheduledCrawlsAndDiffs } from "./services/changeSchedulerService.js";
import { sendScheduledDigests } from "./services/digestService.js";
import { processExecutionQueue } from "./services/runnerPoolService.js";
import { idempotencyMiddleware, cleanupExpiredIdempotencyKeys } from "./services/idempotencyService.js";
import { rateLimitMiddleware } from "./services/rateLimitService.js";
import { errBody } from "./errorCodes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT) || 4100;
const uploadDir = path.join(__dirname, "uploads");

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// FR-1.1/FR-1.9: reject unsupported formats with a clear message instead of
// silently accepting/dropping them. Screenshots must be JPG/PNG; videos must be
// a real video mimetype/extension -- previously there was no fileFilter at all,
// so e.g. a .txt file uploaded as a "screenshot" was silently accepted (HTTP 201).
const ALLOWED_IMAGE_EXT = /\.(jpe?g|png)$/i;
const ALLOWED_VIDEO_EXT = /\.(mp4|mov|webm|avi)$/i;
// FR-1.7/FR-1.9: document upload only accepts formats documentParsingService can
// actually parse -- PDF, modern Word (.docx), and Excel (.xlsx/.xls). Legacy .doc
// is rejected up front with a clear message rather than silently failing to parse.
const ALLOWED_DOC_EXT = /\.(pdf|docx|xlsx|xls)$/i;

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    // Preserve the original extension so express.static serves images with the
    // right Content-Type (multer's default dest-only storage strips it, which
    // left thumbnails served as application/octet-stream).
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname)}`),
  }),
  fileFilter: (req, file, cb) => {
    const isScreenshotField = file.fieldname === "screenshots";
    const isVideoField = file.fieldname === "videos";
    if (isScreenshotField && !(file.mimetype.startsWith("image/") && ALLOWED_IMAGE_EXT.test(file.originalname))) {
      return cb(new Error(`Unsupported screenshot format: "${file.originalname}". Only JPG/PNG images are accepted.`));
    }
    if (isVideoField && !(file.mimetype.startsWith("video/") || ALLOWED_VIDEO_EXT.test(file.originalname))) {
      return cb(new Error(`Unsupported video format: "${file.originalname}". Only MP4/MOV/WebM/AVI videos are accepted.`));
    }
    cb(null, true);
  },
});

const uploadDocs = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname)}`),
  }),
  fileFilter: (req, file, cb) => {
    if (file.fieldname === "documents" && !ALLOWED_DOC_EXT.test(file.originalname)) {
      return cb(new Error(`Unsupported document format: "${file.originalname}". Only PDF, Word (.docx), and Excel (.xlsx/.xls) files are accepted.`));
    }
    cb(null, true);
  },
});

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err?.type === "entity.parse.failed" || err instanceof SyntaxError) {
    return res.status(400).json(errBody(400, err.message || "Invalid JSON body"));
  }
  next(err);
});
app.use(attachUser); // FR-8.1: resolve X-User-Id into req.user (defaults to a permissive Tester identity)
app.use(rateLimitMiddleware); // Dev TDD §6.5: 429 RATE_LIMITED, per-identity fixed window
app.use(enforceReadOnlyRoles); // FR-8.1: Manager/Stakeholder role is read-only
app.use(idempotencyMiddleware); // SR-FR-0.4: replay the stored response for a repeated Idempotency-Key

// Bundled demo app-under-test, so generated scripts have something real to run against
app.use("/demo", express.static(path.join(__dirname, "demo-app")));
// Deeper Bug Detection Phase 2 verification fixture: a togglable mock API
// response (?variant=1|2) used by server/src/demo-app/buggy-fixture.html to
// prove baseline-capture-then-drift-detection against a real endpoint, not a
// hand-constructed body. Lives under /demo/ alongside the other demo-app
// fixtures -- not part of the real API surface.
app.get("/demo/api/orders", (req, res) => {
  if (req.query.variant === "2") {
    // Phase 2 demo: dropped `total`, changed `id` from number to string.
    res.json({ id: "ord_1", items: ["a"] });
  } else {
    res.json({ id: 1, total: 42.5, items: ["a"] });
  }
});
// Phase 6 verification fixture: a fixed 5-item list, used by
// consistency-fixture.html to prove the UI-vs-API consistency check across
// an exact match, a legitimate paginated subset (comparison_mode 'at-most'),
// and a genuine rendering bug (comparison_mode 'exact').
app.get("/demo/api/products", (_req, res) => {
  res.json({ items: [1, 2, 3, 4, 5] });
});
// Phase 1 hardening verification fixtures: a JSON-content-type endpoint that
// returns unparsable JSON (malformed-JSON detection), and a togglable
// endpoint whose baseline always returns populated data but can return an
// empty array on demand (empty-response-where-data-expected detection).
app.get("/demo/api/malformed-json", (_req, res) => {
  res.setHeader("content-type", "application/json");
  res.status(200).send("{not valid json,,,");
});
app.get("/demo/api/inventory", (req, res) => {
  if (req.query.variant === "2") {
    res.json([]);
  } else {
    res.json([{ sku: "a" }, { sku: "b" }]);
  }
});
// Phase 1B verification fixture: a 500 used by correlation-fixture.html to
// prove one user action's network failure + stuck spinner + console error
// (the master prompt's own §17 worked example) collapse into one
// correlation_group_id instead of three unrelated findings.
app.post("/demo/api/order-fail", (_req, res) => {
  res.status(500).json({ error: "insufficient stock" });
});
// FR-1.1: serve uploaded screenshots so the client can render real thumbnails
app.use("/uploads", express.static(uploadDir));

app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
app.use("/api/inputs", inputsRouter);
app.post("/api/inputs/upload", (req, res, next) => {
  upload.fields([{ name: "screenshots", maxCount: 20 }, { name: "videos", maxCount: 20 }])(req, res, (err: any) => {
    // FR-1.1/FR-1.9: surface a clear, specific error instead of letting multer's
    // default behavior either 500 with a stack trace or (with no fileFilter at
    // all, as before) silently accept the file.
    if (err) return res.status(400).json(errBody(400, err.message || "Upload rejected: unsupported file format."));
    next();
  });
}, async (req, res) => {
  const files = req.files as { screenshots?: Express.Multer.File[]; videos?: Express.Multer.File[] } | undefined;
  const screenshots = Array.isArray(files?.screenshots) ? files.screenshots : [];
  const videos = Array.isArray(files?.videos) ? files.videos : [];

  const stored: any[] = screenshots.map((file: any) => ({ kind: "screenshot", originalName: file.originalname, savedName: file.filename, path: path.join(uploadDir, file.filename), url: `/uploads/${file.filename}` }));

  // FR-1.2: attempt real key-frame extraction for each uploaded video, traceable
  // back to the source video (see ingestionService.extractVideoFrames)
  for (const file of videos as any[]) {
    const videoEntry: any = { kind: "video", originalName: file.originalname, savedName: file.filename, path: path.join(uploadDir, file.filename), url: `/uploads/${file.filename}` };
    try {
      const extraction = await extractVideoFrames(videoEntry.path, uploadDir);
      videoEntry.frame_extraction_status = extraction.status;
      videoEntry.frame_extraction_message = extraction.message;
      if (extraction.status === "extracted") {
        videoEntry.frames = recordVideoFrames(file.originalname, extraction.frames).map((f) => ({ id: f.id, frame_index: f.frame_index, url: f.frame_url }));
      }
    } catch (err: any) {
      videoEntry.frame_extraction_status = "unavailable";
      videoEntry.frame_extraction_message = err.message;
    }
    stored.push(videoEntry);
  }

  res.status(201).json({ uploaded: stored });
});

// FR-1.7/FR-1.9: multi-file PDF/Word/Excel document upload -- extracts real text
// content from each file (documentParsingService) and creates one `inputs` row
// per successfully parsed document, running it through the same org-level PII
// redaction (FR-1.8) and active-business-rules enrichment (FR-2.11) as the
// free-text input path. Generation is triggered separately by the client via
// the existing POST /api/inputs/:id/generate, exactly like the free-text tab,
// so generation_status (none/pending/queued/retrying/completed/failed) flows
// through the same lifecycle already tracked on the inputs table.
// A file that fails to parse (unsupported format or corrupted) is reported back
// per-file with a clear error instead of failing the whole batch or crashing (FR-1.9).
app.post("/api/inputs/upload-documents", (req, res, next) => {
  uploadDocs.fields([{ name: "documents", maxCount: 20 }])(req, res, (err: any) => {
    if (err) return res.status(400).json(errBody(400, err.message || "Upload rejected: unsupported document format."));
    next();
  });
}, async (req, res) => {
  const files = req.files as { documents?: Express.Multer.File[] } | undefined;
  const documents = Array.isArray(files?.documents) ? files.documents : [];

  if (documents.length === 0) {
    return res.status(400).json(errBody(400, "At least one PDF/Word/Excel document is required."));
  }

  const orgRedactionDisabled = Boolean(getOrgRedactionSetting().pii_redaction_disabled);
  const activeRules = getActiveBusinessRulesText();
  const now = new Date().toISOString();
  const results: Array<{ originalName: string; size: number; status: "parsed" | "failed"; kind?: string; error?: string; inputId?: string; content?: string }> = [];

  for (const file of documents as Express.Multer.File[]) {
    const filePath = path.join(uploadDir, file.filename);
    const extraction = await extractDocumentText(filePath, file.originalname, file.mimetype);

    if (extraction.status === "failed") {
      results.push({ originalName: file.originalname, size: file.size, status: "failed", kind: extraction.kind, error: extraction.error });
      continue;
    }

    const safeContent = redactLikelyPii(extraction.text, orgRedactionDisabled);
    const enrichedContent = activeRules ? `${safeContent}\n\nBusiness rules:\n${activeRules}` : safeContent;
    const id = nanoid(10);
    db.prepare("INSERT INTO inputs (id, type, content, created_at) VALUES (?, ?, ?, ?)").run(id, "document", enrichedContent, now);

    // FR-1.10/FR-2.14: catalog a Screen for every parsed document (PDF/Word/Excel),
    // named from the file itself -- same treatment url_crawl/batch_upload already
    // get, so document-sourced test cases are screen-tagged too instead of only
    // ever being reachable by input id.
    catalogScreen({ name: file.originalname, sourceInputId: id, content: `${file.originalname}::${file.size}` });

    results.push({ originalName: file.originalname, size: file.size, status: "parsed", kind: extraction.kind, inputId: id, content: enrichedContent });
  }

  res.status(201).json({ documents: results });
});

app.use("/api/test-cases", testCasesRouter);
app.use("/api/automation-scripts", codegenRouter);
app.use("/api/execution-runs", executionRouter);
app.use("/api/self-healing", selfHealingRouter);
app.use("/api/reporting", reportingRouter);
app.use("/api/integrations", integrationsRouter);
app.use("/api/admin", adminRouter);
app.use("/api/screens", screensRouter);
app.use("/api/environments", environmentsRouter);
app.use("/api/crawler", crawlerRouter);
app.use("/api/allure", allureRouter);
app.use("/api/bugs", bugsRouter);
app.use("/api/api-schemas", apiSchemasRouter);
// Embedded Allure report viewer (Phase 8 step 5): served statically so the
// client can open it in an <iframe> instead of requiring download/unzip/open.
app.use("/allure-report", express.static(path.join(__dirname, "..", "allure-report")));

// Last-resort error handler: routes generally catch their own errors and
// respond with a JSON 500, but this keeps any missed throw from crashing
// the whole process (e.g. a filesystem error inside a route body).
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[unhandled route error]", err);
  if (!res.headersSent) {
    res.status(500).json({ error: err?.message || "Internal server error" });
  }
});

process.on("unhandledRejection", (err) => {
  console.error("[unhandled rejection]", err);
});

const server = app.listen(PORT, () => {
  console.log(`AI Test Automation Platform server listening on http://localhost:${PORT}`);
  console.log(`Demo app-under-test available at http://localhost:${PORT}/demo/login.html`);
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[server] Port ${PORT} is already in use -- another server instance is still running.`);
    process.exit(1);
  }
  throw err;
});

// FR-4.16: check every minute for scheduled Execution Profiles due to run
setInterval(() => {
  runScheduledProfiles().catch((err) => console.warn("[scheduler] tick failed:", err.message));
}, 60_000);

// FR-4.8: check every hour for artifacts past their retention window
setInterval(() => {
  try {
    cleanupExpiredArtifacts();
  } catch (err: any) {
    console.warn("[retention] cleanup failed:", err.message);
  }
}, 60 * 60_000);

// FR-4.5/FR-4.3/FR-4.17: process the execution queue every 3 seconds -- dequeues
// eligible queued runs when capacity is free, autoscales the shared pool, and
// recomputes every remaining run's queue_position
setInterval(() => {
  processExecutionQueue().catch((err) => console.warn("[runner-pool] tick failed:", err.message));
}, 3_000);

// FR-5.1/FR-5.2: re-crawl/re-diff catalogued screens every 30 minutes
setInterval(() => {
  runScheduledCrawlsAndDiffs().catch((err) => console.warn("[change-detection] scheduled tick failed:", err.message));
}, 30 * 60_000);

// FR-6.9: check every hour whether a daily digest is due (self-throttles to the
// configured cadence internally, so an hourly tick is a safe polling interval)
setInterval(() => {
  sendScheduledDigests().catch((err) => console.warn("[digest] scheduled tick failed:", err.message));
}, 60 * 60_000);

// SR-FR-0.4: sweep expired idempotency keys out of the short-TTL store hourly
setInterval(() => {
  try {
    cleanupExpiredIdempotencyKeys();
  } catch (err: any) {
    console.warn("[idempotency] cleanup failed:", err.message);
  }
}, 60 * 60_000);
