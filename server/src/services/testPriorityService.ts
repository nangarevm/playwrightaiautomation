// Playbook §3 -- Test Priority (numbered engine #3, entirely net-new). Every
// scenario/scan service built in this codebase answers "is this ONE thing
// broken" -- nothing until now has answered the prior question a real QA
// lead asks first: "given limited time, WHICH screens are worth testing
// first". This is a deterministic, weighted risk score over data this
// engine already has (screens' own change-tracking, existing bug_findings,
// existing test-case/script coverage counts) -- no new browser automation,
// same reasoning as bugExpansionService.ts (§33): a pure aggregation over
// already-collected facts.
//
// Risk factors, each independently justifiable and named so the score stays
// auditable rather than an opaque number (same design principle as
// bugConfidenceService.ts's own CONFIDENCE_CONFIG):
//   - Recently changed/newly cataloged screens are riskier than stable,
//     unchanged ones -- new code is where new bugs live.
//   - A screen matching a business-critical keyword (checkout/payment/auth/
//     admin/...) carries more real-world consequence per bug than an
//     incidental page, independent of whether a bug has been found yet.
//   - A screen with existing open bug findings -- especially critical/high
//     severity ones -- already has a demonstrated defect concentration;
//     more likely than not to have more nearby.
//   - A screen with NO existing test-case coverage at all is flying blind --
//     nothing has ever systematically checked it, which is itself a risk
//     signal independent of whether a bug happens to already be on file.
//
// FALSE-POSITIVE RISK: this is a HEURISTIC priority signal for allocating
// limited testing effort, not a certainty that a high-scoring screen has a
// bug or that a low-scoring one doesn't -- treat it as a starting order, the
// same caveat bugConfidenceService.ts gives its own score. The critical-area
// keyword match is necessarily an English-language, naming-convention-based
// guess (a screen named in another language, or with a non-obvious internal
// name, won't match) -- it under-detects rather than over-detects, so a
// screen missing this bonus isn't proof it's low-risk, just that its name
// didn't happen to contain a recognized keyword.

import { db } from "../db.js";
import { listBugFindings, type BugFindingRow } from "./bugDetectionService.js";

export type TestPriorityBand = "P0" | "P1" | "P2" | "P3";

export const TEST_PRIORITY_CONFIG = {
  base: 20,
  changedBonus: 25, // screens.change_status === 'changed'
  newBonus: 15, // screens.change_status === 'new'
  criticalAreaBonus: 20,
  noCoverageBonus: 15, // zero linked test_cases
  perOpenCriticalOrHighBugBonus: 10,
  maxCriticalOrHighBugBonus: 30,
  perOpenAnyBugBonus: 3,
  maxAnyBugBonus: 15,
  min: 0,
  max: 100,
  // Business-critical keyword heuristic -- deliberately a broad, easily
  // auditable English-language name/module match, same style as the
  // crawler's own DESTRUCTIVE_ACTION_PATTERN elsewhere in this codebase.
  criticalAreaPattern: /checkout|payment|billing|login|auth|admin|delete|account|password|signup|register|cart|order/i,
};

function clampScore(value: number): number {
  return Math.max(TEST_PRIORITY_CONFIG.min, Math.min(TEST_PRIORITY_CONFIG.max, value));
}

export interface TestPriorityScore {
  screenId: string;
  name: string;
  score: number;
  band: TestPriorityBand;
  reasons: string[];
}

interface ScreenRow {
  id: string;
  name: string;
  module_name: string | null;
  change_status: string | null;
  test_case_count: number;
}

function scoreOneScreen(screen: ScreenRow, findings: BugFindingRow[]): TestPriorityScore {
  let score = TEST_PRIORITY_CONFIG.base;
  const reasons: string[] = [];

  if (screen.change_status === "changed") {
    score += TEST_PRIORITY_CONFIG.changedBonus;
    reasons.push("Recently changed since it was last captured.");
  } else if (screen.change_status === "new") {
    score += TEST_PRIORITY_CONFIG.newBonus;
    reasons.push("Newly cataloged -- never tested before.");
  }

  const nameAndModule = `${screen.name} ${screen.module_name ?? ""}`;
  if (TEST_PRIORITY_CONFIG.criticalAreaPattern.test(nameAndModule)) {
    score += TEST_PRIORITY_CONFIG.criticalAreaBonus;
    reasons.push("Matches a business-critical area keyword (checkout/payment/auth/admin/...).");
  }

  if (screen.test_case_count === 0) {
    score += TEST_PRIORITY_CONFIG.noCoverageBonus;
    reasons.push("No existing test-case coverage at all.");
  }

  const openFindings = findings.filter((f) => (f.status === "open" || f.status === "acknowledged") && f.screen_id === screen.id);
  const criticalOrHighCount = openFindings.filter((f) => f.severity === "critical" || f.severity === "high").length;
  if (criticalOrHighCount > 0) {
    const bonus = Math.min(TEST_PRIORITY_CONFIG.maxCriticalOrHighBugBonus, criticalOrHighCount * TEST_PRIORITY_CONFIG.perOpenCriticalOrHighBugBonus);
    score += bonus;
    reasons.push(`${criticalOrHighCount} open critical/high-severity finding(s) already on this screen.`);
  }
  if (openFindings.length > 0) {
    const bonus = Math.min(TEST_PRIORITY_CONFIG.maxAnyBugBonus, openFindings.length * TEST_PRIORITY_CONFIG.perOpenAnyBugBonus);
    score += bonus;
    reasons.push(`${openFindings.length} open finding(s) total on this screen.`);
  }

  return {
    screenId: screen.id,
    name: screen.name,
    score: Math.round(clampScore(score)),
    band: deriveTestPriorityBand(clampScore(score)),
    reasons,
  };
}

export function deriveTestPriorityBand(score: number): TestPriorityBand {
  if (score >= 70) return "P0";
  if (score >= 45) return "P1";
  if (score >= 20) return "P2";
  return "P3";
}

/**
 * Scores every cataloged screen's testing priority and returns them sorted
 * highest-risk-first. Pure aggregation over screens + bug_findings + linked
 * test_cases -- no browser launch, safe to call as often as needed.
 */
export function computeTestPriorities(): TestPriorityScore[] {
  const screens = db
    .prepare("SELECT s.id, s.name, s.module_name, s.change_status, (SELECT COUNT(*) FROM test_cases WHERE screen_id = s.id) as test_case_count FROM screens s")
    .all() as ScreenRow[];
  const findings = listBugFindings();
  return screens.map((screen) => scoreOneScreen(screen, findings)).sort((a, b) => b.score - a.score);
}
