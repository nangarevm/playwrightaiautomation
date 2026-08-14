// Orchestrator: ties discovery (Phase 1) + locator extraction (Phase 2) +
// scenario generation (Phase 3) + diff-against-baseline (Phase 4) + API
// capture (Phase 5) into one call. Deliberately has no database dependency --
// the caller (services/crawlerService.ts) supplies a `getBaseline` lookup and
// owns all persistence, so this module stays independently testable.

import { runDiscoveryCrawl, type DiscoveredPage } from "./discovery.js";
import { buildCrudFlowScenario, buildFlowScenariosForSite, buildIntraPageFlowScenario, buildScenariosForPage } from "./scenarios.js";
import { buildApiScenariosForSite } from "./apiScenarios.js";
import { classifyChange, compareLinkSets, compareSnapshots, diffElements, hashElements, type ChangeStatus } from "./diff.js";
import { collectPageSpellingIssues } from "./spellcheck.js";
import { dedupeScenariosFuzzy, scenarioFingerprint } from "./scenarioDedup.js";
import { normalizeUrl } from "./urlUtils.js";
import type { ApiCallRecord, ComponentInventoryItem, CoverageMode, CrawlOptions, ElementRecord, PageDiff, ScenarioRecord, SpellingIssue } from "./types.js";

function resolveCoverageMode(mode?: CoverageMode): CoverageMode {
  if (mode === "standard" || mode === "full" || mode === "minimal") return mode;
  const env = (process.env.CRAWL_COVERAGE_MODE || "minimal").toLowerCase();
  if (env === "standard" || env === "full") return env;
  return "minimal";
}

function maxFlowsForMode(mode: CoverageMode): number {
  if (mode === "minimal") return 5;
  if (mode === "standard") return 10;
  return 20;
}

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
  etag?: string | null;
  lastModified?: string | null;
  a11yHash?: string | null;
  screenshotHash?: string | null;
  changeSignals?: DiscoveredPage["changeSignals"];
  scanMode?: string;
  skippedHttp?: boolean;
  links?: Array<{ url: string; label: string }>;
  snapshot?: DiscoveredPage["snapshot"];
  httpStatus?: number | null;
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
    skippedHttp?: number;
    scannedBrowser?: number;
    deepScans?: number;
    coverage?: {
      reachableHtmlPages: number;
      sitemapUrls: number;
      combinedUnique: number;
      sitemapOnly: number;
      externalLinks: number;
      maxDepth: number;
      statusCounts: Record<string, number>;
      sitemapKeys?: string[];
    };
    restoredPages?: number;
  };
}

export interface BaselineLookup {
  (url: string): import("./types.js").PageBaselineMeta | null;
}

export async function runCrawl(options: CrawlOptions, getBaseline: BaselineLookup): Promise<CrawlRunOutput> {
  const mode = options.mode ?? "full";
  const coverageMode = resolveCoverageMode(options.coverageMode);
  const { pages, edges, authenticated, authMessage, coverage } = await runDiscoveryCrawl({
    ...options,
    mode,
    getBaseline,
  });

  let reusedBaselines = 0;
  const output: CrawledPageOutput[] = pages.map((discovered) => {
    const hash = hashElements(discovered.elements);
    const baseline = getBaseline(discovered.url);
    const snapshotEvents = compareSnapshots(baseline?.snapshot, discovered.snapshot);
    const linkEvents = compareLinkSets(baseline?.links, discovered.links);
    const events = [...snapshotEvents, ...linkEvents];
    if (discovered.changeSignals?.structure === "changed") {
      events.push({ type: "STRUCTURE_CHANGED", severity: "high" });
    }
    if (discovered.changeSignals?.visual === "changed") {
      events.push({ type: "VISUAL_CHANGED", severity: "high" });
    }

    const priorState = (baseline?.priorChangeStatus || "").toLowerCase();
    const wasGone = priorState === "removed" || priorState === "temporarily_unavailable";
    let changeStatus: ChangeStatus = discovered.reusedBaseline
      ? "unchanged"
      : classifyChange(baseline?.hash, hash);
    if (wasGone) changeStatus = "restored";
    else if (discovered.errorCategory) changeStatus = "error";
    else if (changeStatus === "unchanged" && events.length > 0) changeStatus = "changed";
    if (discovered.reusedBaseline) reusedBaselines++;

    let scenarios: ScenarioRecord[] = [];
    let diff: PageDiff | null = null;
    if (changeStatus !== "unchanged") {
      scenarios = dedupeScenariosFuzzy(
        buildScenariosForPage(
          discovered.title,
          discovered.elements,
          discovered.formCount,
          discovered.url,
          discovered.componentInventory,
          coverageMode
        )
      );
      // CRUD lifecycle only in standard/full — minimal already has form happy-path.
      if (coverageMode !== "minimal") {
        const crudFlow = buildCrudFlowScenario(discovered.title, discovered.elements);
        if (crudFlow) scenarios.push(crudFlow);
        scenarios = dedupeScenariosFuzzy(scenarios);
      }
    }
    if ((changeStatus === "changed" || changeStatus === "restored") && baseline) {
      diff = diffElements(baseline.elements, discovered.elements);
      diff.events = events;
    } else if (events.length) {
      diff = { added: [], removed: [], changed: [], events };
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
      // Always reported, including for unchanged pages: the site-level spelling
      // count is an inventory of what's on the site, not a per-run delta.
      spellingIssues: collectPageSpellingIssues(discovered.title, discovered.elements),
      componentInventory: discovered.componentInventory,
      etag: discovered.etag,
      lastModified: discovered.lastModified,
      a11yHash: discovered.a11yHash,
      screenshotHash: discovered.screenshotHash,
      changeSignals: discovered.changeSignals,
      scanMode: discovered.scanMode,
      skippedHttp: discovered.skippedHttp,
      links: discovered.links,
      snapshot: discovered.snapshot,
      httpStatus: discovered.httpStatus ?? discovered.snapshot?.httpStatus ?? null,
    };
  });

  const skippedHttp = pages.filter((p) => p.skippedHttp).length;
  const deepScans = pages.filter((p) => p.scanMode === "deep").length;
  const scannedBrowser = pages.filter((p) => !p.skippedHttp).length;

  const siteHost = safeHost(options.url);
  if (siteHost) {
    const apiScenariosByPage = buildApiScenariosForSite(
      siteHost,
      output.map((p) => ({ url: p.url, apis: p.apis }))
    );
    for (const page of output) {
      if (page.changeStatus === "unchanged") continue;
      const apiScenarios = apiScenariosByPage.get(page.url);
      if (!apiScenarios?.length) continue;
      // Minimal: one API scenario per page max.
      page.scenarios.push(...(coverageMode === "minimal" ? apiScenarios.slice(0, 1) : apiScenarios));
    }
  }

  // Multi-page flows once from the crawl entry URL (not once per changed page).
  const siteFlowFingerprints = new Set<string>();
  const entryUrl = normalizeUrl(options.url);
  const flowOwnerPages = output.filter((p) => p.changeStatus !== "unchanged");
  if (flowOwnerPages.length > 0) {
    const flowStart =
      output.find((p) => normalizeUrl(p.url) === entryUrl)?.url || flowOwnerPages[0].url;
    const flowResults = buildFlowScenariosForSite(
      flowStart,
      output.map((p) => ({ url: p.url, title: p.title, elements: p.elements })),
      edges,
      { maxFlows: maxFlowsForMode(coverageMode) }
    );
    for (const { scenario, entryUrl: flowEntry } of flowResults) {
      const fp = scenarioFingerprint(scenario);
      if (siteFlowFingerprints.has(fp)) continue;
      siteFlowFingerprints.add(fp);
      const owner = output.find((p) => p.url === flowEntry);
      owner?.scenarios.push(scenario);
    }
  }

  // Guarantee the flow slot is never empty when the site graph didn't yield journeys.
  // Minimal: at most one intra-page flow for the whole site.
  for (const page of output) {
    if (page.changeStatus === "unchanged") continue;
    if (coverageMode === "minimal" && siteFlowFingerprints.size > 0) break;
    const hasFlow = page.scenarios.some((s) => s.type === "flow");
    if (hasFlow) {
      if (coverageMode === "minimal") break;
      continue;
    }
    const intra = buildIntraPageFlowScenario(page.title, page.elements);
    if (intra) {
      const fp = scenarioFingerprint(intra);
      if (!siteFlowFingerprints.has(fp)) {
        siteFlowFingerprints.add(fp);
        page.scenarios.push(intra);
        if (coverageMode === "minimal") break;
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
      skippedHttp,
      scannedBrowser,
      deepScans,
      coverage,
      restoredPages: output.filter((p) => p.changeStatus === "restored").length,
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
