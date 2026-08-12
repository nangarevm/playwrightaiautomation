import { nanoid } from "nanoid";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { db } from "../db.js";
import { llm } from "../llm/index.js";
import { sanitizeForLlm } from "./safetyService.js";
import { commitGeneratedScriptToGit } from "./integrationsService.js";
import { withLlmGateway } from "./llmGatewayService.js";
import { tagScriptToScreen } from "./screensService.js";
import { getDefaultScriptLanguage } from "../llm/modelConfig.js";
import type { ScriptLanguage } from "../llm/modelConfig.js";
import { optimizePromptWithCompression, isPromptOptimizationEnabled } from "./promptOptimizationService.js";
import { getPromptResponse, cachePromptResponse, isCacheEnabled } from "./cacheService.js";
import { selectModel, isModelRoutingEnabled } from "./modelRoutingService.js";
import { tryBuildCrawledScriptWithoutLlm } from "../llm/mockProvider.js";

interface GeneratedArtifactRecord {
  language: string;
  framework: string;
  code: string;
  fileName: string;
  filePath: string;
  security_scan_status: string;
  security_scan_notes: string;
  locator_strategy: string;
}

// Dev TDD §6.5 (422 SECURITY_SCAN_FAILED / FR-3.6): a static scan already
// existed and recorded pass/flagged, but nothing ever acted on "flagged" --
// the script was always persisted and returned 201 regardless. This is the
// missing enforcement half: a flagged artifact is rejected rather than
// silently shipped, and the route surfaces it as 422 SECURITY_SCAN_FAILED.
export class SecurityScanFailedError extends Error {
  notes: string;
  constructor(notes: string) {
    super(`Generated script failed the static security scan (FR-3.6): ${notes}`);
    this.notes = notes;
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GENERATED_DIR = path.join(__dirname, "..", "..", "generated");
fs.mkdirSync(GENERATED_DIR, { recursive: true });

// Minimal static scanner. In production this would call out to a real SAST
// tool (e.g. semgrep). Flags patterns that should never appear in
// AI-generated Playwright automation code.
//
// External-host check is allowlist-aware: crawled sites (and TARGET_URL) are
// legitimate destinations for generated scripts. Only unexpected third-party
// hosts should be flagged.
const ALWAYS_DANGEROUS: { pattern: RegExp; reason: string }[] = [
  { pattern: /child_process/, reason: "spawns OS processes" },
  { pattern: /\beval\s*\(/, reason: "uses eval()" },
  { pattern: /require\(['"]fs['"]\).*(unlink|rm|rmdir)/s, reason: "deletes files from disk" },
  { pattern: /process\.env\.[A-Z_]*(SECRET|TOKEN|KEY)[A-Z_]*\s*(=|\+=)/, reason: "writes to a secret-looking env var" },
];

const DEFAULT_ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1"]);

export function hostFromUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    return new URL(withProtocol).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function collectAllowedHosts(...candidates: Array<string | null | undefined>): Set<string> {
  const hosts = new Set(DEFAULT_ALLOWED_HOSTS);
  for (const candidate of candidates) {
    if (!candidate) continue;
    // Pull every URL-looking token out of rationale / hints, not just a single host.
    const matches = String(candidate).matchAll(/https?:\/\/[^\s)'"`]+/gi);
    for (const match of matches) {
      const host = hostFromUrl(match[0]);
      if (host) hosts.add(host);
    }
    const bare = hostFromUrl(candidate);
    if (bare) hosts.add(bare);
  }
  return hosts;
}

export function staticSecurityScan(
  code: string,
  options?: { allowedHosts?: Iterable<string> }
): { status: "passed" | "flagged"; notes: string } {
  const hits = ALWAYS_DANGEROUS.filter((d) => d.pattern.test(code)).map((d) => d.reason);

  const allowed = new Set(DEFAULT_ALLOWED_HOSTS);
  for (const host of options?.allowedHosts ?? []) {
    if (host) allowed.add(String(host).toLowerCase());
  }

  const urlMatches = code.matchAll(/https?:\/\/[^\s)'"`]+/gi);
  const disallowedHosts = new Set<string>();
  for (const match of urlMatches) {
    const host = hostFromUrl(match[0]);
    if (!host) continue;
    if (allowed.has(host)) continue;
    disallowedHosts.add(host);
  }
  if (disallowedHosts.size > 0) {
    hits.push(
      `references an external network host not equal to the target-under-test (${Array.from(disallowedHosts).join(", ")})`
    );
  }

  if (hits.length === 0) return { status: "passed", notes: "No disallowed patterns detected." };
  return { status: "flagged", notes: `Flagged for: ${hits.join("; ")}` };
}

// SR-FR-3.4: previously "accessibility-first locators" was only true implicitly,
// inline in the generated code/comments (see mockProvider.ts's FR-3.4 fallback
// comment) with no queryable record of which strategy a given script actually
// used. This classifies the generated code itself so it's a real column
// (automation_scripts.locator_strategy), not just a comment a compliance report
// would have to grep for.
const ACCESSIBILITY_LOCATOR_PATTERN = /getByRole|getByLabel|getByText|get_by_role|get_by_label|get_by_text|By\.(?:ROLE|LABEL)\b/;
const CSS_XPATH_LOCATOR_PATTERN = /page\.locator\(|document\.querySelector|By\.(?:CSS_SELECTOR|XPATH)\b|find_element_by_(?:css|xpath)|driver\.findElement\(By\.(?:cssSelector|xpath)/;

export function classifyLocatorStrategy(code: string): "accessibility" | "css_xpath_fallback" | "mixed" | "n/a" {
  const usesAccessibility = ACCESSIBILITY_LOCATOR_PATTERN.test(code);
  const usesCssXpath = CSS_XPATH_LOCATOR_PATTERN.test(code);
  if (usesAccessibility && usesCssXpath) return "mixed";
  if (usesAccessibility) return "accessibility";
  if (usesCssXpath) return "css_xpath_fallback";
  return "n/a"; // e.g. FR-3.5 API scripts, which have no UI locators at all
}

const FIXTURES_DIR = path.join(GENERATED_DIR, "fixtures");
fs.mkdirSync(FIXTURES_DIR, { recursive: true });

function longestCommonStepPrefix(stepLists: string[][]): string[] {
  if (stepLists.length === 0) return [];
  const shortest = stepLists.reduce((a, b) => (a.length <= b.length ? a : b));
  const prefix: string[] = [];
  for (let i = 0; i < shortest.length; i++) {
    const step = shortest[i];
    if (stepLists.every((list) => list[i] === step)) prefix.push(step);
    else break;
  }
  return prefix;
}

// FR-3.7: generate (or refresh) the shared setup/teardown fixture for every test
// case tied to a screen -- computed as the longest common leading step sequence
// across that screen's test cases (e.g. shared login/navigation steps), written
// to one file scripts reference rather than duplicating in every generated script.
// Because updating the fixture file updates the one artifact every script for
// that screen points at (fixture_path), a later regeneration of the fixture
// automatically applies to every script already tagged to the screen.
function ensureScreenFixture(screenId: string): string | null {
  const testCases = db.prepare("SELECT id, steps FROM test_cases WHERE screen_id = ?").all(screenId) as Array<{ id: string; steps: string }>;
  if (testCases.length < 2) return null; // nothing to share across a single test case

  const stepLists = testCases.map((tc) => JSON.parse(tc.steps) as string[]);
  const sharedSteps = longestCommonStepPrefix(stepLists);
  if (sharedSteps.length === 0) return null;

  const fileName = `${screenId}.fixture.ts`;
  const filePath = path.join(FIXTURES_DIR, fileName);
  const code = `// Auto-generated shared setup fixture for screen ${screenId} (FR-3.7).
// Steps common to every test case tagged to this screen -- regenerate this
// file (by calling ensureScreenFixture again) and every script that imports
// it picks up the change without being individually re-edited.
import { Page } from "@playwright/test";

export async function sharedSetup(page: Page): Promise<void> {
${sharedSteps.map((s) => `  // ${s}`).join("\n")}
}
`;
  fs.writeFileSync(filePath, code, "utf-8");
  db.prepare("UPDATE screens SET fixture_path = ? WHERE id = ?").run(filePath, screenId);
  return filePath;
}

export async function generateAutomationScript(
  testCaseId: string,
  options: { framework?: "playwright" | "selenium" | "cypress"; language?: ScriptLanguage } = {}
) {
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

  // FR-3.2: optional Selenium/Cypress export; default Playwright in one language per LLM call.
  const requestedFramework = options.framework ?? "playwright";
  const language = options.language ?? getDefaultScriptLanguage();

  // FR-9.5/9.6/9.7: route script generation through the same LLM gateway test-case
  // generation already uses. Cache key includes language/framework so different
  // export targets never share the same cached script.
  const cacheKey = [sanitizedTestCase.title, ...sanitizedTestCase.steps, language, requestedFramework].join(" ");

  // Phase 2: prompt cache → compress → model route (must run on hot path, not import-only).
  let effectivePrompt = cacheKey;
  if (isPromptOptimizationEnabled()) {
    try {
      const { optimized } = optimizePromptWithCompression(cacheKey);
      if (optimized?.trim()) effectivePrompt = optimized;
    } catch {
      /* keep original prompt */
    }
  }
  if (isModelRoutingEnabled()) {
    try {
      const complexity = Math.min(1, (sanitizedTestCase.steps.length || 1) / 20);
      const pageType =
        String(sanitizedTestCase.category || "").toLowerCase().includes("api")
          ? "api"
          : "interactive";
      const decision = selectModel(pageType as any, complexity);
      console.info(`[codegen] model route → ${decision.model} (${decision.reason})`);
    } catch {
      /* non-blocking */
    }
  }
  if (isCacheEnabled()) {
    const cachedCode = getPromptResponse(effectivePrompt);
    if (cachedCode && cachedCode.length > 40) {
      const fileName =
        requestedFramework === "cypress"
          ? `${tc.id}.cy.js`
          : requestedFramework === "selenium"
            ? `${tc.id}.selenium.js`
            : language === "python"
              ? `${tc.id}.py`
              : language === "javascript"
                ? `${tc.id}.spec.js`
                : `${tc.id}.spec.ts`;
      const artifacts = [{ language, framework: requestedFramework, code: cachedCode, fileName }];
      // Fall through to security scan / persist using cached artifact.
      const screen = tc.screen_id
        ? (db.prepare("SELECT url_or_path FROM screens WHERE id = ?").get(tc.screen_id) as { url_or_path: string | null } | undefined)
        : undefined;
      const crawlUrlMatch = String(tc.source_rationale || "").match(/CRAWL_URL=(\S+)/);
      const allowedHosts = collectAllowedHosts(
        tc.source_rationale,
        crawlUrlMatch?.[1],
        screen?.url_or_path,
        process.env.TARGET_URL
      );
      const fixturePath = tc.screen_id ? ensureScreenFixture(tc.screen_id) : null;
      const scan = staticSecurityScan(cachedCode, { allowedHosts });
      if (scan.status === "flagged") throw new SecurityScanFailedError(scan.notes);
      const filePath = path.join(GENERATED_DIR, fileName);
      const codeWithFixtureRef = fixturePath
        ? `// FR-3.7: shares setup steps with other scripts on this screen via ${path.relative(GENERATED_DIR, fixturePath)}\n${cachedCode}`
        : cachedCode;
      fs.writeFileSync(filePath, codeWithFixtureRef, "utf-8");
      try {
        await commitGeneratedScriptToGit(fileName, tc.id, tc.title);
      } catch (err: any) {
        console.warn(`[codegen] git commit failed for ${fileName}: ${err.message}`);
      }
      const id = nanoid(10);
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO automation_scripts
          (id, test_case_id, language, framework, code, file_path, security_scan_status, security_scan_notes, fixture_path, locator_strategy, created_at)
        VALUES (@id, @test_case_id, @language, @framework, @code, @file_path, @security_scan_status, @security_scan_notes, @fixture_path, @locator_strategy, @created_at)
      `).run({
        id,
        test_case_id: tc.id,
        language,
        framework: requestedFramework,
        code: codeWithFixtureRef,
        file_path: filePath,
        security_scan_status: scan.status,
        security_scan_notes: scan.notes,
        locator_strategy: classifyLocatorStrategy(cachedCode),
        fixture_path: fixturePath,
        created_at: now,
      });
      tagScriptToScreen(id, tc.id);
      return {
        artifacts: [{
          language,
          framework: requestedFramework,
          code: codeWithFixtureRef,
          fileName,
          filePath,
          security_scan_status: scan.status,
          security_scan_notes: scan.notes,
          locator_strategy: classifyLocatorStrategy(cachedCode),
        }],
        fromCache: true,
      };
    }
  }

  type Artifact = { language: string; framework: string; code: string; fileName: string };

  // Crawler scenarios already carry URL + locators — build the script from that
  // template instead of spending an LLM call (default on; set CRAWL_TEMPLATE_FIRST=false to force LLM).
  let artifacts: Artifact[] | null = null;
  const templateFirst = process.env.CRAWL_TEMPLATE_FIRST !== "false";
  if (templateFirst && requestedFramework === "playwright") {
    const lang =
      language === "javascript" ? "javascript" : language === "python" ? "python" : "typescript";
    const templated = tryBuildCrawledScriptWithoutLlm(sanitizedTestCase, lang, tc.source_rationale);
    if (templated) {
      const fileName =
        language === "python"
          ? `${tc.id}.py`
          : language === "javascript"
            ? `${tc.id}.spec.js`
            : `${tc.id}.spec.ts`;
      artifacts = [{ language, framework: requestedFramework, code: templated, fileName }];
      if (isCacheEnabled()) {
        try {
          cachePromptResponse(effectivePrompt, templated);
        } catch {
          /* ignore */
        }
      }
      console.info(`[codegen] template-first script for ${tc.id} (no LLM call)`);
    }
  }

  if (!artifacts) {
    artifacts = await withLlmGateway<Artifact[]>(
    "script_generation",
    { inputId: tc.id, provider: llm.name, prompt: effectivePrompt, category: sanitizedTestCase.category },
    async (_preparedPrompt, tier) => {
      const code = await llm.generatePlaywrightScript(sanitizedTestCase, {
        tier,
        language,
        framework: requestedFramework,
        apiSpecHint: tc.source_rationale,
      });
      const fileName =
        requestedFramework === "cypress"
          ? `${tc.id}.cy.js`
          : requestedFramework === "selenium"
            ? `${tc.id}.selenium.js`
            : language === "python"
              ? `${tc.id}.py`
              : language === "javascript"
                ? `${tc.id}.spec.js`
                : `${tc.id}.spec.ts`;
      const result: Artifact[] = [{ language, framework: requestedFramework, code, fileName }];
      if (isCacheEnabled() && code) {
        try {
          cachePromptResponse(effectivePrompt, code);
        } catch {
          /* ignore cache write failures */
        }
      }
      return { result, outputText: code };
    }
  );
  }

  // Cached artifacts were generated for a different test case id -- every filename/fileName
  // embeds tc.id, so a cache hit needs its artifact filenames rewritten to this test case
  // before anything is written to disk, or a cache hit would silently overwrite/alias an
  // unrelated script's file.
  for (const artifact of artifacts) {
    artifact.fileName = artifact.fileName.replace(/^[^.]+/, tc.id);
  }

  // FR-3.7: (re)compute the shared setup fixture for this test case's screen,
  // if it's tagged to one, before writing scripts so the reference is current.
  const fixturePath = tc.screen_id ? ensureScreenFixture(tc.screen_id) : null;

  // FR-3.6 (MVP gate): scan every artifact BEFORE anything is written to disk
  // or committed to Git -- "static security scan on all AI-generated code
  // before Git commit/CI-CD execution" per the SRS. A flagged artifact fails
  // the whole generation call closed (nothing partially written/committed)
  // rather than being silently persisted with a 201, which is what happened
  // before this pass.
  //
  // Allow the crawled page URL / screen URL / TARGET_URL so Generate+Run against
  // a real site is not false-flagged as "unexpected external host".
  const screen = tc.screen_id
    ? (db.prepare("SELECT url_or_path FROM screens WHERE id = ?").get(tc.screen_id) as { url_or_path: string | null } | undefined)
    : undefined;
  const crawlUrlMatch = String(tc.source_rationale || "").match(/CRAWL_URL=(\S+)/);
  const allowedHosts = collectAllowedHosts(
    tc.source_rationale,
    crawlUrlMatch?.[1],
    screen?.url_or_path,
    process.env.TARGET_URL
  );

  const scans = artifacts.map((artifact) => ({
    artifact,
    scan: staticSecurityScan(artifact.code, { allowedHosts }),
  }));
  const flagged = scans.find((s) => s.scan.status === "flagged");
  if (flagged) {
    throw new SecurityScanFailedError(flagged.scan.notes);
  }

  const writtenArtifacts: GeneratedArtifactRecord[] = [];
  for (const { artifact, scan } of scans) {
    const fileName = artifact.fileName || `${tc.id}.${artifact.language === "python" ? "py" : artifact.framework === "cypress" ? "cy.js" : "spec.ts"}`;
    const filePath = path.join(GENERATED_DIR, fileName);
    const codeWithFixtureRef = fixturePath
      ? `// FR-3.7: shares setup steps with other scripts on this screen via ${path.relative(GENERATED_DIR, fixturePath)}\n${artifact.code}`
      : artifact.code;
    fs.writeFileSync(filePath, codeWithFixtureRef, "utf-8");

    // FR-7.4: version generated automation scripts in a connected Git repo. Best-effort --
    // a git failure (e.g. git not installed) must not block codegen.
    try {
      await commitGeneratedScriptToGit(fileName, tc.id, tc.title);
    } catch (err: any) {
      console.warn(`[codegen] git commit failed for ${fileName}: ${err.message}`);
    }

    const id = nanoid(10);
    const now = new Date().toISOString();
    // SR-FR-3.4: classify against the raw generated code, before the FR-3.7
    // fixture-reference comment is prepended, so the classification reflects
    // this artifact's own locators only.
    const locatorStrategy = classifyLocatorStrategy(artifact.code);
    db.prepare(`
      INSERT INTO automation_scripts
        (id, test_case_id, language, framework, code, file_path, security_scan_status, security_scan_notes, fixture_path, locator_strategy, created_at)
      VALUES (@id, @test_case_id, @language, @framework, @code, @file_path, @security_scan_status, @security_scan_notes, @fixture_path, @locator_strategy, @created_at)
    `).run({
      id,
      test_case_id: tc.id,
      language: artifact.language,
      framework: artifact.framework,
      code: codeWithFixtureRef,
      file_path: filePath,
      security_scan_status: scan.status,
      security_scan_notes: scan.notes,
      locator_strategy: locatorStrategy,
      fixture_path: fixturePath,
      created_at: now,
    });
    // FR-2.14: script inherits its Screen tag from the test case it was generated from
    tagScriptToScreen(id, tc.id);

    writtenArtifacts.push({
      language: artifact.language,
      framework: artifact.framework,
      code: codeWithFixtureRef,
      fileName,
      filePath,
      security_scan_status: scan.status,
      security_scan_notes: scan.notes,
      locator_strategy: locatorStrategy,
    });
  }

  return { artifacts: writtenArtifacts };
}
