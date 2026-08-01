import { nanoid } from "nanoid";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { db } from "../db.js";
import { llm } from "../llm/index.js";
import { sanitizeForLlm } from "./safetyService.js";
import { commitGeneratedScriptToGit } from "./integrationsService.js";

interface GeneratedArtifactRecord {
  language: string;
  framework: string;
  code: string;
  fileName: string;
  filePath: string;
  security_scan_status: string;
  security_scan_notes: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GENERATED_DIR = path.join(__dirname, "..", "..", "generated");
fs.mkdirSync(GENERATED_DIR, { recursive: true });

// Minimal static scanner. In production this would call out to a real SAST
// tool (e.g. semgrep). Flags patterns that should never appear in
// AI-generated Playwright automation code.
const DANGEROUS_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /child_process/, reason: "spawns OS processes" },
  { pattern: /\beval\s*\(/, reason: "uses eval()" },
  { pattern: /require\(['"]fs['"]\).*(unlink|rm|rmdir)/s, reason: "deletes files from disk" },
  { pattern: /process\.env\.[A-Z_]*(SECRET|TOKEN|KEY)[A-Z_]*\s*(=|\+=)/, reason: "writes to a secret-looking env var" },
  { pattern: /https?:\/\/(?!localhost|127\.0\.0\.1)/, reason: "references an external network host not equal to the target-under-test" },
];

function staticSecurityScan(code: string): { status: "passed" | "flagged"; notes: string } {
  const hits = DANGEROUS_PATTERNS.filter((d) => d.pattern.test(code)).map((d) => d.reason);
  if (hits.length === 0) return { status: "passed", notes: "No disallowed patterns detected." };
  return { status: "flagged", notes: `Flagged for: ${hits.join("; ")}` };
}

export async function generateAutomationScript(testCaseId: string, options: { framework?: "playwright" | "selenium" | "cypress" } = {}) {
  const tc = db.prepare("SELECT * FROM test_cases WHERE id = ?").get(testCaseId) as any;
  if (!tc) throw new Error("Test case not found");
  if (tc.status !== "accepted" && tc.status !== "edited") {
    throw new Error("Test case must be accepted before automation can be generated (FR-2.4)");
  }

  const rawSteps = JSON.parse(tc.steps) as string[];

  // FR-9.2: sanitize before submission to the LLM, even for already human-reviewed test case content
  const sanitizedTestCase = {
    title: sanitizeForLlm(tc.title).sanitized,
    steps: rawSteps.map((s) => sanitizeForLlm(s).sanitized),
    expected_result: sanitizeForLlm(tc.expected_result).sanitized,
    category: tc.category,
  };

  // FR-3.2: optional Selenium/Cypress export, in addition to the default Playwright trio
  const requestedFramework = options.framework;
  let artifacts: Array<{ language: string; framework: string; code: string; fileName: string }>;
  if (requestedFramework && requestedFramework !== "playwright") {
    artifacts = [{
      language: "javascript",
      framework: requestedFramework,
      code: await llm.generatePlaywrightScript(sanitizedTestCase, { language: "javascript", framework: requestedFramework }),
      fileName: `${tc.id}.${requestedFramework === "cypress" ? "cy.js" : "selenium.js"}`,
    }];
  } else {
    const rawArtifacts = await llm.generateAutomationArtifacts?.(sanitizedTestCase, { apiSpecHint: tc.source_rationale }) ?? [];
    artifacts = rawArtifacts.length > 0 ? rawArtifacts : [{
      language: "typescript",
      framework: "playwright",
      code: await llm.generatePlaywrightScript(sanitizedTestCase, { language: "typescript", framework: "playwright" }),
      fileName: `${tc.id}.spec.ts`,
    }];
  }

  const writtenArtifacts: GeneratedArtifactRecord[] = [];
  for (const artifact of artifacts) {
    const scan = staticSecurityScan(artifact.code);
    const fileName = artifact.fileName || `${tc.id}.${artifact.language === "python" ? "py" : artifact.framework === "cypress" ? "cy.js" : "spec.ts"}`;
    const filePath = path.join(GENERATED_DIR, fileName);
    fs.writeFileSync(filePath, artifact.code, "utf-8");

    // FR-7.4: version generated automation scripts in a connected Git repo. Best-effort --
    // a git failure (e.g. git not installed) must not block codegen.
    try {
      await commitGeneratedScriptToGit(fileName, tc.id, tc.title);
    } catch (err: any) {
      console.warn(`[codegen] git commit failed for ${fileName}: ${err.message}`);
    }

    const id = nanoid(10);
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO automation_scripts
        (id, test_case_id, language, framework, code, file_path, security_scan_status, security_scan_notes, created_at)
      VALUES (@id, @test_case_id, @language, @framework, @code, @file_path, @security_scan_status, @security_scan_notes, @created_at)
    `).run({
      id,
      test_case_id: tc.id,
      language: artifact.language,
      framework: artifact.framework,
      code: artifact.code,
      file_path: filePath,
      security_scan_status: scan.status,
      security_scan_notes: scan.notes,
      created_at: now,
    });

    writtenArtifacts.push({
      language: artifact.language,
      framework: artifact.framework,
      code: artifact.code,
      fileName,
      filePath,
      security_scan_status: scan.status,
      security_scan_notes: scan.notes,
    });
  }

  return { artifacts: writtenArtifacts };
}
