// Playbook §32 -- Hypothesis Engine. bugExpansionService.ts (§33) handles
// findings from checks that already run automatically against EVERY
// cataloged screen -- for those, "the same defect recurs elsewhere" is a
// fact you can look up directly in already-collected data. This module
// covers the opposite case: a finding from one of this codebase's
// DECLARATIVE, human-configured scenario engines (network failure
// injection, state-transition flows, multi-tab testing, list-behavior
// testing, file-transfer testing) which only ever ran against the ONE
// screen a human named concrete selectors for. There's no data to look up
// for "did this also happen on screen X" because the scenario never ran
// there -- so instead of a lookup, this generates a HYPOTHESIS: a plain-
// language suggestion of which other cataloged screens are worth
// configuring the same kind of scenario against, based on which finding
// category/shape was involved, for a human (or an orchestrating caller) to
// decide whether to act on.
//
// Deliberately NOT auto-executing anything -- generating a real scenario for
// an arbitrary other screen needs concrete selectors this module has no way
// to infer safely (the same reasoning stateTransitionService.ts's own
// doc comment gives for why flows are human-authored in the first place).
// This only narrows "which screens to look at first", it never invents a
// selector to test blindly.
//
// FALSE-POSITIVE RISK: none in the traditional sense -- this never records a
// bug_findings row itself, it only ever returns suggestions. The risk is
// scope creep in the other direction: every candidateScreens list here is
// literally every OTHER cataloged screen (there's no reliable signal in this
// codebase for "these two screens share the same checkout component"), so a
// large screen catalog makes for a long, low-precision candidate list. Treat
// it as a prioritized starting point, not a proof any specific screen is
// actually affected.

import { db } from "../db.js";
import type { BugFindingRow } from "./bugDetectionService.js";

export interface ScreenCandidate {
  id: string;
  name: string;
  url_or_path: string | null;
}

export interface Hypothesis {
  hypothesis: string;
  suggestedScenarioType: "network-failure-injection" | "state-transition" | "multi-tab-testing" | "list-behavior-testing" | "file-transfer-testing";
  candidateScreens: ScreenCandidate[];
}

type FindingShape = Pick<BugFindingRow, "category" | "title" | "evidence">;

function evidenceHasField(evidence: string, field: string): boolean {
  try {
    return field in (JSON.parse(evidence) ?? {});
  } catch {
    return false;
  }
}

// Each rule's `match` relies on this codebase's own recording conventions --
// every scenario service in this repo gives its findings a distinctive title
// prefix/keyword (see each service's own recordBugFinding calls), so these
// are mutually exclusive by construction rather than a fragile guess.
const HYPOTHESIS_RULES: Array<{
  scenarioType: Hypothesis["suggestedScenarioType"];
  match: (f: FindingShape) => boolean;
  hypothesis: (f: FindingShape) => string;
}> = [
  {
    scenarioType: "network-failure-injection",
    match: (f) => f.category === "network-resilience",
    hypothesis: () =>
      "This screen broke under a deliberately injected network failure (stuck spinner, false success, or silent failure). Any other screen with its own submit/save/pay/delete action likely shares the same unhandled-failure code path -- worth configuring the same network-failure-injection scenario against those screens too.",
  },
  {
    scenarioType: "state-transition",
    match: (f) => f.category === "functional" && f.title.startsWith("State-transition invariant violated") && evidenceHasField(f.evidence, "violatedInvariant"),
    hypothesis: () =>
      "This screen's create/edit/delete flow violated an invariant (e.g. a delete that doesn't persist after refresh). Any other screen with its own CRUD-style flow likely shares the same stale-refresh or race-condition bug -- worth configuring the same state-transition template against those screens too.",
  },
  {
    scenarioType: "multi-tab-testing",
    match: (f) => f.category === "functional" && f.title.startsWith("Multi-tab invariant violated"),
    hypothesis: () =>
      "This screen showed a cross-tab state-sync bug (a logout, concurrent edit, or session-expiry invariant violated across two tabs). Any other screen with its own auth-gated content or editable record likely shares the same per-tab-storage or lost-update bug -- worth configuring the same multi-tab scenario against those screens too.",
  },
  {
    scenarioType: "list-behavior-testing",
    match: (f) => f.category === "functional" && /search|filter|sort|pagination/i.test(f.title),
    hypothesis: () =>
      "This screen's search/filter/sort/pagination behavior was incorrect. Any other screen with its own searchable, filterable, sortable, or paginated list likely shares the same list-rendering bug (often a shared list/table component) -- worth configuring the same list-behavior scenario against those screens too.",
  },
  {
    scenarioType: "file-transfer-testing",
    match: (f) => f.category === "functional" && /upload|download/i.test(f.title),
    hypothesis: () =>
      "This screen's file upload or download behavior was incorrect (a validation gap, a silent failure, or a broken/empty download). Any other screen with its own file upload or export/download feature likely shares the same gap -- worth configuring the same file-transfer scenario against those screens too.",
  },
];

/**
 * Generates hypotheses for where else the SAME kind of defect as `finding`
 * might exist, based on which declarative scenario type produced it. Returns
 * one Hypothesis per matching rule (usually zero or one -- the rules are
 * mutually exclusive by title/category, but a caller passing a hand-built
 * finding-like object rather than a real recorded row could in principle
 * match more than one). Every hypothesis's candidateScreens is every OTHER
 * cataloged screen (see the file-level false-positive-risk note on why this
 * can't be narrowed further with the data this codebase has).
 */
export function generateHypotheses(finding: FindingShape, excludeScreenId?: string | null): Hypothesis[] {
  const screens = (
    excludeScreenId
      ? db.prepare("SELECT id, name, url_or_path FROM screens WHERE id != ? ORDER BY updated_at DESC").all(excludeScreenId)
      : db.prepare("SELECT id, name, url_or_path FROM screens ORDER BY updated_at DESC").all()
  ) as ScreenCandidate[];

  const hypotheses: Hypothesis[] = [];
  for (const rule of HYPOTHESIS_RULES) {
    if (rule.match(finding)) {
      hypotheses.push({ hypothesis: rule.hypothesis(finding), suggestedScenarioType: rule.scenarioType, candidateScreens: screens });
    }
  }
  return hypotheses;
}
