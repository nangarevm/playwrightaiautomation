// Playbook §38/§39 -- Bug Verification Engine (reset/replay/repeat) +
// FLAKY/ENV/NOT_A_BUG classification. bugDetectionService.recordReproductionAttempt
// (Phase 5) already existed as the low-level primitive -- a manual "record
// one reproduction attempt" call -- but nothing until now actually DROVE
// that primitive automatically: re-running the check that originally
// produced a finding, several times, from a clean state, and classifying
// the result.
//
// "Reset/replay/repeat" here means: re-run scanScreenForUiBugs() (the same
// passive scan that produces console-error/api-status/api-schema/ui-visual/
// ui-dom/ui-api-mismatch/accessibility/performance/security findings) fresh
// against the finding's own screen, N times, and check whether a finding
// with the SAME stable fingerprint (bugFingerprintService.computeFingerprint)
// reappears each time. Each fresh scan IS the "reset" (a brand-new browser
// context, no leftover state) and the "replay" (identical navigation/
// checks); "repeat" is just calling it attempts times.
//
// SCOPED LIMITATION, stated plainly rather than faked: this only works for
// the 9 categories scanScreenForUiBugs() itself produces. A 'functional' or
// 'network-resilience' finding comes from one of this codebase's
// DECLARATIVE, human-configured scenario services (state-transition, multi-
// tab, list-behavior, file-transfer, network-failure-injection, metamorphic,
// chaos) -- none of which persist their concrete selectors in a form this
// module could safely replay blindly (the same reasoning every one of those
// services' own doc comments gives for why they're human-configured in the
// first place). Verifying one of those means re-running the ORIGINAL
// scenario call by hand -- recordReproductionAttempt remains the right
// primitive for recording that manually. Calling verifyFinding on such a
// finding returns NOT_VERIFIABLE rather than silently doing nothing useful.
//
// Classification:
//   REPRODUCIBLE   -- reproduced on every attempt.
//   FLAKY          -- reproduced on some but not all attempts.
//   NOT_A_BUG      -- reproduced on zero attempts -- likely a one-off/stale
//                     finding (the underlying issue may have been fixed, or
//                     the original detection was itself a false positive).
//   ENV            -- reproduced reliably on the primary engine but NOT at
//                     all on an optional secondary browser engine (see
//                     crossBrowserScanService.ts, §Q) -- browser-specific,
//                     not a universal defect. Only computed when a
//                     secondaryBrowserName is passed AND the primary engine
//                     reproduced every attempt (checking a secondary engine
//                     against a finding that doesn't even reproduce
//                     reliably on its OWN engine wouldn't isolate anything).
//   NOT_VERIFIABLE -- no screen_id, or a category this module can't safely
//                     replay (see limitation above).
//
// FALSE-POSITIVE RISK: a NOT_A_BUG verdict means "did not reproduce in THIS
// verification run", not "definitely never a real bug" -- a since-deployed
// fix, a time-of-day-dependent condition, or a change in seed/test data
// between the original detection and verification can all produce this
// verdict for a bug that was genuinely real at the time. Treat NOT_A_BUG as
// "safe to deprioritize", not "provably false".

import { getBugFinding, recordReproductionAttempt, runBugScanForScreen, type ScanScreenOptions } from "./bugDetectionService.js";

export const VERIFICATION_CONFIG = {
  defaultAttempts: 3,
};

export type VerificationVerdict = "REPRODUCIBLE" | "FLAKY" | "ENV" | "NOT_A_BUG" | "NOT_VERIFIABLE";

// Categories produced by a declarative, human-configured scenario service
// rather than the passive scan -- see the file-level doc comment for why
// these can't be safely auto-replayed from a finding alone.
const NOT_AUTO_REPLAYABLE_CATEGORIES = new Set(["functional", "network-resilience"]);

export interface VerificationResult {
  findingId: string;
  verdict: VerificationVerdict;
  attemptsMade: number;
  timesReproduced: number;
  secondaryBrowserChecked: NonNullable<ScanScreenOptions["browserName"]> | null;
  secondaryBrowserReproduced: boolean | null;
  verifiedAt: string;
}

function notVerifiable(findingId: string): VerificationResult {
  return {
    findingId,
    verdict: "NOT_VERIFIABLE",
    attemptsMade: 0,
    timesReproduced: 0,
    secondaryBrowserChecked: null,
    secondaryBrowserReproduced: null,
    verifiedAt: new Date().toISOString(),
  };
}

function deriveVerdict(timesReproduced: number, attempts: number, secondaryBrowserReproduced: boolean | null): VerificationVerdict {
  if (timesReproduced === 0) return "NOT_A_BUG";
  if (secondaryBrowserReproduced === false && timesReproduced === attempts) return "ENV";
  if (timesReproduced < attempts) return "FLAKY";
  return "REPRODUCIBLE";
}

export interface VerifyFindingOptions {
  attempts?: number;
  /** An optional second browser engine to check ONLY once the primary engine reproduces every attempt -- see the ENV verdict's own doc comment above. */
  secondaryBrowserName?: "firefox" | "webkit";
}

/**
 * Re-runs the passive scan against `findingId`'s own screen `attempts` times
 * (default 3) from a fresh browser context each time, checking whether the
 * SAME fingerprint reappears, and classifies the result. A miss on any
 * attempt is recorded via recordReproductionAttempt(id, false) -- a hit is
 * already recorded automatically by recordBugFinding's own fingerprint-merge
 * logic inside the scan itself, so it is deliberately NOT double-recorded
 * here.
 */
export async function verifyFinding(findingId: string, options?: VerifyFindingOptions): Promise<VerificationResult> {
  const attempts = options?.attempts ?? VERIFICATION_CONFIG.defaultAttempts;
  const finding = getBugFinding(findingId);
  if (!finding) throw new Error("Bug finding not found.");
  if (!finding.screen_id || !finding.category || NOT_AUTO_REPLAYABLE_CATEGORIES.has(finding.category)) {
    return notVerifiable(findingId);
  }

  let timesReproduced = 0;
  for (let i = 0; i < attempts; i++) {
    const freshFindings = await runBugScanForScreen(finding.screen_id);
    const reproduced = freshFindings.some((f) => f.fingerprint === finding.fingerprint);
    if (reproduced) {
      timesReproduced++;
    } else {
      recordReproductionAttempt(findingId, false);
    }
  }

  let secondaryBrowserReproduced: boolean | null = null;
  if (options?.secondaryBrowserName && timesReproduced === attempts) {
    const secondaryFindings = await runBugScanForScreen(finding.screen_id, undefined, { browserName: options.secondaryBrowserName });
    secondaryBrowserReproduced = secondaryFindings.some((f) => f.fingerprint === finding.fingerprint);
  }

  return {
    findingId,
    verdict: deriveVerdict(timesReproduced, attempts, secondaryBrowserReproduced),
    attemptsMade: attempts,
    timesReproduced,
    secondaryBrowserChecked: options?.secondaryBrowserName ?? null,
    secondaryBrowserReproduced,
    verifiedAt: new Date().toISOString(),
  };
}
