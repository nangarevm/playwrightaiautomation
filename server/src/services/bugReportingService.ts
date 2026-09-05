// Phase 5 -- developer-ready reporting (master prompt #23/#24). With the
// fingerprint/correlation/confidence skeleton already landed in Phase 1B,
// this phase is about PRESENTING what's already captured, not new detection
// logic: a formatted bug report per the master prompt's own template shape,
// dashboard rollups extending reportingService.ts's existing pattern, and a
// bounded re-verification path for high-confidence findings before their
// confidence is treated as final (master prompt #21: "a bug should ideally
// be reproduced before assigning high confidence").

import { db } from "../db.js";
import { getBugFinding, listBugFindings, recordReproductionAttempt, scanScreenForUiBugs, type BugFindingRow } from "./bugDetectionService.js";

export const BUG_REPORTING_CONFIG = {
  // A finding is only worth an on-demand re-verification call if it's
  // already scored above this bar -- re-verifying a low-confidence finding
  // just to lower it further isn't the point of this check (the confidence
  // score already says "treat this skeptically").
  reverifyConfidenceThreshold: 0.6,
  dashboardTopN: 10,
};

function resolveScreenUrl(screenId: string | null): string | null {
  if (!screenId) return null;
  const row = db.prepare("SELECT url_or_path FROM screens WHERE id = ?").get(screenId) as { url_or_path: string | null } | undefined;
  return row?.url_or_path ?? null;
}

function confidenceLabel(score: number | null): string {
  if (score === null) return "Not yet scored";
  if (score >= 0.7) return "High";
  if (score >= 0.45) return "Medium";
  return "Low";
}

// Deterministic root-cause ranking: which category is most likely the actual
// cause vs. a downstream symptom, when several findings are correlated
// together. Kept as a hand-rolled rule (not an LLM call) per this session's
// established "deterministic rules first" philosophy -- see
// IMPLEMENTATION_PLAN.md's principle #3 and risk #3 (new LLM call volume
// needs explicit sign-off before it ships; this doesn't add any).
const ROOT_CAUSE_RANK: Record<string, number> = {
  security: 6,
  "api-status": 5,
  "api-schema": 5,
  "ui-api-mismatch": 4,
  functional: 3,
  "console-error": 2,
  "ui-dom": 1,
  performance: 1,
  accessibility: 1,
  "ui-visual": 0,
};

function rankOf(f: BugFindingRow): number {
  return f.category ? (ROOT_CAUSE_RANK[f.category] ?? 0) : 0;
}

/**
 * For a correlated group of findings, infers (rule-based, not LLM) which one
 * is most likely the actual root cause vs. a downstream symptom, and
 * persists that narrative onto every finding in the group -- always marked
 * root_cause_is_inferred = 1 (never presented as confirmed fact, per master
 * prompt #19). A standalone (uncorrelated) finding gets no narrative: its
 * own `detail` field already IS the closest thing to a root-cause
 * description, so there's nothing this adds beyond restating it.
 */
export function inferAndPersistRootCause(correlationGroupId: string): string | null {
  const findings = db.prepare("SELECT * FROM bug_findings WHERE correlation_group_id = ?").all(correlationGroupId) as BugFindingRow[];
  if (findings.length < 2) return null;

  const sorted = [...findings].sort((a, b) => rankOf(b) - rankOf(a));
  const primary = sorted[0];
  const symptoms = sorted.slice(1);
  const narrative = `"${primary.title}" (${primary.category}) is the most likely root cause; ${symptoms
    .map((s) => `"${s.title}" (${s.category})`)
    .join(", ")} appear to be downstream symptoms observed in the same scan.`;

  const now = new Date().toISOString();
  const update = db.prepare("UPDATE bug_findings SET root_cause_narrative = ?, root_cause_is_inferred = 1, updated_at = ? WHERE id = ?");
  const tx = db.transaction((rows: BugFindingRow[]) => {
    for (const row of rows) update.run(narrative, now, row.id);
  });
  tx(findings);
  return narrative;
}

/**
 * Master-prompt #24 bug report template: Title/Severity/Priority/Confidence/
 * Category/URL/Steps/Expected/Actual/Evidence/Probable Root Cause. Computes
 * (and persists, if missing) the group's root-cause narrative first when the
 * finding belongs to a correlation group.
 */
export function formatBugReport(findingId: string): string {
  const finding = getBugFinding(findingId);
  if (!finding) throw new Error("Bug finding not found.");

  if (finding.correlation_group_id && !finding.root_cause_narrative) {
    inferAndPersistRootCause(finding.correlation_group_id);
  }
  const current = getBugFinding(findingId)!;

  const url = (() => {
    try {
      const evidence = JSON.parse(current.evidence || "{}");
      if (typeof evidence.url === "string") return evidence.url;
      if (typeof evidence.endpointKey === "string") return evidence.endpointKey;
    } catch {
      /* fall through to screen lookup */
    }
    return resolveScreenUrl(current.screen_id) ?? "N/A";
  })();

  const steps: string[] = (() => {
    try {
      return JSON.parse(current.steps_to_reproduce || "[]");
    } catch {
      return [];
    }
  })();
  const actual = steps.length ? steps[steps.length - 1] : current.detail;

  const evidenceLines: string[] = [];
  if (current.screenshot_url) evidenceLines.push(`- Screenshot: ${current.screenshot_url}`);
  if (current.video_url) evidenceLines.push(`- Video: ${current.video_url}`);
  evidenceLines.push(`- Raw evidence: ${current.evidence}`);

  const rootCauseSection = current.root_cause_narrative
    ? `${current.root_cause_narrative}${current.root_cause_is_inferred ? "\n\n**(AI Inference -- not confirmed)**" : ""}`
    : "Not yet analyzed -- this finding is not part of a correlated group.";

  return [
    `# Bug Report: ${current.title}`,
    "",
    `**Severity:** ${current.severity}`,
    `**Priority:** ${current.priority ?? "Not yet scored"}`,
    `**Confidence:** ${current.confidence_score !== null ? `${Math.round(current.confidence_score * 100)}% (${confidenceLabel(current.confidence_score)})` : "Not yet scored"}`,
    `**Category:** ${current.category ?? "uncategorized"}`,
    `**URL:** ${url}`,
    `**Status:** ${current.status}`,
    `**Reproducibility:** ${current.reproducibility_successes}/${current.reproducibility_attempts} scan(s)`,
    current.correlation_group_id ? `**Correlated with:** ${(db.prepare("SELECT COUNT(*) as c FROM bug_findings WHERE correlation_group_id = ? AND id != ?").get(current.correlation_group_id, current.id) as any).c} other finding(s)` : "",
    "",
    "## Steps to Reproduce",
    ...steps.map((s, i) => `${i + 1}. ${s}`),
    "",
    "## Expected Result",
    "No defect of this kind -- the checked condition should hold.",
    "",
    "## Actual Result",
    actual,
    "",
    "## Evidence",
    ...evidenceLines,
    "",
    "## Probable Root Cause",
    rootCauseSection,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * Extends reportingService.ts's existing dashboard pattern with the
 * category-level rollups master prompt #23 asks for -- additive to the
 * existing test-execution dashboard (getDashboardSummary), not a new one.
 */
export function getBugDashboard() {
  const all = listBugFindings();

  const byCategory: Record<string, number> = {};
  const byPriority: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  let newCount = 0;
  let recurringCount = 0;
  let correlatedFindingCount = 0;
  const correlationGroups = new Set<string>();
  let confidenceSum = 0;
  let confidenceScored = 0;

  const screenCounts = new Map<string, number>();
  const endpointCounts = new Map<string, number>();

  for (const f of all) {
    byCategory[f.category ?? "uncategorized"] = (byCategory[f.category ?? "uncategorized"] ?? 0) + 1;
    if (f.priority) byPriority[f.priority] = (byPriority[f.priority] ?? 0) + 1;
    bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
    if (f.reproducibility_attempts <= 1) newCount++;
    else recurringCount++;
    if (f.correlation_group_id) {
      correlatedFindingCount++;
      correlationGroups.add(f.correlation_group_id);
    }
    if (f.confidence_score !== null) {
      confidenceSum += f.confidence_score;
      confidenceScored++;
    }
    if (f.screen_id) screenCounts.set(f.screen_id, (screenCounts.get(f.screen_id) ?? 0) + 1);
    try {
      const evidence = JSON.parse(f.evidence || "{}");
      const endpointKey = evidence.endpointKey || evidence.rule?.endpointKey;
      if (typeof endpointKey === "string") endpointCounts.set(endpointKey, (endpointCounts.get(endpointKey) ?? 0) + 1);
    } catch {
      /* non-JSON/unstructured evidence -- skip endpoint attribution */
    }
  }

  const screenNames = new Map(
    (db.prepare("SELECT id, name FROM screens").all() as Array<{ id: string; name: string }>).map((s) => [s.id, s.name])
  );

  const topFailingPages = Array.from(screenCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, BUG_REPORTING_CONFIG.dashboardTopN)
    .map(([screenId, count]) => ({ screenId, screenName: screenNames.get(screenId) ?? screenId, count }));

  const topFailingApis = Array.from(endpointCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, BUG_REPORTING_CONFIG.dashboardTopN)
    .map(([endpointKey, count]) => ({ endpointKey, count }));

  return {
    totalFindings: all.length,
    byCategory,
    byPriority,
    bySeverity,
    newCount,
    recurringCount,
    duplicatesCollapsed: all.reduce((sum, f) => sum + (f.reproducibility_attempts - 1), 0),
    correlationGroupCount: correlationGroups.size,
    correlatedFindingCount,
    averageConfidence: confidenceScored > 0 ? Math.round((confidenceSum / confidenceScored) * 100) / 100 : null,
    topFailingPages,
    topFailingApis,
  };
}

export interface BugGroupView {
  correlationGroupId: string;
  findings: BugFindingRow[];
  rootCauseNarrative: string | null;
}

export function getBugGroup(correlationGroupId: string): BugGroupView {
  const findings = db.prepare("SELECT * FROM bug_findings WHERE correlation_group_id = ? ORDER BY created_at ASC").all(correlationGroupId) as BugFindingRow[];
  if (findings.length === 0) throw new Error("Correlation group not found.");
  if (!findings[0].root_cause_narrative) {
    const narrative = inferAndPersistRootCause(correlationGroupId);
    if (narrative) return { correlationGroupId, findings: findings.map((f) => ({ ...f, root_cause_narrative: narrative, root_cause_is_inferred: 1 })), rootCauseNarrative: narrative };
  }
  return { correlationGroupId, findings, rootCauseNarrative: findings[0].root_cause_narrative };
}

/**
 * Re-verifies a high-confidence finding by re-scanning its screen, per master
 * prompt #21 ("a bug should ideally be reproduced before assigning high
 * confidence"). Reuses the existing scan pipeline entirely -- if the same
 * fingerprint reappears, scanScreenForUiBugs' own recordBugFinding call
 * already bumped reproducibility (returned here as-is, no double counting);
 * if it does NOT reappear, this records a failed reproduction attempt
 * explicitly (attempts += 1, successes unchanged), which lowers confidence
 * accordingly -- an honest signal that the finding may be transient/flaky
 * rather than a confirmed, reliably-reproducible defect.
 */
export async function reverifyHighConfidenceFinding(findingId: string): Promise<BugFindingRow> {
  const finding = getBugFinding(findingId);
  if (!finding) throw new Error("Bug finding not found.");
  if (!finding.screen_id) throw new Error("Cannot re-verify a finding with no associated screen.");
  const screen = db.prepare("SELECT id, name, url_or_path FROM screens WHERE id = ?").get(finding.screen_id) as
    | { id: string; name: string; url_or_path: string | null }
    | undefined;
  if (!screen?.url_or_path) throw new Error("This finding's screen has no URL to re-verify against.");

  const rescanFindings = await scanScreenForUiBugs(screen, undefined, screen.id);
  const reproduced = rescanFindings.find((f) => f.id === findingId);
  if (reproduced) return reproduced; // already bumped by the rescan's own recordBugFinding dedup path
  return recordReproductionAttempt(findingId, false);
}
