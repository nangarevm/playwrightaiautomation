// Playbook §45 -- Regression Intelligence. A finding that recurs AFTER
// having been marked 'resolved' is a materially different, more concerning
// event than a plain new bug: it means a fix regressed. bugDetectionService.
// bumpReproducibility already reopens a resolved finding the moment it
// recurs (status flips back to 'open') and, per the db.ts migration
// alongside this file, now also stamps regression_count/last_regressed_at
// at that exact moment -- the only point this fact is knowable, since a
// plain 'open' status alone can't retroactively distinguish "always been
// open" from "was fixed, then broke again". This module is the read side:
// surfacing every finding that has ever regressed, ordered by most
// recently regressed first.
//
// Pure aggregation over existing data -- no new browser automation.
//
// FALSE-POSITIVE RISK: a finding marked 'resolved' by mistake (a human
// closed it without a real fix shipping, or closed a different finding by
// accident) that then reappears on the next scan will read as a genuine
// regression here even though nothing regressed -- the fix was never really
// in place. There's no way to distinguish that from a real regression using
// only this data; a regression alert is worth a quick sanity check of
// whether a corresponding fix actually shipped before escalating it as one.

import { listBugFindings, type BugFindingRow } from "./bugDetectionService.js";

export interface RegressionRecord {
  findingId: string;
  screenId: string | null;
  title: string;
  category: string | null;
  severity: string;
  regressionCount: number;
  lastRegressedAt: string;
}

/**
 * Every finding that has regressed at least once (recurred after being
 * marked resolved), ordered most-recently-regressed first.
 */
export function listRegressions(): RegressionRecord[] {
  return listBugFindings()
    .filter((f) => f.regression_count > 0 && f.last_regressed_at)
    .map((f) => ({
      findingId: f.id,
      screenId: f.screen_id,
      title: f.title,
      category: f.category,
      severity: f.severity,
      regressionCount: f.regression_count,
      lastRegressedAt: f.last_regressed_at as string,
    }))
    .sort((a, b) => (a.lastRegressedAt < b.lastRegressedAt ? 1 : -1));
}

export interface RegressionSummary {
  totalRegressedFindings: number;
  totalRegressionEvents: number;
  mostRegressedFinding: RegressionRecord | null;
}

/** A small rollup for a dashboard: how many findings have ever regressed, and how many times in total. */
export function summarizeRegressions(): RegressionSummary {
  const regressions = listRegressions();
  const totalRegressionEvents = regressions.reduce((sum, r) => sum + r.regressionCount, 0);
  const mostRegressedFinding = regressions.length > 0 ? regressions.reduce((max, r) => (r.regressionCount > max.regressionCount ? r : max)) : null;
  return { totalRegressedFindings: regressions.length, totalRegressionEvents, mostRegressedFinding };
}

// Re-exported for callers that already have a BugFindingRow (e.g. a bug
// detail view) and just want to know "has this one specific finding ever
// regressed" without a fresh DB query.
export function hasRegressed(finding: Pick<BugFindingRow, "regression_count">): boolean {
  return finding.regression_count > 0;
}
