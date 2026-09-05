// Deeper Bug Detection #6 -- UI-vs-API consistency check. Where a page renders
// data that maps to a known API response (a list, a table, an "N results"
// count), compares what's rendered against what the API actually returned and
// flags a mismatch. Reliably auto-pairing an arbitrary rendered list with the
// right endpoint/field isn't a solvable heuristic in general, so the pairing
// is declarative (ui_api_consistency_rules): a human names, once, which CSS
// selector's matched-element count should equal which JSON path in which
// endpoint's response -- then every future scan checks it automatically.

import { nanoid } from "nanoid";
import type { Page } from "playwright";
import { db } from "../db.js";
import { recordBugFinding, type BugFindingRow } from "./bugDetectionService.js";

export type ConsistencyComparisonMode = "exact" | "at-most";

export interface ConsistencyRuleRow {
  id: string;
  screen_id: string;
  name: string | null;
  dom_selector: string;
  api_endpoint_key: string;
  json_path: string;
  comparison_mode: ConsistencyComparisonMode;
  is_active: number;
  created_at: string;
}

export function listConsistencyRules(screenId?: string): ConsistencyRuleRow[] {
  if (screenId) {
    return db.prepare("SELECT * FROM ui_api_consistency_rules WHERE screen_id = ? ORDER BY created_at DESC").all(screenId) as ConsistencyRuleRow[];
  }
  return db.prepare("SELECT * FROM ui_api_consistency_rules ORDER BY created_at DESC").all() as ConsistencyRuleRow[];
}

export function getConsistencyRule(id: string): ConsistencyRuleRow | undefined {
  return db.prepare("SELECT * FROM ui_api_consistency_rules WHERE id = ?").get(id) as ConsistencyRuleRow | undefined;
}

export function createConsistencyRule(input: {
  screenId: string;
  name?: string;
  domSelector: string;
  apiEndpointKey: string;
  jsonPath?: string;
  comparisonMode?: ConsistencyComparisonMode;
}): ConsistencyRuleRow {
  if (!input.screenId || !input.domSelector || !input.apiEndpointKey) {
    throw new Error("screenId, domSelector, and apiEndpointKey are required");
  }
  if (input.comparisonMode && input.comparisonMode !== "exact" && input.comparisonMode !== "at-most") {
    throw new Error("comparisonMode must be 'exact' or 'at-most'");
  }
  const id = nanoid(10);
  const now = new Date().toISOString();
  const row = {
    id,
    screen_id: input.screenId,
    name: input.name ?? null,
    dom_selector: input.domSelector,
    api_endpoint_key: input.apiEndpointKey,
    json_path: input.jsonPath ?? "",
    comparison_mode: input.comparisonMode ?? "exact",
    is_active: 1,
    created_at: now,
  };
  db.prepare(`
    INSERT INTO ui_api_consistency_rules (id, screen_id, name, dom_selector, api_endpoint_key, json_path, comparison_mode, is_active, created_at)
    VALUES (@id, @screen_id, @name, @dom_selector, @api_endpoint_key, @json_path, @comparison_mode, @is_active, @created_at)
  `).run(row);
  return row as ConsistencyRuleRow;
}

export function setConsistencyRuleActive(id: string, active: boolean): ConsistencyRuleRow {
  db.prepare("UPDATE ui_api_consistency_rules SET is_active = ? WHERE id = ?").run(active ? 1 : 0, id);
  const row = getConsistencyRule(id);
  if (!row) throw new Error("Consistency rule not found");
  return row;
}

export function deleteConsistencyRule(id: string): void {
  db.prepare("DELETE FROM ui_api_consistency_rules WHERE id = ?").run(id);
}

/** Resolve a count from a captured JSON body at the given dot path ('' = root). */
function resolveCount(body: unknown, jsonPath: string): number | null {
  let value: unknown = body;
  if (jsonPath) {
    for (const key of jsonPath.split(".")) {
      if (value === null || value === undefined || typeof value !== "object") return null;
      value = (value as Record<string, unknown>)[key];
    }
  }
  if (Array.isArray(value)) return value.length;
  if (typeof value === "number") return value;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.count === "number") return obj.count;
    if (typeof obj.total === "number") return obj.total;
    if (Array.isArray(obj.items)) return obj.items.length;
  }
  return null;
}

/**
 * Runs every active consistency rule for a screen against the page currently
 * open (for the DOM count) and the response bodies captured during this same
 * page visit (for the API count) -- called from
 * bugDetectionService.scanScreenForUiBugs right after network capture, so
 * both sides reflect the same page load.
 */
export async function checkUiApiConsistency(
  page: Page,
  screenId: string,
  screenName: string,
  capturedBodies: Map<string, unknown>,
  runId?: string
): Promise<BugFindingRow[]> {
  const rules = listConsistencyRules(screenId).filter((r) => r.is_active);
  if (rules.length === 0) return [];

  const findings: BugFindingRow[] = [];
  for (const rule of rules) {
    if (!capturedBodies.has(rule.api_endpoint_key)) continue; // that endpoint wasn't called during this page visit
    const apiCount = resolveCount(capturedBodies.get(rule.api_endpoint_key), rule.json_path);
    if (apiCount === null) continue;

    const uiCount = await page.locator(rule.dom_selector).count().catch(() => -1);
    if (uiCount < 0) continue;

    // 'at-most' tolerates the UI showing FEWER elements than the API
    // returned (a paginated view showing page 1 of N, a virtualized list
    // only rendering visible rows) -- both are legitimate, not a bug. It
    // still flags the UI showing MORE than the API returned, which is
    // never legitimate (there's no more data to render that many from).
    const mismatch = rule.comparison_mode === "at-most" ? uiCount > apiCount : uiCount !== apiCount;

    if (mismatch) {
      findings.push(
        recordBugFinding({
          source: "ui_exploratory",
          category: "ui-api-mismatch",
          severity: "medium",
          title: `${rule.name || rule.dom_selector} count (${uiCount}) doesn't match ${rule.api_endpoint_key} (${apiCount})`,
          detail: `The page renders ${uiCount} element(s) matching "${rule.dom_selector}", but ${rule.api_endpoint_key}${rule.json_path ? ` at ${rule.json_path}` : ""} returned ${apiCount} (mode: ${rule.comparison_mode}).`,
          screenId,
          runId,
          evidence: { rule: { selector: rule.dom_selector, endpointKey: rule.api_endpoint_key, jsonPath: rule.json_path, comparisonMode: rule.comparison_mode }, uiCount, apiCount },
          stepsToReproduce: [
            `Navigate to: ${screenName}`,
            `Count elements matching "${rule.dom_selector}" on the rendered page: ${uiCount}`,
            `Compare against ${rule.api_endpoint_key}'s response${rule.json_path ? ` at ${rule.json_path}` : ""}: ${apiCount}`,
            `Observe: the two counts disagree (comparison mode: ${rule.comparison_mode}).`,
          ],
        })
      );
    }
  }
  return findings;
}
