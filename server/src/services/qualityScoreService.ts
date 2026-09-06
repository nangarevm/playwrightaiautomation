// Playbook §43 -- Quality Score. testPriorityService.ts (§3) answers "where
// should we test next" (a forward-looking risk signal, independent of
// whether any bug has actually been confirmed there yet). This answers a
// different, backward-looking question: "how healthy is this screen/the
// app RIGHT NOW", given the defects already confirmed on it. A single
// 0-100 score, starting from a clean 100 and deducting for each open
// finding, weighted by severity AND by that finding's own confidence score
// (bugConfidenceService.ts) -- a low-confidence finding should cost less
// quality than a high-confidence one making the exact same severity claim.
//
// FALSE-POSITIVE RISK: same caveat as bugConfidenceService.ts's own score --
// this is a heuristic summary for trend-watching and reporting, not a
// certified defect count. A screen with a genuinely low score should still
// be triaged finding-by-finding rather than trusted as "definitely N% as
// good" -- the number is for tracking direction over time (did this week's
// score improve after fixes shipped), not for precise comparison between
// two different screens with very different finding volumes.

import { db } from "../db.js";
import { listBugFindings, type BugFindingRow, type BugSeverity } from "./bugDetectionService.js";

export const QUALITY_SCORE_CONFIG = {
  max: 100,
  min: 0,
  // Per-open-finding penalty at full (1.0) confidence; actually applied
  // penalty is scaled by the finding's own confidence_score (a low-
  // confidence finding costs proportionally less).
  severityPenalty: {
    critical: 25,
    high: 12,
    medium: 5,
    low: 1,
  } as Record<BugSeverity, number>,
  defaultConfidenceWhenMissing: 0.55, // matches bugConfidenceService.CONFIDENCE_CONFIG.base -- a finding scored before this system existed
};

export interface QualityScore {
  screenId: string | null; // null for the app-wide score
  screenName: string | null;
  score: number;
  openFindingCount: number;
  penaltyBreakdown: Record<BugSeverity, number>;
}

function scoreFromFindings(findings: BugFindingRow[]): { score: number; penaltyBreakdown: Record<BugSeverity, number> } {
  const penaltyBreakdown: Record<BugSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  let totalPenalty = 0;
  for (const finding of findings) {
    const confidence = finding.confidence_score ?? QUALITY_SCORE_CONFIG.defaultConfidenceWhenMissing;
    const penalty = QUALITY_SCORE_CONFIG.severityPenalty[finding.severity] * confidence;
    penaltyBreakdown[finding.severity] += Math.round(penalty * 10) / 10;
    totalPenalty += penalty;
  }
  const score = Math.max(QUALITY_SCORE_CONFIG.min, Math.min(QUALITY_SCORE_CONFIG.max, Math.round(QUALITY_SCORE_CONFIG.max - totalPenalty)));
  return { score, penaltyBreakdown };
}

function openFindings(): BugFindingRow[] {
  return listBugFindings().filter((f) => f.status === "open" || f.status === "acknowledged");
}

/** App-wide quality score across every open finding on every screen. */
export function computeAppWideQualityScore(): QualityScore {
  const findings = openFindings();
  const { score, penaltyBreakdown } = scoreFromFindings(findings);
  return { screenId: null, screenName: null, score, openFindingCount: findings.length, penaltyBreakdown };
}

/** Per-screen quality score, for every cataloged screen, worst-first. */
export function computeQualityScoresByScreen(): QualityScore[] {
  const screens = db.prepare("SELECT id, name FROM screens").all() as Array<{ id: string; name: string }>;
  const findings = openFindings();
  const byScreen = new Map<string, BugFindingRow[]>();
  for (const finding of findings) {
    if (!finding.screen_id) continue;
    const list = byScreen.get(finding.screen_id) ?? [];
    list.push(finding);
    byScreen.set(finding.screen_id, list);
  }
  return screens
    .map((screen) => {
      const screenFindings = byScreen.get(screen.id) ?? [];
      const { score, penaltyBreakdown } = scoreFromFindings(screenFindings);
      return { screenId: screen.id, screenName: screen.name, score, openFindingCount: screenFindings.length, penaltyBreakdown };
    })
    .sort((a, b) => a.score - b.score);
}
