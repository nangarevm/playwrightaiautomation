// Playbook §33 -- Bug Expansion Engine. Every automatic, passive check in
// this codebase (console-error, api-status, api-schema, ui-visual, ui-dom,
// ui-api-mismatch, accessibility, performance, security -- everything
// scanScreenForUiBugs() runs on every visit) already runs against EVERY
// cataloged Screen on every scan. So when the SAME underlying defect turns
// up on several different screens, that's not a coincidence worth ignoring
// as N separate low-priority findings -- it's a single systemic defect
// (almost always a shared component, a shared backend endpoint, or a shared
// utility function) that recurs everywhere that component/endpoint is used,
// and deserves ONE root-cause fix rather than N separate tickets.
//
// This is pure aggregation over data this engine already collected -- no new
// browser automation needed. It reuses bugFingerprintService.computeFingerprint
// (the same stable, screen-agnostic-once-you-ignore-screenId hash already
// used for cross-scan dedup) by passing a constant marker in place of the
// finding's real screenId: two findings with the same category + endpoint +
// normalized message on two DIFFERENT screens hash identically once screenId
// is neutralized like this, which is exactly the grouping key needed here.
//
// FALSE-POSITIVE RISK: a coincidentally-identical message on two genuinely
// unrelated screens (e.g. two different forms that both happen to log
// "Failed to fetch") will group together here even though they're unrelated
// defects. That's the same normalization trade-off bugFingerprintService
// already documents for its own cross-scan dedup -- this reuses it rather
// than inventing a second, differently-tuned heuristic. A human reviewing a
// systemic-issue group should sanity-check the sample findings' evidence
// before treating "same fingerprint" as proof of "same root cause".

import { listBugFindings, type BugFindingRow, type BugCategory } from "./bugDetectionService.js";
import { computeFingerprint } from "./bugFingerprintService.js";

const CROSS_SCREEN_MARKER = "__cross_screen__";

function safeParseEvidence(evidence: string): Record<string, any> {
  try {
    return JSON.parse(evidence);
  } catch {
    return {};
  }
}

export interface SystemicIssueGroup {
  crossScreenFingerprint: string;
  category: BugCategory | null;
  sampleTitle: string;
  sampleDetail: string;
  screenIds: string[];
  findingIds: string[];
  occurrences: number;
}

export interface FindSystemicIssuesOptions {
  /** Minimum distinct screens the same defect must appear on to count as systemic. Defaults to 2. */
  minScreens?: number;
  /** Which finding statuses to consider. Defaults to open + acknowledged (a resolved/ignored finding shouldn't drive a new systemic-issue alert). */
  statuses?: BugFindingRow["status"][];
}

/**
 * Groups all cataloged findings by a screen-agnostic fingerprint and returns
 * every group that recurs on at least minScreens distinct screens, sorted by
 * how many screens it touches (the most widespread issues first).
 */
export function findSystemicIssues(options?: FindSystemicIssuesOptions): SystemicIssueGroup[] {
  const minScreens = options?.minScreens ?? 2;
  const statuses = options?.statuses ?? (["open", "acknowledged"] as BugFindingRow["status"][]);

  const relevant = listBugFindings().filter((f) => statuses.includes(f.status) && f.screen_id);

  const groups = new Map<string, { category: BugCategory | null; sample: BugFindingRow; screenIds: Set<string>; findingIds: string[] }>();
  for (const finding of relevant) {
    const crossScreenFingerprint = computeFingerprint({
      screenId: CROSS_SCREEN_MARKER,
      category: finding.category,
      title: finding.title,
      detail: finding.detail,
      evidence: safeParseEvidence(finding.evidence),
    });
    let group = groups.get(crossScreenFingerprint);
    if (!group) {
      group = { category: finding.category, sample: finding, screenIds: new Set(), findingIds: [] };
      groups.set(crossScreenFingerprint, group);
    }
    group.screenIds.add(finding.screen_id!);
    group.findingIds.push(finding.id);
  }

  const result: SystemicIssueGroup[] = [];
  for (const [crossScreenFingerprint, group] of groups) {
    if (group.screenIds.size >= minScreens) {
      result.push({
        crossScreenFingerprint,
        category: group.category,
        sampleTitle: group.sample.title,
        sampleDetail: group.sample.detail,
        screenIds: Array.from(group.screenIds),
        findingIds: group.findingIds,
        occurrences: group.findingIds.length,
      });
    }
  }

  return result.sort((a, b) => b.screenIds.length - a.screenIds.length);
}
