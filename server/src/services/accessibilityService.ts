// Phase 2 -- Accessibility testing (master prompt #12). Injects axe-core
// (via @axe-core/playwright) against the already-loaded page inside
// bugDetectionService.scanScreenForUiBugs(), the same "reuse the open page,
// no extra navigation" discipline domChecksService.runDomChecks already
// uses. Unlike every other check added this session, this one deliberately
// reaches for a maintained third-party rule engine rather than a hand-rolled
// heuristic -- accessibility rule correctness (contrast ratio math, ARIA
// semantics, focus-order edge cases) is exactly the kind of domain where a
// widely-used, actively-maintained library is the honest choice, not a
// shortcut. New runtime dependency: @axe-core/playwright, added to
// server/package.json the same way pixelmatch/pngjs were added for visual
// regression -- no new deployment topology.
//
// FALSE-POSITIVE RISK: low relative to this codebase's other heuristic
// checks (axe-core is the industry-standard accessibility linter, used
// broadly in production CI pipelines), but not zero -- a handful of axe
// rules are known to occasionally flag intentional patterns (e.g.
// "landmark-unique" on a deliberately duplicated ARIA landmark, or
// "color-contrast" against text that's decorative/disabled rather than
// meant to be read). Suppress a specific rule ID for a specific screen via
// screens.accessibility_ignore_rules_json (getAccessibilityIgnoreRules/
// setAccessibilityIgnoreRules below, PUT /api/screens/:id/accessibility-ignore-rules) --
// empty by default, same "don't guess app-specific exceptions" principle as
// every other ignore-list this session.

import AxeBuilder from "@axe-core/playwright";
import type { Page } from "playwright";
import { db } from "../db.js";
import type { BugSeverity } from "./bugDetectionService.js";
import { getAccessibilityWcagLevel } from "./adminService.js";

export const ACCESSIBILITY_CONFIG = {
  // axe-core's own tag vocabulary, one set per configured WCAG conformance level.
  wcagTags: {
    A: ["wcag2a", "wcag21a"],
    AA: ["wcag2a", "wcag21a", "wcag2aa", "wcag21aa"],
    AAA: ["wcag2a", "wcag21a", "wcag2aa", "wcag21aa", "wcag2aaa"],
  } as Record<"A" | "AA" | "AAA", string[]>,
  // axe's own impact levels mapped onto this platform's four-level severity.
  impactSeverity: {
    critical: "critical",
    serious: "high",
    moderate: "medium",
    minor: "low",
  } as Record<string, BugSeverity>,
  // Caps the finding list per scan, same reasoning as API_SCHEMA_CONFIG.maxDiffIssuesPerResponse
  // and DOM_CHECKS_CONFIG.maxSamplesPerCheck -- a badly-broken page can't produce an unbounded finding list.
  maxIssuesPerScan: 30,
  maxSampleTargetsPerIssue: 5,
};

export interface AccessibilityIssue {
  ruleId: string;
  impact: string;
  severity: BugSeverity;
  description: string;
  helpUrl: string;
  targets: string[];
  nodeCount: number;
}

export function getAccessibilityIgnoreRules(screenId: string): string[] {
  const row = db.prepare("SELECT accessibility_ignore_rules_json FROM screens WHERE id = ?").get(screenId) as { accessibility_ignore_rules_json: string } | undefined;
  if (!row) return [];
  try {
    return JSON.parse(row.accessibility_ignore_rules_json);
  } catch {
    return [];
  }
}

export function setAccessibilityIgnoreRules(screenId: string, rules: string[]): void {
  if (!Array.isArray(rules) || !rules.every((r) => typeof r === "string")) {
    throw new Error("rules must be an array of axe-core rule id strings");
  }
  db.prepare("UPDATE screens SET accessibility_ignore_rules_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(rules), new Date().toISOString(), screenId);
}

/**
 * Run axe-core against the already-loaded page. Never throws -- an
 * accessibility-engine failure (e.g. a page that blocks script injection) is
 * swallowed and reported as zero issues, so it can never fail the surrounding
 * UI scan the way DOM/visual checks already don't.
 */
export async function runAccessibilityChecks(page: Page, ignoreRules: string[] = []): Promise<AccessibilityIssue[]> {
  try {
    const wcagLevel = getAccessibilityWcagLevel();
    let builder = new AxeBuilder({ page }).withTags(ACCESSIBILITY_CONFIG.wcagTags[wcagLevel]);
    if (ignoreRules.length > 0) builder = builder.disableRules(ignoreRules);
    const results = await builder.analyze();
    return results.violations.slice(0, ACCESSIBILITY_CONFIG.maxIssuesPerScan).map((v) => ({
      ruleId: v.id,
      impact: v.impact || "minor",
      severity: ACCESSIBILITY_CONFIG.impactSeverity[v.impact || "minor"] || "low",
      description: v.help,
      helpUrl: v.helpUrl,
      targets: v.nodes.slice(0, ACCESSIBILITY_CONFIG.maxSampleTargetsPerIssue).map((n) => n.target.map(String).join(" ")),
      nodeCount: v.nodes.length,
    }));
  } catch {
    return [];
  }
}
