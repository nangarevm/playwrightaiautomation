// Bug Detection Engine: proactive defect discovery, distinct from FR-7.6's
// reactive "previously-passing test now fails" regression filing. Two
// techniques, folded in from what used to be a disconnected standalone
// Playwright project (bug-crawler/): an exploratory UI scan of a cataloged
// Screen (broken images, JS/console errors, server errors while the page
// loads) and an API fuzz pass (boundary/malformed/negative-id inputs that
// should 4xx cleanly but instead crash with a 5xx). Every finding records
// steps to reproduce plus a screenshot (UI findings) and/or a screen
// recording of the whole scan session, so a human doesn't have to re-derive
// "how do I see this myself" from a one-line description. Findings are
// recorded in `bug_findings` and, best-effort, auto-filed to whatever
// Jira/Azure integration is configured (see integrationsService.fileGenericBug).
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import { nanoid } from "nanoid";
import { db } from "../db.js";
import { getScreen, compareScreenshotToBaseline } from "./screensService.js";
import { fileGenericBug } from "./integrationsService.js";
import type { SpellingIssue } from "../crawler/types.js";
import { originOf, normalizeUrl } from "../crawler/urlUtils.js";
import { isLikelyApiResponse } from "../crawler/network.js";
import { analyzeVisualDifferences, detectImageLoadingIssues, detectTextRenderingIssues } from "./visualDetectionService.js";
import { analyzeConsoleError, summarizeErrors, groupErrorsByCategory, detectRelatedErrors, type ConsoleError } from "./consoleErrorService.js";
import { validateInteraction, validateInteractionSequence, detectInteractionPatterns, type InteractionEvent } from "./interactionValidationService.js";
import { checkAndRecordApiResponse } from "./apiSchemaService.js";
import { runDomChecks } from "./domChecksService.js";
import { checkUiApiConsistency } from "./uiApiConsistencyService.js";
import { getVisualDiffThresholdPercent } from "./adminService.js";
import { runResponsiveBugScan } from "./responsiveService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, "..", "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export type BugSeverity = "critical" | "high" | "medium" | "low";
export type BugSource = "ui_exploratory" | "api_fuzz" | "regression";
// The six-value taxonomy a finding is tagged with, plus 'functional' for the
// pre-existing FR-7.6 regression-on-failure findings (a test-execution
// failure, not one of the six proactive-detection categories below). The rule
// used to assign a category to every *existing* finding type (none of them
// were tagged before this pass) is: what signal actually detected it --
//   console-error      <- console.error / uncaught exception (page.on('console'|'pageerror'))
//   api-status          <- an HTTP status/network-connection signal, whether the
//                          request was for the page itself, an image, a link, or
//                          an XHR/fetch call (4xx/5xx, failed request, nav timeout,
//                          API fuzz crash, "2xx with an error body")
//   api-schema           <- a captured API response's JSON shape drifted from its
//                          stored baseline (apiSchemaService.ts)
//   ui-visual             <- a pixel-diff against a stored screenshot baseline
//                          exceeded its threshold (screensService.ts)
//   ui-dom                <- a DOM/rendering-level signal: broken image, stuck
//                          spinner, empty body, spelling, or the new zero-size/
//                          overlap/text-overflow/off-viewport checks (domChecksService.ts)
//   ui-api-mismatch     <- a declared UI-count-vs-API-count rule disagreed
//                          (uiApiConsistencyService.ts)
export type BugCategory = "console-error" | "api-status" | "api-schema" | "ui-visual" | "ui-dom" | "ui-api-mismatch" | "functional";

export interface BugFindingInput {
  source: BugSource;
  category?: BugCategory;
  severity: BugSeverity;
  title: string;
  detail: string;
  screenId?: string | null;
  runId?: string | null;
  viewport?: string | null;
  evidence?: Record<string, any>;
  stepsToReproduce?: string[];
  screenshotUrl?: string | null;
  videoUrl?: string | null;
}

export interface BugFindingRow {
  id: string;
  source: BugSource;
  category: BugCategory | null;
  severity: BugSeverity;
  title: string;
  detail: string;
  screen_id: string | null;
  run_id: string | null;
  viewport: string | null;
  evidence: string;
  steps_to_reproduce: string | null;
  screenshot_url: string | null;
  video_url: string | null;
  status: "open" | "acknowledged" | "resolved" | "ignored";
  filed_provider: string | null;
  filed_external_id: string | null;
  created_at: string;
  updated_at: string;
}

export function recordBugFinding(input: BugFindingInput): BugFindingRow {
  const id = nanoid(10);
  const now = new Date().toISOString();
  const row: BugFindingRow = {
    id,
    source: input.source,
    category: input.category ?? null,
    severity: input.severity,
    title: input.title,
    detail: input.detail,
    screen_id: input.screenId ?? null,
    run_id: input.runId ?? null,
    viewport: input.viewport ?? null,
    evidence: JSON.stringify(input.evidence ?? {}),
    steps_to_reproduce: JSON.stringify(input.stepsToReproduce ?? []),
    screenshot_url: input.screenshotUrl ?? null,
    video_url: input.videoUrl ?? null,
    status: "open",
    filed_provider: null,
    filed_external_id: null,
    created_at: now,
    updated_at: now,
  };
  db.prepare(`
    INSERT INTO bug_findings (id, source, category, severity, title, detail, screen_id, run_id, viewport, evidence, steps_to_reproduce, screenshot_url, video_url, status, created_at, updated_at)
    VALUES (@id, @source, @category, @severity, @title, @detail, @screen_id, @run_id, @viewport, @evidence, @steps_to_reproduce, @screenshot_url, @video_url, @status, @created_at, @updated_at)
  `).run(row);
  return row;
}

export function listBugFindings(filter?: { status?: string; severity?: string; screenId?: string; category?: string }): BugFindingRow[] {
  const clauses: string[] = [];
  const params: Record<string, string> = {};
  if (filter?.status) { clauses.push("status = @status"); params.status = filter.status; }
  if (filter?.severity) { clauses.push("severity = @severity"); params.severity = filter.severity; }
  if (filter?.screenId) { clauses.push("screen_id = @screen_id"); params.screen_id = filter.screenId; }
  if (filter?.category) { clauses.push("category = @category"); params.category = filter.category; }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return db.prepare(`SELECT * FROM bug_findings ${where} ORDER BY created_at DESC`).all(params) as BugFindingRow[];
}

export function getBugFinding(id: string): BugFindingRow | undefined {
  return db.prepare("SELECT * FROM bug_findings WHERE id = ?").get(id) as BugFindingRow | undefined;
}

export function updateBugFindingStatus(id: string, status: "open" | "acknowledged" | "resolved" | "ignored"): BugFindingRow | undefined {
  const now = new Date().toISOString();
  db.prepare("UPDATE bug_findings SET status = ?, updated_at = ? WHERE id = ?").run(status, now, id);
  return getBugFinding(id);
}

export function markBugFindingFiled(id: string, provider: string, externalId: string | undefined) {
  const now = new Date().toISOString();
  db.prepare("UPDATE bug_findings SET filed_provider = ?, filed_external_id = ?, updated_at = ? WHERE id = ?").run(provider, externalId ?? null, now, id);
  return getBugFinding(id);
}

// Video is only finalized once the browser context that recorded it closes, so
// findings created mid-scan are inserted with video_url = null and backfilled
// here once the recording is on disk. Mutates the passed-in row objects too --
// the caller (scanScreenForUiBugs) returns these same objects, and without
// this they'd still carry the stale video_url: null snapshot taken at insert
// time even though the DB row has since been updated.
function attachVideoToFindings(findings: BugFindingRow[], videoUrl: string) {
  if (findings.length === 0) return;
  const now = new Date().toISOString();
  const update = db.prepare("UPDATE bug_findings SET video_url = ?, updated_at = ? WHERE id = ?");
  const tx = db.transaction((rows: BugFindingRow[]) => {
    for (const row of rows) update.run(videoUrl, now, row.id);
  });
  tx(findings);
  for (const row of findings) {
    row.video_url = videoUrl;
    row.updated_at = now;
  }
}

// Fire-and-forget: file only the findings worth a human's attention immediately.
// Low/medium noise (a handful of console warnings) shouldn't spam the tracker.
function autoFileIfSevere(finding: BugFindingRow) {
  if (finding.severity !== "critical" && finding.severity !== "high") return;
  fileGenericBug(finding)
    .then((result: any) => {
      if (result?.filed) markBugFindingFiled(finding.id, result.provider, result.externalId);
    })
    .catch(() => undefined);
}

function saveUploadFile(buffer: Buffer, extension: string): string {
  const fileName = `bugscan-${nanoid(10)}${extension}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, fileName), buffer);
  return `/uploads/${fileName}`;
}

// Playwright writes a failed test's own screenshot/video into its per-test
// output folder (e.g. test-results/artifacts/<test-name>/test-failed-1.png).
// That folder isn't web-served, so a bug finding built from a test-execution
// failure (executionService's regression detection) couldn't show a screenshot
// the way an exploratory UI scan finding already can. Copy whatever evidence
// exists there into UPLOAD_DIR (which IS served under /uploads) so both finding
// types carry the same kind of visual evidence. Best-effort: a missing/renamed
// evidence folder just means no screenshot, not a failure.
export function publishFailureEvidence(evidenceDir: string | null | undefined): { screenshotUrl: string | null; videoUrl: string | null } {
  if (!evidenceDir) return { screenshotUrl: null, videoUrl: null };
  try {
    if (!fs.existsSync(evidenceDir) || !fs.statSync(evidenceDir).isDirectory()) return { screenshotUrl: null, videoUrl: null };
    const files = fs.readdirSync(evidenceDir);
    const pngFile = files.find((f) => f.toLowerCase().endsWith(".png"));
    const webmFile = files.find((f) => f.toLowerCase().endsWith(".webm"));
    const screenshotUrl = pngFile ? saveUploadFile(fs.readFileSync(path.join(evidenceDir, pngFile)), ".png") : null;
    const videoUrl = webmFile ? saveUploadFile(fs.readFileSync(path.join(evidenceDir, webmFile)), ".webm") : null;
    return { screenshotUrl, videoUrl };
  } catch {
    return { screenshotUrl: null, videoUrl: null };
  }
}

const FUZZ_IDS = [
  { label: "negative id", value: "-1" },
  { label: "huge number id", value: "99999999999999999999999999" },
  { label: "sqli-like id", value: "' OR '1'='1' --" },
  { label: "xss-like id", value: "<script>alert(1)</script>" },
  { label: "path traversal id", value: "../../etc/passwd" },
  { label: "null-byte id", value: "abc%00def" },
];

// API fuzz: hit each ":id"-shaped endpoint template with boundary/malformed/
// negative values. A clean 4xx is fine and expected; a 5xx means unvalidated
// input reached something that crashed -- that's the bug. Steps to reproduce
// are the literal request, so anyone can replay it with curl.
export async function fuzzApiEndpoint(baseUrl: string, endpointTemplate: string, runId?: string, headers: Record<string, string> = {}): Promise<BugFindingRow[]> {
  const findings: BugFindingRow[] = [];
  for (const fuzz of FUZZ_IDS) {
    const url = endpointTemplate.includes(":")
      ? `${baseUrl.replace(/\/$/, "")}${endpointTemplate.replace(/:[A-Za-z_]+/, encodeURIComponent(fuzz.value))}`
      : `${baseUrl.replace(/\/$/, "")}${endpointTemplate}`;
    try {
      const res = await fetch(url, { headers });
      if (res.status >= 500) {
        const headerLines = Object.entries(headers).map(([k, v]) => `-H "${k}: ${v}"`).join(" ");
        const finding = recordBugFinding({
          source: "api_fuzz",
          category: "api-status",
          severity: "high",
          title: `${endpointTemplate} crashes (HTTP ${res.status}) on ${fuzz.label}`,
          detail: `GET ${url} returned HTTP ${res.status} instead of a clean 4xx -- unvalidated input reached a server-side failure.`,
          runId,
          evidence: { url, status: res.status, fuzzLabel: fuzz.label, fuzzInput: fuzz.value },
          stepsToReproduce: [
            `Send a GET request to: ${url}${headerLines ? ` (with headers: ${headerLines})` : ""}`,
            `Equivalent curl: curl -i ${headerLines ? `${headerLines} ` : ""}"${url}"`,
            `Observe: HTTP ${res.status} (a server-side crash) instead of a clean 4xx validation error.`,
          ],
        });
        findings.push(finding);
        autoFileIfSevere(finding);
      }
    } catch {
      // Target unreachable for this probe -- not itself a finding worth recording.
    }
  }
  return findings;
}

export async function fuzzApiEndpoints(baseUrl: string, endpointTemplates: string[], runId?: string, headers?: Record<string, string>): Promise<BugFindingRow[]> {
  const all: BugFindingRow[] = [];
  for (const template of endpointTemplates) {
    all.push(...(await fuzzApiEndpoint(baseUrl, template, runId, headers)));
  }
  return all;
}

const SPINNER_GRACE_MS = 1500;
const SCAN_NAV_TIMEOUT_MS = 30000;

// UI exploratory scan: load a cataloged Screen's URL headlessly and watch for
// the same class of bug a manual exploratory tester would catch by just
// looking at the page -- console/page errors, failed network calls, broken
// images, a load spinner that never resolves. The whole session is screen-
// recorded (attached to every finding from this scan) and each individual
// finding also gets its own screenshot taken at the moment it's detected.
export interface ScanScreenOptions {
  /** Deeper Bug Detection #5: which viewport to scan at. Defaults to the original 1280x800 desktop size. */
  viewport?: { name: string; width: number; height: number };
  /** Deeper Bug Detection #6: run declarative UI-vs-API consistency rules for this screen. Defaults to true when a real screenId is available. */
  checkUiApiConsistency?: boolean;
}

const DESKTOP_VIEWPORT = { name: "desktop", width: 1280, height: 800 };

export async function scanScreenForUiBugs(
  screen: { id: string; name: string; url_or_path: string | null },
  runId?: string,
  catalogScreenId?: string | null,
  options?: ScanScreenOptions
): Promise<BugFindingRow[]> {
  if (!screen.url_or_path) return [];
  const screenId = catalogScreenId ?? null;
  const viewport = options?.viewport ?? DESKTOP_VIEWPORT;
  const findings: BugFindingRow[] = [];
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    recordVideo: { dir: UPLOAD_DIR, size: { width: viewport.width, height: viewport.height } },
  });

  async function screenshotNow(): Promise<string | null> {
    try {
      const buffer = await page.screenshot({ fullPage: true });
      return saveUploadFile(buffer, ".png");
    } catch {
      return null;
    }
  }

  const page = await context.newPage();
  try {
    const consoleErrors: ConsoleError[] = [];
    const pageErrors: string[] = [];
    const serverErrors: Array<{ url: string; status: number }> = [];
    const clientErrors: Array<{ url: string; status: number }> = [];
    const failedRequests: Array<{ url: string; error: string }> = [];
    // Deeper Bug Detection #2: candidate XHR/fetch responses worth validating
    // as API calls -- the response body is read after the page settles (below),
    // not inline in this listener, so a slow/streaming body never blocks or
    // races the rest of the scan.
    const apiResponseCandidates: Array<{ response: import("playwright").Response; method: string }> = [];

    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push({
          type: (msg.type() as any) || "error",
          message: msg.text().slice(0, 500),
          source: msg.location()?.url,
          line: msg.location()?.lineNumber,
          column: msg.location()?.columnNumber,
          timestamp: Date.now(),
        });
      }
    });
    page.on("pageerror", (err) => pageErrors.push(err.message.slice(0, 300)));
    page.on("response", (res) => {
      if (res.status() >= 500) serverErrors.push({ url: res.url(), status: res.status() });
      else if (res.status() >= 400 && res.request().resourceType() === "document") {
        clientErrors.push({ url: res.url(), status: res.status() });
      }
      const req = res.request();
      const resourceType = req.resourceType();
      if ((resourceType === "xhr" || resourceType === "fetch") && isLikelyApiResponse(res.headers()["content-type"] || "", res.url())) {
        apiResponseCandidates.push({ response: res, method: req.method().toUpperCase() });
      }
    });
    page.on("requestfailed", (req) => {
      failedRequests.push({ url: req.url(), error: (req.failure()?.errorText || "request failed").slice(0, 200) });
    });

    const baseSteps = [
      `Navigate to: ${screen.url_or_path}`,
      "Wait for the page to finish loading.",
    ];

    let mainResponse: import("playwright").Response | null = null;
    try {
      mainResponse = await page.goto(screen.url_or_path, { waitUntil: "domcontentloaded", timeout: SCAN_NAV_TIMEOUT_MS });
    } catch (navErr: any) {
      const screenshotUrl = await screenshotNow();
      const finding = recordBugFinding({
        source: "ui_exploratory",
        category: "api-status",
        severity: "critical",
        title: `${screen.name} failed to load`,
        detail: `Navigating to ${screen.url_or_path} did not complete: ${navErr.message}`,
        screenId,
        runId,
        evidence: { url: screen.url_or_path, error: navErr.message },
        stepsToReproduce: [...baseSteps, `Observe: navigation never completes -- ${navErr.message}`],
        screenshotUrl,
      });
      findings.push(finding);
      autoFileIfSevere(finding);
      return findings;
    }

    if (mainResponse && mainResponse.status() >= 400) {
      const screenshotUrl = await screenshotNow();
      const finding = recordBugFinding({
        source: "ui_exploratory",
        category: "api-status",
        severity: mainResponse.status() >= 500 ? "critical" : "high",
        title: `${screen.name} returned HTTP ${mainResponse.status()}`,
        detail: `The main document at ${screen.url_or_path} returned HTTP ${mainResponse.status()} instead of a successful response.`,
        screenId,
        runId,
        evidence: { url: screen.url_or_path, status: mainResponse.status() },
        stepsToReproduce: [...baseSteps, `Observe: HTTP ${mainResponse.status()} on the main page load.`],
        screenshotUrl,
      });
      findings.push(finding);
      autoFileIfSevere(finding);
    }

    const brokenImages: string[] = await page
      .locator("img:visible")
      .evaluateAll((imgs: any[]) => imgs.filter((img) => img.complete && img.naturalWidth === 0).map((img) => img.src))
      .catch(() => []);

    await page.waitForTimeout(SPINNER_GRACE_MS);
    const stuckSpinners = await page.locator(".animate-spin:visible, [role='progressbar']:visible").count().catch(() => 0);

    if (serverErrors.length) {
      const screenshotUrl = await screenshotNow();
      const finding = recordBugFinding({
        source: "ui_exploratory",
        category: "api-status",
        severity: "critical",
        title: `Server error(s) while loading ${screen.name}`,
        detail: serverErrors.map((e) => `HTTP ${e.status} — ${e.url}`).join("\n"),
        screenId,
        runId,
        evidence: { serverErrors },
        stepsToReproduce: [...baseSteps, `Observe: ${serverErrors.length} request(s) returned a 5xx server error -- see the response network tab for ${serverErrors.map((e) => e.url).join(", ")}`],
        screenshotUrl,
      });
      findings.push(finding);
      autoFileIfSevere(finding);
    }
    if (pageErrors.length) {
      const screenshotUrl = await screenshotNow();
      const finding = recordBugFinding({
        source: "ui_exploratory",
        category: "console-error",
        severity: "high",
        title: `JavaScript error on ${screen.name}`,
        detail: pageErrors.join("\n"),
        screenId,
        runId,
        evidence: { pageErrors },
        stepsToReproduce: [...baseSteps, "Observe: an uncaught JavaScript exception is thrown -- open the browser console to see it.", `Error message: ${pageErrors[0]}`],
        screenshotUrl,
      });
      findings.push(finding);
      autoFileIfSevere(finding);
    }
    if (brokenImages.length) {
      const screenshotUrl = await screenshotNow();
      findings.push(
        recordBugFinding({
          source: "ui_exploratory",
          category: "ui-dom",
          severity: "medium",
          title: `Broken image(s) on ${screen.name}`,
          detail: brokenImages.join("\n"),
          screenId,
          runId,
          evidence: { brokenImages },
          stepsToReproduce: [...baseSteps, `Observe: the following image(s) fail to load (broken/404): ${brokenImages.join(", ")}`],
          screenshotUrl,
        })
      );
    }

    const brokenLinks = await checkBrokenInternalLinks(page, screen.url_or_path);
    if (brokenLinks.length) {
      const screenshotUrl = await screenshotNow();
      findings.push(
        recordBugFinding({
          source: "ui_exploratory",
          category: "api-status",
          severity: "medium",
          title: `Broken internal link(s) on ${screen.name}`,
          detail: brokenLinks.map((l) => `HTTP ${l.status} — ${l.url} (${l.label})`).join("\n"),
          screenId,
          runId,
          evidence: { brokenLinks },
          stepsToReproduce: [...baseSteps, `Observe: ${brokenLinks.length} same-origin link(s) return 4xx/5xx instead of loading.`],
          screenshotUrl,
        })
      );
    }

    if (stuckSpinners > 0) {
      const screenshotUrl = await screenshotNow();
      findings.push(
        recordBugFinding({
          source: "ui_exploratory",
          category: "ui-dom",
          severity: "medium",
          title: `Stuck loading indicator on ${screen.name}`,
          detail: `${stuckSpinners} loading indicator(s) still animating ${SPINNER_GRACE_MS}ms after the page reported idle.`,
          screenId,
          runId,
          evidence: { stuckSpinners },
          stepsToReproduce: [...baseSteps, `Wait an additional ${SPINNER_GRACE_MS}ms.`, `Observe: ${stuckSpinners} spinner/progress indicator(s) still animating instead of resolving.`],
          screenshotUrl,
        })
      );
    }
    if (consoleErrors.length) {
      const summary = summarizeErrors(consoleErrors);
      const grouped = groupErrorsByCategory(consoleErrors);
      const related = detectRelatedErrors(summary.topErrors);
      
      findings.push(
        recordBugFinding({
          source: "ui_exploratory",
          category: "console-error",
          severity: summary.bySeverity.critical || summary.bySeverity.high ? "high" : "medium",
          title: `Console error(s) on ${screen.name} (${summary.total} total)`,
          detail: `
Summary:
- Total errors: ${summary.total}
- Critical: ${summary.bySeverity.critical || 0}
- High: ${summary.bySeverity.high || 0}

Top Errors:
${summary.topErrors.map((e, i) => `${i + 1}. [${e.severity.toUpperCase()}] ${e.errorType}: ${e.message}`).join("\n")}

Categories:
${Object.entries(grouped)
  .filter(([, errors]) => errors.length > 0)
  .map(([category, errors]) => `- ${category}: ${errors.length}`)
  .join("\n")}
          `.trim(),
          screenId,
          runId,
          evidence: {
            total: summary.total,
            byType: summary.byType,
            byCategory: summary.byCategory,
            bySeverity: summary.bySeverity,
            topErrors: summary.topErrors.map((e) => ({
              type: e.errorType,
              severity: e.severity,
              message: e.message,
              category: e.category,
              fix: e.suggestedFix,
            })),
            relatedErrorGroups: related.map((group) => ({
              count: group.length,
              type: group[0].errorType,
              origin: group[0].originFunction,
            })),
          },
          stepsToReproduce: [...baseSteps, "Open the browser DevTools console.", `Observe: ${summary.total} console error(s) found`, `Most severe: ${summary.topErrors[0]?.message || "N/A"}`],
        })
      );
    }

    if (clientErrors.length) {
      const screenshotUrl = await screenshotNow();
      findings.push(
        recordBugFinding({
          source: "ui_exploratory",
          category: "api-status",
          severity: "high",
          title: `Client error loading ${screen.name}`,
          detail: clientErrors.map((e) => `HTTP ${e.status} — ${e.url}`).join("\n"),
          screenId,
          runId,
          evidence: { clientErrors },
          stepsToReproduce: [...baseSteps, `Observe: page load returned HTTP ${clientErrors[0].status}.`],
          screenshotUrl,
        })
      );
    }

    const criticalFailedRequests = failedRequests.filter((r) => !/favicon|analytics|tracking|google-analytics|doubleclick/i.test(r.url));
    if (criticalFailedRequests.length > 0) {
      const screenshotUrl = await screenshotNow();
      findings.push(
        recordBugFinding({
          source: "ui_exploratory",
          category: "api-status",
          severity: "medium",
          title: `Failed network request(s) on ${screen.name}`,
          detail: criticalFailedRequests.slice(0, 8).map((r) => `${r.error} — ${r.url}`).join("\n"),
          screenId,
          runId,
          evidence: { failedRequests: criticalFailedRequests.slice(0, 8) },
          stepsToReproduce: [...baseSteps, "Open DevTools Network tab.", `Observe: ${criticalFailedRequests.length} request(s) failed to load.`],
          screenshotUrl,
        })
      );
    }

    const emptyBody = await page.locator("body").evaluate((el) => (el.textContent || "").trim().length < 20).catch(() => false);
    if (emptyBody) {
      const screenshotUrl = await screenshotNow();
      findings.push(
        recordBugFinding({
          source: "ui_exploratory",
          category: "ui-dom",
          severity: "high",
          title: `${screen.name} appears blank or nearly empty`,
          detail: "The page body has very little visible text after load — the page may be broken or failed to render content.",
          screenId,
          runId,
          evidence: { emptyBody: true },
          stepsToReproduce: [...baseSteps, "Observe: the page body is blank or shows almost no content."],
          screenshotUrl,
        })
      );
    }

    // Deeper Bug Detection #4: DOM-level checks (zero-size w/ content, overlapping
    // interactive elements, text overflow, off-viewport) -- one extra
    // page.evaluate() pass on the already-loaded page, no extra navigation.
    const domIssues = await runDomChecks(page);
    for (const issue of domIssues) {
      const screenshotUrl = await screenshotNow();
      findings.push(
        recordBugFinding({
          source: "ui_exploratory",
          category: "ui-dom",
          severity: issue.severity,
          title: `${issue.kind.replace(/_/g, " ")} on ${screen.name} (${viewport.name})`,
          detail: issue.message,
          screenId,
          runId,
          viewport: viewport.name,
          evidence: { kind: issue.kind, samples: issue.samples, count: issue.count },
          stepsToReproduce: [...baseSteps, `Observe: ${issue.message}`, `Examples: ${issue.samples.join("; ")}`],
          screenshotUrl,
        })
      );
    }

    // Deeper Bug Detection #2: validate each captured API response's schema
    // against its stored baseline and flag a 2xx-with-error-shaped-body
    // anomaly regardless of mode. Bodies captured here also feed the
    // UI-vs-API consistency check right below (same page load, same data).
    const capturedApiBodies = new Map<string, unknown>();
    for (const candidate of apiResponseCandidates.slice(0, 30)) {
      let body: unknown;
      try {
        body = await candidate.response.json();
      } catch {
        continue; // not a parseable JSON body -- nothing to validate
      }
      let pathname = candidate.response.url();
      try {
        pathname = new URL(candidate.response.url()).pathname;
      } catch {
        /* keep the full URL as a fallback path */
      }
      const endpointKey = `${candidate.method} ${pathname}`;
      capturedApiBodies.set(endpointKey, body);
      findings.push(
        ...checkAndRecordApiResponse({
          method: candidate.method,
          path: pathname,
          status: candidate.response.status(),
          body,
          screenId,
          runId,
        })
      );
    }

    // Deeper Bug Detection #6: declarative UI-count-vs-API-count rules, checked
    // against the bodies just captured for this same page load.
    if (screenId && (options?.checkUiApiConsistency ?? true) && capturedApiBodies.size > 0) {
      findings.push(...(await checkUiApiConsistency(page, screenId, screen.name, capturedApiBodies, runId)));
    }

    // Deeper Bug Detection #3: pixel-diff against this screen's stored baseline
    // for this viewport, if one has been saved (screensService.saveVisualBaseline).
    // No baseline yet -- nothing to compare against, not itself a finding.
    if (screenId) {
      try {
        const currentScreenshot = await page.screenshot({ fullPage: true });
        const diff = compareScreenshotToBaseline(screenId, currentScreenshot, {
          viewportName: viewport.name,
          thresholdPercent: getVisualDiffThresholdPercent(),
        });
        if (diff.hasBaseline && diff.visualChangeDetected) {
          const screenshotUrl = diff.diffImage ? saveUploadFile(diff.diffImage, ".png") : await screenshotNow();
          findings.push(
            recordBugFinding({
              source: "ui_exploratory",
              category: "ui-visual",
              severity: (diff.diffPercentage ?? 0) > 25 ? "high" : "medium",
              title: `Visual regression on ${screen.name} (${viewport.name}): ${diff.diffPercentage}% of pixels differ`,
              detail: `Pixel diff against the stored baseline is ${diff.diffPercentage}%, above the configured threshold of ${diff.thresholdPercent}%.`,
              screenId,
              runId,
              viewport: viewport.name,
              evidence: { diffPercentage: diff.diffPercentage, thresholdPercent: diff.thresholdPercent, dimensions: diff.dimensions },
              stepsToReproduce: [
                ...baseSteps,
                `Compare against the saved visual baseline for this screen (${viewport.name}).`,
                `Observe: ${diff.diffPercentage}% of pixels differ (threshold: ${diff.thresholdPercent}%). See the attached diff image.`,
              ],
              screenshotUrl,
            })
          );
        }
      } catch {
        // Visual diff is supplementary evidence -- never fail the scan over it.
      }
    }
  } finally {
    await context.close();
    if (findings.length > 0) {
      try {
        const videoPath = await page.video()?.path();
        if (videoPath && fs.existsSync(videoPath)) {
          const fileName = path.basename(videoPath);
          attachVideoToFindings(findings, `/uploads/${fileName}`);
        }
      } catch {
        // Video capture is best-effort supplementary evidence -- never fail the scan over it.
      }
    } else {
      // No findings -- discard the recording rather than accumulating disk usage for clean scans.
      try {
        const videoPath = await page.video()?.path();
        if (videoPath && fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
      } catch {
        /* best-effort cleanup */
      }
    }
    await browser.close();
  }
  return findings;
}

// Orchestrator: run the exploratory UI scan for a single cataloged Screen.
// Called automatically right after an execution run completes (see
// executionService.runExecution) and available on demand via POST /api/bugs/scan.
export async function runBugScanForScreen(screenId: string, runId?: string, options?: ScanScreenOptions): Promise<BugFindingRow[]> {
  const screen = getScreen(screenId) as { id: string; name: string; url_or_path: string | null } | undefined;
  if (!screen) throw new Error("Screen not found.");
  return scanScreenForUiBugs(screen, runId, screenId, options);
}

async function checkBrokenInternalLinks(
  page: import("playwright").Page,
  pageUrl: string
): Promise<Array<{ url: string; label: string; status: number }>> {
  const origin = originOf(pageUrl);
  if (!origin) return [];

  const links = await page
    .evaluate(() =>
      Array.from(document.querySelectorAll("a[href]"))
        .map((a) => ({
          href: (a as HTMLAnchorElement).href,
          label: (a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60),
        }))
        .filter((l) => l.href.startsWith("http"))
    )
    .catch(() => [] as Array<{ href: string; label: string }>);

  const sameOriginLinks = links.filter((l) => {
    try {
      return new URL(l.href).origin === origin && !l.href.includes("#");
    } catch {
      return false;
    }
  });

  const broken: Array<{ url: string; label: string; status: number }> = [];
  const checked = new Set<string>();
  for (const link of sameOriginLinks.slice(0, 15)) {
    if (checked.has(link.href)) continue;
    checked.add(link.href);
    try {
      const res = await page.request.get(link.href, { timeout: 8000 });
      if (res.status() >= 400) broken.push({ url: link.href, label: link.label || link.href, status: res.status() });
    } catch {
      broken.push({ url: link.href, label: link.label || link.href, status: 0 });
    }
  }
  return broken;
}

export function fileSpellingFindings(screenId: string, screenName: string, issues: SpellingIssue[]): BugFindingRow[] {
  const findings: BugFindingRow[] = [];
  const seen = new Set<string>();
  for (const issue of issues.slice(0, 20)) {
    const key = `${issue.word}::${issue.context}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push(
      recordBugFinding({
        source: "ui_exploratory",
        category: "ui-dom",
        severity: "low",
        title: `Spelling issue on ${screenName}: "${issue.word}"`,
        detail: `Misspelled "${issue.word}" in ${issue.context}${issue.suggestions?.[0] ? ` (suggested: "${issue.suggestions[0]}")` : ""}`,
        screenId,
        evidence: { issue },
        stepsToReproduce: [
          `Navigate to the screen: ${screenName}`,
          `Look for the text in context: ${issue.context}`,
          `Observe the misspelling "${issue.word}"`,
        ],
      })
    );
  }
  return findings;
}

// After a crawl completes: scan every cataloged page for UI bugs, file spelling
// issues captured during crawl, and fuzz API endpoints observed in network capture.
export async function runPostCrawlBugScan(
  siteId: string,
  opts?: { changeStatuses?: string[] }
): Promise<BugFindingRow[]> {
  const site = db.prepare("SELECT * FROM crawl_sites WHERE id = ?").get(siteId) as { url: string } | undefined;
  if (!site) return [];

  let pages = db.prepare("SELECT * FROM crawl_pages WHERE site_id = ? AND change_status != 'removed'").all(siteId) as any[];
  if (opts?.changeStatuses?.length) {
    const allowed = new Set(opts.changeStatuses);
    pages = pages.filter((p) => allowed.has(p.change_status));
  }

  const allFindings: BugFindingRow[] = [];
  const apiTemplates = new Set<string>();

  for (const page of pages) {
    const screen = db
      .prepare("SELECT id, name, url_or_path FROM screens WHERE url_or_path = ? OR url_or_path = ? ORDER BY updated_at DESC LIMIT 1")
      .get(page.url, normalizeUrl(page.url)) as { id: string; name: string; url_or_path: string } | undefined;

    const screenId = screen?.id ?? null;
    const screenName = screen?.name ?? (page.title || page.url);
    const scanTarget = { id: screenId ?? `page-${page.id}`, name: screenName, url_or_path: page.url };

    const spellingIssues: SpellingIssue[] = JSON.parse(page.spelling_issues_json || "[]");
    if (spellingIssues.length && screenId) allFindings.push(...fileSpellingFindings(screenId, screenName, spellingIssues));

    const uiFindings = await scanScreenForUiBugs(scanTarget, undefined, screenId);
    allFindings.push(...uiFindings);

    // Deeper Bug Detection #5: also re-scan at mobile/tablet viewport sizes for
    // every cataloged screen touched by this crawl (desktop is the scan above).
    if (screenId) {
      const responsiveFindings = await runResponsiveBugScan(screenId).catch(() => [] as BugFindingRow[]);
      allFindings.push(...responsiveFindings);
    }

    const apis = JSON.parse(page.apis_json || "[]") as Array<{ method: string; endpoint: string }>;
    for (const api of apis) {
      if (api.endpoint.includes(":id") || /\/\d+/.test(api.endpoint)) {
        apiTemplates.add(api.endpoint);
      }
    }
  }

  if (apiTemplates.size > 0) {
    const fuzzed = await fuzzApiEndpoints(site.url, Array.from(apiTemplates).slice(0, 10));
    allFindings.push(...fuzzed);
  }

  return allFindings;
}
