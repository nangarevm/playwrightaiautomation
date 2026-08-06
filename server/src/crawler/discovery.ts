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
import { dedupeKey, fetchSitemapUrls, normalizeUrl, sameOrigin } from "./urlUtils.js";
import { structureMatches } from "./diff.js";

export { dedupeKey, normalizeUrl, sameOrigin } from "./urlUtils.js";

export interface DiscoveredPage {
  url: string;
  title: string;
  elements: ElementRecord[];
  apis: ApiCallRecord[];
  formCount: number;
  componentInventory: ComponentInventoryItem[];
  /** True when incremental mode reused the prior baseline without deep interaction. */
  reusedBaseline?: boolean;
}

async function extractLinks(page: import("playwright").Page, baseUrl: string): Promise<ExtractedLink[]> {
  const raw = await page
    .evaluate(() => {
      const anchors = Array.from(document.querySelectorAll("a[href], [role='link'][href], nav a[href], [data-testid*='nav'] a[href]"));
      return anchors.map((node) => {
        const el = node as HTMLAnchorElement;
        return {
          href: el.href,
          label: (el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80),
        };
      });
    })
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

interface ExtractedLink {
  url: string;
  label: string;
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
  const maxPages = Math.max(1, options.maxPages ?? 50);
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 3, 6));

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

    // Re-crawl: re-visit previously discovered pages first so coverage isn't lost
    // when homepage/nav links change between runs.
    for (const known of options.knownUrls ?? []) {
      try {
        if (!sameOrigin(known, normalizedUrl)) continue;
        const key = dedupeKey(known);
        if (!queuedKeys.has(key)) {
          queuedKeys.add(key);
          queue.push(known);
        }
      } catch {
        /* skip malformed known URLs */
      }
    }

    // Seed BFS with sitemap URLs so deep pages not linked from the homepage are still discovered.
    const sitemapUrls = await fetchSitemapUrls(normalizedUrl, maxPages * 2);
    for (const sitemapUrl of sitemapUrls) {
      const key = dedupeKey(sitemapUrl);
      if (!queuedKeys.has(key)) {
        queuedKeys.add(key);
        queue.push(sitemapUrl);
      }
    }

    const results: DiscoveredPage[] = [];
    const incremental = (options.mode ?? "full") === "incremental";
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

          const baseline = options.getBaseline?.(targetUrl) ?? null;
          let elements: ElementRecord[];
          let formCount: number;
          let componentInventory: ComponentInventoryItem[];
          let reusedBaseline = false;

          if (incremental && baseline?.elements?.length) {
            // Fast probe: shallow scan (no exploratory clicks). If structure matches
            // the last crawl, reuse baseline locators and skip the expensive deep pass.
            const shallow = await discoverPageInteractions(page, capture?.setTrigger, { shallow: true });
            if (structureMatches(shallow.elements, baseline.elements)) {
              elements = baseline.elements;
              formCount = shallow.formCount || (baseline.elements.filter((e) => ["input", "textarea", "dropdown"].includes(e.type)).length > 0 ? 1 : 0);
              componentInventory = [];
              reusedBaseline = true;
            } else {
              const deep = await discoverPageInteractions(page, capture?.setTrigger);
              elements = deep.elements;
              formCount = deep.formCount;
              componentInventory = await collectComponentInventory(page);
            }
          } else {
            const deep = await discoverPageInteractions(page, capture?.setTrigger);
            elements = deep.elements;
            formCount = deep.formCount;
            componentInventory = await collectComponentInventory(page);
          }

          formsDiscoveredTotal += formCount;

          const currentUrl = page.url();
          if (currentUrl !== targetUrl && sameOrigin(currentUrl, normalizedUrl) && !visited.has(dedupeKey(currentUrl))) {
            discoveredLinksThisBatch.push({ url: currentUrl, label: "navigation" });
            edges.push({ from: targetUrl, to: currentUrl, via: "navigation" });
          }

          const links = await extractLinks(page, normalizedUrl);
          discoveredLinksThisBatch.push(...links);
          for (const link of links) edges.push({ from: currentUrl, to: link.url, via: link.label });

          results.push({
            url: targetUrl,
            title,
            elements,
            apis: reusedBaseline ? [] : (capture?.records ?? []),
            formCount,
            componentInventory,
            reusedBaseline,
          });
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
