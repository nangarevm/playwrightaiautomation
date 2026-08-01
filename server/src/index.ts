import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import "./db.js";
import { inputsRouter } from "./routes/inputs.js";
import { testCasesRouter } from "./routes/testcases.js";
import { codegenRouter } from "./routes/codegen.js";
import { executionRouter } from "./routes/execution.js";
import { selfHealingRouter } from "./routes/selfHealing.js";
import { reportingRouter } from "./routes/reporting.js";
import { integrationsRouter } from "./routes/integrations.js";
import { adminRouter } from "./routes/admin.js";
import { attachUser, enforceReadOnlyRoles } from "./services/adminService.js";
import { cleanupExpiredArtifacts, runScheduledProfiles } from "./services/executionService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT) || 4100;
const uploadDir = path.join(__dirname, "uploads");

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const upload = multer({ dest: uploadDir });

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(attachUser); // FR-8.1: resolve X-User-Id into req.user (defaults to a permissive Tester identity)
app.use(enforceReadOnlyRoles); // FR-8.1: Manager/Stakeholder role is read-only

// Bundled demo app-under-test, so generated scripts have something real to run against
app.use("/demo", express.static(path.join(__dirname, "demo-app")));

app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
app.use("/api/inputs", inputsRouter);
app.post("/api/inputs/upload", upload.fields([{ name: "screenshots", maxCount: 20 }, { name: "videos", maxCount: 20 }]), (req, res) => {
  const files = req.files as { screenshots?: Express.Multer.File[]; videos?: Express.Multer.File[] } | undefined;
  const screenshots = Array.isArray(files?.screenshots) ? files.screenshots : [];
  const videos = Array.isArray(files?.videos) ? files.videos : [];

  const stored = [
    ...screenshots.map((file: any) => ({ kind: "screenshot", originalName: file.originalname, savedName: file.filename, path: path.join(uploadDir, file.filename) })),
    ...videos.map((file: any) => ({ kind: "video", originalName: file.originalname, savedName: file.filename, path: path.join(uploadDir, file.filename) })),
  ];

  res.status(201).json({ uploaded: stored });
});
app.use("/api/test-cases", testCasesRouter);
app.use("/api/automation-scripts", codegenRouter);
app.use("/api/execution-runs", executionRouter);
app.use("/api/self-healing", selfHealingRouter);
app.use("/api/reporting", reportingRouter);
app.use("/api/integrations", integrationsRouter);
app.use("/api/admin", adminRouter);

app.listen(PORT, () => {
  console.log(`AI Test Automation Platform server listening on http://localhost:${PORT}`);
  console.log(`Demo app-under-test available at http://localhost:${PORT}/demo/login.html`);
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
