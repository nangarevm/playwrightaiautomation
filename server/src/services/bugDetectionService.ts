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
import crypto from "crypto";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import { nanoid } from "nanoid";
import { db } from "../db.js";
import { diffAgainstVisualBaseline, getScreen, saveVisualBaseline } from "./screensService.js";
import { fileGenericBug } from "./integrationsService.js";
import type { SpellingIssue } from "../crawler/types.js";
import { originOf, normalizeUrl } from "../crawler/urlUtils.js";
import { analyzeVisualDifferences, detectImageLoadingIssues, detectTextRenderingIssues } from "./visualDetectionService.js";
import { analyzeConsoleError, summarizeErrors, groupErrorsByCategory, detectRelatedErrors, type ConsoleError } from "./consoleErrorService.js";
import { validateInteraction, validateInteractionSequence, detectInteractionPatterns, type InteractionEvent } from "./interactionValidationService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, "..", "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export type BugSeverity = "critical" | "high" | "medium" | "low";
export type BugSource = "ui_exploratory" | "api_fuzz" | "regression";
export type RootCauseClassification =
  | "REAL_PRODUCT_BUG"
  | "REAL_API_BUG"
  | "REAL_UI_BUG"
  | "REAL_BUSINESS_LOGIC_BUG"
  | "REAL_SECURITY_BUG"
  | "REAL_DATA_BUG"
  | "REAL_PERFORMANCE_BUG"
  | "AUTOMATION_BUG"
  | "ENVIRONMENT_BUG"
  | "UNKNOWN_REQUIRES_INVESTIGATION";
export type BugPriority = "P0" | "P1" | "P2" | "P3";

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
  siteId?: string | null;
  rootCause?: RootCauseClassification;
  priority?: BugPriority;
  environment?: Record<string, any>;
  preconditions?: string[];
  testData?: Record<string, any>;
  expectedResult?: string;
  actualResult?: string;
  reproductionAttempts?: number;
  reproductionSuccesses?: number;
  validationStatus?: "candidate" | "confirmed" | "rejected";
  affectedScenarios?: string[];
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
  site_id: string | null;
  root_cause: RootCauseClassification;
  priority: BugPriority;
  environment_json: string;
  preconditions_json: string;
  test_data_json: string;
  expected_result: string | null;
  actual_result: string | null;
  reproduction_attempts: number;
  reproduction_successes: number;
  validation_status: "candidate" | "confirmed" | "rejected";
  fingerprint: string | null;
  occurrence_count: number;
  affected_scenarios_json: string;
  created_at: string;
  updated_at: string;
}

function inferRootCause(input: BugFindingInput): RootCauseClassification {
  if (input.rootCause) return input.rootCause;
  const text = `${input.title} ${input.detail}`.toLowerCase();
  if (input.source === "api_fuzz" || /\bapi\b|http \d{3}|endpoint|response/.test(text)) return "REAL_API_BUG";
  if (/authorization|forbidden|access control|permission|authentication bypass/.test(text)) return "REAL_SECURITY_BUG";
  if (/stale|incorrect total|calculation|duplicate record|persistence|database/.test(text)) return "REAL_DATA_BUG";
  if (/slow|timeout|stuck loading|performance/.test(text)) return "REAL_PERFORMANCE_BUG";
  if (/layout|overflow|viewport|contrast|focus|label|broken image|blank|not visible/.test(text)) return "REAL_UI_BUG";
  return "REAL_PRODUCT_BUG";
}

function priorityForSeverity(severity: BugSeverity): BugPriority {
  if (severity === "critical") return "P0";
  if (severity === "high") return "P1";
  if (severity === "medium") return "P2";
  return "P3";
}

function findingFingerprint(input: BugFindingInput, rootCause: RootCauseClassification): string {
  const evidence = input.evidence || {};
  const stableEvidence = String(
    evidence.url || evidence.endpoint || evidence.selector || evidence.errorType || evidence.status || ""
  )
    .toLowerCase()
    .replace(/[?#].*$/, "");
  const stableTitle = input.title
    .toLowerCase()
    .replace(/\(\d+\s+total\)/g, "")
    .replace(/\b\d{3,}\b/g, "#")
    .replace(/\s+/g, " ")
    .trim();
  return crypto
    .createHash("sha256")
    .update(`${rootCause}|${input.screenId || ""}|${stableTitle}|${stableEvidence}`)
    .digest("hex");
}

export function recordBugFinding(input: BugFindingInput): BugFindingRow {
  const now = new Date().toISOString();
  const rootCause = inferRootCause(input);
  const fingerprint = findingFingerprint(input, rootCause);
  const reproductionAttempts = Math.max(1, input.reproductionAttempts ?? 1);
  const reproductionSuccesses = Math.max(0, input.reproductionSuccesses ?? 1);
  const validationStatus =
    input.validationStatus ??
    (reproductionAttempts >= 2 && reproductionSuccesses >= 2 ? "confirmed" : "candidate");
  const affectedScenarios = Array.from(new Set(input.affectedScenarios || []));
  const existing = db
    .prepare("SELECT * FROM bug_findings WHERE fingerprint = ? AND status != 'resolved' ORDER BY created_at DESC LIMIT 1")
    .get(fingerprint) as BugFindingRow | undefined;

  if (existing) {
    const mergedScenarios = Array.from(
      new Set([...(JSON.parse(existing.affected_scenarios_json || "[]") as string[]), ...affectedScenarios])
    );
    const attempts = Number(existing.reproduction_attempts || 0) + reproductionAttempts;
    const successes = Number(existing.reproduction_successes || 0) + reproductionSuccesses;
    // Repeated automation failures are duplicates, not independent product
    // verification. Promotion to confirmed must come from an explicit probe.
    const mergedValidation =
      existing.validation_status === "confirmed" || validationStatus === "confirmed"
        ? "confirmed"
        : validationStatus === "rejected" && existing.validation_status !== "candidate"
          ? "rejected"
          : "candidate";
    db.prepare(`
      UPDATE bug_findings
      SET occurrence_count = occurrence_count + 1,
          reproduction_attempts = ?,
          reproduction_successes = ?,
          validation_status = ?,
          affected_scenarios_json = ?,
          evidence = ?,
          screenshot_url = COALESCE(?, screenshot_url),
          video_url = COALESCE(?, video_url),
          updated_at = ?
      WHERE id = ?
    `).run(
      attempts,
      successes,
      mergedValidation,
      JSON.stringify(mergedScenarios),
      JSON.stringify(input.evidence ?? {}),
      input.screenshotUrl ?? null,
      input.videoUrl ?? null,
      now,
      existing.id
    );
    return getBugFinding(existing.id)!;
  }

  const id = nanoid(10);
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
    site_id: input.siteId ?? null,
    root_cause: rootCause,
    priority: input.priority ?? priorityForSeverity(input.severity),
    environment_json: JSON.stringify(
      input.environment ?? {
        browser: "Chromium",
        os: process.platform,
        viewport: "1280x800",
        build: process.env.BUILD_VERSION || process.env.npm_package_version || "local",
      }
    ),
    preconditions_json: JSON.stringify(input.preconditions ?? []),
    test_data_json: JSON.stringify(input.testData ?? {}),
    expected_result: input.expectedResult ?? "The application should complete the user action without an application error.",
    actual_result: input.actualResult ?? input.detail,
    reproduction_attempts: reproductionAttempts,
    reproduction_successes: reproductionSuccesses,
    validation_status: validationStatus,
    fingerprint,
    occurrence_count: 1,
    affected_scenarios_json: JSON.stringify(affectedScenarios),
    created_at: now,
    updated_at: now,
  };
  db.prepare(`
    INSERT INTO bug_findings (
      id, source, severity, title, detail, screen_id, run_id, evidence,
      steps_to_reproduce, screenshot_url, video_url, status, root_cause,
      priority, environment_json, preconditions_json, test_data_json,
      expected_result, actual_result, reproduction_attempts,
      reproduction_successes, validation_status, fingerprint, occurrence_count,
      affected_scenarios_json, site_id, created_at, updated_at
    )
    VALUES (
      @id, @source, @severity, @title, @detail, @screen_id, @run_id, @evidence,
      @steps_to_reproduce, @screenshot_url, @video_url, @status, @root_cause,
      @priority, @environment_json, @preconditions_json, @test_data_json,
      @expected_result, @actual_result, @reproduction_attempts,
      @reproduction_successes, @validation_status, @fingerprint, @occurrence_count,
      @affected_scenarios_json, @site_id, @created_at, @updated_at
    )
  `).run(row);
  return row;
}

export function listBugFindings(filter?: {
  status?: string;
  severity?: string;
  screenId?: string;
  siteId?: string;
  validationStatus?: string;
}): BugFindingRow[] {
  if (filter?.siteId) {
    return listBugFindingsForSite(filter.siteId, filter);
  }
  const clauses: string[] = [];
  const params: Record<string, string> = {};
  if (filter?.status) { clauses.push("status = @status"); params.status = filter.status; }
  if (filter?.severity) { clauses.push("severity = @severity"); params.severity = filter.severity; }
  if (filter?.screenId) { clauses.push("screen_id = @screen_id"); params.screen_id = filter.screenId; }
  if (filter?.validationStatus) {
    clauses.push("validation_status = @validation_status");
    params.validation_status = filter.validationStatus;
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return db.prepare(`SELECT * FROM bug_findings ${where} ORDER BY created_at DESC`).all(params) as BugFindingRow[];
}

/** Crawl-time UI/API findings catalogued against screens for this site. */
export function listBugFindingsForSite(
  siteId: string,
  filter?: { status?: string; severity?: string; validationStatus?: string }
): BugFindingRow[] {
  const params: Record<string, string> = { siteId };
  if (filter?.status) params.status = filter.status;
  if (filter?.severity) params.severity = filter.severity;
  if (filter?.validationStatus) {
    params.validation_status = filter.validationStatus;
  }
  return db
    .prepare(
      `SELECT DISTINCT b.* FROM bug_findings b
       LEFT JOIN screens s ON s.id = b.screen_id
       WHERE (b.site_id = @siteId OR s.source_input_id = @siteId)
         ${filter?.status ? "AND b.status = @status" : ""}
         ${filter?.severity ? "AND b.severity = @severity" : ""}
         ${filter?.validationStatus ? "AND b.validation_status = @validation_status" : ""}
       ORDER BY b.created_at DESC`
    )
    .all(params) as BugFindingRow[];
}

export interface QaDashboard {
  totalScenariosExecuted: number;
  totalWorkflowsExecuted: number;
  totalApiCallsAnalyzed: number;
  totalUiStatesAnalyzed: number;
  totalRealBugs: number;
  criticalBugs: number;
  highBugs: number;
  mediumBugs: number;
  lowBugs: number;
  automationFailures: number;
  environmentFailures: number;
  duplicateIssues: number;
  falsePositivesRejected: number;
  unknownRequiresInvestigation: number;
}

export function getQaDashboard(siteId?: string): QaDashboard {
  const siteJoin = ` JOIN automation_scripts a ON a.id = er.script_id
        JOIN test_cases tc ON tc.id = a.test_case_id
        ${siteId ? "LEFT JOIN screens s ON s.id = tc.screen_id" : ""}`;
  const siteWhere = siteId ? " WHERE s.source_input_id = @siteId" : "";
  const params = siteId ? { siteId } : {};
  const execution = db
    .prepare(`
      SELECT
        COUNT(DISTINCT er.id) AS scenarios,
        COUNT(DISTINCT CASE WHEN lower(tc.title) LIKE '%end-to-end%' OR lower(tc.title) LIKE '%journey%' THEN er.id END) AS workflows
      FROM execution_runs er
      ${siteJoin}
      ${siteWhere}
    `)
    .get(params) as { scenarios: number; workflows: number };

  const findingWhere = siteId
    ? "WHERE b.site_id = @siteId OR b.screen_id IN (SELECT id FROM screens WHERE source_input_id = @siteId)"
    : "";
  const bugStats = db
    .prepare(`
      SELECT
        SUM(CASE WHEN validation_status = 'confirmed' AND root_cause LIKE 'REAL_%' THEN 1 ELSE 0 END) AS real_bugs,
        SUM(CASE WHEN validation_status = 'confirmed' AND root_cause LIKE 'REAL_%' AND severity = 'critical' THEN 1 ELSE 0 END) AS critical,
        SUM(CASE WHEN validation_status = 'confirmed' AND root_cause LIKE 'REAL_%' AND severity = 'high' THEN 1 ELSE 0 END) AS high,
        SUM(CASE WHEN validation_status = 'confirmed' AND root_cause LIKE 'REAL_%' AND severity = 'medium' THEN 1 ELSE 0 END) AS medium,
        SUM(CASE WHEN validation_status = 'confirmed' AND root_cause LIKE 'REAL_%' AND severity = 'low' THEN 1 ELSE 0 END) AS low,
        SUM(CASE WHEN occurrence_count > 1 THEN occurrence_count - 1 ELSE 0 END) AS duplicates,
        SUM(CASE WHEN validation_status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
        SUM(CASE WHEN validation_status = 'candidate' OR root_cause = 'UNKNOWN_REQUIRES_INVESTIGATION' THEN 1 ELSE 0 END) AS unknown_count
      FROM bug_findings b
      ${findingWhere}
    `)
    .get(params) as any;

  const evidenceJoin = siteId
    ? ` JOIN execution_runs er ON er.id = ee.run_id
        JOIN automation_scripts a ON a.id = er.script_id
        JOIN test_cases tc ON tc.id = a.test_case_id
        LEFT JOIN screens s ON s.id = tc.screen_id`
    : "";
  const evidenceWhere = siteId ? " WHERE s.source_input_id = @siteId" : "";
  const failures = db
    .prepare(`
      SELECT
        SUM(CASE WHEN ee.failure_class = 'automation_issue' THEN 1 ELSE 0 END) AS automation,
        SUM(CASE WHEN ee.failure_class = 'environment_issue' THEN 1 ELSE 0 END) AS environment
      FROM execution_evidence ee
      ${evidenceJoin}
      ${evidenceWhere}
    `)
    .get(params) as any;

  const scans = db
    .prepare(`
      SELECT
        COALESCE(SUM(api_calls_analyzed), 0) AS api_calls,
        COALESCE(SUM(ui_states_analyzed), 0) AS ui_states
      FROM qa_scan_runs
      ${siteId ? "WHERE site_id = @siteId" : ""}
    `)
    .get(params) as any;

  return {
    totalScenariosExecuted: Number(execution?.scenarios || 0),
    totalWorkflowsExecuted: Number(execution?.workflows || 0),
    totalApiCallsAnalyzed: Number(scans?.api_calls || 0),
    totalUiStatesAnalyzed: Number(scans?.ui_states || 0),
    totalRealBugs: Number(bugStats?.real_bugs || 0),
    criticalBugs: Number(bugStats?.critical || 0),
    highBugs: Number(bugStats?.high || 0),
    mediumBugs: Number(bugStats?.medium || 0),
    lowBugs: Number(bugStats?.low || 0),
    automationFailures: Number(failures?.automation || 0),
    environmentFailures: Number(failures?.environment || 0),
    duplicateIssues: Number(bugStats?.duplicates || 0),
    falsePositivesRejected: Number(bugStats?.rejected || 0),
    unknownRequiresInvestigation: Number(bugStats?.unknown_count || 0),
  };
}

export function getBugFinding(id: string): BugFindingRow | undefined {
  return db.prepare("SELECT * FROM bug_findings WHERE id = ?").get(id) as BugFindingRow | undefined;
}

export async function confirmHttpFinding(
  findingId: string,
  url: string,
  expectedStatus: number,
  method = "GET"
): Promise<BugFindingRow | undefined> {
  const finding = getBugFinding(findingId);
  if (!finding || finding.validation_status === "confirmed") return finding;
  const attempts: Array<{ status: number; body: string; durationMs: number }> = [];
  for (let i = 0; i < 2; i++) {
    const started = Date.now();
    const response = await fetch(url, { method }).catch(() => null);
    if (!response) continue;
    attempts.push({
      status: response.status,
      body: (await response.text()).slice(0, 1000),
      durationMs: Date.now() - started,
    });
  }
  const successes = attempts.filter((attempt) => attempt.status === expectedStatus).length;
  let evidence: Record<string, any> = {};
  try {
    evidence = JSON.parse(finding.evidence || "{}");
  } catch {
    evidence = {};
  }
  const confirmed = successes === 2;
  db.prepare(`
    UPDATE bug_findings
    SET reproduction_attempts = reproduction_attempts + ?,
        reproduction_successes = reproduction_successes + ?,
        validation_status = ?,
        evidence = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    attempts.length,
    successes,
    confirmed ? "confirmed" : "rejected",
    JSON.stringify({ ...evidence, independentHttpVerification: attempts }),
    new Date().toISOString(),
    findingId
  );
  const updated = getBugFinding(findingId);
  if (updated?.validation_status === "confirmed") autoFileIfSevere(updated);
  return updated;
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
  if (finding.validation_status !== "confirmed" || !finding.root_cause.startsWith("REAL_")) return;
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
export async function fuzzApiEndpoint(
  baseUrl: string,
  endpointTemplate: string,
  runId?: string,
  headers: Record<string, string> = {},
  siteId?: string
): Promise<BugFindingRow[]> {
  const findings: BugFindingRow[] = [];
  const parsedTemplate = endpointTemplate.match(/^(GET|POST|PUT|PATCH|DELETE)\s+(.+)$/i);
  const method = (parsedTemplate?.[1] || "GET").toUpperCase();
  const endpointPath = parsedTemplate?.[2] || endpointTemplate;
  if (method !== "GET" && process.env.ALLOW_DESTRUCTIVE_QA !== "1") {
    return findings;
  }
  for (const fuzz of FUZZ_IDS) {
    const fuzzedPath = endpointPath.replace(/:[A-Za-z_]+/, encodeURIComponent(fuzz.value));
    const url = /^https?:\/\//i.test(fuzzedPath)
      ? fuzzedPath
      : `${baseUrl.replace(/\/$/, "")}${fuzzedPath.startsWith("/") ? "" : "/"}${fuzzedPath}`;
    try {
      const attempts: Array<{
        status: number;
        durationMs: number;
        responseBody: string;
        responseHeaders: Record<string, string>;
      }> = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        const started = Date.now();
        const res = await fetch(url, { method, headers });
        const responseHeaders: Record<string, string> = {};
        res.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });
        attempts.push({
          status: res.status,
          durationMs: Date.now() - started,
          responseBody: (await res.text()).slice(0, 2000),
          responseHeaders,
        });
      }
      const serverFailures = attempts.filter((a) => a.status >= 500);
      const unsafeSuccesses = attempts.filter(
        (a) =>
          a.status >= 200 &&
          a.status < 300 &&
          (/sqli|xss|path traversal|null-byte/i.test(fuzz.label) ||
            /"success"\s*:\s*false|"ok"\s*:\s*false|"error"\s*:/i.test(a.responseBody))
      );
      if (serverFailures.length >= 2 || unsafeSuccesses.length >= 2) {
        const representative = serverFailures[0] || unsafeSuccesses[0];
        const isUnsafeSuccess = unsafeSuccesses.length >= 2;
        const headerLines = Object.entries(headers).map(([k, v]) => `-H "${k}: ${v}"`).join(" ");
        const finding = recordBugFinding({
          source: "api_fuzz",
          severity: "high",
          rootCause: isUnsafeSuccess ? "REAL_SECURITY_BUG" : "REAL_API_BUG",
          priority: "P1",
          title: isUnsafeSuccess
            ? `${endpointTemplate} accepts dangerous ${fuzz.label} input`
            : `${endpointTemplate} crashes (HTTP ${representative.status}) on ${fuzz.label}`,
          detail: isUnsafeSuccess
            ? `GET ${url} returned success for dangerous input in ${unsafeSuccesses.length}/3 attempts instead of rejecting it.`
            : `GET ${url} returned HTTP 5xx in ${serverFailures.length}/3 attempts instead of a clean 4xx.`,
          runId,
          siteId,
          evidence: {
            method,
            url,
            requestHeaders: headers,
            fuzzLabel: fuzz.label,
            fuzzInput: fuzz.value,
            attempts,
            correlationId:
              representative.responseHeaders["x-correlation-id"] ||
              representative.responseHeaders["x-request-id"] ||
              null,
          },
          testData: { id: fuzz.value },
          expectedResult: "Malformed or dangerous identifiers should be rejected with a documented 4xx response and must not expose data.",
          actualResult: isUnsafeSuccess
            ? `The API returned success in ${unsafeSuccesses.length}/3 attempts.`
            : `The API returned a server error in ${serverFailures.length}/3 attempts.`,
          reproductionAttempts: 3,
          reproductionSuccesses: isUnsafeSuccess ? unsafeSuccesses.length : serverFailures.length,
          validationStatus: "confirmed",
          stepsToReproduce: [
            `Send a ${method} request to: ${url}${headerLines ? ` (with headers: ${headerLines})` : ""}`,
            `Equivalent curl: curl -i -X ${method} ${headerLines ? `${headerLines} ` : ""}"${url}"`,
            `Repeat the request three times.`,
            isUnsafeSuccess
              ? `Observe: the API accepts dangerous input with a 2xx response.`
              : `Observe: the API repeatedly returns 5xx instead of a clean 4xx validation response.`,
          ],
        });
        findings.push(finding);
        autoFileIfSevere(finding);
      }
    } catch {
      // Target unreachable for this probe -- not itself a finding worth recording.
    }
  }

  const hasAuth = Object.keys(headers).some((key) => /authorization|x-user-id|api-key/i.test(key));
  const protectedHint =
    method !== "GET" || /admin|role|permission|user|account|delete|export|billing|payment/i.test(endpointPath);
  const destructiveProbeAllowed = method === "GET" || process.env.ALLOW_DESTRUCTIVE_QA === "1";
  if (hasAuth && protectedHint && destructiveProbeAllowed) {
    const anonymousHeaders = Object.fromEntries(
      Object.entries(headers).filter(([key]) => !/authorization|x-user-id|api-key/i.test(key))
    );
    const authPath = endpointPath.replace(/:[A-Za-z_]+/, "__qa_nonexistent__");
    const probeUrl = /^https?:\/\//i.test(authPath)
      ? authPath
      : `${baseUrl.replace(/\/$/, "")}${authPath.startsWith("/") ? "" : "/"}${authPath}`;
    const attempts: Array<{ status: number; body: string }> = [];
    for (let i = 0; i < 3; i++) {
      const response = await fetch(probeUrl, { method, headers: anonymousHeaders }).catch(() => null);
      if (response) attempts.push({ status: response.status, body: (await response.text()).slice(0, 1000) });
    }
    const unauthorizedSuccesses = attempts.filter((a) => a.status >= 200 && a.status < 300);
    if (unauthorizedSuccesses.length === 3) {
      findings.push(
        recordBugFinding({
          source: "api_fuzz",
          severity: "critical",
          rootCause: "REAL_SECURITY_BUG",
          priority: "P0",
          title: `${method} ${endpointPath} permits unauthenticated access`,
          detail: `The endpoint returned 2xx without authentication in 3/3 attempts.`,
          runId,
          siteId,
          evidence: { method, url: probeUrl, attempts, removedHeaders: Object.keys(headers) },
          expectedResult: "The protected operation should reject unauthenticated requests with HTTP 401 or 403.",
          actualResult: "The protected operation succeeded without authentication in all three attempts.",
          reproductionAttempts: 3,
          reproductionSuccesses: 3,
          validationStatus: "confirmed",
          stepsToReproduce: [
            `Remove authentication headers from ${method} ${probeUrl}.`,
            "Send the request three times.",
            "Observe that each request succeeds instead of returning 401 or 403.",
          ],
        })
      );
    }
  }
  return findings;
}

export async function fuzzApiEndpoints(
  baseUrl: string,
  endpointTemplates: string[],
  runId?: string,
  headers?: Record<string, string>,
  siteId?: string
): Promise<BugFindingRow[]> {
  const all: BugFindingRow[] = [];
  for (const template of endpointTemplates) {
    all.push(...(await fuzzApiEndpoint(baseUrl, template, runId, headers, siteId)));
  }
  return all;
}

const SPINNER_GRACE_MS = 1500;
const SCAN_NAV_TIMEOUT_MS = 30000;
const RESPONSIVE_VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1280, height: 720 },
  { width: 1440, height: 900 },
] as const;

interface ResponsiveIssue {
  kind:
    | "horizontal_overflow"
    | "fixed_control_clipped"
    | "modal_overflow"
    | "text_clipped"
    | "missing_accessible_name"
    | "small_touch_target";
  detail: string;
}

async function inspectResponsiveState(
  page: import("playwright").Page,
  viewport: { width: number; height: number }
): Promise<ResponsiveIssue[]> {
  await page.setViewportSize(viewport);
  await page.waitForTimeout(150);
  return page.evaluate(({ width, height }) => {
    const issues: ResponsiveIssue[] = [];
    const doc = document.documentElement;
    if (doc.scrollWidth > width + 8) {
      issues.push({
        kind: "horizontal_overflow",
        detail: `Document width ${doc.scrollWidth}px exceeds the ${width}px viewport.`,
      });
    }

    const visible = Array.from(
      document.querySelectorAll<HTMLElement>(
        'button, input, select, textarea, [role="button"], [role="dialog"], [aria-modal="true"], [style*="position: fixed"], [style*="position:fixed"]'
      )
    ).filter((el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const chrome = `${el.id} ${el.getAttribute("name") || ""} ${el.className || ""}`.toLowerCase();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity || "1") > 0 &&
        rect.width > 0 &&
        rect.height > 0 &&
        !/report-email|report-msg|report-abuse|cf-turnstile/.test(chrome)
      );
    });

    for (const el of visible) {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const label = (
        el.getAttribute("aria-label") ||
        el.getAttribute("name") ||
        el.textContent ||
        el.id ||
        el.tagName
      )
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80);
      const fixed = style.position === "fixed" || style.position === "sticky";
      const modal = el.matches('[role="dialog"], [aria-modal="true"]');
      const tag = el.tagName.toLowerCase();
      const interactive =
        el.matches('button, input:not([type="hidden"]), select, textarea, [role="button"]');
      const labelled =
        Boolean(el.getAttribute("aria-label")?.trim()) ||
        Boolean(el.getAttribute("aria-labelledby")?.trim()) ||
        Boolean(el.getAttribute("title")?.trim()) ||
        Boolean((el as HTMLInputElement).labels?.length) ||
        Boolean((el.textContent || "").trim()) ||
        (tag === "input" && Boolean((el as HTMLInputElement).value || el.getAttribute("placeholder")));
      if (interactive && !labelled) {
        issues.push({
          kind: "missing_accessible_name",
          detail: `${tag} control has no accessible name at ${width}x${height}.`,
        });
      }
      if (
        width <= 390 &&
        interactive &&
        tag !== "input" &&
        (rect.width < 24 || rect.height < 24)
      ) {
        issues.push({
          kind: "small_touch_target",
          detail: `Touch target "${label}" is ${Math.round(rect.width)}x${Math.round(rect.height)}px (below 24px minimum).`,
        });
      }
      if (modal && (rect.left < -4 || rect.right > width + 4 || rect.top < -4 || rect.bottom > height + 4)) {
        issues.push({ kind: "modal_overflow", detail: `Modal "${label}" extends outside ${width}x${height}.` });
      } else if (fixed && (rect.left < -4 || rect.right > width + 4)) {
        issues.push({
          kind: "fixed_control_clipped",
          detail: `Fixed/sticky control "${label}" is horizontally clipped at ${width}x${height}.`,
        });
      }
      const text = (el.textContent || "").trim();
      if (
        text.length > 2 &&
        (style.overflow === "hidden" || style.textOverflow === "ellipsis") &&
        (el.scrollWidth > el.clientWidth + 4 || el.scrollHeight > el.clientHeight + 4)
      ) {
        issues.push({ kind: "text_clipped", detail: `Text/control "${label}" is clipped at ${width}x${height}.` });
      }
    }
    return issues.slice(0, 12);
  }, viewport);
}

async function scanResponsiveLayout(
  page: import("playwright").Page,
  screen: { name: string; url_or_path: string | null },
  screenId: string | null,
  runId?: string
): Promise<BugFindingRow[]> {
  const findings: BugFindingRow[] = [];
  for (const viewport of RESPONSIVE_VIEWPORTS) {
    const first = await inspectResponsiveState(page, viewport);
    if (first.length === 0) continue;
    const second = await inspectResponsiveState(page, viewport);
    const confirmed = first.filter((a) => second.some((b) => b.kind === a.kind && b.detail === a.detail));
    if (confirmed.length === 0) continue;
    const screenshotUrl = await page
      .screenshot({ fullPage: true })
      .then((buffer) => saveUploadFile(buffer, ".png"))
      .catch(() => null);
    findings.push(
      recordBugFinding({
        source: "ui_exploratory",
        severity: confirmed.some((i) => i.kind === "modal_overflow" || i.kind === "fixed_control_clipped")
          ? "medium"
          : "low",
        rootCause: "REAL_UI_BUG",
        title: `UI/responsive defect on ${screen.name} at ${viewport.width}x${viewport.height}`,
        detail: confirmed.map((i) => i.detail).join("\n"),
        screenId,
        runId,
        environment: { browser: "Chromium", os: process.platform, viewport: `${viewport.width}x${viewport.height}` },
        evidence: { viewport, issues: confirmed },
        expectedResult: "All product content and fixed/modal controls should remain usable without horizontal clipping.",
        actualResult: confirmed.map((i) => i.detail).join(" "),
        reproductionAttempts: 2,
        reproductionSuccesses: 2,
        validationStatus: "confirmed",
        stepsToReproduce: [
          `Open ${screen.url_or_path}.`,
          `Set the viewport to ${viewport.width}x${viewport.height}.`,
          "Wait for the page to settle.",
          `Observe: ${confirmed.map((i) => i.detail).join(" ")}`,
        ],
        screenshotUrl,
      })
    );
  }
  return findings;
}

async function confirmUiFindings(
  context: import("playwright").BrowserContext,
  url: string,
  findings: BugFindingRow[]
): Promise<void> {
  if (findings.length === 0) return;
  const page = await context.newPage();
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const responses: Array<{ url: string; status: number }> = [];
  const failedRequests: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("response", (res) => responses.push({ url: res.url(), status: res.status() }));
  page.on("requestfailed", (req) => failedRequests.push(req.url()));

  let mainStatus = 0;
  let navigationDurationMs = 0;
  try {
    const started = Date.now();
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: SCAN_NAV_TIMEOUT_MS });
    navigationDurationMs = Date.now() - started;
    mainStatus = response?.status() || 0;
    await page.waitForTimeout(SPINNER_GRACE_MS);
  } catch {
    // A second navigation failure confirms only a first navigation-failure finding.
  }

  const brokenImages = await page
    .locator("img:visible")
    .evaluateAll((imgs: any[]) => imgs.filter((img) => img.complete && img.naturalWidth === 0).map((img) => img.src))
    .catch(() => [] as string[]);
  const stuckSpinners = await page.locator(".animate-spin:visible, [role='progressbar']:visible").count().catch(() => 0);
  const emptyBody = await page
    .locator("body")
    .evaluate((el) => (el.textContent || "").trim().length < 20)
    .catch(() => false);

  for (const finding of findings) {
    if (finding.validation_status === "confirmed") continue;
    let evidence: Record<string, any> = {};
    try {
      evidence = JSON.parse(finding.evidence || "{}");
    } catch {
      evidence = {};
    }
    let confirmed = false;
    if (evidence.status) confirmed = mainStatus === Number(evidence.status);
    else if (Array.isArray(evidence.serverErrors)) {
      confirmed = evidence.serverErrors.some((expected: any) =>
        responses.some((actual) => actual.url === expected.url && actual.status === expected.status)
      );
    } else if (Array.isArray(evidence.pageErrors)) {
      confirmed = evidence.pageErrors.some((expected: string) => pageErrors.some((actual) => actual.includes(expected)));
    } else if (Array.isArray(evidence.brokenImages)) {
      confirmed = evidence.brokenImages.some((expected: string) => brokenImages.includes(expected));
    } else if (Array.isArray(evidence.clientErrors)) {
      confirmed = evidence.clientErrors.some((expected: any) =>
        responses.some((actual) => actual.url === expected.url && actual.status === expected.status)
      );
    } else if (Array.isArray(evidence.failedRequests)) {
      confirmed = evidence.failedRequests.some((expected: any) => failedRequests.includes(expected.url));
    } else if (evidence.stuckSpinners) confirmed = stuckSpinners > 0;
    else if (evidence.emptyBody) confirmed = emptyBody;
    else if (evidence.durationThresholdMs) confirmed = navigationDurationMs >= Number(evidence.durationThresholdMs);
    else if (evidence.topErrors) {
      confirmed = evidence.topErrors.some((expected: any) =>
        consoleErrors.some((actual) => actual.includes(expected.message))
      );
    } else if (Array.isArray(evidence.brokenLinks)) {
      for (const expected of evidence.brokenLinks.slice(0, 5)) {
        const status = await page.request
          .get(expected.url, { timeout: 8000 })
          .then((res) => res.status())
          .catch(() => 0);
        if (status === expected.status || (status >= 400 && expected.status >= 400)) {
          confirmed = true;
          break;
        }
      }
    } else if (/failed to load/i.test(finding.title)) {
      confirmed = mainStatus === 0;
    }

    db.prepare(`
      UPDATE bug_findings
      SET reproduction_attempts = reproduction_attempts + 1,
          reproduction_successes = reproduction_successes + ?,
          validation_status = CASE WHEN ? = 1 THEN 'confirmed' ELSE 'rejected' END,
          updated_at = ?
      WHERE id = ?
    `).run(confirmed ? 1 : 0, confirmed ? 1 : 0, new Date().toISOString(), finding.id);
    finding.reproduction_attempts += 1;
    if (confirmed) {
      finding.reproduction_successes += 1;
      finding.validation_status = "confirmed";
      autoFileIfSevere(finding);
    }
  }
  await page.close();
}

// UI exploratory scan: load a cataloged Screen's URL headlessly and watch for
// the same class of bug a manual exploratory tester would catch by just
// looking at the page -- console/page errors, failed network calls, broken
// images, a load spinner that never resolves. The whole session is screen-
// recorded (attached to every finding from this scan) and each individual
// finding also gets its own screenshot taken at the moment it's detected.
export async function scanScreenForUiBugs(
  screen: { id: string; name: string; url_or_path: string | null },
  runId?: string,
  catalogScreenId?: string | null
): Promise<BugFindingRow[]> {
  if (!screen.url_or_path) return [];
  const screenId = catalogScreenId ?? null;
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
    const consoleErrors: ConsoleError[] = [];
    const pageErrors: string[] = [];
    const serverErrors: Array<{ url: string; status: number }> = [];
    const clientErrors: Array<{ url: string; status: number }> = [];
    const failedRequests: Array<{ url: string; error: string }> = [];

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
    });
    page.on("requestfailed", (req) => {
      failedRequests.push({ url: req.url(), error: (req.failure()?.errorText || "request failed").slice(0, 200) });
    });

    const baseSteps = [
      `Navigate to: ${screen.url_or_path}`,
      "Wait for the page to finish loading.",
    ];

    let mainResponse: import("playwright").Response | null = null;
    const navigationStarted = Date.now();
    try {
      mainResponse = await page.goto(screen.url_or_path, { waitUntil: "domcontentloaded", timeout: SCAN_NAV_TIMEOUT_MS });
    } catch (navErr: any) {
      const screenshotUrl = await screenshotNow();
      const finding = recordBugFinding({
        source: "ui_exploratory",
        severity: "critical",
        rootCause: "ENVIRONMENT_BUG",
        priority: "P3",
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
    const navigationDurationMs = Date.now() - navigationStarted;
    if (navigationDurationMs >= 10_000) {
      findings.push(
        recordBugFinding({
          source: "ui_exploratory",
          severity: navigationDurationMs >= 20_000 ? "high" : "medium",
          rootCause: "REAL_PERFORMANCE_BUG",
          title: `Slow initial page load on ${screen.name}`,
          detail: `DOMContentLoaded took ${navigationDurationMs}ms, exceeding the 10000ms usability threshold.`,
          screenId,
          runId,
          evidence: { url: screen.url_or_path, durationMs: navigationDurationMs, durationThresholdMs: 10_000 },
          expectedResult: "The initial page should become usable within 10 seconds under normal network conditions.",
          actualResult: `The initial document took ${navigationDurationMs}ms to load.`,
          stepsToReproduce: [...baseSteps, `Measure DOMContentLoaded: ${navigationDurationMs}ms.`],
        })
      );
    }

    if (mainResponse && mainResponse.status() >= 400) {
      const screenshotUrl = await screenshotNow();
      const finding = recordBugFinding({
        source: "ui_exploratory",
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

    // A raw observation is not yet a product defect. Re-open the page and
    // independently verify each signal; unresolved one-off observations stay
    // as candidates and are excluded from the real-bug dashboard.
    await confirmUiFindings(context, screen.url_or_path, findings);

    // Check six representative responsive states. Each reported layout issue
    // must reproduce twice at the same viewport before it is persisted.
    findings.push(...(await scanResponsiveLayout(page, screen, screenId, runId)));
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
  return scanScreenForUiBugs(screen, runId, screenId);
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
  const scanId = nanoid(10);
  const scanStarted = new Date().toISOString();
  db.prepare(`
    INSERT INTO qa_scan_runs (id, site_id, status, started_at)
    VALUES (?, ?, 'running', ?)
  `).run(scanId, siteId, scanStarted);

  let pages = db.prepare("SELECT * FROM crawl_pages WHERE site_id = ? AND change_status != 'removed'").all(siteId) as any[];
  if (opts?.changeStatuses?.length) {
    const allowed = new Set(opts.changeStatuses);
    pages = pages.filter((p) => allowed.has(p.change_status));
  }

  const allFindings: BugFindingRow[] = [];
  const apiTemplates = new Set<string>();

  for (const page of pages) {
    const screen = db
      .prepare("SELECT id, name, url_or_path, visual_baseline_ref FROM screens WHERE url_or_path = ? OR url_or_path = ? ORDER BY updated_at DESC LIMIT 1")
      .get(page.url, normalizeUrl(page.url)) as
        | { id: string; name: string; url_or_path: string; visual_baseline_ref?: string | null }
        | undefined;

    const screenId = screen?.id ?? null;
    const screenName = screen?.name ?? (page.title || page.url);
    const scanTarget = { id: screenId ?? `page-${page.id}`, name: screenName, url_or_path: page.url };

    const spellingIssues: SpellingIssue[] = JSON.parse(page.spelling_issues_json || "[]");
    if (spellingIssues.length && screenId) allFindings.push(...fileSpellingFindings(screenId, screenName, spellingIssues));

    const uiFindings = await scanScreenForUiBugs(scanTarget, undefined, screenId);
    allFindings.push(...uiFindings);

    if (screenId && screen) {
      if (!screen.visual_baseline_ref) {
        await saveVisualBaseline(screenId, { url: page.url }).catch(() => undefined);
      } else {
        const firstDiff = await diffAgainstVisualBaseline(screenId, { url: page.url }).catch(() => null);
        const secondDiff =
          firstDiff?.visualChangeDetected
            ? await diffAgainstVisualBaseline(screenId, { url: page.url }).catch(() => null)
            : null;
        if (firstDiff?.visualChangeDetected && secondDiff?.visualChangeDetected) {
          const firstPercent = Number((firstDiff as any).diffPercentage || 0);
          const secondPercent = Number((secondDiff as any).diffPercentage || 0);
          allFindings.push(
            recordBugFinding({
              source: "ui_exploratory",
              severity: Math.max(firstPercent, secondPercent) >= 20 ? "high" : "medium",
              rootCause: "REAL_UI_BUG",
              title: `Meaningful visual regression on ${screenName}`,
              detail: `The page differs from its approved visual baseline by ${firstPercent}% and ${secondPercent}% in two independent captures.`,
              screenId,
              evidence: { baseline: screen.visual_baseline_ref, attempts: [firstDiff, secondDiff] },
              expectedResult: "The rendered screen should match its approved visual baseline apart from ignored dynamic/rendering noise.",
              actualResult: `Material visual differences reproduced twice (${firstPercent}% and ${secondPercent}%).`,
              reproductionAttempts: 2,
              reproductionSuccesses: 2,
              validationStatus: "confirmed",
              stepsToReproduce: [
                `Open ${page.url} at 1280x800.`,
                "Disable animations and ignore timestamps/advertising content.",
                "Compare the settled page against the approved baseline.",
                `Observe a material pixel difference of ${firstPercent}% (confirmed at ${secondPercent}%).`,
              ],
            })
          );
        }
      }
    }

    const apis = JSON.parse(page.apis_json || "[]") as Array<{ method: string; endpoint: string }>;
    for (const api of apis) {
      if (api.endpoint.includes(":id") || /\/\d+/.test(api.endpoint)) {
        const template = api.endpoint.replace(/\/\d+(?=\/|[?#]|$)/, "/:id");
        apiTemplates.add(`${String(api.method || "GET").toUpperCase()} ${template}`);
      }
    }
  }

  if (apiTemplates.size > 0) {
    const fuzzed = await fuzzApiEndpoints(
      originOf(site.url) || site.url,
      Array.from(apiTemplates).slice(0, 10),
      undefined,
      undefined,
      siteId
    );
    allFindings.push(...fuzzed);
  }

  const confirmed = allFindings.filter((f) => f.validation_status === "confirmed");
  const rejected = allFindings.filter((f) => f.validation_status === "rejected");
  const duplicates = confirmed.reduce((sum, f) => sum + Math.max(0, Number(f.occurrence_count || 1) - 1), 0);
  const probedApiTemplates = Array.from(apiTemplates)
    .slice(0, 10)
    .filter((template) => /^GET\s/i.test(template) || process.env.ALLOW_DESTRUCTIVE_QA === "1").length;
  db.prepare(`
    UPDATE qa_scan_runs
    SET status = 'completed',
        workflows_executed = ?,
        api_calls_analyzed = ?,
        ui_states_analyzed = ?,
        duplicate_issues = ?,
        false_positives_rejected = ?,
        completed_at = ?
    WHERE id = ?
  `).run(
    pages.length,
    probedApiTemplates * FUZZ_IDS.length * 3,
    pages.length * (1 + RESPONSIVE_VIEWPORTS.length),
    duplicates,
    rejected.length,
    new Date().toISOString(),
    scanId
  );

  return allFindings;
}
