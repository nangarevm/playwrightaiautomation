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
import { getScreen, compareScreenshotToBaseline, prepareForVisualCapture, getVisualIgnoreSelectors } from "./screensService.js";
import { fileGenericBug } from "./integrationsService.js";
import type { SpellingIssue } from "../crawler/types.js";
import { originOf, normalizeUrl } from "../crawler/urlUtils.js";
import { isLikelyApiResponse } from "../crawler/network.js";
import { analyzeVisualDifferences, detectImageLoadingIssues, detectTextRenderingIssues } from "./visualDetectionService.js";
import { analyzeConsoleError, summarizeErrors, groupErrorsByCategory, detectRelatedErrors, type ConsoleError } from "./consoleErrorService.js";
import { validateInteraction, validateInteractionSequence, detectInteractionPatterns, type InteractionEvent } from "./interactionValidationService.js";
import { checkAndRecordApiResponse } from "./apiSchemaService.js";
import { runDomChecks, getDomCheckIgnoreSelectors } from "./domChecksService.js";
import { checkUiApiConsistency } from "./uiApiConsistencyService.js";
import { getVisualDiffThresholdPercent, getMaxDuplicateRequests } from "./adminService.js";
import { runResponsiveBugScan } from "./responsiveService.js";
import { computeFingerprint } from "./bugFingerprintService.js";
import { correlateFindings } from "./bugCorrelationService.js";
import { scoreConfidence, derivePriority, type BugPriority } from "./bugConfidenceService.js";

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
  // Phase 1B: correlation/dedup/confidence skeleton -- see bugFingerprintService.ts,
  // bugCorrelationService.ts, bugConfidenceService.ts.
  fingerprint: string | null;
  correlation_group_id: string | null;
  confidence_score: number | null;
  priority: BugPriority | null;
  reproducibility_attempts: number;
  reproducibility_successes: number;
  root_cause_narrative: string | null;
  root_cause_is_inferred: number;
  environment_info_json: string | null;
}

// Every scan that hits the same underlying defect (the same screen +
// category + endpoint + normalized message -- see bugFingerprintService)
// bumps this existing row's reproducibility counters instead of inserting a
// new row, so a repeat scan of the same page doesn't multiply bug_findings
// rows for one recurring bug. A 'resolved' finding that recurs is reopened
// (it came back); an 'ignored' finding stays ignored (the human explicitly
// suppressed it) but its reproducibility counters still advance, so the
// suppression decision remains visible as informed rather than stale.
function bumpReproducibility(existing: BugFindingRow): BugFindingRow {
  const now = new Date().toISOString();
  const attempts = (existing.reproducibility_attempts ?? 1) + 1;
  const successes = (existing.reproducibility_successes ?? 1) + 1;
  const nextStatus = existing.status === "resolved" ? "open" : existing.status;
  const confidenceScore = scoreConfidence({
    category: existing.category,
    severity: existing.severity,
    evidence: existing.evidence,
    reproducibility_attempts: attempts,
    reproducibility_successes: successes,
  });
  const priority = derivePriority(existing.severity, confidenceScore);
  db.prepare(
    "UPDATE bug_findings SET reproducibility_attempts = ?, reproducibility_successes = ?, status = ?, confidence_score = ?, priority = ?, updated_at = ? WHERE id = ?"
  ).run(attempts, successes, nextStatus, confidenceScore, priority, now, existing.id);
  return getBugFinding(existing.id)!;
}

export function recordBugFinding(input: BugFindingInput): BugFindingRow {
  const fingerprint = computeFingerprint({
    screenId: input.screenId,
    category: input.category,
    title: input.title,
    detail: input.detail,
    evidence: input.evidence,
  });

  const existing = db.prepare("SELECT * FROM bug_findings WHERE fingerprint = ? ORDER BY created_at DESC LIMIT 1").get(fingerprint) as BugFindingRow | undefined;
  if (existing) return bumpReproducibility(existing);

  const id = nanoid(10);
  const now = new Date().toISOString();
  const evidenceJson = JSON.stringify(input.evidence ?? {});
  const confidenceScore = scoreConfidence({
    category: input.category ?? null,
    severity: input.severity,
    evidence: evidenceJson,
    reproducibility_attempts: 1,
    reproducibility_successes: 1,
  });
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
    evidence: evidenceJson,
    steps_to_reproduce: JSON.stringify(input.stepsToReproduce ?? []),
    screenshot_url: input.screenshotUrl ?? null,
    video_url: input.videoUrl ?? null,
    status: "open",
    filed_provider: null,
    filed_external_id: null,
    created_at: now,
    updated_at: now,
    fingerprint,
    correlation_group_id: null,
    confidence_score: confidenceScore,
    priority: derivePriority(input.severity, confidenceScore),
    reproducibility_attempts: 1,
    reproducibility_successes: 1,
    root_cause_narrative: null,
    root_cause_is_inferred: 0,
    environment_info_json: null,
  };
  db.prepare(`
    INSERT INTO bug_findings (
      id, source, category, severity, title, detail, screen_id, run_id, viewport, evidence, steps_to_reproduce,
      screenshot_url, video_url, status, created_at, updated_at, fingerprint, correlation_group_id,
      confidence_score, priority, reproducibility_attempts, reproducibility_successes,
      root_cause_narrative, root_cause_is_inferred, environment_info_json
    )
    VALUES (
      @id, @source, @category, @severity, @title, @detail, @screen_id, @run_id, @viewport, @evidence, @steps_to_reproduce,
      @screenshot_url, @video_url, @status, @created_at, @updated_at, @fingerprint, @correlation_group_id,
      @confidence_score, @priority, @reproducibility_attempts, @reproducibility_successes,
      @root_cause_narrative, @root_cause_is_inferred, @environment_info_json
    )
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

// Phase 1 config: every tunable value for console/network capture lives here,
// not scattered as inline magic numbers/regex. Edit this object directly (no
// separate config file exists yet in this codebase -- every other tunable in
// this service, e.g. adminService's confidence thresholds, is also a constant
// or a DB-backed setting, not a file, so this follows that precedent) to
// adjust behavior for your site without touching the scan logic below.
export const BUG_SCAN_CONFIG = {
  // How long to wait after the page reports network-idle before checking
  // whether a loading spinner is still animating (some spinners take a
  // moment to naturally resolve after idle).
  spinnerGraceMs: 1500,
  // Max time to wait for initial navigation before treating it as a failed load.
  navTimeoutMs: 30000,

  // URL substrings/patterns excluded from EVERY network-based finding in this
  // file (server/client errors, failed requests, broken links) -- known
  // third-party noise that isn't your app's own bug. The default list below
  // is a reasonable starting point (ad/analytics beacons, favicon probes);
  // add your own site's known-noisy third-party calls (chat widgets, feature-
  // flag probes that 404 by design, etc.) rather than us guessing what's
  // noisy for your specific app.
  ignoredUrlPatterns: [/favicon/i, /analytics/i, /tracking/i, /google-analytics/i, /doubleclick/i] as RegExp[],

  // Message substrings/patterns excluded from console-error and uncaught-
  // exception findings. The one default entry below is NOT an app-specific
  // guess -- it's a universal Chromium behavior confirmed by live testing
  // against a fixture page: Chromium auto-echoes every failed network
  // request into the console as "Failed to load resource: ... status of
  // NNN", which would otherwise double-report the exact same defect the
  // response listener above already captures more precisely (with the real
  // status code and resource type) as an api-status finding. Beyond that,
  // we have no visibility into which OTHER console messages your app logs
  // as expected noise (a third-party widget logging via console.error, a
  // benign framework warning), so per the ground rule "don't guess a
  // default silently," nothing app-specific is pre-added here -- add your
  // own as you discover them, e.g. `/ResizeObserver loop limit exceeded/i`
  // (a well-known Chrome no-op warning many sites see and ignore).
  ignoredConsolePatterns: [/^Failed to load resource: the server responded with a status of \d+/i] as RegExp[],

  // Phase 1 hardening: identical (method+path) XHR/fetch calls within one page
  // visit at or above this count are flagged as a likely duplicate/excessive-
  // request bug (a polling storm, a re-render loop refiring the same fetch on
  // every state change). Reads the live org_settings value at scan time via
  // adminService.getMaxDuplicateRequests() (see the response listener below) --
  // this constant is only the fallback used if that lookup ever throws.
  maxDuplicateRequestsFallback: 5,
};

function isIgnoredUrl(url: string): boolean {
  return BUG_SCAN_CONFIG.ignoredUrlPatterns.some((p) => p.test(url));
}

function isIgnoredConsoleMessage(message: string): boolean {
  return BUG_SCAN_CONFIG.ignoredConsolePatterns.some((p) => p.test(message));
}

const SPINNER_GRACE_MS = BUG_SCAN_CONFIG.spinnerGraceMs;
const SCAN_NAV_TIMEOUT_MS = BUG_SCAN_CONFIG.navTimeoutMs;

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
  // SCAN_CHROMIUM_PATH is an optional escape hatch for a Chromium binary at a
  // non-standard path (e.g. a deployment that pins its own browser build) --
  // undefined by default, which preserves Playwright's normal auto-resolution
  // for everyone who hasn't set it.
  const browser = await chromium.launch({ headless: true, executablePath: process.env.SCAN_CHROMIUM_PATH || undefined });
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
    const clientErrors: Array<{ url: string; status: number; resourceType: string }> = [];
    const failedRequests: Array<{ url: string; error: string }> = [];
    // Deeper Bug Detection #2: candidate XHR/fetch responses worth validating
    // as API calls -- the response body is read after the page settles (below),
    // not inline in this listener, so a slow/streaming body never blocks or
    // races the rest of the scan.
    const apiResponseCandidates: Array<{ response: import("playwright").Response; method: string }> = [];
    // Phase 1 hardening: unhandled promise rejections, captured as their own
    // signal rather than folded indiscriminately into the generic pageerror
    // bucket below -- a rejected promise nobody awaited/caught is a distinct,
    // very common real-world JS bug (a fire-and-forget async call whose
    // failure is silently swallowed) worth naming specifically in a root-cause
    // narrative instead of being reported as an undifferentiated "JavaScript
    // error". Chromium's own pageerror event ALSO fires for the same
    // rejection (CDP reports both via the same Runtime.exceptionThrown
    // mechanism), so pageErrors is filtered below to exclude anything already
    // captured here -- otherwise the same defect would produce two findings.
    const unhandledRejections: string[] = [];
    // Phase 1 hardening: count identical (method+path) XHR/fetch calls made
    // during this one page visit, to flag a likely polling-storm/re-render-
    // loop bug (see the duplicate-request check after the page settles below).
    const apiCallCounts = new Map<string, number>();

    await page.exposeFunction("__reportUnhandledRejection", (message: string) => {
      unhandledRejections.push(String(message).slice(0, 300));
    });
    await page.addInitScript(() => {
      window.addEventListener("unhandledrejection", (event) => {
        const reason: any = (event as any).reason;
        const message = reason && reason.message ? String(reason.message) : String(reason);
        // @ts-ignore -- installed by page.exposeFunction above
        if (typeof window.__reportUnhandledRejection === "function") window.__reportUnhandledRejection(message);
      });
    });

    page.on("console", (msg) => {
      if (msg.type() === "error") {
        const message = msg.text().slice(0, 500);
        if (isIgnoredConsoleMessage(message)) return;
        consoleErrors.push({
          type: (msg.type() as any) || "error",
          message,
          source: msg.location()?.url,
          line: msg.location()?.lineNumber,
          column: msg.location()?.columnNumber,
          timestamp: Date.now(),
        });
      }
    });
    page.on("pageerror", (err) => {
      const message = err.message.slice(0, 300);
      if (isIgnoredConsoleMessage(message)) return;
      pageErrors.push(message);
    });
    page.on("response", (res) => {
      if (!isIgnoredUrl(res.url())) {
        if (res.status() >= 500) {
          serverErrors.push({ url: res.url(), status: res.status() });
        } else if (res.status() >= 400) {
          const resourceType = res.request().resourceType();
          // "image" is deliberately excluded here -- a broken image is already
          // caught more informatively by the naturalWidth===0 DOM check below
          // (category ui-dom), which points at the actual <img> element rather
          // than a bare URL. Flagging it again here would double-report the
          // same underlying issue under two categories.
          if (resourceType !== "image") {
            clientErrors.push({ url: res.url(), status: res.status(), resourceType });
          }
        }
      }
      const req = res.request();
      const resourceType = req.resourceType();
      if (resourceType === "xhr" || resourceType === "fetch") {
        const method = req.method().toUpperCase();
        let pathname = res.url();
        try {
          pathname = new URL(res.url()).pathname;
        } catch {
          /* keep the full URL as a fallback key */
        }
        const callKey = `${method} ${pathname}`;
        apiCallCounts.set(callKey, (apiCallCounts.get(callKey) ?? 0) + 1);
        if (isLikelyApiResponse(res.headers()["content-type"] || "", res.url())) {
          apiResponseCandidates.push({ response: res, method });
        }
      }
    });
    page.on("requestfailed", (req) => {
      if (isIgnoredUrl(req.url())) return;
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
        viewport: viewport.name,
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
        viewport: viewport.name,
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
        viewport: viewport.name,
        evidence: { serverErrors },
        stepsToReproduce: [...baseSteps, `Observe: ${serverErrors.length} request(s) returned a 5xx server error -- see the response network tab for ${serverErrors.map((e) => e.url).join(", ")}`],
        screenshotUrl,
      });
      findings.push(finding);
      autoFileIfSevere(finding);
    }
    // Only report a pageerror as a generic "JavaScript error" if it wasn't
    // already captured more specifically as an unhandled promise rejection
    // above -- see the unhandledRejections listener setup for why the same
    // underlying event can otherwise surface through both channels.
    const genericPageErrors = pageErrors.filter(
      (m) => !unhandledRejections.some((u) => m.includes(u) || u.includes(m))
    );
    if (genericPageErrors.length) {
      const screenshotUrl = await screenshotNow();
      const finding = recordBugFinding({
        source: "ui_exploratory",
        category: "console-error",
        severity: "high",
        title: `JavaScript error on ${screen.name}`,
        detail: genericPageErrors.join("\n"),
        screenId,
        runId,
        viewport: viewport.name,
        evidence: { pageErrors: genericPageErrors },
        stepsToReproduce: [...baseSteps, "Observe: an uncaught JavaScript exception is thrown -- open the browser console to see it.", `Error message: ${genericPageErrors[0]}`],
        screenshotUrl,
      });
      findings.push(finding);
      autoFileIfSevere(finding);
    }
    if (unhandledRejections.length) {
      const screenshotUrl = await screenshotNow();
      const finding = recordBugFinding({
        source: "ui_exploratory",
        category: "console-error",
        severity: "high",
        title: `Unhandled promise rejection on ${screen.name}`,
        detail: unhandledRejections.join("\n"),
        screenId,
        runId,
        viewport: viewport.name,
        evidence: { unhandledRejections },
        stepsToReproduce: [
          ...baseSteps,
          "Observe: a promise rejects and nothing awaits/catches it -- open the browser console to see it.",
          `Rejection reason: ${unhandledRejections[0]}`,
        ],
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
          viewport: viewport.name,
          evidence: { brokenImages },
          stepsToReproduce: [...baseSteps, `Observe: the following image(s) fail to load (broken/404): ${brokenImages.join(", ")}`],
          screenshotUrl,
        })
      );
    }

    const brokenLinks = await checkBrokenInternalLinks(page, screen.url_or_path);
    if (brokenLinks.length) {
      const screenshotUrl = await screenshotNow();
      // Severity scales with the worst status code found in the batch, same
      // tiering as the main-document check above: a 5xx (server-side crash)
      // is worse than a 4xx (broken/moved link), and an unreachable link
      // (status 0 -- request threw, e.g. DNS/connection failure) is worst.
      const worstStatus = Math.min(...brokenLinks.map((l) => (l.status === 0 ? -1 : l.status)));
      const brokenLinksSeverity: BugSeverity = worstStatus === -1 || worstStatus >= 500 ? "high" : "medium";
      findings.push(
        recordBugFinding({
          source: "ui_exploratory",
          category: "api-status",
          severity: brokenLinksSeverity,
          title: `Broken internal link(s) on ${screen.name}`,
          detail: brokenLinks.map((l) => `HTTP ${l.status} — ${l.url} (${l.label})`).join("\n"),
          screenId,
          runId,
          viewport: viewport.name,
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
          viewport: viewport.name,
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
          viewport: viewport.name,
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
      const hasDocumentError = clientErrors.some((e) => e.resourceType === "document");
      findings.push(
        recordBugFinding({
          source: "ui_exploratory",
          category: "api-status",
          severity: "high",
          title: hasDocumentError ? `Client error loading ${screen.name}` : `${clientErrors.length} failed API/resource request(s) on ${screen.name}`,
          detail: clientErrors.map((e) => `HTTP ${e.status} (${e.resourceType}) — ${e.url}`).join("\n"),
          screenId,
          runId,
          viewport: viewport.name,
          evidence: { clientErrors },
          stepsToReproduce: [
            ...baseSteps,
            `Observe: ${clientErrors.length} request(s) returned a 4xx client error -- ${clientErrors.map((e) => `HTTP ${e.status} on ${e.url}`).join("; ")}`,
          ],
          screenshotUrl,
        })
      );
    }

    // Phase 1 hardening: identical (method+path) XHR/fetch calls repeated
    // above the configured threshold in one page visit -- a likely polling
    // storm or a re-render loop refiring the same fetch on every state
    // change. False-positive risk: legitimate short-interval polling
    // (a live dashboard, a status-check loop) will trip this by design --
    // raise org_settings.max_duplicate_requests (adminService.
    // setMaxDuplicateRequests) for screens that intentionally poll.
    const duplicateThreshold = (() => {
      try {
        return getMaxDuplicateRequests();
      } catch {
        return BUG_SCAN_CONFIG.maxDuplicateRequestsFallback;
      }
    })();
    const duplicateCalls = Array.from(apiCallCounts.entries()).filter(([, count]) => count >= duplicateThreshold);
    if (duplicateCalls.length) {
      const screenshotUrl = await screenshotNow();
      findings.push(
        recordBugFinding({
          source: "ui_exploratory",
          category: "api-status",
          severity: "medium",
          title: `Duplicate/excessive API call(s) on ${screen.name}`,
          detail: duplicateCalls.map(([key, count]) => `${key} was called ${count} times in one page visit`).join("\n"),
          screenId,
          runId,
          viewport: viewport.name,
          evidence: { duplicateCalls: duplicateCalls.map(([callKey, count]) => ({ callKey, count })), threshold: duplicateThreshold },
          stepsToReproduce: [
            ...baseSteps,
            `Open DevTools Network tab and filter by XHR/Fetch.`,
            `Observe: ${duplicateCalls.map(([key, count]) => `${key} fired ${count} times`).join("; ")} (threshold: ${duplicateThreshold}).`,
          ],
          screenshotUrl,
        })
      );
    }

    // Noise filtering already happened at capture time (the requestfailed
    // listener above skips BUG_SCAN_CONFIG.ignoredUrlPatterns), so every entry
    // reaching here is already a non-noise failure -- no second filter needed.
    const criticalFailedRequests = failedRequests;
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
          viewport: viewport.name,
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
          viewport: viewport.name,
          evidence: { emptyBody: true },
          stepsToReproduce: [...baseSteps, "Observe: the page body is blank or shows almost no content."],
          screenshotUrl,
        })
      );
    }

    // Deeper Bug Detection #4: DOM-level checks (zero-size w/ content, overlapping
    // interactive elements, text overflow, off-viewport) -- one extra
    // page.evaluate() pass on the already-loaded page, no extra navigation.
    const domIssues = await runDomChecks(page, screenId ? getDomCheckIgnoreSelectors(screenId) : []);
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
      let pathname = candidate.response.url();
      try {
        pathname = new URL(candidate.response.url()).pathname;
      } catch {
        /* keep the full URL as a fallback path */
      }
      let body: unknown;
      let jsonParseFailed = false;
      try {
        body = await candidate.response.json();
      } catch {
        jsonParseFailed = true; // handled explicitly below instead of silently skipping
      }
      if (jsonParseFailed) {
        // Phase 1 hardening: previously this candidate was silently dropped
        // (`continue`) whenever the body didn't parse as JSON, meaning an
        // endpoint that ADVERTISES a JSON content-type but returns malformed/
        // truncated JSON was never flagged as anything -- callers relying on
        // res.json() in production would crash with no corresponding finding
        // here. Only flag it when the response actually claimed to be JSON;
        // a non-JSON content-type failing to parse as JSON is expected, not a bug.
        const contentType = candidate.response.headers()["content-type"] || "";
        findings.push(
          ...checkAndRecordApiResponse({
            method: candidate.method,
            path: pathname,
            status: candidate.response.status(),
            body: undefined,
            contentType,
            jsonParseFailed: true,
            screenId,
            runId,
          })
        );
        continue;
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
        // Same masking as the baseline capture (screensService.saveVisualBaseline)
        // -- disable animations/transitions and hide any screen-specific
        // known-dynamic regions -- applied to THIS screenshot too, so both
        // sides of the diff treat known noise identically.
        await prepareForVisualCapture(page, getVisualIgnoreSelectors(screenId));
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

    // Phase 1B: correlate this scan's findings (rule-based grouping -- see
    // bugCorrelationService.correlateFindings's own false-positive-risk doc),
    // then re-score confidence for anything that got grouped, since
    // corroboration by an independent signal in the same scan is itself a
    // confidence-raising fact the initial per-finding score above couldn't
    // know at insert time (each finding was scored in isolation as it was recorded).
    if (findings.length > 1) {
      correlateFindings(findings);
      const now = new Date().toISOString();
      for (const finding of findings) {
        const refreshed = getBugFinding(finding.id);
        if (!refreshed || !refreshed.correlation_group_id) continue;
        const confidenceScore = scoreConfidence(
          { category: refreshed.category, severity: refreshed.severity, evidence: refreshed.evidence, reproducibility_attempts: refreshed.reproducibility_attempts, reproducibility_successes: refreshed.reproducibility_successes },
          { isCorrelated: true }
        );
        const priority = derivePriority(refreshed.severity, confidenceScore);
        db.prepare("UPDATE bug_findings SET confidence_score = ?, priority = ?, updated_at = ? WHERE id = ?").run(confidenceScore, priority, now, refreshed.id);
        finding.correlation_group_id = refreshed.correlation_group_id;
        finding.confidence_score = confidenceScore;
        finding.priority = priority;
        finding.updated_at = now;
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
    if (isIgnoredUrl(l.href)) return false;
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
