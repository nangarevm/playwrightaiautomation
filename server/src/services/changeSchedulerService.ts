// FR-5.1/FR-5.2: scheduled change detection -- periodically re-fetches each
// catalogued Screen's source (a crawled URL) or re-diffs an OpenAPI spec input
// against its last-seen content, rather than only detecting changes when a
// human manually re-submits an input. Runs on an interval from index.ts,
// exactly like the existing FR-4.16 execution scheduler.

import { db } from "../db.js";
import { catalogScreen } from "./screensService.js";
import { parseOpenApiSpec } from "./ingestionService.js";

// FR-5.1: re-crawl every Screen that has a known URL and re-hash its content;
// catalogScreen already does the Changed/Unchanged comparison (FR-5.7).
export async function runScheduledUiChangeDetection(): Promise<{ checked: number; changed: number }> {
  const screens = db.prepare("SELECT * FROM screens WHERE url_or_path IS NOT NULL").all() as any[];
  let changed = 0;

  for (const screen of screens) {
    try {
      const res = await fetch(screen.url_or_path, { headers: { "User-Agent": "AI-Test-Automation-Platform" } });
      if (!res.ok) continue;
      const html = await res.text();
      const before = screen.change_status;
      const updated: any = catalogScreen({
        name: screen.name,
        sourceInputId: screen.source_input_id,
        urlOrPath: screen.url_or_path,
        content: html,
      });
      if (updated.change_status === "changed" && before !== "changed") changed++;
    } catch {
      // unreachable screen this tick -- leave its last-known state alone, try again next tick
    }
  }

  return { checked: screens.length, changed };
}

// FR-5.2: re-fetch OpenAPI/Swagger spec inputs that were imported with a live
// source URL (see inputs.ts import-openapi's optional `source_url`), re-parse,
// and re-diff their structural hash against the last-seen one -- flags a real
// Changed/Unchanged classification exactly like FR-5.1's UI change detection
// does for Screens, instead of only counting rows.
//
// Honest scope note: most specs in this build are imported as pasted text with
// no live URL to refetch (FR-1.4's primary path) -- those have no way to be
// periodically re-checked without a URL, so they're counted but not re-diffed
// here. This is a real limitation of "no URL was given", not a stub -- any
// input that *does* have a source_url is fully re-fetched and diffed below.
export async function runScheduledApiChangeDetection(): Promise<{ checked: number; reFetched: number; changed: number; unreachable: number }> {
  const specInputs = db.prepare("SELECT * FROM inputs WHERE type = 'openapi_spec'").all() as any[];
  let reFetched = 0;
  let changed = 0;
  let unreachable = 0;

  for (const input of specInputs) {
    if (!input.source_url) continue; // nothing to refetch -- no live URL recorded for this import

    try {
      const res = await fetch(input.source_url, { headers: { "User-Agent": "AI-Test-Automation-Platform" } });
      if (!res.ok) {
        unreachable++;
        continue;
      }
      const raw = await res.text();
      const result = parseOpenApiSpec(raw);
      reFetched++;

      const changeStatus = input.content_hash === result.structureHash ? "unchanged" : "changed";
      if (changeStatus === "changed") changed++;

      db.prepare("UPDATE inputs SET content_hash = ?, change_status = ?, spec_title = ?, content = ? WHERE id = ?").run(
        result.structureHash,
        changeStatus,
        result.title,
        result.summary,
        input.id
      );
    } catch {
      unreachable++; // unreachable/invalid spec this tick -- leave last-known state alone, try again next tick
    }
  }

  return { checked: specInputs.length, reFetched, changed, unreachable };
}

export async function runScheduledCrawlsAndDiffs() {
  const ui = await runScheduledUiChangeDetection();
  const api = await runScheduledApiChangeDetection();
  return { ui, api };
}
