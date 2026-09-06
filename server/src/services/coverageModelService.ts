// Playbook §37 -- Coverage Model. A different question than testPriorityService.ts
// (§3, "where should we test NEXT") -- this answers "how much of the app has
// EVER been touched by testing at all", both by screen (does this screen have
// any test-case/automation coverage) and by check TYPE (has this category of
// check ever actually fired anywhere in the app, or has it silently never
// triggered -- which could mean either "the app has no such defects" or "the
// detector for this category never actually ran/works"). Pure aggregation
// over existing data, no new browser automation.
//
// FALSE-POSITIVE RISK: "has 1+ test case" is a coverage proxy, not a
// guarantee that test case is any good or still passing -- a stale, never-
// re-run test case counts as "covered" here. Likewise, "this category has
// never been detected anywhere" is consistent with both "truly bug-free"
// and "this detector never got a chance to run" -- this model can't tell
// those apart from bug_findings data alone; cross-check with actual scan/
// run history before concluding a category's detector is broken.

import { db } from "../db.js";
import type { BugCategory } from "./bugDetectionService.js";

// The full BugCategory union, kept in sync by hand -- TypeScript unions
// aren't introspectable at runtime, so there's no way to derive this list
// from the type itself. bugConfidenceService.ts's own categoryWeight Record
// already requires the same manual sync (and the compiler enforces it stays
// exhaustive there); this list has no such compiler check, so keep it
// aligned with bugDetectionService.ts's BugCategory definition by hand.
const ALL_KNOWN_CATEGORIES: BugCategory[] = [
  "console-error",
  "api-status",
  "api-schema",
  "ui-visual",
  "ui-dom",
  "ui-api-mismatch",
  "functional",
  "accessibility",
  "performance",
  "security",
  "network-resilience",
];

export interface CoverageModel {
  totalScreens: number;
  screensWithTestCaseCoverage: number;
  screensWithAutomationCoverage: number;
  screensWithAnyBugScanActivity: number;
  testCaseCoveragePercent: number;
  automationCoveragePercent: number;
  bugScanActivityCoveragePercent: number;
  categoriesEverDetected: BugCategory[];
  categoriesNeverDetected: BugCategory[];
}

function percent(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 10; // one decimal place
}

/**
 * Computes an app-wide coverage snapshot: what fraction of cataloged screens
 * have any test-case coverage, any automation-script coverage, or any
 * recorded bug-scan activity at all, plus which BugCategory values have
 * ever actually been detected anywhere vs. never once.
 */
export function computeCoverageModel(): CoverageModel {
  const totalScreens = (db.prepare("SELECT COUNT(*) as c FROM screens").get() as any).c as number;
  const screensWithTestCaseCoverage = (
    db.prepare("SELECT COUNT(*) as c FROM screens s WHERE EXISTS (SELECT 1 FROM test_cases t WHERE t.screen_id = s.id)").get() as any
  ).c as number;
  const screensWithAutomationCoverage = (
    db.prepare("SELECT COUNT(*) as c FROM screens s WHERE EXISTS (SELECT 1 FROM automation_scripts a WHERE a.screen_id = s.id)").get() as any
  ).c as number;
  const screensWithAnyBugScanActivity = (
    db.prepare("SELECT COUNT(*) as c FROM screens s WHERE EXISTS (SELECT 1 FROM bug_findings b WHERE b.screen_id = s.id)").get() as any
  ).c as number;

  const detectedCategories = new Set(
    (db.prepare("SELECT DISTINCT category FROM bug_findings WHERE category IS NOT NULL").all() as Array<{ category: string }>).map((r) => r.category)
  );
  const categoriesEverDetected = ALL_KNOWN_CATEGORIES.filter((c) => detectedCategories.has(c));
  const categoriesNeverDetected = ALL_KNOWN_CATEGORIES.filter((c) => !detectedCategories.has(c));

  return {
    totalScreens,
    screensWithTestCaseCoverage,
    screensWithAutomationCoverage,
    screensWithAnyBugScanActivity,
    testCaseCoveragePercent: percent(screensWithTestCaseCoverage, totalScreens),
    automationCoveragePercent: percent(screensWithAutomationCoverage, totalScreens),
    bugScanActivityCoveragePercent: percent(screensWithAnyBugScanActivity, totalScreens),
    categoriesEverDetected,
    categoriesNeverDetected,
  };
}
