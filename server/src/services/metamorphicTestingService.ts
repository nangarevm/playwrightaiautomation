// Playbook §34 -- Metamorphic Testing Engine (entirely net-new). Every other
// list-behavior check in this codebase (listBehaviorTestingService.ts, §F/§G/§H)
// checks an ABSOLUTE property of one result ("is this list actually sorted",
// "does every result contain the search term"). Metamorphic testing checks a
// RELATION between two related actions instead -- useful precisely when
// there's no simple absolute oracle, but a mathematical property the
// behavior MUST satisfy regardless of implementation:
//
//   MR-SORT   Sorting a list is a PERMUTATION, never a filter -- the exact
//             same set of items must be present before and after, just
//             possibly reordered. A sort that silently drops or duplicates
//             an item (a common bug with tie-breaking or a buggy client-side
//             re-render) violates this regardless of which column/direction
//             was requested.
//   MR-FILTER Applying two independent filters in either order must produce
//             the SAME result set -- AND is commutative. A UI whose filter B
//             resets filter A (or otherwise has order-dependent state) will
//             violate this even though each filter looks correct in
//             isolation.
//   MR-SEARCH A strictly more specific query (built by appending characters
//             to a broader one) can only ever NARROW a substring-search
//             result set, never introduce an item the broader query didn't
//             already match. A violation here means search isn't behaving
//             as a monotonic narrowing filter -- e.g. a debounce/race bug
//             serving a stale, unrelated result set for the longer query.
//
// Modeled the same way as listBehaviorTestingService.ts -- app-specific
// selectors are supplied by a human/integration per call.
//
// FALSE-POSITIVE RISK: MR-SEARCH assumes substring semantics (narrower query
// text is a superset of the broader query's characters, e.g. "appl" built by
// appending to "app") -- an app whose search is intentionally NOT substring-
// based (fuzzy/typo-tolerant/synonym search) can legitimately return an item
// for "appl" that "app" didn't match, which would misreport as a violation.
// Only use runSearchNarrowingScenario against a search you know is substring-
// based. MR-FILTER assumes the two filters are logically independent (each
// narrows by an unrelated property) -- two filters that are themselves
// mutually exclusive by design (e.g. "Status: Active" vs "Status: Archived"
// on the same field) aren't a meaningful pairing for this relation.

import { chromium, type Page } from "playwright";
import { recordBugFinding, type BugFindingRow } from "./bugDetectionService.js";

export const METAMORPHIC_CONFIG = {
  graceMs: 800,
  navTimeoutMs: 30000,
};

async function launch() {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.SCAN_CHROMIUM_PATH || undefined });
  const context = await browser.newContext();
  const page = await context.newPage();
  return { browser, page };
}

async function readItemIds(page: Page, itemSelector: string, idSelector?: string): Promise<string[]> {
  const items = page.locator(itemSelector);
  const count = await items.count();
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const item = items.nth(i);
    const target = idSelector ? item.locator(idSelector).first() : item;
    const text = (await target.textContent().catch(() => null)) ?? "";
    ids.push(text.trim());
  }
  return ids;
}

function sameSet(a: string[], b: string[]): { equal: boolean; onlyInA: string[]; onlyInB: string[] } {
  const countOf = (arr: string[]) => {
    const m = new Map<string, number>();
    for (const x of arr) m.set(x, (m.get(x) ?? 0) + 1);
    return m;
  };
  const ca = countOf(a);
  const cb = countOf(b);
  const onlyInA: string[] = [];
  const onlyInB: string[] = [];
  for (const [k, n] of ca) if ((cb.get(k) ?? 0) !== n) onlyInA.push(k);
  for (const [k, n] of cb) if ((ca.get(k) ?? 0) !== n) onlyInB.push(k);
  return { equal: onlyInA.length === 0 && onlyInB.length === 0, onlyInA, onlyInB };
}

// ---- MR-SORT: sort is a permutation ----

export interface SortPermutationScenario {
  name: string;
  url: string;
  sortControlSelector: string;
  itemSelector: string;
  idSelector?: string;
  graceMs?: number;
  screenId?: string | null;
  runId?: string | null;
}

export async function runSortPermutationScenario(scenario: SortPermutationScenario): Promise<BugFindingRow[]> {
  const findings: BugFindingRow[] = [];
  const grace = scenario.graceMs ?? METAMORPHIC_CONFIG.graceMs;
  const { browser, page } = await launch();
  try {
    await page.goto(scenario.url, { waitUntil: "domcontentloaded", timeout: METAMORPHIC_CONFIG.navTimeoutMs }).catch(() => undefined);
    const before = await readItemIds(page, scenario.itemSelector, scenario.idSelector);

    await page.locator(scenario.sortControlSelector).first().click({ timeout: 10000 }).catch(() => undefined);
    await page.waitForTimeout(grace);
    const after = await readItemIds(page, scenario.itemSelector, scenario.idSelector);

    const diff = sameSet(before, after);
    if (!diff.equal) {
      findings.push(
        recordBugFinding({
          source: "ui_exploratory",
          category: "functional",
          severity: "high",
          title: `Sorting changed the item set (metamorphic relation violated): ${scenario.name}`,
          detail: `Sorting must be a permutation of the SAME items, never add/remove/duplicate any -- but after clicking "${scenario.sortControlSelector}", the item set changed.${diff.onlyInA.length ? ` Item(s) present before sort but missing after: ${diff.onlyInA.join(", ")}.` : ""}${diff.onlyInB.length ? ` Item(s) present after sort but not before: ${diff.onlyInB.join(", ")}.` : ""}`,
          screenId: scenario.screenId ?? null,
          runId: scenario.runId ?? null,
          evidence: { scenario: scenario.name, before, after, onlyInA: diff.onlyInA, onlyInB: diff.onlyInB },
          stepsToReproduce: [
            `Navigate to ${scenario.url}`,
            `Record the visible item set`,
            `Click "${scenario.sortControlSelector}"`,
            `Observe: the item set changed instead of just reordering (missing: [${diff.onlyInA.join(", ")}], added: [${diff.onlyInB.join(", ")}])`,
          ],
        })
      );
    }
  } finally {
    await browser.close();
  }
  return findings;
}

// ---- MR-FILTER: filter order independence (AND is commutative) ----

export interface FilterOrderIndependenceScenario {
  name: string;
  url: string;
  filterASelector: string;
  filterBSelector: string;
  itemSelector: string;
  idSelector?: string;
  graceMs?: number;
  screenId?: string | null;
  runId?: string | null;
}

export async function runFilterOrderIndependenceScenario(scenario: FilterOrderIndependenceScenario): Promise<BugFindingRow[]> {
  const findings: BugFindingRow[] = [];
  const grace = scenario.graceMs ?? METAMORPHIC_CONFIG.graceMs;
  const { browser, page } = await launch();
  try {
    // Order 1: A then B.
    await page.goto(scenario.url, { waitUntil: "domcontentloaded", timeout: METAMORPHIC_CONFIG.navTimeoutMs }).catch(() => undefined);
    await page.locator(scenario.filterASelector).first().click({ timeout: 10000 }).catch(() => undefined);
    await page.waitForTimeout(grace);
    await page.locator(scenario.filterBSelector).first().click({ timeout: 10000 }).catch(() => undefined);
    await page.waitForTimeout(grace);
    const orderAB = await readItemIds(page, scenario.itemSelector, scenario.idSelector);

    // Order 2: B then A, from a fresh page load.
    await page.goto(scenario.url, { waitUntil: "domcontentloaded", timeout: METAMORPHIC_CONFIG.navTimeoutMs }).catch(() => undefined);
    await page.locator(scenario.filterBSelector).first().click({ timeout: 10000 }).catch(() => undefined);
    await page.waitForTimeout(grace);
    await page.locator(scenario.filterASelector).first().click({ timeout: 10000 }).catch(() => undefined);
    await page.waitForTimeout(grace);
    const orderBA = await readItemIds(page, scenario.itemSelector, scenario.idSelector);

    const diff = sameSet(orderAB, orderBA);
    if (!diff.equal) {
      findings.push(
        recordBugFinding({
          source: "ui_exploratory",
          category: "functional",
          severity: "high",
          title: `Filter order changed the result set (metamorphic relation violated): ${scenario.name}`,
          detail: `Applying "${scenario.filterASelector}" then "${scenario.filterBSelector}" produced a different result set than applying them in the opposite order -- independent filters combined with AND must be order-independent. This suggests one filter resets/overrides the other rather than the two being combined.`,
          screenId: scenario.screenId ?? null,
          runId: scenario.runId ?? null,
          evidence: { scenario: scenario.name, orderAB, orderBA, onlyInAB: diff.onlyInA, onlyInBA: diff.onlyInB },
          stepsToReproduce: [
            `Navigate to ${scenario.url}`,
            `Apply "${scenario.filterASelector}" then "${scenario.filterBSelector}" -- note the result set`,
            `Reload, then apply "${scenario.filterBSelector}" then "${scenario.filterASelector}" -- note the result set`,
            `Observe: the two result sets differ (only in A-then-B: [${diff.onlyInA.join(", ")}], only in B-then-A: [${diff.onlyInB.join(", ")}])`,
          ],
        })
      );
    }
  } finally {
    await browser.close();
  }
  return findings;
}

// ---- MR-SEARCH: narrowing a query only ever shrinks the result set ----

export interface SearchNarrowingScenario {
  name: string;
  url: string;
  searchInputSelector: string;
  /** The broader query, e.g. "app". */
  broaderQuery: string;
  /** A strictly more specific query built by appending characters to broaderQuery, e.g. "appl". */
  narrowerQuery: string;
  itemSelector: string;
  idSelector?: string;
  graceMs?: number;
  screenId?: string | null;
  runId?: string | null;
}

export async function runSearchNarrowingScenario(scenario: SearchNarrowingScenario): Promise<BugFindingRow[]> {
  if (!scenario.narrowerQuery.toLowerCase().startsWith(scenario.broaderQuery.toLowerCase())) {
    throw new Error("narrowerQuery must extend broaderQuery (e.g. broaderQuery 'app', narrowerQuery 'appl') for the narrowing relation to apply.");
  }
  const findings: BugFindingRow[] = [];
  const grace = scenario.graceMs ?? METAMORPHIC_CONFIG.graceMs;
  const { browser, page } = await launch();
  try {
    await page.goto(scenario.url, { waitUntil: "domcontentloaded", timeout: METAMORPHIC_CONFIG.navTimeoutMs }).catch(() => undefined);

    await page.locator(scenario.searchInputSelector).first().fill(scenario.broaderQuery, { timeout: 10000 }).catch(() => undefined);
    await page.keyboard.press("Enter").catch(() => undefined);
    await page.waitForTimeout(grace);
    const broaderResults = await readItemIds(page, scenario.itemSelector, scenario.idSelector);

    await page.locator(scenario.searchInputSelector).first().fill(scenario.narrowerQuery, { timeout: 10000 }).catch(() => undefined);
    await page.keyboard.press("Enter").catch(() => undefined);
    await page.waitForTimeout(grace);
    const narrowerResults = await readItemIds(page, scenario.itemSelector, scenario.idSelector);

    const broaderSet = new Set(broaderResults);
    const introduced = narrowerResults.filter((id) => !broaderSet.has(id));
    if (introduced.length > 0) {
      findings.push(
        recordBugFinding({
          source: "ui_exploratory",
          category: "functional",
          severity: "high",
          title: `Narrower search introduced result(s) the broader search didn't have (metamorphic relation violated): ${scenario.name}`,
          detail: `Searching "${scenario.narrowerQuery}" (which extends "${scenario.broaderQuery}") returned item(s) not present in "${scenario.broaderQuery}"'s own results: ${introduced.join(", ")} -- a substring-based search's results should only ever shrink as the query becomes more specific, never introduce new matches. This suggests a stale/race result set (e.g. a debounced search returning results for an earlier query) rather than a genuine substring-narrowing bug.`,
          screenId: scenario.screenId ?? null,
          runId: scenario.runId ?? null,
          evidence: { scenario: scenario.name, broaderQuery: scenario.broaderQuery, narrowerQuery: scenario.narrowerQuery, broaderResults, narrowerResults, introduced },
          stepsToReproduce: [
            `Navigate to ${scenario.url}`,
            `Search "${scenario.broaderQuery}" -- note the result set`,
            `Search "${scenario.narrowerQuery}" -- note the result set`,
            `Observe: the narrower query's results include item(s) not present in the broader query's results: ${introduced.join(", ")}`,
          ],
        })
      );
    }
  } finally {
    await browser.close();
  }
  return findings;
}
