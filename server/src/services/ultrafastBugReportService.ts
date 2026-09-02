// Ultrafast Mode Bug Report Service
// Collects bugs from crawl and test execution, aggregates them,
// and generates a comprehensive bug report for the user

import { db } from "../db.js";
import { listBugFindings, BugFindingRow } from "./bugDetectionService.js";
import type { BugSeverity } from "./bugDetectionService.js";

export interface AggregatedBug {
  id: string;
  title: string;
  severity: BugSeverity;
  source: "ui_exploratory" | "api_fuzz" | "regression" | "test_failure";
  category: "ui" | "navigation" | "content" | "performance" | "functional" | "accessibility";
  pageTitle: string | null;
  stepsToReproduce: string[];
  screenshot: string | null;
  evidence: Record<string, any>;
}

export interface UltrafastBugReport {
  siteId: string;
  timestamp: string;
  totalBugsFound: number;
  severityCounts: {
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
  byCategory: Record<string, { count: number; bugs: AggregatedBug[] }>;
  topIssues: AggregatedBug[];
  recommendations: string[];
  allBugs: AggregatedBug[];
}

// Collect bugs discovered during crawl for a site
export function collectCrawlBugsForSite(siteId: string): BugFindingRow[] {
  const page = db.prepare("SELECT id FROM crawl_pages WHERE site_id = ?").all(siteId) as Array<{ id: string }>;
  const pageIds = page.map((p) => p.id);

  const allBugs: BugFindingRow[] = [];
  for (const pageId of pageIds) {
    const bugs = db
      .prepare(
        "SELECT * FROM bug_findings WHERE screen_id IN (SELECT id FROM screens WHERE url_or_path IN (SELECT url FROM crawl_pages WHERE id = ?))"
      )
      .all(pageId) as BugFindingRow[];
    allBugs.push(...bugs);
  }
  return allBugs;
}

export interface ExecutionBug {
  id: string;
  title: string;
  severity: BugSeverity;
  source: "test_failure";
  detail: string;
  testCaseId: string;
  stepsToReproduce: string[];
  screenshot: string | null;
}

// Collect bugs from test execution (failures, timeouts, errors), joined all the
// way back to the originating test case so the report can show the *actual*
// steps that were run (not just "a test failed") -- preconditions, the test
// case's own numbered steps, expected vs. actual result. Previously this only
// read execution_evidence and mislabeled the run id as the test case id.
export function collectTestExecutionBugs(runIds: string[]): ExecutionBug[] {
  if (runIds.length === 0) return [];
  const placeholders = runIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT ee.id, ee.test_title, ee.error_message, ee.failure_class, ee.failure_label,
              er.id as run_id, er.browser_set,
              tc.id as test_case_id, tc.steps as tc_steps, tc.expected_result
       FROM execution_evidence ee
       JOIN execution_runs er ON ee.run_id = er.id
       JOIN automation_scripts a ON er.script_id = a.id
       JOIN test_cases tc ON a.test_case_id = tc.id
       WHERE ee.run_id IN (${placeholders}) AND ee.error_message IS NOT NULL`
    )
    .all(...runIds) as Array<{
    id: string;
    test_title: string;
    error_message: string | null;
    failure_class: string | null;
    failure_label: string | null;
    run_id: string;
    browser_set: string | null;
    test_case_id: string;
    tc_steps: string | null;
    expected_result: string | null;
  }>;

  return rows.map((ev) => {
    // execution_evidence has no duration_ms column (it never has -- a prior
    // version of this query selected one anyway, which meant this function
    // always threw "no such column: duration_ms" and every caller's
    // try/catch silently swallowed it, so a test-execution bug report was
    // never actually produced). Detect a timeout from the error text itself
    // instead, same signal classifyTestFailure in executionService.ts uses.
    const isTimeout = /test timeout of \d+ms exceeded/i.test(ev.error_message || "");
    const isMissingElement = ev.error_message?.includes("locator") || ev.error_message?.includes("not found");
    const isAssertion = ev.failure_class === "possible_bug" || ev.error_message?.toLowerCase().includes("assert");

    const severity: BugSeverity = isTimeout ? "high" : isMissingElement ? "medium" : isAssertion ? "high" : "medium";

    let steps: string[] = [];
    try {
      steps = ev.tc_steps ? JSON.parse(ev.tc_steps) : [];
    } catch {
      steps = [];
    }

    const stepsToReproduce = [
      ev.browser_set ? `Preconditions: run on the ${ev.browser_set} browser.` : undefined,
      ...(steps.length > 0 ? steps.map((s, i) => `Step ${i + 1}: ${s}`) : [`Run the automated test: "${ev.test_title}"`]),
      `Expected result: ${ev.expected_result || "See the linked test case for the expected outcome."}`,
      `Actual result: ${ev.failure_label ? `${ev.failure_label} -- ` : ""}${ev.error_message || "Test failed"}`,
    ].filter(Boolean) as string[];

    return {
      id: ev.id,
      title: isTimeout ? `Test timeout on ${ev.test_title}` : isMissingElement ? `Missing element in ${ev.test_title}` : `Failed: ${ev.test_title}`,
      severity,
      source: "test_failure",
      detail: ev.error_message || "Test failed",
      testCaseId: ev.test_case_id,
      stepsToReproduce,
      screenshot: null,
    };
  });
}

// Categorize bug by its nature
function categorizeBug(bug: any): "ui" | "navigation" | "content" | "performance" | "functional" | "accessibility" {
  const title = bug.title?.toLowerCase() || "";
  const detail = bug.detail?.toLowerCase() || "";
  const fullText = `${title} ${detail}`;

  if (fullText.includes("image") || fullText.includes("button") || fullText.includes("layout")) return "ui";
  if (fullText.includes("navigation") || fullText.includes("link") || fullText.includes("redirect")) return "navigation";
  if (fullText.includes("spelling") || fullText.includes("text") || fullText.includes("content")) return "content";
  if (fullText.includes("timeout") || fullText.includes("slow") || fullText.includes("performance")) return "performance";
  if (fullText.includes("aria") || fullText.includes("alt") || fullText.includes("accessibility")) return "accessibility";
  return "functional";
}

// Calculate severity based on bug characteristics
function calculateSeverity(bug: any): BugSeverity {
  const text = `${bug.title || ""} ${bug.detail || ""}`.toLowerCase();

  // Critical indicators
  if (text.includes("500") || text.includes("crash") || text.includes("broken")) return "critical";
  if (text.includes("cannot") || text.includes("unable") || text.includes("blocked")) return "critical";

  // High indicators
  if (text.includes("timeout") || text.includes("error") || text.includes("fail")) return "high";
  if (bug.severity === "high") return "high";

  // Medium indicators
  if (text.includes("missing") || text.includes("warning")) return "medium";
  if (bug.severity === "medium") return "medium";

  return "low";
}

// Aggregate all bugs from crawl and execution
export function aggregateUltrafastBugs(crawlBugs: BugFindingRow[], executionBugs: ExecutionBug[]): AggregatedBug[] {
  const bugs: AggregatedBug[] = [];

  // Add crawl bugs
  for (const bug of crawlBugs) {
    bugs.push({
      id: bug.id,
      title: bug.title,
      severity: calculateSeverity(bug),
      source: bug.source,
      category: categorizeBug(bug),
      pageTitle: null, // Could be populated from screen data if needed
      stepsToReproduce: bug.steps_to_reproduce ? JSON.parse(bug.steps_to_reproduce) : [],
      screenshot: bug.screenshot_url,
      evidence: bug.evidence ? JSON.parse(bug.evidence) : {},
    });
  }

  // Add execution bugs -- stepsToReproduce/screenshot already built by
  // collectTestExecutionBugs from the actual test case's steps and expected
  // result, not a generic placeholder.
  for (const bug of executionBugs) {
    bugs.push({
      id: bug.id,
      title: bug.title,
      severity: bug.severity || calculateSeverity(bug),
      source: "test_failure",
      category: categorizeBug(bug),
      pageTitle: null,
      stepsToReproduce: bug.stepsToReproduce?.length ? bug.stepsToReproduce : [`Run test case: ${bug.testCaseId}`],
      screenshot: bug.screenshot ?? null,
      evidence: { errorMessage: bug.detail, testCaseId: bug.testCaseId },
    });
  }

  // Deduplicate similar bugs (same title/page = likely same issue)
  const seen = new Set<string>();
  return bugs.filter((bug) => {
    const key = `${bug.title}|${bug.category}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Generate comprehensive bug report
export function generateUltrafastBugReport(siteId: string, crawlBugs: BugFindingRow[], executionBugs: any[]): UltrafastBugReport {
  const aggregated = aggregateUltrafastBugs(crawlBugs, executionBugs);

  // Count by severity
  const severityCounts = {
    critical: aggregated.filter((b) => b.severity === "critical").length,
    high: aggregated.filter((b) => b.severity === "high").length,
    medium: aggregated.filter((b) => b.severity === "medium").length,
    low: aggregated.filter((b) => b.severity === "low").length,
  };

  // Group by category
  const byCategory: Record<string, { count: number; bugs: AggregatedBug[] }> = {};
  for (const bug of aggregated) {
    if (!byCategory[bug.category]) {
      byCategory[bug.category] = { count: 0, bugs: [] };
    }
    byCategory[bug.category].count++;
    byCategory[bug.category].bugs.push(bug);
  }

  // Top issues (critical + high severity)
  const topIssues = aggregated.filter((b) => b.severity === "critical" || b.severity === "high").slice(0, 5);

  // Generate recommendations based on bugs
  const recommendations = generateRecommendations(aggregated);

  return {
    siteId,
    timestamp: new Date().toISOString(),
    totalBugsFound: aggregated.length,
    severityCounts,
    byCategory,
    topIssues,
    recommendations,
    allBugs: aggregated,
  };
}

// Generate actionable recommendations from bugs
function generateRecommendations(bugs: AggregatedBug[]): string[] {
  const recommendations: string[] = [];

  // Critical issues
  const criticalBugs = bugs.filter((b) => b.severity === "critical");
  if (criticalBugs.length > 0) {
    recommendations.push(`⚠️ URGENT: Fix ${criticalBugs.length} critical issue(s) before deployment`);
    for (const bug of criticalBugs.slice(0, 2)) {
      recommendations.push(`  - ${bug.title}`);
    }
  }

  // Category-specific recommendations
  const uiBugs = bugs.filter((b) => b.category === "ui");
  if (uiBugs.length > 0) {
    recommendations.push(`Fix ${uiBugs.length} UI issue(s) (broken images, missing elements, etc.)`);
  }

  const accessibilityBugs = bugs.filter((b) => b.category === "accessibility");
  if (accessibilityBugs.length > 0) {
    recommendations.push(`Improve accessibility: add ${accessibilityBugs.length} missing labels/descriptions`);
  }

  const performanceBugs = bugs.filter((b) => b.category === "performance");
  if (performanceBugs.length > 0) {
    recommendations.push(`Investigate ${performanceBugs.length} performance issue(s) causing timeouts`);
  }

  // Testing recommendations
  if (bugs.filter((b) => b.source === "test_failure").length > 0) {
    recommendations.push("Review and stabilize flaky tests before merging to production");
  }

  return recommendations;
}

// Export bug report as JSON, HTML, or PDF
export function formatBugReport(report: UltrafastBugReport, format: "json" | "html" | "pdf" = "json"): string {
  if (format === "json") {
    return JSON.stringify(report, null, 2);
  }

  if (format === "html") {
    return `
      <html>
        <head>
          <title>Ultrafast Bug Report - ${new Date().toLocaleDateString()}</title>
          <style>
            body { font-family: system-ui; margin: 20px; }
            h1 { color: #333; }
            .critical { color: #d32f2f; }
            .high { color: #f57c00; }
            .medium { color: #fbc02d; }
            .low { color: #388e3c; }
            .bug { border: 1px solid #ddd; padding: 15px; margin: 10px 0; border-radius: 4px; }
            .summary { background: #f5f5f5; padding: 15px; border-radius: 4px; margin: 20px 0; }
            .stats { display: flex; gap: 20px; margin: 10px 0; }
            .stat { padding: 10px; background: white; border-radius: 4px; }
          </style>
        </head>
        <body>
          <h1>Ultrafast Bug Report</h1>
          <div class="summary">
            <h2>Summary</h2>
            <div class="stats">
              <div class="stat"><strong>${report.totalBugsFound}</strong> Total Bugs</div>
              <div class="stat critical"><strong>${report.severityCounts.critical}</strong> Critical</div>
              <div class="stat high"><strong>${report.severityCounts.high}</strong> High</div>
              <div class="stat medium"><strong>${report.severityCounts.medium}</strong> Medium</div>
              <div class="stat low"><strong>${report.severityCounts.low}</strong> Low</div>
            </div>
          </div>
          
          <h2>Top Issues</h2>
          ${report.topIssues.map((bug) => `
            <div class="bug ${bug.severity}">
              <strong>${bug.title}</strong> <span class="${bug.severity}">[${bug.severity.toUpperCase()}]</span>
              <p>${bug.evidence?.errorMessage || "See attached evidence"}</p>
              ${bug.screenshot ? `<p><img src="${bug.screenshot}" style="max-width: 400px;"></p>` : ""}
            </div>
          `).join("")}
          
          <h2>Recommendations</h2>
          <ul>
            ${report.recommendations.map((rec) => `<li>${rec}</li>`).join("")}
          </ul>
        </body>
      </html>
    `;
  }

  // PDF format would require external library (pdfkit)
  return format === "pdf" ? "PDF format not yet implemented" : JSON.stringify(report);
}
