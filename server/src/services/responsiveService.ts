// Deeper Bug Detection #5 -- Responsive/multi-viewport checks. Reuses the same
// scanScreenForUiBugs pass (DOM checks + visual regression against a
// per-viewport baseline) that already runs for desktop -- not a separate
// pipeline -- just re-run at mobile/tablet viewport sizes. Desktop itself is
// unchanged (already covered by every existing runBugScanForScreen call
// site); this adds the other viewports on top when responsive scanning is on.

import { db } from "../db.js";
import { runBugScanForScreen, type BugFindingRow } from "./bugDetectionService.js";

export interface ViewportPreset {
  name: string;
  width: number;
  height: number;
}

// A fixed, small in-code list rather than a DB-editable one -- three
// well-known device classes cover the ask ("2-3 viewport sizes") without
// adding another piece of configurable state to maintain; the on/off toggle
// below is the configurable knob that actually matters day to day.
export const RESPONSIVE_VIEWPORTS: ViewportPreset[] = [
  { name: "mobile", width: 390, height: 844 }, // iPhone 12/13-class
  { name: "tablet", width: 768, height: 1024 }, // iPad-class
];

export function isResponsiveScanEnabled(): boolean {
  const row = db.prepare("SELECT responsive_scan_enabled FROM org_settings WHERE id = 1").get() as { responsive_scan_enabled: number } | undefined;
  return row ? row.responsive_scan_enabled === 1 : true;
}

export function setResponsiveScanEnabled(enabled: boolean): void {
  db.prepare("UPDATE org_settings SET responsive_scan_enabled = ? WHERE id = 1").run(enabled ? 1 : 0);
}

/**
 * Runs the same bug scan already used for desktop at each additional
 * configured viewport (mobile, tablet) for a cataloged Screen. Best-effort,
 * mirroring runBugScanForScreen's own call sites -- one viewport's scan
 * failing never drops the others or throws to the caller.
 */
export async function runResponsiveBugScan(screenId: string, runId?: string): Promise<BugFindingRow[]> {
  if (!isResponsiveScanEnabled()) return [];
  const findings: BugFindingRow[] = [];
  for (const viewport of RESPONSIVE_VIEWPORTS) {
    try {
      findings.push(...(await runBugScanForScreen(screenId, runId, { viewport })));
    } catch {
      // Best-effort per viewport -- one failing viewport shouldn't drop the others.
    }
  }
  return findings;
}
