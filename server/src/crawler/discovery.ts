// Phase 1: page & route discovery engine. BFS same-origin crawl using ONE
// authenticated browser context (auth.ts logs in once; cookies are reused for
// every page below, never re-logging-in per page). Discovers pages via static
// <a href> links, SPA route changes (framenavigated/history events), and the
// interaction engine's exploratory clicks (interaction.ts). Maintains a
// visited-URL set to avoid infinite loops on cyclic navigation graphs.

import { chromium, type Browser, type BrowserContext } from "playwright";
import { DESTRUCTIVE_ACTION_PATTERN, type ApiCallRecord, type ComponentInventoryItem, type CrawlOptions, type ElementRecord, type NavEdge } from "./types.js";
import { loginIfCredentialsProvided } from "./auth.js";
import { discoverPageInteractions } from "./interaction.js";
import { collectComponentInventory } from "./componentInventory.js";
import { attachNetworkCapture } from "./network.js";

export interface DiscoveredPage {
  url: string;
  title: string;
  elements: ElementRecord[];
  apis: ApiCallRecord[];
  formCount: number;
  componentInventory: ComponentInventoryItem[];
}

function normalizeUrl(raw: string): string {
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

// Common noise params that vary per link/click but never change what the page
// actually is (tracking/session identifiers) -- stripped before a URL is used
// as a "have we already visited this page" key, so e.g. "/forum",
// "/forum?utm_source=nav", and "/forum/" don't each get crawled and scenario-
// generated as if they were three separate pages (previously: they did, which
// is why the same page's card + identical "Verify X loads successfully"
// scenario could show up 2-3x in the Review & curate list for one real page).
const VOLATILE_QUERY_PARAMS = /^(utm_|fbclid$|gclid$|msclkid$|ref$|referrer$|source$|sid$|session(id)?$|_ga$|_gl$)/i;

// The visited-set key for "is this the same page we already crawled" -- NOT
// the URL actually navigated to or stored (that stays the real, full URL so
// links/screenshots/replay scripts keep working). Strips the trailing slash
// and any volatile query params; keeps everything else (a genuinely content-
// differentiating param like `?id=42` still produces a distinct key).
function dedupeKey(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const params = new URLSearchParams(u.search);
    for (const key of Array.from(params.keys())) {
      if (VOLATILE_QUERY_PARAMS.test(key)) params.delete(key);
    }
    params.sort();
    const search = params.toString();
    const pathname = u.pathname.replace(/\/+$/, "") || "/";
    return `${u.origin}${pathname}${search ? `?${search}` : ""}`;
  } catch {
    return rawUrl;
  }
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

interface ExtractedLink {
  url: string;
  label: string;
}

// Same link-collection logic as before, but now also keeps each link's visible
// text/aria-label -- that's what turns a bare page->page edge into a step a
// human (or a Playwright script) can actually replay: "clicks 'View Cart'"
// instead of just "navigates somewhere."
async function extractLinks(page: import("playwright").Page, baseUrl: string): Promise<ExtractedLink[]> {
  const raw = await page
    .evaluate(() =>
      Array.from(document.querySelectorAll("a[href]")).map((a) => ({
        href: (a as HTMLAnchorElement).href,
        label: (a.getAttribute("aria-label") || a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80),
      }))
    )
    .catch(() => [] as Array<{ href: string; label: string }>);
  const resolved: ExtractedLink[] = [];
  for (const { href, label } of raw) {
    try {
      const url = new URL(href, baseUrl);
      url.hash = "";
      if (sameOrigin(url.toString(), baseUrl) && !DESTRUCTIVE_ACTION_PATTERN.test(url.pathname)) {
        resolved.push({ url: url.toString(), label: label || url.pathname });
      }
    } catch {
      // ignore malformed links
    }
  }
  return resolved;
}

async function simplePool<T>(items: T[], size: number, worker: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  async function next(): Promise<void> {
    const current = index++;
    if (current >= items.length) return;
    await worker(items[current]);
    await next();
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(size, items.length || 1)) }, next));
}

export async function runDiscoveryCrawl(options: CrawlOptions): Promise<{ pages: DiscoveredPage[]; edges: NavEdge[]; authenticated: boolean; authMessage: string }> {
  const normalizedUrl = normalizeUrl(options.url);
  const maxPages = Math.max(1, options.maxPages ?? 10);
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 2, 4));

  const browser: Browser = await chromium.launch({ headless: true });
  const context: BrowserContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });

  try {
    // FR-1: login once (if credentials supplied); the same context's cookies
    // carry forward for every page visited below.
    const login = await loginIfCredentialsProvided(context, normalizedUrl, options.username, options.password);
    if (options.username && !login.succeeded && login.attempted) {
      throw new Error(login.message);
    }

    // Keyed by dedupeKey(url), not the raw URL -- see dedupeKey's comment.
    // `queuedKeys` mirrors what's already sitting in `queue` so a second link
    // to the same logical page (different tracking params/trailing slash)
    // doesn't get queued twice before its first occurrence is even visited.
    const visited = new Set<string>();
    const queuedKeys = new Set<string>([dedupeKey(normalizedUrl)]);
    const queue: string[] = [normalizedUrl];
    const results: DiscoveredPage[] = [];
    // The navigation graph: every page->page hop discovered, with what was
    // clicked (or "navigation" for an SPA route change with no single
    // attributable link) to get there -- this is what buildFlowScenariosForSite
    // later walks to find multi-page journeys. A page can be reached more than
    // once during the crawl (different link text pointing at the same URL);
    // all edges are kept rather than deduped to just the first, so a later
    // journey-builder can pick whichever hop reads best.
    const edges: NavEdge[] = [];
    let formsDiscoveredTotal = 0;

    while (queue.length > 0 && results.length < maxPages) {
      const batch: string[] = [];
      while (queue.length > 0 && batch.length < concurrency && results.length + batch.length < maxPages) {
        const next = queue.shift()!;
        const key = dedupeKey(next);
        if (visited.has(key)) continue;
        visited.add(key);
        batch.push(next);
      }
      if (batch.length === 0) break;

      const discoveredLinksThisBatch: ExtractedLink[] = [];

      await simplePool(batch, concurrency, async (targetUrl) => {
        const page = await context.newPage();
        const capture = options.captureApi ? attachNetworkCapture(page) : null;
        try {
          await page.goto(targetUrl, { waitUntil: "networkidle", timeout: 20000 }).catch(async () => {
            await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
          });

          const title = (await page.title().catch(() => "")) || new URL(targetUrl).pathname || targetUrl;
          options.onProgress?.({ pagesDiscovered: results.length, formsDiscovered: formsDiscoveredTotal, scenariosDiscovered: 0, currentPage: targetUrl });

          const { elements, formCount } = await discoverPageInteractions(page, capture?.setTrigger);
          formsDiscoveredTotal += formCount;
          // Scanned after discoverPageInteractions (not before) so modals/dropdowns
          // it clicked open are already in the DOM and get counted too.
          const componentInventory = await collectComponentInventory(page);

          // SPA route changes: after interaction, the URL may have changed via
          // history.pushState without a full navigation -- capture that as an
          // additional discoverable route rather than losing it.
          const currentUrl = page.url();
          if (currentUrl !== targetUrl && sameOrigin(currentUrl, normalizedUrl) && !visited.has(dedupeKey(currentUrl))) {
            discoveredLinksThisBatch.push({ url: currentUrl, label: "navigation" });
            edges.push({ from: targetUrl, to: currentUrl, via: "navigation" });
          }

          // Attribute link edges to the page they're actually extracted from --
          // if an exploratory click above (discoverPageInteractions) navigated
          // the page away from targetUrl, extractLinks here is scraping the
          // POST-navigation page's DOM, not targetUrl's. Using targetUrl as
          // `from` would fabricate an edge for a link that doesn't exist on the
          // originally-requested page.
          const links = await extractLinks(page, normalizedUrl);
          discoveredLinksThisBatch.push(...links);
          for (const link of links) edges.push({ from: currentUrl, to: link.url, via: link.label });

          results.push({ url: targetUrl, title, elements, apis: capture?.records ?? [], formCount, componentInventory });
        } catch (err: any) {
          results.push({ url: targetUrl, title: `(failed to load: ${err.message})`, elements: [], apis: [], formCount: 0, componentInventory: [] });
        } finally {
          await page.close().catch(() => undefined);
        }
      });

      for (const link of discoveredLinksThisBatch) {
        const key = dedupeKey(link.url);
        if (visited.has(key) || queuedKeys.has(key)) continue;
        queuedKeys.add(key);
        queue.push(link.url);
      }
    }

    return { pages: results, edges, authenticated: login.succeeded, authMessage: login.message };
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}
