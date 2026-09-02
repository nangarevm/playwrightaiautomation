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
  /**
   * Scenario depth. Default "minimal": ~2–5 scenarios/page covering load, components,
   * primary flow/form — enough for page + component coverage without LLM token blowups.
   * "standard" adds a few negatives/edges; "full" is the exhaustive historical set.
   */
  coverageMode?: CoverageMode;
  /** Previously discovered page URLs for this site -- seeded first on re-crawl so coverage isn't lost. */
  knownUrls?: string[];
  /** Max BFS hops from the start URL (default 20). */
  maxDepth?: number;
  /** Baseline lookup used during discovery for early unchanged short-circuit (incremental mode). */
  getBaseline?: (url: string) => PageBaselineMeta | null;
  onProgress?: (progress: CrawlProgress) => void;
}

/** How many scenarios the crawler should emit per page / site. */
export type CoverageMode = "minimal" | "standard" | "full";

export interface PageBaselineMeta {
  hash: string;
  elements: ElementRecord[];
  etag?: string | null;
  lastModified?: string | null;
  lastSeenAt?: string | null;
  title?: string | null;
  a11yHash?: string | null;
  screenshotHash?: string | null;
  /** Same-origin outbound links stored on the last scan -- replayed into the nav graph when this page is cheap-skipped. */
  links?: Array<{ url: string; label: string }>;
  httpStatus?: number | null;
  priorChangeStatus?: string | null;
  snapshot?: PageSnapshot | null;
  missCount?: number;
}

export interface CrawlProgress {
  pagesDiscovered: number;
  formsDiscovered: number;
  scenariosDiscovered: number;
  currentPage: string;
  /** Cheap HTTP skips (no Playwright navigation). */
  skippedHttp?: number;
  /** Pages opened in browser (shallow or deep). */
  scannedBrowser?: number;
  /** Pages that required deep interaction. */
  deepScans?: number;
  reusedBaselines?: number;
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
  type: "positive" | "negative" | "edge" | "flow" | "api";
  // Coarser than `type`: which of the three test suites this belongs to.
  // "smoke" = page-load check for every discovered page (does the URL render);
  // "functional" = edge/negative/boundary/API/click coverage generated at crawl;
  // "regression" = happy-path and re-verify scenarios assigned on first crawl
  // (and also applied at persistence on re-crawl for unchanged pages).
  // Multi-page / in-page journeys use type === "flow" (usually tier regression).
  // type "negative" / "edge" always map to Negative / Edge Case categories.
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

export interface PageSnapshot {
  title?: string | null;
  description?: string | null;
  h1?: string | null;
  robots?: string | null;
  canonical?: string | null;
  httpStatus?: number | null;
  finalUrl?: string | null;
  wordCount?: number;
  images?: Array<{ src: string; alt: string }>;
}

export interface ChangeEvent {
  type: string;
  severity: "critical" | "high" | "medium" | "low";
  oldValue?: string;
  newValue?: string;
}

export interface PageDiff {
  added: string[];
  removed: string[];
  changed: string[];
  events?: ChangeEvent[];
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
