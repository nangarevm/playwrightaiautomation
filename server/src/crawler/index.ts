// Orchestrator: ties discovery (Phase 1) + locator extraction (Phase 2) +
// scenario generation (Phase 3) + diff-against-baseline (Phase 4) + API
// capture (Phase 5) into one call. Deliberately has no database dependency --
// the caller (services/crawlerService.ts) supplies a `getBaseline` lookup and
// owns all persistence, so this module stays independently testable.

import { runDiscoveryCrawl } from "./discovery.js";
import { buildCrudFlowScenario, buildFlowScenariosForSite, buildIntraPageFlowScenario, buildScenariosForPage } from "./scenarios.js";
import { buildApiScenariosForSite } from "./apiScenarios.js";
import { classifyChange, diffElements, hashElements, type ChangeStatus } from "./diff.js";
import { collectPageSpellingIssues } from "./spellcheck.js";
import { dedupeScenariosFuzzy, scenarioFingerprint } from "./scenarioDedup.js";
import { normalizeUrl } from "./urlUtils.js";
import type { ApiCallRecord, ComponentInventoryItem, CrawlOptions, ElementRecord, PageDiff, ScenarioRecord, SpellingIssue } from "./types.js";

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
  componentInventory: ComponentInventoryItem[];
}

export interface CrawlRunOutput {
  schemaVersion: "1.0";
  site: string;
  crawledAt: string;
  authenticated: boolean;
  authMessage: string;
  pages: CrawledPageOutput[];
  /** Re-crawl summary: how many pages were new/changed/unchanged this run. */
  summary: {
    mode: "incremental" | "full";
    newPages: number;
    changedPages: number;
    unchangedPages: number;
    reusedBaselines: number;
  };
}

export interface BaselineLookup {
  (url: string): { hash: string; elements: ElementRecord[] } | null;
}

export async function runCrawl(options: CrawlOptions, getBaseline: BaselineLookup): Promise<CrawlRunOutput> {
  const mode = options.mode ?? "full";
  const { pages, edges, authenticated, authMessage } = await runDiscoveryCrawl({
    ...options,
    mode,
    getBaseline,
  });

  let reusedBaselines = 0;
  const output: CrawledPageOutput[] = pages.map((discovered) => {
    const hash = hashElements(discovered.elements);
    const baseline = getBaseline(discovered.url);
    // Reused baseline pages are unchanged by definition -- skip re-hash surprises
    // from shallow vs deep locator differences.
    const changeStatus: ChangeStatus = discovered.reusedBaseline
      ? "unchanged"
      : classifyChange(baseline?.hash, hash);
    if (discovered.reusedBaseline) reusedBaselines++;

    let scenarios: ScenarioRecord[] = [];
    let diff: PageDiff | null = null;
    if (changeStatus !== "unchanged") {
      scenarios = dedupeScenariosFuzzy(buildScenariosForPage(discovered.title, discovered.elements, discovered.formCount));
      const crudFlow = buildCrudFlowScenario(discovered.title, discovered.elements);
      if (crudFlow) scenarios.push(crudFlow);
      scenarios = dedupeScenariosFuzzy(scenarios);
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
      spellingIssues: changeStatus === "unchanged" ? [] : collectPageSpellingIssues(discovered.title, discovered.elements),
      componentInventory: discovered.componentInventory,
    };
  });

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

  const siteFlowFingerprints = new Set<string>();
  for (const page of output) {
    if (page.changeStatus === "unchanged") continue;
    const flowResults = buildFlowScenariosForSite(
      page.url,
      output.map((p) => ({ url: p.url, title: p.title, elements: p.elements })),
      edges
    );
    for (const { scenario, entryUrl } of flowResults) {
      const fp = scenarioFingerprint(scenario);
      if (siteFlowFingerprints.has(fp)) continue;
      siteFlowFingerprints.add(fp);
      const owner = output.find((p) => p.url === entryUrl);
      owner?.scenarios.push(scenario);
    }
  }

  // Guarantee the flow slot is never empty for a page that has interactive
  // elements when the site graph didn't yield a multi-page journey for it.
  for (const page of output) {
    if (page.changeStatus === "unchanged") continue;
    const hasFlow = page.scenarios.some((s) => s.type === "flow");
    if (hasFlow) continue;
    const intra = buildIntraPageFlowScenario(page.title, page.elements);
    if (intra) {
      const fp = scenarioFingerprint(intra);
      if (!siteFlowFingerprints.has(fp)) {
        siteFlowFingerprints.add(fp);
        page.scenarios.push(intra);
      }
    }
  }

  for (const page of output) {
    page.scenarios = dedupeScenariosFuzzy(page.scenarios);
  }

  return {
    schemaVersion: "1.0",
    site: options.url,
    crawledAt: new Date().toISOString(),
    authenticated,
    authMessage,
    pages: output,
    summary: {
      mode,
      newPages: output.filter((p) => p.changeStatus === "new").length,
      changedPages: output.filter((p) => p.changeStatus === "changed").length,
      unchangedPages: output.filter((p) => p.changeStatus === "unchanged").length,
      reusedBaselines,
    },
  };
}

function safeHost(rawUrl: string): string | null {
  try {
    return new URL(normalizeUrl(rawUrl)).host;
  } catch {
    return null;
  }
}

export * from "./types.js";
