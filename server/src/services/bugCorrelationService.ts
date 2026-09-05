// Phase 1B -- Correlation/dedup/confidence skeleton, step 2: within-scan
// correlation. Called once at the end of bugDetectionService.scanScreenForUiBugs(),
// after every check for that page visit has already written its own row(s)
// into bug_findings. Groups findings from THIS ONE SCAN that are likely one
// underlying defect observed through multiple signals -- the master prompt's
// own worked example (§17): a failed `POST /api/order`, a stuck loading
// spinner, and a console TypeError, all from one user action, should read as
// ONE correlated bug, not three unrelated rows.
//
// Deterministic rule-based grouping, not an LLM call -- the signal this rule
// keys on (a shared endpoint key, or "this is the only network failure in an
// otherwise-clean scan") is exactly the kind of thing expressible as a rule,
// matching this codebase's existing house style (consoleErrorService,
// apiSchemaService) of hand-rolled analysis before reaching for an LLM.
//
// FALSE-POSITIVE RISK: this groups by structural co-occurrence, not by
// actually tracing cause and effect through the browser's execution -- it
// CANNOT know that the spinner and the console error were really caused by
// the same click that hit the failing endpoint, only that they all showed up
// in the same scan alongside exactly one clear network failure. A page with
// several independent, unrelated problems (e.g. a genuinely separate
// accessibility issue and a genuinely separate 500 error, both surfacing in
// one scan) risks being folded into one group if there's only one endpoint-
// level anchor to attach to. To bound this:
//   - "Supporting evidence" categories (ui-dom stuck-spinner, console-error)
//     are ONLY auto-attached to an anchor when there is EXACTLY ONE eligible
//     anchor finding in the whole batch -- with 0 or 2+ anchors, the rule
//     stays silent (findings are left uncorrelated) rather than guessing
//     which anchor a generic symptom belongs to.
//   - Two findings that both explicitly reference the SAME endpoint key
//     (evidence.endpointKey / evidence.rule.endpointKey) are always grouped
//     together regardless of anchor count -- this is a much stronger signal
//     (both checks independently identified the same API call) with far
//     lower false-positive risk than the generic-symptom attachment above.
// Suppression: there is no per-screen suppression list for this yet (unlike
// every other check) because incorrect correlation doesn't produce a NEW
// finding, only a shared correlation_group_id on findings that already
// exist independently -- worst case, a human sees one fewer implied grouping
// hint than expected, not a false bug report.

import { db } from "../db.js";
import { nanoid } from "nanoid";
import type { BugFindingRow } from "./bugDetectionService.js";

// Categories treated as "supporting evidence" for a network-failure anchor --
// symptoms a failed API call commonly produces downstream, never findings in
// their own right strong enough to anchor a group.
const SUPPORTING_CATEGORIES = new Set(["ui-dom", "console-error"]);
// Categories strong enough to anchor a correlation group on their own.
const ANCHOR_CATEGORIES = new Set(["api-status", "api-schema", "ui-api-mismatch"]);

function extractEndpointKey(evidenceJson: string | null | undefined): string | null {
  if (!evidenceJson) return null;
  try {
    const evidence = JSON.parse(evidenceJson);
    if (typeof evidence.endpointKey === "string") return evidence.endpointKey;
    if (typeof evidence.rule?.endpointKey === "string") return evidence.rule.endpointKey;
    return null;
  } catch {
    return null;
  }
}

function applyGroup(ids: string[], groupId: string) {
  if (ids.length < 2) return; // a "group" of one finding is not a correlation
  const now = new Date().toISOString();
  const update = db.prepare("UPDATE bug_findings SET correlation_group_id = ?, updated_at = ? WHERE id = ?");
  const tx = db.transaction((rows: string[]) => {
    for (const id of rows) update.run(groupId, now, id);
  });
  tx(ids);
}

/**
 * Groups a batch of findings (all from one scanScreenForUiBugs() call) into
 * correlation groups, mutating bug_findings.correlation_group_id in place.
 * Findings that don't correlate with anything are left with
 * correlation_group_id = null (already their default) -- not every finding
 * belongs to a group, and that's the expected/common case.
 */
export function correlateFindings(findings: BugFindingRow[]): void {
  if (findings.length < 2) return;

  const remaining = new Set(findings.map((f) => f.id));
  const byEndpoint = new Map<string, string[]>();
  for (const f of findings) {
    const key = extractEndpointKey(f.evidence);
    if (!key) continue;
    if (!byEndpoint.has(key)) byEndpoint.set(key, []);
    byEndpoint.get(key)!.push(f.id);
  }

  // Rule 1: any two+ findings that independently named the same endpoint key
  // are grouped together -- the strongest, lowest-false-positive-risk signal.
  for (const [, ids] of byEndpoint) {
    if (ids.length < 2) continue;
    const groupId = `corr-${nanoid(8)}`;
    applyGroup(ids, groupId);
    for (const id of ids) remaining.delete(id);
  }

  // Rule 2: exactly one anchor (api-status/api-schema/ui-api-mismatch) left
  // ungrouped in this batch -- attach every still-ungrouped supporting-
  // category finding (ui-dom, console-error) to it. Left silent (no group)
  // when there are 0 or 2+ eligible anchors, per the false-positive-risk note above.
  const remainingFindings = findings.filter((f) => remaining.has(f.id));
  const anchors = remainingFindings.filter((f) => f.category && ANCHOR_CATEGORIES.has(f.category));
  if (anchors.length === 1) {
    const anchor = anchors[0];
    const supporting = remainingFindings.filter((f) => f.id !== anchor.id && f.category && SUPPORTING_CATEGORIES.has(f.category));
    if (supporting.length > 0) {
      const groupId = `corr-${nanoid(8)}`;
      applyGroup([anchor.id, ...supporting.map((f) => f.id)], groupId);
    }
  }
}
