// v4.6 FR4.25/FR4.26/FR4.27/FR4.30: Ultrafast Mode orchestration -- a single-user, zero-
// intermediate-screen trigger path. Given just a script or test-case reference, this module:
//   1. auto-resolves the default/last-used Execution Profile (FR-4.13) and default Environment
//      (FR-4.19), logging a system-actor audit entry for each auto-selection (FR-4.30);
//   2. auto-accepts any awaiting-review test case whose confidence score clears the QA-Lead-
//      editable threshold -- via the SAME applyTestCaseReview() state machine a human accept
//      uses (FR-2.4), so it is a real accept, not a bypass -- and routes anything below
//      threshold into a non-blocking "needs review later" queue (FR-4.26), logging both outcomes.
//      This also means the SAME FR-2.4/FR-4.29 "must be accepted before codegen" gate that
//      generateAutomationScript() already enforces still applies here unweakened: a case that
//      cannot be auto-accepted has no script to run yet, so the run for that specific case is
//      simply not started this round (still 200/non-blocking -- see `run: null` below), not a
//      bypass of the gate;
//   3. once accepted (just now, or previously), generates the automation script if one doesn't
//      already exist, then immediately starts the run (reusing runExecution) tagged
//      speed_mode: "ultrafast";
//   4. on completion, returns a link to the FR-6.11 interactive HTML report scoped to this run,
//      so it is retrievable directly from the trigger response with no separate publish step
//      (FR-4.27).
//
// Out of scope by the SRS's own "Assumption" callout (Section 12.10): this module does not
// touch FR-8.5 (team/module routing) or FR-8.6 (second-reviewer critical-path gate) -- if a
// test case requires second-reviewer sign-off, applyTestCaseReview's existing FR-8.6 gate still
// blocks the auto-accept (surfaced below as an "auto-accept skipped" outcome, itself routed to
// needs-review-later rather than silently failing the run), exactly as it would for a human.

import { db } from "../db.js";
import { runExecution, suggestExecutionProfile, summarizeRunForClient } from "./executionService.js";
import { applyTestCaseReview, TestCaseReviewError } from "./testCaseFeatures.js";
import { logSystemAudit, getUltrafastConfidenceThreshold } from "./adminService.js";
import { generateAutomationScript, SecurityScanFailedError } from "./codegenService.js";
import { generateUltrafastBugReport, collectCrawlBugsForSite, collectTestExecutionBugs } from "./ultrafastBugReportService.js";

export interface ResolvedDefaults {
  profileId: string | null;
  profileReason: string;
  environmentId: string | null;
  environmentReason: string;
}

// FR-4.13/FR-4.19/FR-4.25: resolve the default/last-used Execution Profile and default
// Environment for a script, with no user input. "Last-used" is read from this script's most
// recent run; falling back to the platform's suggested default profile (FR-4.14's existing
// logic) and, for Environment, the profile's configured default_environment_id, then this
// script's last-used Environment, then the first Environment configured on the platform.
export function resolveDefaultProfileAndEnvironment(scriptId: string): ResolvedDefaults {
  const lastRun = db
    .prepare("SELECT profile_id, environment_id FROM execution_runs WHERE script_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(scriptId) as { profile_id: string | null; environment_id: string | null } | undefined;

  let profileId: string | null = lastRun?.profile_id ?? null;
  let profileReason = "";
  if (profileId) {
    profileReason = "last-used Execution Profile for this script (FR-4.13)";
  } else {
    const suggestion = suggestExecutionProfile({});
    profileId = suggestion.suggestedProfileId;
    profileReason = suggestion.reason ? `default Execution Profile -- ${suggestion.reason} (FR-4.13)` : "no Execution Profile configured";
  }

  const profile = profileId ? (db.prepare("SELECT * FROM execution_profiles WHERE id = ?").get(profileId) as any) : null;

  let environmentId: string | null = profile?.default_environment_id ?? null;
  let environmentReason = environmentId ? "profile's configured default Environment (FR-4.19)" : "";
  if (!environmentId) {
    environmentId = lastRun?.environment_id ?? null;
    if (environmentId) environmentReason = "last-used Environment for this script (FR-4.19)";
  }
  if (!environmentId) {
    const firstEnv = db.prepare("SELECT id FROM environments ORDER BY created_at ASC LIMIT 1").get() as { id: string } | undefined;
    environmentId = firstEnv?.id ?? null;
    environmentReason = environmentId ? "default Environment -- first configured (FR-4.19)" : "no Environment configured";
  }

  return { profileId, profileReason, environmentId, environmentReason };
}

export interface UltrafastTriggerInput {
  script_id?: string;
  test_case_id?: string;
  target_url?: string;
}

type ReviewOutcome = {
  outcome: "auto_accepted" | "needs_review_later" | "already_accepted" | "skipped_second_reviewer_required";
  testCaseId?: string;
  confidenceScore?: number;
};

// FR-4.26: resolve a test case's review state under Ultrafast rules -- auto-accept via the
// real applyTestCaseReview() accept path if confidence clears the threshold, otherwise route
// to the non-blocking needs-review-later queue. No-op (outcome: 'already_accepted') if the
// case has already cleared human or prior-Ultrafast review.
function resolveUltrafastReview(testCaseId: string): ReviewOutcome {
  const testCase = db.prepare("SELECT * FROM test_cases WHERE id = ?").get(testCaseId) as any;
  if (!testCase) throw new Error("Test case not found");

  if (testCase.status === "accepted" || testCase.status === "edited") {
    return { outcome: "already_accepted", testCaseId, confidenceScore: testCase.confidence_score };
  }

  const threshold = getUltrafastConfidenceThreshold();

  if (testCase.confidence_score < threshold) {
    db.prepare("UPDATE test_cases SET needs_review_later = 1 WHERE id = ?").run(testCaseId);
    logSystemAudit("ultrafast_needs_review_later", "test_case", testCaseId, {
      confidence_score: testCase.confidence_score,
      threshold_used: threshold,
    });
    return { outcome: "needs_review_later", testCaseId, confidenceScore: testCase.confidence_score };
  }

  try {
    applyTestCaseReview(testCaseId, "accept", {
      reviewer_notes: `Ultrafast Mode auto-accept (confidence ${testCase.confidence_score} >= threshold ${threshold})`,
      // FR-4.29/FR-4.30: a distinct, attributable system actor -- not the anonymous default --
      // so the resulting review_audit_entries row still names a reviewer, just of actor type
      // "system" rather than "user", mirroring the audit entries logSystemAudit already writes.
      reviewer_user_id: "system:ultrafast",
    });
    logSystemAudit("ultrafast_auto_accept", "test_case", testCaseId, {
      confidence_score: testCase.confidence_score,
      threshold_used: threshold,
    });
    return { outcome: "auto_accepted", testCaseId, confidenceScore: testCase.confidence_score };
  } catch (err) {
    // FR-8.6 still applies unweakened under Ultrafast Mode -- a case that can't be
    // auto-accepted (e.g. critical-path, second-reviewer pending) is routed to
    // needs-review-later instead of failing the whole trigger.
    if (err instanceof TestCaseReviewError) {
      db.prepare("UPDATE test_cases SET needs_review_later = 1 WHERE id = ?").run(testCaseId);
      logSystemAudit("ultrafast_needs_review_later", "test_case", testCaseId, {
        confidence_score: testCase.confidence_score,
        threshold_used: threshold,
        reason: err.message,
      });
      return { outcome: "skipped_second_reviewer_required", testCaseId, confidenceScore: testCase.confidence_score };
    }
    throw err;
  }
}

// FR-4.25/FR-4.26/FR-4.27/FR-4.30
export async function triggerUltrafastRun(input: UltrafastTriggerInput) {
  let scriptId = input.script_id ?? null;
  let testCaseId = input.test_case_id ?? null;

  if (scriptId) {
    const script = db.prepare("SELECT test_case_id FROM automation_scripts WHERE id = ?").get(scriptId) as { test_case_id: string } | undefined;
    if (!script) throw new Error("Script not found");
    testCaseId = script.test_case_id;
  }

  if (!testCaseId) {
    throw new Error("script_id or test_case_id (identifying what to run) is required");
  }

  const testCase = db.prepare("SELECT * FROM test_cases WHERE id = ?").get(testCaseId) as any;
  if (!testCase) throw new Error("Test case not found");

  // FR-4.26/FR-2.4: auto-accept-or-queue before anything else -- codegen (and therefore a
  // script to run) only exists for an accepted/edited test case.
  const reviewOutcome = resolveUltrafastReview(testCaseId);

  if (reviewOutcome.outcome === "needs_review_later" || reviewOutcome.outcome === "skipped_second_reviewer_required") {
    // FR-4.26: non-blocking -- the trigger still succeeds, just with no run yet for this case.
    return {
      run: null,
      resolvedProfile: null,
      resolvedEnvironment: null,
      reviewOutcome,
      reportUrl: null,
    };
  }

  // Ensure a script exists for this now-accepted test case; generate one if not.
  if (!scriptId) {
    const existingScript = db
      // A test case can have multiple generated artifacts (typescript/.spec.ts,
      // javascript/.spec.js, python/.py -- see codegenService.ts's default
      // 3-artifact generation), inserted python-last. Plain "most recent" would
      // resolve to the .py file, which the JS/TS Playwright CLI this engine
      // shells out to can never execute ("No tests found"). Prefer a runnable
      // Playwright JS/TS script among the most recent; only fall back to
      // whatever else exists if none qualifies (e.g. a Selenium/Cypress-only
      // generation request).
      .prepare(
        `SELECT id FROM automation_scripts WHERE test_case_id = ?
         ORDER BY (CASE WHEN framework = 'playwright' AND language IN ('typescript', 'javascript') THEN 0 ELSE 1 END), created_at DESC
         LIMIT 1`
      )
      .get(testCaseId) as { id: string } | undefined;
    if (existingScript) {
      scriptId = existingScript.id;
    } else {
      await generateAutomationScript(testCaseId);
      const generated = db
        .prepare(
          `SELECT id FROM automation_scripts WHERE test_case_id = ?
           ORDER BY (CASE WHEN framework = 'playwright' AND language IN ('typescript', 'javascript') THEN 0 ELSE 1 END), created_at DESC
           LIMIT 1`
        )
        .get(testCaseId) as { id: string } | undefined;
      scriptId = generated?.id ?? null;
    }
  }

  if (!scriptId) throw new Error("Automation script could not be resolved or generated for this test case");

  // FR-4.25: auto-resolve profile + environment, no user input required. Each auto-selection
  // gets its own FR-4.30 system-actor audit entry, structurally identical to a manual one.
  const resolved = resolveDefaultProfileAndEnvironment(scriptId);
  logSystemAudit("ultrafast_profile_auto_selected", "execution_profile", resolved.profileId, {
    script_id: scriptId,
    reason: resolved.profileReason,
  });
  logSystemAudit("ultrafast_environment_auto_selected", "environment", resolved.environmentId, {
    script_id: scriptId,
    reason: resolved.environmentReason,
  });

  // FR-4.25: start the run immediately -- no confirmation dialog.
  const environment = resolved.environmentId ? (db.prepare("SELECT * FROM environments WHERE id = ?").get(resolved.environmentId) as any) : null;
  const targetUrl = input.target_url || environment?.target_url || `http://localhost:${process.env.PORT || 4100}/demo/login.html`;

  const runResult = await runExecution(scriptId, targetUrl, {
    profile_id: resolved.profileId || undefined,
    environment_id: resolved.environmentId || undefined,
    speed_mode: "ultrafast",
    trigger_source: "ultrafast",
  });

  if (runResult?.error || !runResult?.id) {
    throw new Error(runResult?.error || "Execution could not be started for this test case");
  }

  // FR-4.27: the interactive HTML report, scoped to this run, delivered directly --
  // no separate publish/export click required.
  const reportUrl = `/api/reporting/export.html?runId=${runResult.id}`;

  // Ultrafast enhancement: Collect and aggregate bugs from crawl + execution
  let bugReport = null;
  try {
    const screen = testCase.screen_id ? (db.prepare("SELECT * FROM screens WHERE id = ?").get(testCase.screen_id) as any) : null;
    const crawlSiteId = screen?.crawl_site_id || null;
    
    if (crawlSiteId) {
      // `screens.crawl_site_id` doesn't exist -- collectCrawlBugsForSite joins
      // siteId -> crawl_pages -> screens by URL instead (same fix as the
      // /reporting/ultrafast-bug-report route). The inline query here used to
      // throw and get swallowed by the outer catch, so bugReport was silently
      // always null for any crawl-originated run.
      const crawlBugs = collectCrawlBugsForSite(crawlSiteId);

      // collectTestExecutionBugs joins all the way back to the test case so the
      // report shows its actual steps/expected result, not just the run id
      // mislabeled as a test case id (the previous inline query here).
      const executionBugs = collectTestExecutionBugs([runResult.id]);

      bugReport = generateUltrafastBugReport(crawlSiteId, crawlBugs, executionBugs);
    }
  } catch (err: any) {
    // Bug report generation is best-effort -- don't fail the execution if it fails
    console.warn(`[ultrafast] bug report generation failed: ${err.message}`);
  }

  return {
    run: summarizeRunForClient(runResult),
    resolvedProfile: { id: resolved.profileId, reason: resolved.profileReason },
    resolvedEnvironment: { id: resolved.environmentId, reason: resolved.environmentReason },
    reviewOutcome,
    reportUrl,
    bugReport: bugReport ? {
      totalBugs: bugReport.totalBugsFound,
      critical: bugReport.severityCounts.critical,
      high: bugReport.severityCounts.high,
      medium: bugReport.severityCounts.medium,
      low: bugReport.severityCounts.low,
      bugReportUrl: `/api/reporting/ultrafast-bug-report?siteId=${bugReport.siteId}`,
      summary: `Found ${bugReport.totalBugsFound} issues: ${bugReport.severityCounts.critical} critical, ${bugReport.severityCounts.high} high priority`
    } : null
  };
}
