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

// Default fallback, and what a fresh org_settings row seeds -- two additional
// well-known device classes on top of the existing desktop scan, covering
// the "2-3 viewport sizes" ask. Genuinely configurable (org_settings.
// responsive_viewports_json), not a fixed in-code list, for the same reason
// every other Deeper Bug Detection tunable is: don't hardcode what a team
// might reasonably want to change (a different device mix, a third size).
export const RESPONSIVE_VIEWPORTS: ViewportPreset[] = [
  { name: "mobile", width: 390, height: 844 }, // iPhone 12/13-class
  { name: "tablet", width: 768, height: 1024 }, // iPad-class
];

export function getResponsiveViewports(): ViewportPreset[] {
  const row = db.prepare("SELECT responsive_viewports_json FROM org_settings WHERE id = 1").get() as { responsive_viewports_json: string } | undefined;
  if (!row) return RESPONSIVE_VIEWPORTS;
  try {
    const parsed = JSON.parse(row.responsive_viewports_json);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    return RESPONSIVE_VIEWPORTS;
  } catch {
    return RESPONSIVE_VIEWPORTS;
  }
}

export function setResponsiveViewports(viewports: ViewportPreset[]): void {
  if (!Array.isArray(viewports) || viewports.length === 0 || !viewports.every((v) => v && typeof v.name === "string" && typeof v.width === "number" && typeof v.height === "number")) {
    throw new Error("viewports must be a non-empty array of {name, width, height}");
  }
  db.prepare("UPDATE org_settings SET responsive_viewports_json = ? WHERE id = 1").run(JSON.stringify(viewports));
}

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
  for (const viewport of getResponsiveViewports()) {
    try {
      findings.push(...(await runBugScanForScreen(screenId, runId, { viewport })));
    } catch {
      // Best-effort per viewport -- one failing viewport shouldn't drop the others.
    }
  }
  return findings;
}
