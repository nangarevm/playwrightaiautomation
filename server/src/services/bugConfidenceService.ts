// Phase 1B -- Correlation/dedup/confidence skeleton, step 3: a deterministic,
// signal-weighted confidence score (0.0-1.0) plus a derived priority
// (P0-P3), matching the master prompt's own instruction that "a bug should
// ideally be reproduced before assigning high confidence" (§21) and that
// confidence should combine multiple independent signals, not just restate
// severity under a different name.
//
// Deliberately a hand-rolled weighted-rule scorer, not a model call -- every
// input here (category, reproducibility count, correlation-group membership,
// evidence shape) is already a concrete, structured fact by the time this
// runs; there's nothing genuinely ambiguous/semantic for an LLM to resolve.
//
// FALSE-POSITIVE RISK: this is explicitly a HEURISTIC estimate of how likely
// a finding is a real, actionable defect (as opposed to noise/a legitimate
// edge case) -- it is not a certainty score and must never be presented as
// one. The score is capped at 0.95 (never absolute certainty) and floored at
// 0.05 (never presented as impossible) for exactly that reason. A caller
// wanting to suppress low-confidence noise should filter on the returned
// score/priority in their own query rather than this service silently
// dropping findings -- nothing here discards a finding, only annotates it.

import type { BugCategory, BugFindingRow, BugSeverity } from "./bugDetectionService.js";

export type BugPriority = "P0" | "P1" | "P2" | "P3";

// Every weight lives here, not scattered through the scoring function below,
// so a QA Lead reviewing this file can see the full rule set at a glance.
export const CONFIDENCE_CONFIG = {
  base: 0.55,
  // Category-level signal strength: how directly this category's own
  // detection mechanism implies a real defect vs. a possible false positive.
  categoryWeight: {
    "api-schema": 0.18, // a structural shape diff is precise and hard to fake
    "api-status": 0.15, // a real HTTP status code is an unambiguous fact
    "ui-api-mismatch": 0.12,
    "console-error": 0.08, // real, but third-party/benign console noise exists
    "ui-dom": 0.05, // overlap/off-viewport heuristics carry real false-positive risk
    "ui-visual": 0.02, // pixel-diff is the noisiest signal in this codebase (animations, timestamps)
    functional: 0.1,
    accessibility: 0.14, // axe-core is a maintained rule engine, not a hand-rolled heuristic -- more precise than most checks here
    performance: 0.06, // a real measured duration/count against a configurable threshold -- an unambiguous fact, but "slow" is inherently a judgment call on where the threshold sits
    security: 0.2, // an authz probe replaying the identical request as a second identity and getting 200 where a denial was expected is about as unambiguous as this engine's signals get
  } as Record<BugCategory, number>,
  reproducedBonus: 0.15, // reproducibility_successes > 1 (seen again on a later scan, not a one-off)
  correlatedBonus: 0.1, // corroborated by an independent signal in the same scan (bugCorrelationService)
  criticalSeverityBonus: 0.05,
  lowSeverityPenalty: 0.1,
  visualSmallDiffPenalty: 0.15, // a ui-visual finding just barely over threshold is the likeliest false positive in the whole engine
  min: 0.05,
  max: 0.95,
};

function clamp(value: number): number {
  return Math.max(CONFIDENCE_CONFIG.min, Math.min(CONFIDENCE_CONFIG.max, value));
}

export interface ScoreConfidenceOptions {
  /** True when this finding was placed into a correlation_group_id alongside at least one other finding (bugCorrelationService.correlateFindings). */
  isCorrelated?: boolean;
}

export function scoreConfidence(
  finding: Pick<BugFindingRow, "category" | "severity" | "evidence" | "reproducibility_attempts" | "reproducibility_successes">,
  options: ScoreConfidenceOptions = {}
): number {
  let score = CONFIDENCE_CONFIG.base;

  if (finding.category && finding.category in CONFIDENCE_CONFIG.categoryWeight) {
    score += CONFIDENCE_CONFIG.categoryWeight[finding.category];
  }

  const attempts = finding.reproducibility_attempts ?? 1;
  const successes = finding.reproducibility_successes ?? 1;
  if (attempts > 1 && successes > 1) score += CONFIDENCE_CONFIG.reproducedBonus;

  if (options.isCorrelated) score += CONFIDENCE_CONFIG.correlatedBonus;

  if (finding.severity === "critical") score += CONFIDENCE_CONFIG.criticalSeverityBonus;
  if (finding.severity === "low") score -= CONFIDENCE_CONFIG.lowSeverityPenalty;

  if (finding.category === "ui-visual") {
    try {
      const evidence = typeof finding.evidence === "string" ? JSON.parse(finding.evidence) : finding.evidence;
      const diffPercentage = evidence?.diffPercentage;
      const thresholdPercent = evidence?.thresholdPercent;
      if (typeof diffPercentage === "number" && typeof thresholdPercent === "number" && diffPercentage < thresholdPercent * 2) {
        // Within 2x of the configured threshold -- the likeliest zone for
        // animation/timestamp/font-rendering noise rather than a real regression.
        score -= CONFIDENCE_CONFIG.visualSmallDiffPenalty;
      }
    } catch {
      /* evidence not parseable -- score on the other signals only */
    }
  }

  return Math.round(clamp(score) * 100) / 100;
}

// Priority is deliberately a small deterministic table (severity x confidence
// band), not a formula, so the mapping stays auditable/explainable in a bug
// report rather than an opaque computed number.
export function derivePriority(severity: BugSeverity, confidenceScore: number): BugPriority {
  const highConfidence = confidenceScore >= 0.7;
  const mediumConfidence = confidenceScore >= 0.45;

  if (severity === "critical") return highConfidence ? "P0" : "P1";
  if (severity === "high") return highConfidence ? "P1" : mediumConfidence ? "P2" : "P3";
  if (severity === "medium") return mediumConfidence ? "P2" : "P3";
  return "P3"; // low severity is never P0-P2 regardless of confidence
}
