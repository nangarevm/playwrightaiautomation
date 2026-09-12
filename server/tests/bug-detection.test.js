import test from "node:test";
import assert from "node:assert/strict";
import { db } from "../src/db.ts";
import {
  getQaDashboard,
  recordBugFinding,
} from "../src/services/bugDetectionService.ts";
import { tryBuildCrawledScriptWithoutLlm } from "../src/llm/mockProvider.ts";

test.beforeEach(() => {
  db.prepare("DELETE FROM bug_findings").run();
  db.prepare("DELETE FROM qa_scan_runs").run();
});

test("a one-off observation remains a candidate, not a real product bug", () => {
  const finding = recordBugFinding({
    source: "ui_exploratory",
    severity: "high",
    title: "Checkout page showed an error",
    detail: "One uncaught error was observed.",
    evidence: { errorType: "pageerror" },
    reproductionAttempts: 1,
    reproductionSuccesses: 1,
  });

  assert.equal(finding.validation_status, "candidate");
  assert.equal(getQaDashboard().totalRealBugs, 0);
  assert.equal(getQaDashboard().unknownRequiresInvestigation, 1);
});

test("the same independently reproduced issue is confirmed and deduplicated", () => {
  const input = {
    source: "api_fuzz",
    severity: "high",
    title: "/api/orders/:id crashes on malformed id",
    detail: "GET returned HTTP 500 instead of a clean validation response.",
    evidence: { endpoint: "/api/orders/:id", status: 500 },
    expectedResult: "Malformed ids return 4xx.",
    actualResult: "Malformed id returned 500.",
    reproductionAttempts: 1,
    reproductionSuccesses: 1,
  };

  const first = recordBugFinding(input);
  const second = recordBugFinding({
    ...input,
    reproductionAttempts: 2,
    reproductionSuccesses: 2,
    validationStatus: "confirmed",
    evidence: { ...input.evidence, independentVerification: true },
  });

  assert.equal(first.id, second.id);
  assert.equal(second.validation_status, "confirmed");
  assert.equal(second.occurrence_count, 2);
  const dashboard = getQaDashboard();
  assert.equal(dashboard.totalRealBugs, 1);
  assert.equal(dashboard.highBugs, 1);
  assert.equal(dashboard.duplicateIssues, 1);
});

test("explicitly rejected observations are counted as false positives", () => {
  recordBugFinding({
    source: "ui_exploratory",
    severity: "low",
    title: "Transient visual observation",
    detail: "Could not reproduce after reload.",
    evidence: { viewport: "375x812" },
    reproductionAttempts: 2,
    reproductionSuccesses: 1,
    validationStatus: "rejected",
  });

  const dashboard = getQaDashboard();
  assert.equal(dashboard.totalRealBugs, 0);
  assert.equal(dashboard.falsePositivesRejected, 1);
});

test("crawler scripts ignore hosting chrome and install real product oracles", () => {
  const script = tryBuildCrawledScriptWithoutLlm(
    {
      title: "Verify checkout rejects an invalid email",
      category: "Negative",
      steps: [
        'Given the user is on "Checkout"',
        'When the user enters an invalid email in "Email"',
        'And the user clicks "Submit"',
        "Then validation is shown",
      ],
      expected_result: "Validation is shown",
    },
    "typescript",
    `CRAWL_URL=https://example.test/checkout LOCATORS=${JSON.stringify([
      "page.locator('#report-email')",
      "page.getByRole('button', { name: 'Report this website' })",
      "page.getByLabel('Email')",
      "page.getByRole('button', { name: 'Submit' })",
    ])}`
  );

  assert.ok(script);
  assert.match(script, /__productIssues/);
  assert.match(script, /__apiEvents/);
  assert.match(script, /Duplicate mutation request/);
  assert.doesNotMatch(script, /#report-email/);
  assert.doesNotMatch(script, /Report this website/);
  assert.match(script, /:invalid/);
});
