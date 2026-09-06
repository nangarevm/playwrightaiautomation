// Playbook §F/§G/§H -- Search, Filter/Sort, and Pagination testing (entirely
// net-new). These three UI patterns share one root cause for most of their
// real-world bugs: a rendered LIST that's supposed to change in a specific,
// checkable way in response to a user action, and doesn't (or changes wrong).
// Each scenario type below reads the list's own rendered content before and
// after the action and checks a concrete, deterministic property of it --
// no LLM judgment call needed, these are all mechanically verifiable facts:
//
//   §F Search  -- every visible result actually contains the search term
//                 (irrelevant-result bug), and clearing the search restores
//                 the original result count (stuck-filter bug).
//   §G Filter  -- a single filter narrows (never grows) the result count,
//                 and combining two filters narrows AT LEAST as much as
//                 either alone (catches an accidental OR where an AND was
//                 intended -- a very common real-world filter bug).
//   §G Sort    -- the list's own values, read from the page, are actually
//                 in the requested order (a "sort button that doesn't sort"
//                 or sorts the wrong column is otherwise invisible to a
//                 human skimming the list without doing the comparison
//                 by hand).
//   §H Pagination -- no single item id reappears across two different
//                 pages (a duplicate-item bug, usually from an off-by-one
//                 in the backend's offset/limit), and clicking "next" makes
//                 the page's own content actually change (a "stuck next
//                 button" bug).
//
// Modeled the same way as stateTransitionService.ts / multiTabTestingService.ts
// -- app-specific knowledge (which selector is the search box, which is the
// sort control) can't be reliably inferred from an arbitrary crawled page, so
// a human/integration names the concrete selectors once per scenario call.
//
// FALSE-POSITIVE RISK: LIST_BEHAVIOR_CONFIG.graceMs is a fixed wait after
// triggering search/filter/sort/pagination, standing in for "however long
// this app's own debounce + API round-trip takes" -- an app slower than the
// default will read as "nothing changed" when it just hadn't finished yet.
// Override graceMs per call via the scenario's own `graceMs` field if your
// app is slower. Sort-order comparison treats equal adjacent values as
// satisfying either direction (a stable sort with ties is correct, not a
// violation) -- only a genuine inversion between two DIFFERENT values counts.

import { chromium, type Page } from "playwright";
import { recordBugFinding, type BugFindingRow } from "./bugDetectionService.js";

export const LIST_BEHAVIOR_CONFIG = {
  graceMs: 800,
  navTimeoutMs: 30000,
  /** Pagination: hard cap on how many "next" clicks a single scenario run will make, so a stuck/looping "next" button can't hang a scan forever. */
  maxPages: 10,
};

async function launch() {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.SCAN_CHROMIUM_PATH || undefined });
  const context = await browser.newContext();
  const page = await context.newPage();
  return { browser, context, page };
}

async function readItemTexts(page: Page, itemSelector: string, valueSelector?: string): Promise<string[]> {
  const items = page.locator(itemSelector);
  const count = await items.count();
  const texts: string[] = [];
  for (let i = 0; i < count; i++) {
    const item = items.nth(i);
    const target = valueSelector ? item.locator(valueSelector).first() : item;
    const text = (await target.textContent().catch(() => null)) ?? "";
    texts.push(text.trim());
  }
  return texts;
}

function parseNumeric(text: string): number | null {
  const match = text.replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : null;
}

// ---- §F: Search ----

export interface SearchScenario {
  name: string;
  url: string;
  searchInputSelector: string;
  searchTerm: string;
  itemSelector: string;
  /** Sub-selector within each item to read the relevance-checkable text from. Defaults to the item's own full text. */
  itemTextSelector?: string;
  /** Shown when a search legitimately matches nothing. If given and not visible on a 0-result search, that's a silent-empty-result finding. */
  noResultsSelector?: string;
  graceMs?: number;
  screenId?: string | null;
  runId?: string | null;
}

export async function runSearchScenario(scenario: SearchScenario): Promise<BugFindingRow[]> {
  const findings: BugFindingRow[] = [];
  const grace = scenario.graceMs ?? LIST_BEHAVIOR_CONFIG.graceMs;
  const { browser, page } = await launch();
  try {
    await page.goto(scenario.url, { waitUntil: "domcontentloaded", timeout: LIST_BEHAVIOR_CONFIG.navTimeoutMs }).catch(() => undefined);
    const baselineCount = await page.locator(scenario.itemSelector).count();

    await page.locator(scenario.searchInputSelector).first().fill(scenario.searchTerm, { timeout: 10000 }).catch(() => undefined);
    await page.keyboard.press("Enter").catch(() => undefined);
    await page.waitForTimeout(grace);

    const resultTexts = await readItemTexts(page, scenario.itemSelector, scenario.itemTextSelector);
    const term = scenario.searchTerm.toLowerCase();
    const irrelevant = resultTexts.filter((t) => !t.toLowerCase().includes(term));

    if (resultTexts.length === 0 && scenario.noResultsSelector) {
      const noResultsVisible = await page.locator(scenario.noResultsSelector).first().isVisible().catch(() => false);
      if (!noResultsVisible) {
        findings.push(
          recordBugFinding({
            source: "ui_exploratory",
            category: "functional",
            severity: "medium",
            title: `Silent empty search result: ${scenario.name}`,
            detail: `Searching "${scenario.searchTerm}" in "${scenario.searchInputSelector}" produced zero results, but "${scenario.noResultsSelector}" (the configured no-results indicator) was not shown -- the user sees a blank list with no explanation.`,
            screenId: scenario.screenId ?? null,
            runId: scenario.runId ?? null,
            evidence: { scenario: scenario.name, searchTerm: scenario.searchTerm },
            stepsToReproduce: [`Navigate to ${scenario.url}`, `Search for "${scenario.searchTerm}"`, `Observe: the list is empty and no "no results" message is shown.`],
          })
        );
      }
    }

    if (irrelevant.length > 0) {
      findings.push(
        recordBugFinding({
          source: "ui_exploratory",
          category: "functional",
          severity: "high",
          title: `Search returned irrelevant result(s): ${scenario.name}`,
          detail: `Searching "${scenario.searchTerm}" returned ${resultTexts.length} result(s), of which ${irrelevant.length} do not actually contain "${scenario.searchTerm}" (e.g. "${irrelevant[0]}") -- the search is not correctly filtering by the entered term.`,
          screenId: scenario.screenId ?? null,
          runId: scenario.runId ?? null,
          evidence: { scenario: scenario.name, searchTerm: scenario.searchTerm, irrelevantSample: irrelevant.slice(0, 5) },
          stepsToReproduce: [`Navigate to ${scenario.url}`, `Search for "${scenario.searchTerm}"`, `Observe: at least one visible result does not contain "${scenario.searchTerm}", e.g. "${irrelevant[0]}"`],
        })
      );
    }

    await page.locator(scenario.searchInputSelector).first().fill("", { timeout: 10000 }).catch(() => undefined);
    await page.keyboard.press("Enter").catch(() => undefined);
    await page.waitForTimeout(grace);
    const restoredCount = await page.locator(scenario.itemSelector).count();
    if (restoredCount !== baselineCount) {
      findings.push(
        recordBugFinding({
          source: "ui_exploratory",
          category: "functional",
          severity: "medium",
          title: `Clearing search did not restore the original result count: ${scenario.name}`,
          detail: `Before searching, "${scenario.itemSelector}" showed ${baselineCount} item(s); after clearing the search box back to empty, it shows ${restoredCount} -- the list did not return to its original state.`,
          screenId: scenario.screenId ?? null,
          runId: scenario.runId ?? null,
          evidence: { scenario: scenario.name, baselineCount, restoredCount },
          stepsToReproduce: [`Navigate to ${scenario.url}`, `Search for "${scenario.searchTerm}"`, `Clear the search box`, `Observe: the item count is ${restoredCount}, not the original ${baselineCount}`],
        })
      );
    }
  } finally {
    await browser.close();
  }
  return findings;
}

// ---- §G: Filter ----

export interface FilterScenario {
  name: string;
  url: string;
  /** Selectors to click/apply to activate each filter (e.g. a checkbox or a select's option), applied in order. */
  filterSelectors: string[];
  itemSelector: string;
  /** Selector to clear all filters back to the unfiltered baseline (e.g. a "Clear filters" button). */
  clearFiltersSelector?: string;
  graceMs?: number;
  screenId?: string | null;
  runId?: string | null;
}

/**
 * Applies each filter in filterSelectors one at a time (from the unfiltered
 * baseline) to record each filter's own individual result count, then
 * applies them all together and checks that the combined count is no larger
 * than the smallest individual count -- an AND of N filters can only ever
 * narrow or match the most restrictive single filter, never exceed it. A
 * combined count that's larger indicates the filters are being combined
 * with OR-like logic (or not actually being combined at all).
 */
export async function runFilterScenario(scenario: FilterScenario): Promise<BugFindingRow[]> {
  if (scenario.filterSelectors.length === 0) throw new Error("A filter scenario needs at least one filterSelector.");
  const findings: BugFindingRow[] = [];
  const grace = scenario.graceMs ?? LIST_BEHAVIOR_CONFIG.graceMs;
  const { browser, page } = await launch();
  try {
    await page.goto(scenario.url, { waitUntil: "domcontentloaded", timeout: LIST_BEHAVIOR_CONFIG.navTimeoutMs }).catch(() => undefined);
    const baselineCount = await page.locator(scenario.itemSelector).count();

    const individualCounts: number[] = [];
    for (const filterSelector of scenario.filterSelectors) {
      await page.reload({ waitUntil: "domcontentloaded", timeout: LIST_BEHAVIOR_CONFIG.navTimeoutMs }).catch(() => undefined);
      await page.locator(filterSelector).first().click({ timeout: 10000 }).catch(() => undefined);
      await page.waitForTimeout(grace);
      const count = await page.locator(scenario.itemSelector).count();
      individualCounts.push(count);
      if (count > baselineCount) {
        findings.push(
          recordBugFinding({
            source: "ui_exploratory",
            category: "functional",
            severity: "high",
            title: `Applying filter increased the result count: ${scenario.name}`,
            detail: `Before filtering, "${scenario.itemSelector}" showed ${baselineCount} item(s); after applying "${filterSelector}" alone, it shows ${count} -- a filter must never show MORE items than the unfiltered baseline.`,
            screenId: scenario.screenId ?? null,
            runId: scenario.runId ?? null,
            evidence: { scenario: scenario.name, filterSelector, baselineCount, count },
            stepsToReproduce: [`Navigate to ${scenario.url}`, `Apply filter "${filterSelector}"`, `Observe: the item count (${count}) exceeds the unfiltered baseline (${baselineCount})`],
          })
        );
      }
    }

    if (scenario.filterSelectors.length > 1) {
      await page.reload({ waitUntil: "domcontentloaded", timeout: LIST_BEHAVIOR_CONFIG.navTimeoutMs }).catch(() => undefined);
      for (const filterSelector of scenario.filterSelectors) {
        await page.locator(filterSelector).first().click({ timeout: 10000 }).catch(() => undefined);
        await page.waitForTimeout(grace);
      }
      const combinedCount = await page.locator(scenario.itemSelector).count();
      const mostRestrictive = Math.min(...individualCounts);
      if (combinedCount > mostRestrictive) {
        findings.push(
          recordBugFinding({
            source: "ui_exploratory",
            category: "functional",
            severity: "high",
            title: `Combining filters did not narrow results as expected (possible OR instead of AND): ${scenario.name}`,
            detail: `Applied individually, the most restrictive of [${scenario.filterSelectors.join(", ")}] showed ${mostRestrictive} item(s); applied together, the list shows ${combinedCount} -- combining filters should never show MORE items than the most restrictive single filter, which suggests the filters are being OR'd together (or the later filter is overriding the earlier one) instead of being combined with AND.`,
            screenId: scenario.screenId ?? null,
            runId: scenario.runId ?? null,
            evidence: { scenario: scenario.name, filterSelectors: scenario.filterSelectors, individualCounts, combinedCount, mostRestrictive },
            stepsToReproduce: [
              `Navigate to ${scenario.url}`,
              ...scenario.filterSelectors.map((s) => `Apply filter "${s}"`),
              `Observe: the combined item count (${combinedCount}) exceeds the most restrictive individual filter's count (${mostRestrictive})`,
            ],
          })
        );
      }
    }

    if (scenario.clearFiltersSelector) {
      await page.locator(scenario.clearFiltersSelector).first().click({ timeout: 10000 }).catch(() => undefined);
      await page.waitForTimeout(grace);
      const restoredCount = await page.locator(scenario.itemSelector).count();
      if (restoredCount !== baselineCount) {
        findings.push(
          recordBugFinding({
            source: "ui_exploratory",
            category: "functional",
            severity: "medium",
            title: `Clearing filters did not restore the original result count: ${scenario.name}`,
            detail: `Before filtering, "${scenario.itemSelector}" showed ${baselineCount} item(s); after clicking "${scenario.clearFiltersSelector}", it shows ${restoredCount} -- clearing filters did not return the list to its original state.`,
            screenId: scenario.screenId ?? null,
            runId: scenario.runId ?? null,
            evidence: { scenario: scenario.name, baselineCount, restoredCount },
            stepsToReproduce: [`Navigate to ${scenario.url}`, `Apply then clear all filters`, `Observe: the item count is ${restoredCount}, not the original ${baselineCount}`],
          })
        );
      }
    }
  } finally {
    await browser.close();
  }
  return findings;
}

// ---- §G: Sort ----

export interface SortScenario {
  name: string;
  url: string;
  sortControlSelector: string;
  itemSelector: string;
  /** Sub-selector within each item holding the sortable value. Defaults to the item's own full text. */
  valueSelector?: string;
  direction: "asc" | "desc";
  valueType?: "number" | "string";
  graceMs?: number;
  screenId?: string | null;
  runId?: string | null;
}

export async function runSortScenario(scenario: SortScenario): Promise<BugFindingRow[]> {
  const findings: BugFindingRow[] = [];
  const grace = scenario.graceMs ?? LIST_BEHAVIOR_CONFIG.graceMs;
  const valueType = scenario.valueType ?? "string";
  const { browser, page } = await launch();
  try {
    await page.goto(scenario.url, { waitUntil: "domcontentloaded", timeout: LIST_BEHAVIOR_CONFIG.navTimeoutMs }).catch(() => undefined);
    await page.locator(scenario.sortControlSelector).first().click({ timeout: 10000 }).catch(() => undefined);
    await page.waitForTimeout(grace);

    const rawTexts = await readItemTexts(page, scenario.itemSelector, scenario.valueSelector);
    const values: Array<string | number> = valueType === "number" ? rawTexts.map((t) => parseNumeric(t) ?? Number.NaN) : rawTexts;

    let violationIndex = -1;
    for (let i = 1; i < values.length; i++) {
      const prev = values[i - 1];
      const curr = values[i];
      if (typeof prev === "number" && Number.isNaN(prev)) continue;
      if (typeof curr === "number" && Number.isNaN(curr)) continue;
      const outOfOrder = scenario.direction === "asc" ? prev > curr : prev < curr;
      if (outOfOrder) {
        violationIndex = i;
        break;
      }
    }

    if (violationIndex !== -1) {
      findings.push(
        recordBugFinding({
          source: "ui_exploratory",
          category: "functional",
          severity: "high",
          title: `List is not correctly sorted (${scenario.direction}): ${scenario.name}`,
          detail: `After clicking "${scenario.sortControlSelector}" (expected ${scenario.direction === "asc" ? "ascending" : "descending"} order), item ${violationIndex} ("${rawTexts[violationIndex]}") is out of order relative to item ${violationIndex - 1} ("${rawTexts[violationIndex - 1]}").`,
          screenId: scenario.screenId ?? null,
          runId: scenario.runId ?? null,
          evidence: { scenario: scenario.name, direction: scenario.direction, values: rawTexts, violationIndex },
          stepsToReproduce: [`Navigate to ${scenario.url}`, `Click "${scenario.sortControlSelector}"`, `Observe: item ${violationIndex} ("${rawTexts[violationIndex]}") is out of ${scenario.direction} order relative to item ${violationIndex - 1} ("${rawTexts[violationIndex - 1]}")`],
        })
      );
    }
  } finally {
    await browser.close();
  }
  return findings;
}

// ---- §H: Pagination ----

export interface PaginationScenario {
  name: string;
  url: string;
  nextPageSelector: string;
  itemSelector: string;
  /** Sub-selector within each item holding a stable per-item identifier (e.g. an id/SKU/name). Defaults to the item's own full text. */
  idSelector?: string;
  /** Hard cap on "next" clicks. Defaults to LIST_BEHAVIOR_CONFIG.maxPages. */
  maxPages?: number;
  graceMs?: number;
  screenId?: string | null;
  runId?: string | null;
}

export async function runPaginationScenario(scenario: PaginationScenario): Promise<BugFindingRow[]> {
  const findings: BugFindingRow[] = [];
  const grace = scenario.graceMs ?? LIST_BEHAVIOR_CONFIG.graceMs;
  const maxPages = scenario.maxPages ?? LIST_BEHAVIOR_CONFIG.maxPages;
  const { browser, page } = await launch();
  try {
    await page.goto(scenario.url, { waitUntil: "domcontentloaded", timeout: LIST_BEHAVIOR_CONFIG.navTimeoutMs }).catch(() => undefined);

    const seenIds = new Map<string, number>(); // id -> first page index it appeared on
    let previousPageIds: string[] = await readItemTexts(page, scenario.itemSelector, scenario.idSelector);
    for (const id of previousPageIds) seenIds.set(id, 1);

    let stuckPageIndex = -1;
    let duplicate: { id: string; firstPage: number; laterPage: number } | null = null;

    for (let pageIndex = 2; pageIndex <= maxPages; pageIndex++) {
      const nextButton = page.locator(scenario.nextPageSelector).first();
      const isVisible = await nextButton.isVisible().catch(() => false);
      if (!isVisible) break;
      const isDisabled = await nextButton.isDisabled().catch(() => false);
      if (isDisabled) break;

      await nextButton.click({ timeout: 10000 }).catch(() => undefined);
      await page.waitForTimeout(grace);
      const currentPageIds = await readItemTexts(page, scenario.itemSelector, scenario.idSelector);

      if (stuckPageIndex === -1 && currentPageIds.length > 0 && currentPageIds.join("|") === previousPageIds.join("|")) {
        stuckPageIndex = pageIndex;
        break;
      }

      for (const id of currentPageIds) {
        const firstPage = seenIds.get(id);
        if (firstPage !== undefined && duplicate === null) {
          duplicate = { id, firstPage, laterPage: pageIndex };
        }
        if (firstPage === undefined) seenIds.set(id, pageIndex);
      }
      previousPageIds = currentPageIds;
    }

    if (stuckPageIndex !== -1) {
      findings.push(
        recordBugFinding({
          source: "ui_exploratory",
          category: "functional",
          severity: "high",
          title: `Pagination "next" did not advance to a new page: ${scenario.name}`,
          detail: `Clicking "${scenario.nextPageSelector}" to go to page ${stuckPageIndex} produced the exact same set of items as the previous page -- the "next" control is not actually advancing.`,
          screenId: scenario.screenId ?? null,
          runId: scenario.runId ?? null,
          evidence: { scenario: scenario.name, stuckPageIndex },
          stepsToReproduce: [`Navigate to ${scenario.url}`, `Click "${scenario.nextPageSelector}" repeatedly`, `Observe: page ${stuckPageIndex} shows identical items to the page before it`],
        })
      );
    }

    if (duplicate) {
      findings.push(
        recordBugFinding({
          source: "ui_exploratory",
          category: "functional",
          severity: "high",
          title: `Pagination shows a duplicate item across pages: ${scenario.name}`,
          detail: `Item "${duplicate.id}" appeared on both page ${duplicate.firstPage} and page ${duplicate.laterPage} -- a paginated list should never show the same item twice across different pages (a common off-by-one in the backend's offset/limit).`,
          screenId: scenario.screenId ?? null,
          runId: scenario.runId ?? null,
          evidence: { scenario: scenario.name, duplicateId: duplicate.id, firstPage: duplicate.firstPage, laterPage: duplicate.laterPage },
          stepsToReproduce: [`Navigate to ${scenario.url}`, `Click "${scenario.nextPageSelector}" through to page ${duplicate.laterPage}`, `Observe: item "${duplicate.id}" also appeared on page ${duplicate.firstPage}`],
        })
      );
    }
  } finally {
    await browser.close();
  }
  return findings;
}
