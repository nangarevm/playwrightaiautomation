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
import { dedupeKey, normalizeUrl, sameOrigin } from "./urlUtils.js";
import { structureMatches, hashA11yTree, hashScreenshotBuffer } from "./diff.js";
import { decideCheapSkip, fetchSitemapEntries, probeHttpCache } from "./cheapChangeDetection.js";
import { loadPageWithOptimizedStrategy } from "../services/timeoutOptimizationService.js";

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
  /** True when Playwright navigation was skipped (HTTP/ETag/sitemap). */
  skippedHttp?: boolean;
  skipReason?: string;
  etag?: string | null;
  lastModified?: string | null;
  a11yHash?: string | null;
  screenshotHash?: string | null;
  changeSignals?: {
    structure?: "same" | "changed" | "unknown";
    a11y?: "same" | "changed" | "unknown";
    visual?: "same" | "changed" | "unknown";
    http?: "not-modified" | "modified" | "unknown";
  };
  scanMode?: "http-skip" | "shallow" | "deep";
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
      if (url.hash) url.hash = "";
      // Never queue sitemap/index XML documents as user-facing pages.
      if (/\.xml$/i.test(url.pathname) || /sitemap/i.test(url.pathname)) continue;
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

async function dismissConsentOverlays(page: import("playwright").Page): Promise<void> {
  const candidates = [
    'button:has-text("Accept")',
    'button:has-text("Accept all")',
    'button:has-text("Accept All")',
    'button:has-text("Agree")',
    'button:has-text("I agree")',
    'button:has-text("Got it")',
    'button:has-text("Allow all")',
    '[aria-label*="accept" i]',
    '#onetrust-accept-btn-handler',
  ];
  for (const sel of candidates) {
    const clicked = await page.locator(sel).first().click({ timeout: 800 }).then(() => true).catch(() => false);
    if (clicked) {
      await page.waitForTimeout(300);
      break;
    }
  }
}

/** When interactive locator scan is empty/sparse, promote discovered <a> links into ElementRecords. */
function mergeLinkElements(elements: ElementRecord[], links: ExtractedLink[]): ElementRecord[] {
  const existingLabels = new Set(elements.filter((e) => e.type === "link").map((e) => e.label.toLowerCase()));
  const extras: ElementRecord[] = [];
  for (const link of links.slice(0, 40)) {
    const label = (link.label || link.url).replace(/\s+/g, " ").trim().slice(0, 80);
    if (!label || existingLabels.has(label.toLowerCase())) continue;
    existingLabels.add(label.toLowerCase());
    extras.push({
      type: "link",
      label,
      locators: [`page.getByRole('link', { name: ${JSON.stringify(label)} })`],
      component: "Nav",
    });
  }
  return extras.length ? [...elements, ...extras] : elements;
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
  // Phase 1 Optimization: Increase from 3-8 to 10-15 for faster discovery
  let concurrency = Math.max(1, Math.min(options.concurrency ?? 10, 15));
  let detectedPlatform = "custom";
  let platformTimeouts = { pageLoadTimeout: 20000, networkIdleTimeout: 5000 };

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
    // On incremental re-crawls with a solid known-URL set, skip sitemap flooding —
    // known pages are already queued first; new links still expand from visited pages.
    const incremental = (options.mode ?? "full") === "incremental";
    const knownCount = options.knownUrls?.length ?? 0;
    const skipSitemapFlood = incremental && knownCount >= Math.min(maxPages, 8);
    const sitemapLastmod = new Map<string, string | null>();
    if (!skipSitemapFlood) {
      const entries = await fetchSitemapEntries(normalizedUrl, maxPages * 2);
      for (const entry of entries) {
        const key = dedupeKey(entry.url);
        sitemapLastmod.set(key, entry.lastmod);
        if (!queuedKeys.has(key)) {
          queuedKeys.add(key);
          queue.push(entry.url);
        }
      }
    } else {
      // Still load lastmod map for cheap skip decisions without flooding the queue
      const entries = await fetchSitemapEntries(normalizedUrl, maxPages * 2).catch(() => []);
      for (const entry of entries) sitemapLastmod.set(dedupeKey(entry.url), entry.lastmod);
    }

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
    let skippedHttp = 0;
    let scannedBrowser = 0;
    let deepScans = 0;
    let reusedBaselines = 0;

    const emitProgress = (currentPage: string) => {
      options.onProgress?.({
        pagesDiscovered: results.length,
        formsDiscovered: formsDiscoveredTotal,
        scenariosDiscovered: 0,
        currentPage,
        skippedHttp,
        scannedBrowser,
        deepScans,
        reusedBaselines,
      });
    };

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
        // Defensive: sitemap XML should never be treated as a page (older queues / bad seeds).
        if (/\.xml$/i.test(targetUrl) || /sitemap/i.test(new URL(targetUrl).pathname)) {
          return;
        }

        const baseline = options.getBaseline?.(targetUrl) ?? null;
        const key = dedupeKey(targetUrl);

        // P0: cheap HTTP / sitemap skip — no Playwright navigation
        if (incremental && baseline?.elements?.length) {
          const http = await probeHttpCache(targetUrl, {
            etag: baseline.etag,
            lastModified: baseline.lastModified,
          });
          const decision = decideCheapSkip({
            incremental: true,
            hasBaseline: true,
            http,
            sitemapLastmod: sitemapLastmod.get(key) ?? null,
            priorLastSeen: baseline.lastSeenAt ?? null,
          });
          if (decision.skip) {
            skippedHttp++;
            reusedBaselines++;
            const formCount = baseline.elements.filter((e) =>
              ["input", "textarea", "dropdown"].includes(e.type)
            ).length > 0
              ? 1
              : 0;
            formsDiscoveredTotal += formCount;
            results.push({
              url: targetUrl,
              title: baseline.title || targetUrl,
              elements: baseline.elements,
              apis: [],
              formCount,
              componentInventory: [],
              reusedBaseline: true,
              skippedHttp: true,
              skipReason: decision.reason,
              etag: http.etag || baseline.etag,
              lastModified: http.lastModified || baseline.lastModified,
              a11yHash: baseline.a11yHash,
              screenshotHash: baseline.screenshotHash,
              changeSignals: {
                structure: "same",
                a11y: "same",
                visual: "same",
                http: "not-modified",
              },
              scanMode: "http-skip",
            });
            emitProgress(targetUrl);
            return;
          }
        }

        const page = await context.newPage();
        const capture = options.captureApi ? attachNetworkCapture(page) : null;
        try {
          scannedBrowser++;
          await loadPageWithOptimizedStrategy(page, targetUrl);
          await dismissConsentOverlays(page);

          const title = (await page.title().catch(() => "")) || new URL(targetUrl).pathname || targetUrl;
          emitProgress(targetUrl);

          let elements: ElementRecord[];
          let formCount: number;
          let componentInventory: ComponentInventoryItem[];
          let reusedBaseline = false;
          let scanMode: "shallow" | "deep" = "deep";
          let a11yHash: string | null = null;
          let screenshotHash: string | null = null;
          const changeSignals: DiscoveredPage["changeSignals"] = {
            structure: "unknown",
            a11y: "unknown",
            visual: "unknown",
            http: "modified",
          };

          // Fresh HTTP validators for persist
          const freshHttp = await probeHttpCache(targetUrl).catch(() => null);

          if (incremental && baseline?.elements?.length) {
            // Fast probe: shallow scan (no exploratory clicks). If structure matches
            // the last crawl, reuse baseline locators and skip the expensive deep pass.
            const shallow = await discoverPageInteractions(page, capture?.setTrigger, { shallow: true });
            if (structureMatches(shallow.elements, baseline.elements)) {
              elements = baseline.elements;
              formCount =
                shallow.formCount ||
                (baseline.elements.filter((e) => ["input", "textarea", "dropdown"].includes(e.type)).length > 0
                  ? 1
                  : 0);
              componentInventory = [];
              reusedBaseline = true;
              reusedBaselines++;
              scanMode = "shallow";
              changeSignals.structure = "same";
              a11yHash = baseline.a11yHash || null;
              screenshotHash = baseline.screenshotHash || null;
            } else {
              deepScans++;
              const deep = await discoverPageInteractions(page, capture?.setTrigger);
              elements = deep.elements;
              formCount = deep.formCount;
              componentInventory = await collectComponentInventory(page);
              changeSignals.structure = "changed";
              scanMode = "deep";
            }
          } else {
            deepScans++;
            const deep = await discoverPageInteractions(page, capture?.setTrigger);
            elements = deep.elements;
            formCount = deep.formCount;
            componentInventory = await collectComponentInventory(page);
            changeSignals.structure = baseline ? "changed" : "unknown";
            scanMode = "deep";
          }

          // P3: multi-signal — a11y-ish text tree + screenshot hash (best-effort)
          if (scanMode === "deep") {
            try {
              const treeText = await page
                .evaluate(() => {
                  const walk = (node: Node, depth: number): string => {
                    if (depth > 6) return "";
                    if (node.nodeType === Node.TEXT_NODE) {
                      return (node.textContent || "").trim().slice(0, 80);
                    }
                    if (node.nodeType !== Node.ELEMENT_NODE) return "";
                    const el = node as Element;
                    const role = el.getAttribute("role") || el.tagName.toLowerCase();
                    const name =
                      el.getAttribute("aria-label") ||
                      el.getAttribute("name") ||
                      el.getAttribute("placeholder") ||
                      "";
                    const kids = Array.from(el.childNodes)
                      .map((c) => walk(c, depth + 1))
                      .filter(Boolean)
                      .join(" ");
                    return `${role}:${name} ${kids}`.trim();
                  };
                  return walk(document.body, 0).slice(0, 8000);
                })
                .catch(() => "");
              a11yHash = hashA11yTree(treeText || "");
              if (baseline?.a11yHash) {
                changeSignals.a11y = baseline.a11yHash === a11yHash ? "same" : "changed";
              }
            } catch {
              /* optional */
            }
            try {
              const shot = await page.screenshot({ type: "png", fullPage: false }).catch(() => null);
              screenshotHash = hashScreenshotBuffer(shot);
              if (baseline?.screenshotHash && screenshotHash) {
                changeSignals.visual = baseline.screenshotHash === screenshotHash ? "same" : "changed";
              }
            } catch {
              /* optional */
            }
          }

          const links = await extractLinks(page, normalizedUrl);
          elements = mergeLinkElements(elements, links);

          formsDiscoveredTotal += formCount;

          const currentUrl = page.url();
          if (currentUrl !== targetUrl && sameOrigin(currentUrl, normalizedUrl) && !visited.has(dedupeKey(currentUrl))) {
            discoveredLinksThisBatch.push({ url: currentUrl, label: "navigation" });
            edges.push({ from: targetUrl, to: currentUrl, via: "navigation" });
          }

          discoveredLinksThisBatch.push(...links);
          for (const link of links) edges.push({ from: currentUrl, to: link.url, via: link.label });

          results.push({
            url: targetUrl,
            title,
            elements,
            apis: capture?.records ?? [],
            formCount,
            componentInventory,
            reusedBaseline,
            etag: freshHttp?.etag || null,
            lastModified: freshHttp?.lastModified || null,
            a11yHash,
            screenshotHash,
            changeSignals,
            scanMode,
          });
          emitProgress(targetUrl);
        } catch (err: any) {
          results.push({
            url: targetUrl,
            title: `(failed to load: ${err.message})`,
            elements: [],
            apis: [],
            formCount: 0,
            componentInventory: [],
          });
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
