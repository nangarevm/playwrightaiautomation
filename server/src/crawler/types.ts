// AI Crawler shared types (see server/src/crawler/*.ts).

export interface CrawlAuthOptions {
  username?: string;
  password?: string;
}

export interface CrawlOptions {
  url: string;
  username?: string;
  password?: string;
  maxPages?: number;
  captureApi?: boolean;
  concurrency?: number;
  /** incremental (default on re-run): skip deep interaction when page structure matches baseline. full: always deep-scan. */
  mode?: "incremental" | "full";
  /** Previously discovered page URLs for this site -- seeded first on re-crawl so coverage isn't lost. */
  knownUrls?: string[];
  /** Baseline lookup used during discovery for early unchanged short-circuit (incremental mode). */
  getBaseline?: (url: string) => { hash: string; elements: ElementRecord[] } | null;
  onProgress?: (progress: CrawlProgress) => void;
}

export interface CrawlProgress {
  pagesDiscovered: number;
  formsDiscovered: number;
  scenariosDiscovered: number;
  currentPage: string;
}

export interface LocatorCandidate {
  strategy: "data-testid" | "role" | "id" | "text" | "css" | "xpath";
  value: string;
}

export interface ElementRecord {
  type: string; // button, input, dropdown, checkbox, link, etc.
  label: string;
  locators: string[]; // top 2-3 ranked locator expressions, best first
  component: string; // section/component name, e.g. "Login Form"
  required?: boolean;
  inputType?: string;
}

export interface ApiCallRecord {
  trigger: string;
  method: string;
  endpoint: string;
  schema: Record<string, unknown>;
  // Origin host of the request (e.g. "pune.gov.in") -- lets API-scenario
  // generation keep only same-origin calls (the site's own backend) and
  // drop third-party trackers/widgets/CDN calls that happen to share a page.
  host?: string;
}

// Page-level "what kinds of components does this page have" summary -- see
// componentInventory.ts. Distinct from ElementRecord, which is per-clickable-
// element locator data used for scenario generation.
export interface ComponentInventoryItem {
  kind: string;
  label: string;
  count: number;
  samples: string[];
}

export interface ScenarioRecord {
  id: string;
  title: string;
  type: "positive" | "negative" | "flow" | "api";
  // Coarser than `type`: which of the three test suites this belongs to.
  // "smoke" = the one core happy-path check per page/form (does the critical
  // flow work at all); "functional" = everything else generated at crawl time
  // (edge cases, negative/validation, boundary/format coverage, multi-step
  // cross-page journeys, API checks); "regression" is never assigned at
  // generation time -- it's applied at persistence time (crawlerService.ts)
  // to scenarios carried forward unchanged from a page that didn't change on
  // a re-crawl, i.e. "this previously worked, re-verify it still does."
  tier: "smoke" | "functional" | "regression";
  flowGroup: string;
  steps: string[];
  locators: string[];
  // Multi-page flow scenarios (see scenarios.ts's buildFlowScenariosForSite)
  // span several pages and have to be persisted against ONE crawl_pages row
  // (the schema's page_id is NOT NULL) -- entryUrl names which page (the
  // journey's starting page) owns the row. Absent for ordinary same-page
  // scenarios, which are already attached to their page by the caller.
  entryUrl?: string;
}

// A discovered navigation between two pages during the BFS crawl -- either a
// followed <a href> link (via = the link's visible text/aria-label) or an SPA
// route change caught after an exploratory interaction (via = "navigation",
// since there's no single attributable link label for a client-side route
// change). This is the graph that buildFlowScenariosForSite walks to find
// multi-page journeys -- previously discovered and then discarded per page.
export interface NavEdge {
  from: string;
  to: string;
  via: string;
}

export interface SpellingIssue {
  word: string;
  suggestions: string[];
  context: string; // e.g. "page title", "button label", "link text"
}

export interface PageRecord {
  id: string;
  url: string;
  title: string;
  domHash: string;
  elements: ElementRecord[];
  apis: ApiCallRecord[];
  scenarios: ScenarioRecord[];
  changeStatus: "new" | "changed" | "unchanged" | "removed";
  diff?: PageDiff;
  spellingIssues: SpellingIssue[];
}

export interface PageDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

export interface CrawlResult {
  schemaVersion: "1.0";
  site: string;
  crawledAt: string;
  pages: PageRecord[];
}

// FR-1.3.9 (denylist): never auto-click anything that looks destructive unless
// the caller explicitly whitelists it -- protects the target site from real
// data loss during autonomous interaction simulation.
export const DESTRUCTIVE_ACTION_PATTERN =
  /\b(delete|remove|logout|log out|sign out|confirm.?payment|deactivate|cancel.?subscription|unsubscribe|purge|destroy)\b/i;
