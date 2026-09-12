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

export type BugSeverity = "blocker" | "critical" | "high" | "medium" | "low";
export type BugSource = "ui_exploratory" | "api_fuzz" | "regression";
export type DefectClassification =
  | "CONFIRMED_PRODUCT_BUG"
  | "AUTOMATION_ISSUE"
  | "ENVIRONMENT_ISSUE"
  | "TEST_DATA_ISSUE"
  | "CONFIGURATION_ISSUE"
  | "UNCERTAIN";
export type RegressionRisk = "low" | "medium" | "high";
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
  defectClassification?: DefectClassification;
  moduleFeature?: string;
  requirementReference?: string;
  businessImpact?: string;
  severityJustification?: string;
  priorityJustification?: string;
  suspectedRootCause?: string;
  regressionRisk?: RegressionRisk;
  regressionRiskReason?: string;
  suggestedFix?: string;
  aiConfidence?: number;
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
  defect_classification: DefectClassification;
  module_feature: string | null;
  requirement_reference: string | null;
  business_impact: string | null;
  severity_justification: string | null;
  priority_justification: string | null;
  suspected_root_cause: string | null;
  regression_risk: RegressionRisk | null;
  regression_risk_reason: string | null;
  suggested_fix: string | null;
  ai_confidence: number;
  ai_confidence_reason: string | null;
  quality_gate_json: string;
  duplicate_of_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface BugQualityGate {
  requirementUnderstood: boolean;
  expectedBehaviorEstablished: boolean;
  actualBehaviorCaptured: boolean;
  productBehaviorIndependentlyEvaluated: boolean;
  automationFailureRuledOut: boolean;
  environmentIssueRuledOut: boolean;
  testDataIssueRuledOut: boolean;
  reproductionAttempted: boolean;
  evidenceAttached: boolean;
  severityJustified: boolean;
  priorityJustified: boolean;
  businessImpactExplained: boolean;
  duplicateCheckCompleted: boolean;
  noInformationInvented: boolean;
  rootCausePresentedAsSuspected: boolean;
  passed: boolean;
}

function evaluateQualityGate(
  input: BugFindingInput,
  reproductionAttempts: number,
  reproductionSuccesses: number
): BugQualityGate {
  const productClassification = input.defectClassification === "CONFIRMED_PRODUCT_BUG";
  const evidenceAttached =
    Object.keys(input.evidence || {}).length > 0 || Boolean(input.screenshotUrl) || Boolean(input.videoUrl);
  const gate: BugQualityGate = {
    requirementUnderstood: Boolean(input.requirementReference?.trim()),
    expectedBehaviorEstablished: Boolean(input.expectedResult?.trim()),
    actualBehaviorCaptured: Boolean((input.actualResult || input.detail)?.trim()),
    productBehaviorIndependentlyEvaluated: reproductionAttempts >= 2 && reproductionSuccesses >= 2,
    automationFailureRuledOut: productClassification,
    environmentIssueRuledOut: productClassification,
    testDataIssueRuledOut: productClassification,
    reproductionAttempted: reproductionAttempts > 0,
    evidenceAttached,
    severityJustified: Boolean(input.severityJustification?.trim()),
    priorityJustified: Boolean(input.priorityJustification?.trim()),
    businessImpactExplained: Boolean(input.businessImpact?.trim()),
    duplicateCheckCompleted: true,
    noInformationInvented:
      Boolean(input.expectedResult?.trim()) &&
      Boolean(input.actualResult?.trim()) &&
      Boolean(input.requirementReference?.trim()),
    rootCausePresentedAsSuspected:
      !input.suspectedRootCause || /^SUSPECTED ROOT CAUSE\b/i.test(input.suspectedRootCause.trim()),
    passed: false,
  };
  gate.passed = Object.entries(gate)
    .filter(([key]) => key !== "passed")
    .every(([, value]) => value === true);
  return gate;
}

function confidenceFromGate(gate: BugQualityGate, attempts: number, successes: number): number {
  const checks = Object.entries(gate).filter(([key]) => key !== "passed");
  const passed = checks.filter(([, value]) => value === true).length;
  const evidenceScore = Math.round((passed / Math.max(1, checks.length)) * 85);
  const reproductionScore = attempts > 0 ? Math.round((successes / attempts) * 15) : 0;
  return Math.max(0, Math.min(100, evidenceScore + reproductionScore));
}

function confidenceReason(gate: BugQualityGate, attempts: number, successes: number): string {
  const missing = Object.entries(gate)
    .filter(([key, value]) => key !== "passed" && !value)
    .map(([key]) => key.replace(/([A-Z])/g, " $1").toLowerCase());
  if (gate.passed) {
    return `All quality-gate checks passed with independent reproduction in ${successes}/${attempts} attempts.`;
  }
  return `Confidence is limited by: ${missing.join(", ") || "insufficient independent evidence"}; reproduction ${successes}/${attempts}.`;
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
  if (severity === "blocker" || severity === "critical") return "P0";
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
  const requestedClassification =
    input.defectClassification ??
    (rootCause === "AUTOMATION_BUG"
      ? "AUTOMATION_ISSUE"
      : rootCause === "ENVIRONMENT_BUG"
        ? "ENVIRONMENT_ISSUE"
        : "UNCERTAIN");
  const gateInput = { ...input, defectClassification: requestedClassification };
  const qualityGate = evaluateQualityGate(gateInput, reproductionAttempts, reproductionSuccesses);
  const defectClassification: DefectClassification =
    requestedClassification === "CONFIRMED_PRODUCT_BUG" && !qualityGate.passed
      ? "UNCERTAIN"
      : requestedClassification;
  const validationStatus =
    defectClassification === "CONFIRMED_PRODUCT_BUG"
      ? "confirmed"
      : input.validationStatus === "rejected"
        ? "rejected"
        : "candidate";
  const aiConfidence = Math.min(
    input.aiConfidence ?? 100,
    confidenceFromGate(qualityGate, reproductionAttempts, reproductionSuccesses)
  );
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
    const existingConfirmed =
      existing.validation_status === "confirmed" &&
      existing.defect_classification === "CONFIRMED_PRODUCT_BUG";
    const mergedValidation =
      existingConfirmed || validationStatus === "confirmed"
        ? "confirmed"
        : validationStatus === "rejected" && existing.validation_status !== "candidate"
          ? "rejected"
          : "candidate";
    const mergedClassification = existingConfirmed ? existing.defect_classification : defectClassification;
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
          defect_classification = ?,
          quality_gate_json = ?,
          ai_confidence = ?,
          ai_confidence_reason = ?,
          business_impact = COALESCE(?, business_impact),
          requirement_reference = COALESCE(?, requirement_reference),
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
      mergedClassification,
      JSON.stringify(qualityGate),
      aiConfidence,
      confidenceReason(qualityGate, reproductionAttempts, reproductionSuccesses),
      input.businessImpact ?? null,
      input.requirementReference ?? null,
      now,
      existing.id
    );
    return getBugFinding(existing.id)!;
  }

  const id = `BUG-${nanoid(8).toUpperCase()}`;
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
      input.environment ??
        (input.source === "ui_exploratory"
          ? {
              browser: "Chromium",
              os: process.platform,
              viewport: "1280x800",
              build: process.env.BUILD_VERSION || process.env.npm_package_version || "unavailable",
            }
          : {
              browser: input.source === "api_fuzz" ? "not applicable" : "unavailable",
              os: process.platform,
              viewport: "unavailable",
              build: process.env.BUILD_VERSION || process.env.npm_package_version || "unavailable",
            })
    ),
    preconditions_json: JSON.stringify(input.preconditions ?? []),
    test_data_json: JSON.stringify(input.testData ?? {}),
    expected_result: input.expectedResult ?? null,
    actual_result: input.actualResult ?? input.detail,
    reproduction_attempts: reproductionAttempts,
    reproduction_successes: reproductionSuccesses,
    validation_status: validationStatus,
    fingerprint,
    occurrence_count: 1,
    affected_scenarios_json: JSON.stringify(affectedScenarios),
    defect_classification: defectClassification,
    module_feature: input.moduleFeature ?? null,
    requirement_reference: input.requirementReference ?? null,
    business_impact: input.businessImpact ?? null,
    severity_justification: input.severityJustification ?? null,
    priority_justification: input.priorityJustification ?? null,
    suspected_root_cause: input.suspectedRootCause ?? null,
    regression_risk: input.regressionRisk ?? null,
    regression_risk_reason: input.regressionRiskReason ?? null,
    suggested_fix: input.suggestedFix ?? null,
    ai_confidence: aiConfidence,
    ai_confidence_reason: confidenceReason(qualityGate, reproductionAttempts, reproductionSuccesses),
    quality_gate_json: JSON.stringify(qualityGate),
    duplicate_of_id: null,
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
      affected_scenarios_json, site_id, defect_classification, module_feature,
      requirement_reference, business_impact, severity_justification,
      priority_justification, suspected_root_cause, regression_risk,
      regression_risk_reason, suggested_fix, ai_confidence, ai_confidence_reason, quality_gate_json,
      duplicate_of_id, created_at, updated_at
    )
    VALUES (
      @id, @source, @severity, @title, @detail, @screen_id, @run_id, @evidence,
      @steps_to_reproduce, @screenshot_url, @video_url, @status, @root_cause,
      @priority, @environment_json, @preconditions_json, @test_data_json,
      @expected_result, @actual_result, @reproduction_attempts,
      @reproduction_successes, @validation_status, @fingerprint, @occurrence_count,
      @affected_scenarios_json, @site_id, @defect_classification, @module_feature,
      @requirement_reference, @business_impact, @severity_justification,
      @priority_justification, @suspected_root_cause, @regression_risk,
      @regression_risk_reason, @suggested_fix, @ai_confidence, @ai_confidence_reason, @quality_gate_json,
      @duplicate_of_id, @created_at, @updated_at
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
    if (filter.validationStatus === "confirmed") {
      clauses.push("defect_classification = 'CONFIRMED_PRODUCT_BUG'");
    }
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
         ${filter?.validationStatus === "confirmed" ? "AND b.defect_classification = 'CONFIRMED_PRODUCT_BUG'" : ""}
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
  blockerBugs: number;
  criticalBugs: number;
  highBugs: number;
  mediumBugs: number;
  lowBugs: number;
  automationFailures: number;
  environmentFailures: number;
  testDataIssues: number;
  configurationIssues: number;
  duplicateIssues: number;
  falsePositivesRejected: number;
  unknownRequiresInvestigation: number;
  highestRiskDefects: Array<{ id: string; title: string; severity: BugSeverity; businessImpact: string | null }>;
  coverageObservations: string[];
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
    ? "WHERE (b.site_id = @siteId OR b.screen_id IN (SELECT id FROM screens WHERE source_input_id = @siteId))"
    : "";
  const bugStats = db
    .prepare(`
      SELECT
        SUM(CASE WHEN defect_classification = 'CONFIRMED_PRODUCT_BUG' THEN 1 ELSE 0 END) AS real_bugs,
        SUM(CASE WHEN defect_classification = 'CONFIRMED_PRODUCT_BUG' AND severity = 'blocker' THEN 1 ELSE 0 END) AS blocker,
        SUM(CASE WHEN defect_classification = 'CONFIRMED_PRODUCT_BUG' AND severity = 'critical' THEN 1 ELSE 0 END) AS critical,
        SUM(CASE WHEN defect_classification = 'CONFIRMED_PRODUCT_BUG' AND severity = 'high' THEN 1 ELSE 0 END) AS high,
        SUM(CASE WHEN defect_classification = 'CONFIRMED_PRODUCT_BUG' AND severity = 'medium' THEN 1 ELSE 0 END) AS medium,
        SUM(CASE WHEN defect_classification = 'CONFIRMED_PRODUCT_BUG' AND severity = 'low' THEN 1 ELSE 0 END) AS low,
        SUM(CASE WHEN defect_classification = 'AUTOMATION_ISSUE' THEN 1 ELSE 0 END) AS automation_findings,
        SUM(CASE WHEN defect_classification = 'ENVIRONMENT_ISSUE' THEN 1 ELSE 0 END) AS environment_findings,
        SUM(CASE WHEN defect_classification = 'TEST_DATA_ISSUE' THEN 1 ELSE 0 END) AS test_data,
        SUM(CASE WHEN defect_classification = 'CONFIGURATION_ISSUE' THEN 1 ELSE 0 END) AS configuration,
        SUM(CASE WHEN occurrence_count > 1 THEN occurrence_count - 1 ELSE 0 END) AS duplicates,
        SUM(CASE WHEN validation_status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
        SUM(CASE WHEN defect_classification = 'UNCERTAIN' THEN 1 ELSE 0 END) AS unknown_count
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
        SUM(CASE WHEN ee.failure_class = 'environment_issue' THEN 1 ELSE 0 END) AS environment,
        SUM(CASE WHEN ee.failure_class = 'test_data_issue' THEN 1 ELSE 0 END) AS test_data,
        SUM(CASE WHEN ee.failure_class = 'configuration_issue' THEN 1 ELSE 0 END) AS configuration,
        SUM(CASE WHEN ee.failure_class IN ('uncertain', 'unknown', 'possible_bug') THEN 1 ELSE 0 END) AS uncertain
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
  const highestRiskDefects = db
    .prepare(`
      SELECT id, title, severity, business_impact
      FROM bug_findings b
      ${findingWhere ? `${findingWhere} AND` : "WHERE"}
        defect_classification = 'CONFIRMED_PRODUCT_BUG'
      ORDER BY CASE severity
        WHEN 'blocker' THEN 5 WHEN 'critical' THEN 4 WHEN 'high' THEN 3
        WHEN 'medium' THEN 2 ELSE 1 END DESC,
        created_at DESC
      LIMIT 5
    `)
    .all(params) as Array<{ id: string; title: string; severity: BugSeverity; business_impact: string | null }>;
  const coverageObservations: string[] = [];
  if (!Number(execution?.scenarios || 0)) coverageObservations.push("No test executions were available for analysis.");
  if (!Number(scans?.api_calls || 0)) coverageObservations.push("No API calls were analyzed; API behavior remains unverified.");
  if (!Number(scans?.ui_states || 0)) coverageObservations.push("No exploratory UI states were analyzed.");
  if (Number(execution?.workflows || 0) === 0) coverageObservations.push("No complete end-to-end workflow executions were identified.");
  if (coverageObservations.length === 0) {
    coverageObservations.push("Execution, workflow, API, and UI-state evidence is available; unexecuted product areas are not claimed as covered.");
  }

  return {
    totalScenariosExecuted: Number(execution?.scenarios || 0),
    totalWorkflowsExecuted: Number(execution?.workflows || 0),
    totalApiCallsAnalyzed: Number(scans?.api_calls || 0),
    totalUiStatesAnalyzed: Number(scans?.ui_states || 0),
    totalRealBugs: Number(bugStats?.real_bugs || 0),
    blockerBugs: Number(bugStats?.blocker || 0),
    criticalBugs: Number(bugStats?.critical || 0),
    highBugs: Number(bugStats?.high || 0),
    mediumBugs: Number(bugStats?.medium || 0),
    lowBugs: Number(bugStats?.low || 0),
    automationFailures: Number(failures?.automation || 0) + Number(bugStats?.automation_findings || 0),
    environmentFailures: Number(failures?.environment || 0) + Number(bugStats?.environment_findings || 0),
    testDataIssues: Number(bugStats?.test_data || 0) + Number(failures?.test_data || 0),
    configurationIssues: Number(bugStats?.configuration || 0) + Number(failures?.configuration || 0),
    duplicateIssues: Number(bugStats?.duplicates || 0),
    falsePositivesRejected: Number(bugStats?.rejected || 0),
    unknownRequiresInvestigation: Number(bugStats?.unknown_count || 0) + Number(failures?.uncertain || 0),
    highestRiskDefects: highestRiskDefects.map((row) => ({
      id: row.id,
      title: row.title,
      severity: row.severity,
      businessImpact: row.business_impact,
    })),
    coverageObservations,
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
  const totalAttempts = finding.reproduction_attempts + attempts.length;
  const totalSuccesses = finding.reproduction_successes + successes;
  const gateInput: BugFindingInput = {
    source: finding.source,
    severity: finding.severity,
    title: finding.title,
    detail: finding.detail,
    evidence: { ...evidence, independentHttpVerification: attempts },
    screenshotUrl: finding.screenshot_url,
    videoUrl: finding.video_url,
    expectedResult: finding.expected_result || undefined,
    actualResult: finding.actual_result || undefined,
    requirementReference: finding.requirement_reference || undefined,
    businessImpact: finding.business_impact || undefined,
    severityJustification: finding.severity_justification || undefined,
    priorityJustification: finding.priority_justification || undefined,
    suspectedRootCause: finding.suspected_root_cause || undefined,
    defectClassification: "CONFIRMED_PRODUCT_BUG",
  };
  const qualityGate = evaluateQualityGate(gateInput, totalAttempts, totalSuccesses);
  const confirmed = successes === 2 && qualityGate.passed;
  const confidence = confidenceFromGate(qualityGate, totalAttempts, totalSuccesses);
  db.prepare(`
    UPDATE bug_findings
    SET reproduction_attempts = reproduction_attempts + ?,
        reproduction_successes = reproduction_successes + ?,
        validation_status = ?,
        defect_classification = ?,
        quality_gate_json = ?,
        ai_confidence = ?,
        ai_confidence_reason = ?,
        evidence = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    attempts.length,
    successes,
    confirmed ? "confirmed" : "rejected",
    confirmed ? "CONFIRMED_PRODUCT_BUG" : "UNCERTAIN",
    JSON.stringify(qualityGate),
    confidence,
    confidenceReason(qualityGate, totalAttempts, totalSuccesses),
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
  if (
    finding.validation_status !== "confirmed" ||
    finding.defect_classification !== "CONFIRMED_PRODUCT_BUG" ||
    !finding.root_cause.startsWith("REAL_")
  ) return;
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
          responseHeaders[key] = /set-cookie|authorization|token|secret/i.test(key) ? "[REDACTED]" : value;
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
        const redactedHeaders = Object.fromEntries(
          Object.entries(headers).map(([key, value]) => [
            key,
            /authorization|cookie|token|api-key|secret/i.test(key) ? "[REDACTED]" : value,
          ])
        );
        const headerLines = Object.entries(redactedHeaders).map(([k, v]) => `-H "${k}: ${v}"`).join(" ");
        const finding = recordBugFinding({
          source: "api_fuzz",
          severity: "high",
          rootCause: isUnsafeSuccess ? "REAL_SECURITY_BUG" : "REAL_API_BUG",
          priority: isUnsafeSuccess ? "P2" : "P1",
          defectClassification: isUnsafeSuccess ? "UNCERTAIN" : "CONFIRMED_PRODUCT_BUG",
          moduleFeature: `API → ${method} ${endpointPath}`,
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
            requestHeaders: redactedHeaders,
            fuzzLabel: fuzz.label,
            fuzzInput: fuzz.value,
            attempts,
            correlationId:
              representative.responseHeaders["x-correlation-id"] ||
              representative.responseHeaders["x-request-id"] ||
              null,
          },
          testData: { id: fuzz.value },
          expectedResult: isUnsafeSuccess
            ? "The endpoint should follow its documented identifier validation and authorization contract."
            : "Malformed identifiers should be rejected with a controlled 4xx response rather than crashing the server.",
          actualResult: isUnsafeSuccess
            ? `The API returned success in ${unsafeSuccesses.length}/3 attempts.`
            : `The API returned a server error in ${serverFailures.length}/3 attempts.`,
          reproductionAttempts: 3,
          reproductionSuccesses: isUnsafeSuccess ? unsafeSuccesses.length : serverFailures.length,
          validationStatus: isUnsafeSuccess ? "candidate" : "confirmed",
          requirementReference: isUnsafeSuccess
            ? "No explicit API contract available — human review is required to determine whether this identifier is valid."
            : "Established HTTP/API behavior: malformed client input must produce a controlled 4xx response, not a server-side 5xx.",
          businessImpact: isUnsafeSuccess
            ? "Impact is not established until the endpoint contract and returned data are reviewed."
            : "Clients receive an uncontrolled server error and cannot handle invalid input predictably.",
          severityJustification: isUnsafeSuccess
            ? "Severity is provisional because acceptance of the value has not been proven incorrect."
            : "High because malformed input repeatedly causes a server-side failure.",
          priorityJustification: isUnsafeSuccess
            ? "P2 review is appropriate until the API contract is confirmed."
            : "P1 because the API crashes consistently and requires backend validation.",
          regressionRisk: "medium",
          regressionRiskReason: "Identifier validation may be shared by other operations on the same resource.",
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
          defectClassification: "CONFIRMED_PRODUCT_BUG",
          moduleFeature: `Authorization → ${method} ${endpointPath}`,
          requirementReference: "Established access-control rule: protected operations must reject unauthenticated requests with 401 or 403.",
          businessImpact: "An unauthenticated caller can perform or retrieve a protected operation.",
          severityJustification: "Critical because access control is bypassed in 3/3 independent attempts.",
          priorityJustification: "P0 because unauthorized access requires immediate containment.",
          regressionRisk: "high",
          regressionRiskReason: "Authorization middleware may protect multiple endpoints and roles.",
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
    const impairsUse = confirmed.some((i) => i.kind === "modal_overflow" || i.kind === "fixed_control_clipped");
    const screenshotUrl = await page
      .screenshot({ fullPage: true })
      .then((buffer) => saveUploadFile(buffer, ".png"))
      .catch(() => null);
    findings.push(
      recordBugFinding({
        source: "ui_exploratory",
        severity: impairsUse ? "medium" : "low",
        rootCause: "REAL_UI_BUG",
        defectClassification: "CONFIRMED_PRODUCT_BUG",
        priority: impairsUse ? "P2" : "P3",
        moduleFeature: `Responsive UI → ${screen.name}`,
        title: `UI/responsive defect on ${screen.name} at ${viewport.width}x${viewport.height}`,
        detail: confirmed.map((i) => i.detail).join("\n"),
        screenId,
        runId,
        environment: { browser: "Chromium", os: process.platform, viewport: `${viewport.width}x${viewport.height}` },
        evidence: { viewport, issues: confirmed },
        expectedResult: "Product content, controls, labels, and dialogs should remain visible, named, and usable at the tested viewport.",
        actualResult: confirmed.map((i) => i.detail).join(" "),
        reproductionAttempts: 2,
        reproductionSuccesses: 2,
        validationStatus: "confirmed",
        requirementReference: "Established responsive-usability and accessibility behavior at the explicitly tested viewport.",
        businessImpact: impairsUse
          ? "Users at this viewport cannot fully view or operate the affected control."
          : "Users encounter clipped content, undersized touch targets, or controls without accessible names.",
        severityJustification: impairsUse
          ? "Medium because an affected fixed control or modal is not fully usable, while the rest of the page remains available."
          : "Low because the reproduced issue affects accessibility or presentation without blocking the full workflow.",
        priorityJustification: impairsUse
          ? "P2 because an important responsive interaction is impaired and needs correction."
          : "P3 because the issue is localized and does not block the primary workflow.",
        regressionRisk: "medium",
        regressionRiskReason: "Responsive CSS and shared control styles can affect multiple viewport sizes and screens.",
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

    const totalAttempts = finding.reproduction_attempts + 1;
    const totalSuccesses = finding.reproduction_successes + (confirmed ? 1 : 0);
    const gateInput: BugFindingInput = {
      source: finding.source,
      severity: finding.severity,
      title: finding.title,
      detail: finding.detail,
      evidence,
      screenshotUrl: finding.screenshot_url,
      videoUrl: finding.video_url,
      expectedResult: finding.expected_result || undefined,
      actualResult: finding.actual_result || undefined,
      requirementReference: finding.requirement_reference || undefined,
      businessImpact: finding.business_impact || undefined,
      severityJustification: finding.severity_justification || undefined,
      priorityJustification: finding.priority_justification || undefined,
      suspectedRootCause: finding.suspected_root_cause || undefined,
      defectClassification: "CONFIRMED_PRODUCT_BUG",
    };
    const qualityGate = evaluateQualityGate(gateInput, totalAttempts, totalSuccesses);
    const productConfirmed = confirmed && qualityGate.passed;
    const validationStatus = !confirmed ? "rejected" : productConfirmed ? "confirmed" : "candidate";
    const classification: DefectClassification = productConfirmed ? "CONFIRMED_PRODUCT_BUG" : "UNCERTAIN";
    const confidence = confidenceFromGate(qualityGate, totalAttempts, totalSuccesses);
    db.prepare(`
      UPDATE bug_findings
      SET reproduction_attempts = reproduction_attempts + 1,
          reproduction_successes = reproduction_successes + ?,
          validation_status = ?,
          defect_classification = ?,
          quality_gate_json = ?,
          ai_confidence = ?,
          ai_confidence_reason = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      confirmed ? 1 : 0,
      validationStatus,
      classification,
      JSON.stringify(qualityGate),
      confidence,
      confidenceReason(qualityGate, totalAttempts, totalSuccesses),
      new Date().toISOString(),
      finding.id
    );
    finding.reproduction_attempts += 1;
    if (confirmed) {
      finding.reproduction_successes += 1;
      finding.validation_status = validationStatus;
      finding.defect_classification = classification;
      finding.quality_gate_json = JSON.stringify(qualityGate);
      finding.ai_confidence = confidence;
      finding.ai_confidence_reason = confidenceReason(qualityGate, totalAttempts, totalSuccesses);
      if (productConfirmed) autoFileIfSevere(finding);
    } else {
      finding.validation_status = "rejected";
      finding.defect_classification = "UNCERTAIN";
      finding.quality_gate_json = JSON.stringify(qualityGate);
      finding.ai_confidence = confidence;
      finding.ai_confidence_reason = confidenceReason(qualityGate, totalAttempts, totalSuccesses);
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
    const targetOrigin = originOf(screen.url_or_path);

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
      const responseOrigin = originOf(res.url());
      if (targetOrigin && responseOrigin !== targetOrigin) return;
      if (res.status() >= 500) serverErrors.push({ url: res.url(), status: res.status() });
      else if (res.status() >= 400 && res.request().resourceType() === "document") {
        clientErrors.push({ url: res.url(), status: res.status() });
      }
    });
    page.on("requestfailed", (req) => {
      if (targetOrigin && originOf(req.url()) !== targetOrigin) return;
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

    if (mainResponse && mainResponse.status() >= 400 && mainResponse.status() < 500) {
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
        rootCause: "REAL_API_BUG",
        defectClassification: "CONFIRMED_PRODUCT_BUG",
        priority: "P0",
        moduleFeature: `Page load API → ${screen.name}`,
        title: `Server error(s) while loading ${screen.name}`,
        detail: serverErrors.map((e) => `HTTP ${e.status} — ${e.url}`).join("\n"),
        screenId,
        runId,
        evidence: { serverErrors },
        expectedResult: "Same-origin application requests required to load the screen should complete without HTTP 5xx responses.",
        actualResult: `${serverErrors.length} same-origin request(s) returned HTTP 5xx while the screen loaded.`,
        requirementReference: "Established application behavior: loading a cataloged product screen must not trigger an internal server error.",
        businessImpact: "The screen loads with failed application data or functionality and the related user workflow may be unavailable.",
        severityJustification: "Critical because required same-origin application requests repeatedly fail with server errors.",
        priorityJustification: "P0 because a server-side failure occurs during normal screen loading.",
        regressionRisk: "high",
        regressionRiskReason: "The failed same-origin endpoint may serve multiple screens and workflows.",
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
          rootCause: "REAL_UI_BUG",
          defectClassification: "CONFIRMED_PRODUCT_BUG",
          priority: "P2",
          moduleFeature: `Rendered content → ${screen.name}`,
          title: `Broken image(s) on ${screen.name}`,
          detail: brokenImages.join("\n"),
          screenId,
          runId,
          evidence: { brokenImages },
          expectedResult: "Visible product images should load successfully and have non-zero natural dimensions.",
          actualResult: `${brokenImages.length} visible image(s) repeatedly completed with zero natural width.`,
          requirementReference: "Established rendered-UI behavior for visible product images.",
          businessImpact: "Users cannot view the affected visual content.",
          severityJustification: "Medium because visible content is unavailable, while the rest of the screen remains accessible.",
          priorityJustification: "P2 because the defect is user-visible and affects content comprehension.",
          regressionRisk: "medium",
          regressionRiskReason: "Shared image URLs or asset delivery can affect other screens.",
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
          rootCause: "REAL_PRODUCT_BUG",
          defectClassification: "CONFIRMED_PRODUCT_BUG",
          priority: "P2",
          moduleFeature: `Navigation → ${screen.name}`,
          title: `Broken internal link(s) on ${screen.name}`,
          detail: brokenLinks.map((l) => `HTTP ${l.status} — ${l.url} (${l.label})`).join("\n"),
          screenId,
          runId,
          evidence: { brokenLinks },
          expectedResult: "Visible same-origin navigation links should resolve to a valid application response.",
          actualResult: `${brokenLinks.length} visible same-origin link(s) repeatedly returned HTTP 4xx/5xx.`,
          requirementReference: "Established navigation behavior for visible same-origin product links.",
          businessImpact: "Users cannot reach the linked product destination.",
          severityJustification: "Medium because navigation to the affected destination is broken but the source page remains usable.",
          priorityJustification: "P2 because the broken path blocks a related workflow with a possible alternative route.",
          regressionRisk: "medium",
          regressionRiskReason: "Shared routes and navigation components may expose the same broken destination elsewhere.",
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
      // A transport failure may be local network/environment instability. It
      // is intentionally not promoted to a product link defect.
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
          const majorRegression = Math.max(firstPercent, secondPercent) >= 20;
          allFindings.push(
            recordBugFinding({
              source: "ui_exploratory",
              severity: majorRegression ? "high" : "medium",
              rootCause: "REAL_UI_BUG",
              defectClassification: "CONFIRMED_PRODUCT_BUG",
              priority: majorRegression ? "P1" : "P2",
              moduleFeature: `Visual regression → ${screenName}`,
              title: `Meaningful visual regression on ${screenName}`,
              detail: `The page differs from its approved visual baseline by ${firstPercent}% and ${secondPercent}% in two independent captures.`,
              screenId,
              evidence: { baseline: screen.visual_baseline_ref, attempts: [firstDiff, secondDiff] },
              expectedResult: "The rendered screen should match its approved visual baseline apart from ignored dynamic/rendering noise.",
              actualResult: `Material visual differences reproduced twice (${firstPercent}% and ${secondPercent}%).`,
              reproductionAttempts: 2,
              reproductionSuccesses: 2,
              validationStatus: "confirmed",
              requirementReference: "Approved visual baseline for this screen; dynamic timestamps, advertisements, animations, and sub-2% rendering noise are excluded.",
              businessImpact: majorRegression
                ? "Users see a major unintended change across a substantial portion of the screen."
                : "Users see a material unintended visual difference from the approved screen.",
              severityJustification: majorRegression
                ? "High because at least 20% of the rendered screen differs from the approved baseline."
                : "Medium because the change exceeds the 2% material-difference threshold but affects less than 20%.",
              priorityJustification: majorRegression
                ? "P1 because a large user-visible regression requires prompt review."
                : "P2 because the regression is meaningful but not proven to block the workflow.",
              regressionRisk: "high",
              regressionRiskReason: "Shared layout, theme, and component changes can affect multiple screens.",
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
