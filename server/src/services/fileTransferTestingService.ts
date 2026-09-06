// Playbook §T/§U -- File Upload and Download testing (entirely net-new).
// Both directions of file transfer are checked the same way as the rest of
// this engine's active/scenario-based services (networkFailureInjectionService.ts,
// listBehaviorTestingService.ts): trigger a real file operation via
// Playwright and check a concrete, deterministic outcome.
//
// §T Upload -- setInputFiles() a real file (a valid one, or a deliberately
// invalid one the caller names as such via expectSuccess: false) and check
// whether the app's own success/error feedback matches what SHOULD have
// happened: a valid file silently rejected is a false-rejection bug; an
// invalid file (wrong type, oversized, whatever the caller is testing)
// silently ACCEPTED with no error is a data-integrity/security-relevant bug
// (e.g. a client-side-only extension check that a renamed file bypasses);
// either direction producing neither a success nor an error indicator is a
// silent-outcome bug -- the user has no idea what happened.
//
// §U Download -- click the trigger and wait for Playwright's own `download`
// event, which is not a heuristic: if it never fires within the timeout,
// the "download" is definitively broken (dead link/handler), not maybe
// broken. Once it fires, this checks the actual downloaded file: is it
// empty, is it at least as big as expected, does its filename match the
// expected pattern, and (for text-based exports like CSV/JSON) does its
// content contain an expected substring -- catching a "successful" download
// that's actually an empty or truncated/corrupted export.
//
// FALSE-POSITIVE RISK: an app whose upload feedback doesn't match this
// module's default success/error selector conventions (see
// FILE_TRANSFER_CONFIG, reusing the same convention as
// networkFailureInjectionService.ts for consistency across this engine) will
// read as "no feedback" even when it showed one via a different convention
// -- pass your own selectors per call if the defaults don't match. A
// download that legitimately takes longer than downloadTimeoutMs to start
// (a very slow report-generation backend) will read as "never triggered" --
// raise downloadTimeoutMs per call for a known-slow export.

import fs from "fs";
import os from "os";
import path from "path";
import { chromium, type Page } from "playwright";
import { recordBugFinding, type BugFindingRow } from "./bugDetectionService.js";

export const FILE_TRANSFER_CONFIG = {
  graceMs: 1000,
  navTimeoutMs: 30000,
  downloadTimeoutMs: 15000,
  successIndicatorSelectors: [".success", ".success-message", ".toast-success", ".alert-success", '[data-testid*="success" i]'] as string[],
  errorIndicatorSelectors: ['[role="alert"]', ".error", ".error-message", '[aria-invalid="true"]', ".toast-error", ".alert-danger", ".alert-error"] as string[],
};

async function launch() {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.SCAN_CHROMIUM_PATH || undefined });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  return { browser, page };
}

async function anyVisible(page: Page, selectors: string[]): Promise<boolean> {
  for (const sel of selectors) {
    const visible = await page.locator(sel).first().isVisible().catch(() => false);
    if (visible) return true;
  }
  return false;
}

// ---- §T: Upload ----

export interface FileUploadScenario {
  name: string;
  url: string;
  fileInputSelector: string;
  /** Absolute path to a real local file to upload. */
  filePath: string;
  /** Whether uploading THIS file is expected to succeed. false for a deliberately invalid file (wrong type, oversized, empty...) the app should reject. */
  expectSuccess: boolean;
  submitSelector?: string;
  successIndicatorSelectors?: string[];
  errorIndicatorSelectors?: string[];
  graceMs?: number;
  screenId?: string | null;
  runId?: string | null;
}

export async function runFileUploadScenario(scenario: FileUploadScenario): Promise<BugFindingRow[]> {
  const findings: BugFindingRow[] = [];
  const grace = scenario.graceMs ?? FILE_TRANSFER_CONFIG.graceMs;
  const successSelectors = scenario.successIndicatorSelectors ?? FILE_TRANSFER_CONFIG.successIndicatorSelectors;
  const errorSelectors = scenario.errorIndicatorSelectors ?? FILE_TRANSFER_CONFIG.errorIndicatorSelectors;
  const { browser, page } = await launch();

  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message.slice(0, 300)));

  try {
    await page.goto(scenario.url, { waitUntil: "domcontentloaded", timeout: FILE_TRANSFER_CONFIG.navTimeoutMs }).catch(() => undefined);
    await page.locator(scenario.fileInputSelector).first().setInputFiles(scenario.filePath, { timeout: 10000 }).catch(() => undefined);
    if (scenario.submitSelector) {
      await page.locator(scenario.submitSelector).first().click({ timeout: 10000 }).catch(() => undefined);
    }
    await page.waitForTimeout(grace);

    const successVisible = await anyVisible(page, successSelectors);
    const errorVisible = await anyVisible(page, errorSelectors);
    const fileName = path.basename(scenario.filePath);
    const baseSteps = [
      `Navigate to ${scenario.url}`,
      `Select "${fileName}" in "${scenario.fileInputSelector}"`,
      ...(scenario.submitSelector ? [`Click "${scenario.submitSelector}"`] : []),
      `Wait ${grace}ms.`,
    ];

    if (scenario.expectSuccess && errorVisible) {
      findings.push(
        recordBugFinding({
          source: "ui_exploratory",
          category: "functional",
          severity: "high",
          title: `Valid file upload was rejected: ${scenario.name}`,
          detail: `Uploading "${fileName}", which should be accepted, produced a visible error indicator instead of success.`,
          screenId: scenario.screenId ?? null,
          runId: scenario.runId ?? null,
          evidence: { scenario: scenario.name, fileName, expectSuccess: true, errorVisible },
          stepsToReproduce: [...baseSteps, "Observe: an error is shown even though this file should be accepted."],
        })
      );
    }

    if (!scenario.expectSuccess && successVisible) {
      findings.push(
        recordBugFinding({
          source: "ui_exploratory",
          category: "functional",
          severity: "critical",
          title: `Invalid file upload was silently accepted: ${scenario.name}`,
          detail: `Uploading "${fileName}", which should be rejected, produced a visible SUCCESS indicator instead of an error -- a client- or server-side validation gap likely lets an unwanted file type/size through (check for a client-only check bypassable by a renamed file, or a missing server-side check).`,
          screenId: scenario.screenId ?? null,
          runId: scenario.runId ?? null,
          evidence: { scenario: scenario.name, fileName, expectSuccess: false, successVisible },
          stepsToReproduce: [...baseSteps, "Observe: a success indicator is shown even though this file should be rejected."],
        })
      );
    }

    if (!successVisible && !errorVisible) {
      findings.push(
        recordBugFinding({
          source: "ui_exploratory",
          category: "functional",
          severity: "medium",
          title: `Upload produced no user-visible feedback: ${scenario.name}`,
          detail: `Uploading "${fileName}" produced neither a success nor an error indicator -- the user has no idea whether the upload worked.`,
          screenId: scenario.screenId ?? null,
          runId: scenario.runId ?? null,
          evidence: { scenario: scenario.name, fileName },
          stepsToReproduce: [...baseSteps, "Observe: no success or error indicator is visible."],
        })
      );
    }

    if (pageErrors.length > 0) {
      findings.push(
        recordBugFinding({
          source: "ui_exploratory",
          category: "functional",
          severity: "high",
          title: `Uncaught JS exception during file upload: ${scenario.name}`,
          detail: pageErrors.join("\n"),
          screenId: scenario.screenId ?? null,
          runId: scenario.runId ?? null,
          evidence: { scenario: scenario.name, fileName, pageErrors },
          stepsToReproduce: [...baseSteps, `Observe: an uncaught JavaScript exception is thrown -- ${pageErrors[0]}`],
        })
      );
    }
  } finally {
    await browser.close();
  }
  return findings;
}

// ---- §U: Download ----

export interface FileDownloadScenario {
  name: string;
  url: string;
  downloadTriggerSelector: string;
  /** The downloaded filename must match this (substring or RegExp test). */
  expectedFilenamePattern?: string | RegExp;
  /** Downloaded file must be at least this many bytes (default: just non-empty, i.e. > 0). */
  minSizeBytes?: number;
  /** For text-based downloads (CSV/JSON/etc) -- the file's content must contain this substring. */
  expectedContentSubstring?: string;
  downloadTimeoutMs?: number;
  screenId?: string | null;
  runId?: string | null;
}

export async function runFileDownloadScenario(scenario: FileDownloadScenario): Promise<BugFindingRow[]> {
  const findings: BugFindingRow[] = [];
  const timeout = scenario.downloadTimeoutMs ?? FILE_TRANSFER_CONFIG.downloadTimeoutMs;
  const { browser, page } = await launch();

  try {
    await page.goto(scenario.url, { waitUntil: "domcontentloaded", timeout: FILE_TRANSFER_CONFIG.navTimeoutMs }).catch(() => undefined);

    const baseSteps = [`Navigate to ${scenario.url}`, `Click "${scenario.downloadTriggerSelector}"`];

    const downloadPromise = page.waitForEvent("download", { timeout }).catch(() => null);
    await page.locator(scenario.downloadTriggerSelector).first().click({ timeout: 10000 }).catch(() => undefined);
    const download = await downloadPromise;

    if (!download) {
      findings.push(
        recordBugFinding({
          source: "ui_exploratory",
          category: "functional",
          severity: "high",
          title: `Download never triggered: ${scenario.name}`,
          detail: `Clicking "${scenario.downloadTriggerSelector}" did not produce a browser download within ${timeout}ms -- the download link/handler is broken (dead link, JS error before the download starts, or a server response that isn't recognized as a downloadable file).`,
          screenId: scenario.screenId ?? null,
          runId: scenario.runId ?? null,
          evidence: { scenario: scenario.name, timeoutMs: timeout },
          stepsToReproduce: [...baseSteps, `Observe: no download started within ${timeout}ms.`],
        })
      );
      return findings;
    }

    const suggestedFilename = download.suggestedFilename();
    const savedPath = path.join(os.tmpdir(), `dl-verify-${Date.now()}-${suggestedFilename}`);
    await download.saveAs(savedPath).catch(() => undefined);

    let sizeBytes = 0;
    let content = "";
    try {
      const stat = fs.statSync(savedPath);
      sizeBytes = stat.size;
      if (sizeBytes > 0 && sizeBytes < 5_000_000) content = fs.readFileSync(savedPath, "utf-8");
    } catch {
      /* file may not have saved -- sizeBytes stays 0, handled below */
    } finally {
      try {
        fs.unlinkSync(savedPath);
      } catch {
        /* best-effort cleanup */
      }
    }

    const minSize = scenario.minSizeBytes ?? 1;
    if (sizeBytes < minSize) {
      findings.push(
        recordBugFinding({
          source: "ui_exploratory",
          category: "functional",
          severity: "high",
          title: `Downloaded file is empty or smaller than expected: ${scenario.name}`,
          detail: `"${suggestedFilename}" downloaded at ${sizeBytes} byte(s), below the expected minimum of ${minSize} -- the export/download likely produced an empty or truncated file.`,
          screenId: scenario.screenId ?? null,
          runId: scenario.runId ?? null,
          evidence: { scenario: scenario.name, suggestedFilename, sizeBytes, minSizeBytes: minSize },
          stepsToReproduce: [...baseSteps, `Observe: the downloaded file "${suggestedFilename}" is only ${sizeBytes} byte(s).`],
        })
      );
    }

    if (scenario.expectedFilenamePattern) {
      const matches =
        typeof scenario.expectedFilenamePattern === "string"
          ? suggestedFilename.includes(scenario.expectedFilenamePattern)
          : scenario.expectedFilenamePattern.test(suggestedFilename);
      if (!matches) {
        findings.push(
          recordBugFinding({
            source: "ui_exploratory",
            category: "functional",
            severity: "low",
            title: `Downloaded filename does not match expected pattern: ${scenario.name}`,
            detail: `Expected the downloaded filename to match ${String(scenario.expectedFilenamePattern)}, but got "${suggestedFilename}".`,
            screenId: scenario.screenId ?? null,
            runId: scenario.runId ?? null,
            evidence: { scenario: scenario.name, suggestedFilename, expectedPattern: String(scenario.expectedFilenamePattern) },
            stepsToReproduce: [...baseSteps, `Observe: the downloaded filename "${suggestedFilename}" does not match the expected pattern.`],
          })
        );
      }
    }

    if (scenario.expectedContentSubstring && sizeBytes > 0 && !content.includes(scenario.expectedContentSubstring)) {
      findings.push(
        recordBugFinding({
          source: "ui_exploratory",
          category: "functional",
          severity: "high",
          title: `Downloaded file content is missing expected data: ${scenario.name}`,
          detail: `"${suggestedFilename}" does not contain the expected content ("${scenario.expectedContentSubstring}") -- the export may be corrupted, using stale/cached data, or generated from the wrong query.`,
          screenId: scenario.screenId ?? null,
          runId: scenario.runId ?? null,
          evidence: { scenario: scenario.name, suggestedFilename, expectedContentSubstring: scenario.expectedContentSubstring },
          stepsToReproduce: [...baseSteps, `Observe: "${suggestedFilename}" does not contain "${scenario.expectedContentSubstring}".`],
        })
      );
    }
  } finally {
    await browser.close();
  }
  return findings;
}
