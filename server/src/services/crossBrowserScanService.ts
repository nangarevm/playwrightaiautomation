// Playbook §Q -- Cross-Browser Testing. scanScreenForUiBugs() now accepts an
// optional `browserName` ("chromium" | "firefox" | "webkit", added alongside
// this file in bugDetectionService.ts) -- this module is the orchestration
// layer on top: run the exact same scan against each requested engine, then
// classify every distinct underlying defect as COMMON (present under every
// engine scanned) or BROWSER-SPECIFIC (present under only a subset), which
// is exactly the distinction the master prompt's §Q asks for -- a common bug
// is a real, engine-independent defect; a browser-specific one narrows the
// root cause to that one engine's own rendering/API quirks.
//
// Classification works off each finding's stable `fingerprint` (see
// bugFingerprintService.computeFingerprint, which deliberately never looks
// at evidence.browserName) -- the SAME underlying defect seen on two engines
// hashes identically, so comparing fingerprint SETS across engines is enough;
// no per-engine screenshot/DOM diffing is needed. One consequence worth
// knowing: because scanScreenForUiBugs's own recordBugFinding merges by
// fingerprint across ANY scan (not just within one cross-browser run), a bug
// already seen on an earlier chromium scan and then reproduced on this run's
// firefox scan bumps that SAME stored row's reproducibility counters instead
// of inserting a second row -- so the row's own evidence.browserName ends up
// reflecting only the most recent engine that reproduced it, not every engine
// that ever did. That's a cosmetic limit on the stored evidence field only;
// classification itself is computed from the fingerprints captured
// immediately after each engine's scan below, so it's unaffected.
//
// KNOWN LIMITATION (documented, not a shortcut): only Chromium is installed
// in this repo's dev/test sandbox (see the SCAN_CHROMIUM_PATH workaround
// elsewhere in this codebase) -- the firefox/webkit code paths below (and in
// scanScreenForUiBugs) use Playwright's standard firefox/webkit launchers
// exactly like the chromium path, and are exercised here by unit tests over
// the classification logic (classifyCrossBrowserFindings, which takes plain
// data and launches nothing), but have not been run against a live
// Firefox/WebKit process in this environment. Any environment with
// `npx playwright install firefox webkit` run picks them up with no code
// change.

import { scanScreenForUiBugs, type ScanScreenOptions, type BugFindingRow } from "./bugDetectionService.js";
import { getScreen } from "./screensService.js";

export type ScanBrowserName = "chromium" | "firefox" | "webkit";

export interface CrossBrowserScanResult {
  byBrowser: Partial<Record<ScanBrowserName, BugFindingRow[]>>;
  /** Fingerprints of defects found under EVERY browser passed in -- engine-independent, real defects. */
  common: string[];
  /** Defects found under only a subset of the browsers passed in, with which ones and a representative finding. */
  browserSpecific: Array<{ fingerprint: string; browsers: ScanBrowserName[]; sample: BugFindingRow }>;
}

/**
 * Runs scanScreenForUiBugs once per requested browser engine (sequentially --
 * these are real, resource-heavy browser launches, not something to fan out
 * concurrently by default) and classifies the combined findings as common vs.
 * browser-specific. See the file-level doc comment for the classification
 * approach and its one documented limitation.
 */
export async function scanScreenAcrossBrowsers(
  screen: { id: string; name: string; url_or_path: string | null },
  browsers: ScanBrowserName[],
  runId?: string,
  catalogScreenId?: string | null,
  options?: Omit<ScanScreenOptions, "browserName">
): Promise<CrossBrowserScanResult> {
  if (browsers.length === 0) throw new Error("At least one browser must be specified.");
  const uniqueBrowsers = Array.from(new Set(browsers));
  const byBrowser: Partial<Record<ScanBrowserName, BugFindingRow[]>> = {};
  for (const browserName of uniqueBrowsers) {
    byBrowser[browserName] = await scanScreenForUiBugs(screen, runId, catalogScreenId, { ...options, browserName });
  }
  return classifyCrossBrowserFindings(byBrowser, uniqueBrowsers);
}

// Pure classification logic, split out from scanScreenAcrossBrowsers so it
// can be unit-tested with plain fixture data -- no browser launch needed.
export function classifyCrossBrowserFindings(
  byBrowser: Partial<Record<ScanBrowserName, BugFindingRow[]>>,
  browsers: ScanBrowserName[]
): CrossBrowserScanResult {
  const fingerprintToBrowsers = new Map<string, ScanBrowserName[]>();
  const fingerprintToSample = new Map<string, BugFindingRow>();
  for (const browserName of browsers) {
    for (const finding of byBrowser[browserName] ?? []) {
      if (!finding.fingerprint) continue; // shouldn't happen (recordBugFinding always sets it) -- skip defensively rather than misclassify
      const list = fingerprintToBrowsers.get(finding.fingerprint) ?? [];
      if (!list.includes(browserName)) list.push(browserName);
      fingerprintToBrowsers.set(finding.fingerprint, list);
      if (!fingerprintToSample.has(finding.fingerprint)) fingerprintToSample.set(finding.fingerprint, finding);
    }
  }

  const common: string[] = [];
  const browserSpecific: Array<{ fingerprint: string; browsers: ScanBrowserName[]; sample: BugFindingRow }> = [];
  for (const [fingerprint, seenIn] of fingerprintToBrowsers) {
    if (seenIn.length === browsers.length) {
      common.push(fingerprint);
    } else {
      browserSpecific.push({ fingerprint, browsers: seenIn, sample: fingerprintToSample.get(fingerprint)! });
    }
  }

  return { byBrowser, common, browserSpecific };
}

// Orchestrator mirroring bugDetectionService.runBugScanForScreen -- looks up
// a cataloged Screen by id and runs the cross-browser scan against it.
// Available on demand via POST /api/bugs/scan/cross-browser.
export async function runCrossBrowserBugScanForScreen(
  screenId: string,
  browsers: ScanBrowserName[],
  runId?: string,
  options?: Omit<ScanScreenOptions, "browserName">
): Promise<CrossBrowserScanResult> {
  const screen = getScreen(screenId) as { id: string; name: string; url_or_path: string | null } | undefined;
  if (!screen) throw new Error("Screen not found.");
  return scanScreenAcrossBrowsers(screen, browsers, runId, screenId, options);
}
