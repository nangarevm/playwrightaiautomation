// Orchestrator: ties discovery (Phase 1) + locator extraction (Phase 2) +
// scenario generation (Phase 3) + diff-against-baseline (Phase 4) + API
// capture (Phase 5) into one call. Deliberately has no database dependency --
// the caller (services/crawlerService.ts) supplies a `getBaseline` lookup and
// owns all persistence, so this module stays independently testable.

import { runDiscoveryCrawl } from "./discovery.js";
import { buildCrudFlowScenario, buildFlowScenariosForSite, buildScenariosForPage } from "./scenarios.js";
import { buildApiScenariosForSite } from "./apiScenarios.js";
import { classifyChange, diffElements, hashElements, type ChangeStatus } from "./diff.js";
import { collectPageSpellingIssues } from "./spellcheck.js";
import type { ApiCallRecord, CrawlOptions, ElementRecord, PageDiff, ScenarioRecord, SpellingIssue } from "./types.js";

export interface CrawledPageOutput {
  url: string;
  title: string;
  hash: string;
  elements: ElementRecord[];
  apis: ApiCallRecord[];
  scenarios: ScenarioRecord[];
  changeStatus: ChangeStatus;
  diff: PageDiff | null;
  spellingIssues: SpellingIssue[];
}

export interface CrawlRunOutput {
  schemaVersion: "1.0";
  site: string;
  crawledAt: string;
  authenticated: boolean;
  authMessage: string;
  pages: CrawledPageOutput[];
}

export interface BaselineLookup {
  (url: string): { hash: string; elements: ElementRecord[] } | null;
}

export async function runCrawl(options: CrawlOptions, getBaseline: BaselineLookup): Promise<CrawlRunOutput> {
  const { pages, edges, authenticated, authMessage } = await runDiscoveryCrawl(options);

  const output: CrawledPageOutput[] = pages.map((discovered) => {
    const hash = hashElements(discovered.elements);
    const baseline = getBaseline(discovered.url);
    const changeStatus = classifyChange(baseline?.hash, hash);

    // Phase 4: only pages that are new or actually changed get full scenario
    // (re-)generation -- an unchanged page keeps whatever scenarios it already
    // had (the caller leaves those rows untouched), which is what makes a
    // re-run fast instead of re-generating everything from scratch.
    let scenarios: ScenarioRecord[] = [];
    let diff: PageDiff | null = null;
    if (changeStatus !== "unchanged") {
      scenarios = buildScenariosForPage(discovered.title, discovered.elements, discovered.formCount);
      const crudFlow = buildCrudFlowScenario(discovered.title, discovered.elements);
      if (crudFlow) scenarios.push(crudFlow);
    }
    if (changeStatus === "changed" && baseline) {
      diff = diffElements(baseline.elements, discovered.elements);
    }

    options.onProgress?.({
      pagesDiscovered: pages.indexOf(discovered) + 1,
      formsDiscovered: discovered.formCount,
      scenariosDiscovered: scenarios.length,
      currentPage: discovered.url,
    });

    return {
      url: discovered.url,
      title: discovered.title,
      hash,
      elements: discovered.elements,
      apis: discovered.apis,
      scenarios,
      changeStatus,
      diff,
      spellingIssues: collectPageSpellingIssues(discovered.title, discovered.elements),
    };
  });

  // Phase 9: API scenarios are deduped across the WHOLE site (the same
  // backend endpoint is typically called from most pages), so this runs once
  // over every page's captured calls rather than per-page like buildScenariosForPage
  // above. Same unchanged-page policy as UI scenarios: an endpoint first seen
  // only on an unchanged page isn't (re)attached this run.
  const siteHost = safeHost(options.url);
  if (siteHost) {
    const apiScenariosByPage = buildApiScenariosForSite(
      siteHost,
      output.map((p) => ({ url: p.url, apis: p.apis }))
    );
    for (const page of output) {
      if (page.changeStatus === "unchanged") continue;
      const apiScenarios = apiScenariosByPage.get(page.url);
      if (apiScenarios) page.scenarios.push(...apiScenarios);
    }
  }

  // Full-application-flow scenarios: walk the navigation graph captured during
  // discovery to find multi-page journeys (e.g. login -> browse -> checkout ->
  // confirmation) rather than only ever generating same-page scenarios. Each
  // journey is attached to its starting page's scenario list (crawl_scenarios.
  // page_id is NOT NULL, so a multi-page scenario needs exactly one owning
  // page row -- the entry page is the natural owner). Same unchanged-page
  // policy as the rest of this function: only regenerated when the entry page
  // itself is new/changed, so a stable site doesn't get duplicate journeys on
  // every re-run.
  const normalizedEntryUrl = normalizeUrlForFlow(options.url);
  const entryPageOutput = output.find((p) => p.url === normalizedEntryUrl);
  if (entryPageOutput && entryPageOutput.changeStatus !== "unchanged") {
    const flowResults = buildFlowScenariosForSite(
      normalizedEntryUrl,
      output.map((p) => ({ url: p.url, title: p.title, elements: p.elements })),
      edges
    );
    for (const { scenario, entryUrl } of flowResults) {
      const owner = output.find((p) => p.url === entryUrl);
      owner?.scenarios.push(scenario);
    }
  }

  return {
    schemaVersion: "1.0",
    site: options.url,
    crawledAt: new Date().toISOString(),
    authenticated,
    authMessage,
    pages: output,
  };
}

function normalizeUrlForFlow(rawUrl: string): string {
  return /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
}

function safeHost(rawUrl: string): string | null {
  try {
    const normalized = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
    return new URL(normalized).host;
  } catch {
    return null;
  }
}

export * from "./types.js";
