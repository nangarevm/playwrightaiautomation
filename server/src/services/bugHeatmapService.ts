// Playbook §44 -- Heatmap. A screen x category breakdown of where open
// findings cluster -- the raw dataset a UI would render as an actual visual
// heatmap (screens on one axis, categories on the other, cell intensity =
// count or severity-weighted score). This module only produces the data,
// in a sparse "long" format (one row per non-empty screen/category cell)
// rather than a dense matrix -- easier for any consumer (a table, a chart
// library, a hand-rolled grid) to work with than reconstructing a 2D array
// would be, and it avoids emitting a wall of zero-cells for a large screen
// catalog against the small set of categories.
//
// FALSE-POSITIVE RISK: none beyond what the underlying findings already
// carry -- this is a pure re-aggregation of bug_findings data already
// subject to each detector's own documented false-positive risk (see each
// finding-producing service's own doc comment). A "hot" cell here means
// "many findings recorded", not necessarily "many CONFIRMED real defects".

import { db } from "../db.js";
import { listBugFindings, type BugCategory, type BugSeverity } from "./bugDetectionService.js";

const SEVERITY_WEIGHT: Record<BugSeverity, number> = { critical: 4, high: 2, medium: 1, low: 0.5 };

export interface HeatmapCell {
  screenId: string;
  screenName: string;
  category: BugCategory;
  count: number;
  severityWeightedScore: number;
}

/**
 * Returns one cell per (screen, category) pair that has at least one open
 * finding, sorted by severity-weighted score descending -- the hottest
 * cells (most findings, weighted toward more severe ones) first.
 */
export function computeBugHeatmap(): HeatmapCell[] {
  const screens = db.prepare("SELECT id, name FROM screens").all() as Array<{ id: string; name: string }>;
  const screenNameById = new Map(screens.map((s) => [s.id, s.name]));

  const openFindings = listBugFindings().filter((f) => (f.status === "open" || f.status === "acknowledged") && f.screen_id && f.category);

  const cellKey = (screenId: string, category: string) => `${screenId}::${category}`;
  const cells = new Map<string, { screenId: string; category: BugCategory; count: number; severityWeightedScore: number }>();

  for (const finding of openFindings) {
    const key = cellKey(finding.screen_id!, finding.category!);
    const existing = cells.get(key);
    const weight = SEVERITY_WEIGHT[finding.severity];
    if (existing) {
      existing.count += 1;
      existing.severityWeightedScore += weight;
    } else {
      cells.set(key, { screenId: finding.screen_id!, category: finding.category!, count: 1, severityWeightedScore: weight });
    }
  }

  return Array.from(cells.values())
    .map((cell) => ({
      screenId: cell.screenId,
      screenName: screenNameById.get(cell.screenId) ?? "(unknown screen)",
      category: cell.category,
      count: cell.count,
      severityWeightedScore: Math.round(cell.severityWeightedScore * 10) / 10,
    }))
    .sort((a, b) => b.severityWeightedScore - a.severityWeightedScore);
}
