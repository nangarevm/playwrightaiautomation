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
import { getScreen } from "./screensService.js";
import { fileGenericBug } from "./integrationsService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, "..", "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export type BugSeverity = "critical" | "high" | "medium" | "low";
export type BugSource = "ui_exploratory" | "api_fuzz" | "regression";

export interface BugFindingInput {
  source: BugSource;
  severity: BugSeverity;
  title: string;
  detail: string;
  screenId?: string | null;
  runId?: string | null;
  evidence?: Record<string, any>;
  stepsToReproduce?: string[];
  screenshotUrl?: string | null;
  videoUrl?: string | null;
}

export interface BugFindingRow {
  id: string;
  source: BugSource;
  severity: BugSeverity;
  title: string;
  detail: string;
  screen_id: string | null;
  run_id: string | null;
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
    severity: input.severity,
    title: input.title,
    detail: input.detail,
    screen_id: input.screenId ?? null,
    run_id: input.runId ?? null,
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
    INSERT INTO bug_findings (id, source, severity, title, detail, screen_id, run_id, evidence, steps_to_reproduce, screenshot_url, video_url, status, created_at, updated_at)
    VALUES (@id, @source, @severity, @title, @detail, @screen_id, @run_id, @evidence, @steps_to_reproduce, @screenshot_url, @video_url, @status, @created_at, @updated_at)
  `).run(row);
  return row;
}

export function listBugFindings(filter?: { status?: string; severity?: string; screenId?: string }): BugFindingRow[] {
  const clauses: string[] = [];
  const params: Record<string, string> = {};
  if (filter?.status) { clauses.push("status = @status"); params.status = filter.status; }
  if (filter?.severity) { clauses.push("severity = @severity"); params.severity = filter.severity; }
  if (filter?.screenId) { clauses.push("screen_id = @screen_id"); params.screen_id = filter.screenId; }
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

// UI exploratory scan: load a cataloged Screen's URL headlessly and watch for
// the same class of bug a manual exploratory tester would catch by just
// looking at the page -- console/page errors, failed network calls, broken
// images, a load spinner that never resolves. The whole session is screen-
// recorded (attached to every finding from this scan) and each individual
// finding also gets its own screenshot taken at the moment it's detected.
export async function scanScreenForUiBugs(screen: { id: string; name: string; url_or_path: string | null }, runId?: string): Promise<BugFindingRow[]> {
  if (!screen.url_or_path) return [];
  const findings: BugFindingRow[] = [];
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    recordVideo: { dir: UPLOAD_DIR, size: { width: 1280, height: 800 } },
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
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const serverErrors: Array<{ url: string; status: number }> = [];

    page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 300)); });
    page.on("pageerror", (err) => pageErrors.push(err.message.slice(0, 300)));
    page.on("response", (res) => { if (res.status() >= 500) serverErrors.push({ url: res.url(), status: res.status() }); });

    const baseSteps = [
      `Navigate to: ${screen.url_or_path}`,
      "Wait for the page to finish loading (network idle).",
    ];

    try {
      await page.goto(screen.url_or_path, { waitUntil: "networkidle", timeout: 15000 });
    } catch (navErr: any) {
      const screenshotUrl = await screenshotNow();
      const finding = recordBugFinding({
        source: "ui_exploratory",
        severity: "critical",
        title: `${screen.name} failed to load`,
        detail: `Navigating to ${screen.url_or_path} did not complete: ${navErr.message}`,
        screenId: screen.id,
        runId,
        evidence: { url: screen.url_or_path, error: navErr.message },
        stepsToReproduce: [...baseSteps, `Observe: navigation never completes -- ${navErr.message}`],
        screenshotUrl,
      });
      findings.push(finding);
      autoFileIfSevere(finding);
      return findings;
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
        severity: "critical",
        title: `Server error(s) while loading ${screen.name}`,
        detail: serverErrors.map((e) => `HTTP ${e.status} — ${e.url}`).join("\n"),
        screenId: screen.id,
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
        severity: "high",
        title: `JavaScript error on ${screen.name}`,
        detail: pageErrors.join("\n"),
        screenId: screen.id,
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
          severity: "medium",
          title: `Broken image(s) on ${screen.name}`,
          detail: brokenImages.join("\n"),
          screenId: screen.id,
          runId,
          evidence: { brokenImages },
          stepsToReproduce: [...baseSteps, `Observe: the following image(s) fail to load (broken/404): ${brokenImages.join(", ")}`],
          screenshotUrl,
        })
      );
    }
    if (stuckSpinners > 0) {
      const screenshotUrl = await screenshotNow();
      findings.push(
        recordBugFinding({
          source: "ui_exploratory",
          severity: "medium",
          title: `Stuck loading indicator on ${screen.name}`,
          detail: `${stuckSpinners} loading indicator(s) still animating ${SPINNER_GRACE_MS}ms after the page reported idle.`,
          screenId: screen.id,
          runId,
          evidence: { stuckSpinners },
          stepsToReproduce: [...baseSteps, `Wait an additional ${SPINNER_GRACE_MS}ms.`, `Observe: ${stuckSpinners} spinner/progress indicator(s) still animating instead of resolving.`],
          screenshotUrl,
        })
      );
    }
    if (consoleErrors.length) {
      findings.push(
        recordBugFinding({
          source: "ui_exploratory",
          severity: "low",
          title: `Console error(s) on ${screen.name}`,
          detail: consoleErrors.slice(0, 10).join("\n"),
          screenId: screen.id,
          runId,
          evidence: { consoleErrors: consoleErrors.slice(0, 10) },
          stepsToReproduce: [...baseSteps, "Open the browser DevTools console.", `Observe: ${consoleErrors[0]}`],
        })
      );
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
export async function runBugScanForScreen(screenId: string, runId?: string): Promise<BugFindingRow[]> {
  const screen = getScreen(screenId) as { id: string; name: string; url_or_path: string | null } | undefined;
  if (!screen) throw new Error("Screen not found.");
  return scanScreenForUiBugs(screen, runId);
}
