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
import { dedupeKey, isHtmlDocumentUrl, isPaginationUrl, normalizeUrl, originOf, sameOrigin } from "./urlUtils.js";
import { structureMatches, hashA11yTree, hashScreenshotBuffer } from "./diff.js";
import { decideCheapSkip, fetchRobotsDisallows, fetchSitemapEntries, isRobotsDisallowed, probeHttpCache } from "./cheapChangeDetection.js";
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
  /** Same-origin outbound links -- persisted so a later cheap-skip can replay this page's graph edges. */
  links?: ExtractedLink[];
  httpStatus?: number | null;
  contentType?: string | null;
  canonicalUrl?: string | null;
  finalUrl?: string | null;
  depth?: number;
  parentUrl?: string | null;
  discoveryMethod?: string;
  errorCategory?: string | null;
  snapshot?: {
    title?: string | null;
    description?: string | null;
    h1?: string | null;
    robots?: string | null;
    canonical?: string | null;
    httpStatus?: number | null;
    finalUrl?: string | null;
    wordCount?: number;
    images?: Array<{ src: string; alt: string }>;
  };
}

async function extractLinks(page: import("playwright").Page, baseUrl: string): Promise<ExtractedLink[]> {
  const raw = await page
    .evaluate(() => {
      const out: Array<{ href: string; label: string; method: string }> = [];
      const push = (href: string | null, label: string, method: string) => {
        if (!href) return;
        out.push({ href, label: label.replace(/\s+/g, " ").trim().slice(0, 80), method });
      };
      for (const el of Array.from(document.querySelectorAll("a[href], area[href], [role='link'][href]"))) {
        const a = el as HTMLAnchorElement;
        const rel = (a.getAttribute("rel") || "").toLowerCase();
        const method = rel.includes("next") ? "pagination" : "html_link";
        push(a.href, a.getAttribute("aria-label") || a.textContent || "", method);
      }
      for (const el of Array.from(document.querySelectorAll("link[rel='canonical'][href]"))) {
        push((el as HTMLLinkElement).href, "canonical", "canonical");
      }
      for (const el of Array.from(document.querySelectorAll("link[rel='alternate'][hreflang][href]"))) {
        push((el as HTMLLinkElement).href, el.getAttribute("hreflang") || "hreflang", "hreflang");
      }
      for (const el of Array.from(document.querySelectorAll("link[rel='next'][href], a[rel='next'][href]"))) {
        push((el as HTMLLinkElement).href, "next", "pagination");
      }
      for (const el of Array.from(document.querySelectorAll("[data-href], [data-url], [data-to]"))) {
        const href = el.getAttribute("data-href") || el.getAttribute("data-url") || el.getAttribute("data-to");
        push(href, (el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim(), "javascript_navigation");
      }
      return out;
    })
    .catch(() => [] as Array<{ href: string; label: string; method: string }>);

  const resolved: ExtractedLink[] = [];
  const seen = new Set<string>();
  for (const { href, label, method } of raw) {
    try {
      if (/^(mailto|tel|javascript|data):/i.test(href)) continue;
      const url = new URL(href, baseUrl);
      if (url.hash && !url.hash.startsWith("#/")) url.hash = "";
      if (/\.xml$/i.test(url.pathname) || /sitemap/i.test(url.pathname)) continue;
      if (!isHtmlDocumentUrl(url.toString())) continue;
      const key = dedupeKey(url.toString());
      if (seen.has(key)) continue;
      seen.add(key);
      const kind = method === "html_link" && isPaginationUrl(url.toString(), label) ? "pagination" : method;
      resolved.push({ url: url.toString(), label: label || url.pathname, method: kind });
    } catch {
      /* ignore malformed */
    }
  }
  return resolved;
}

export interface ExtractedLink {
  url: string;
  label: string;
  method?: string;
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

// Workers finish in nondeterministic order, so every collection that later feeds
// a cap (maxPages), the BFS queue, or the flow graph is re-ordered by dedupeKey
// before it is used. Without this the SAME unchanged site yields different
// page/scenario counts run over run.
export function sortUrlsByKey(urls: string[]): string[] {
  return urls.slice().sort((a, b) => dedupeKey(a).localeCompare(dedupeKey(b)));
}

export function sortLinksByKey(links: ExtractedLink[]): ExtractedLink[] {
  return links.slice().sort((a, b) => dedupeKey(a.url).localeCompare(dedupeKey(b.url)));
}

export function sortEdges(edges: NavEdge[]): NavEdge[] {
  return edges
    .slice()
    .sort(
      (a, b) =>
        dedupeKey(a.from).localeCompare(dedupeKey(b.from)) ||
        dedupeKey(a.to).localeCompare(dedupeKey(b.to)) ||
        a.via.localeCompare(b.via)
    );
}

function classifyNavError(err: unknown): string {
  const m = String((err as Error)?.message || err || "").toLowerCase();
  if (m.includes("timeout")) return "TIMEOUT";
  if (m.includes("err_name_not_resolved") || m.includes("dns")) return "DNS_ERROR";
  if (m.includes("err_connection") || m.includes("econnrefused")) return "CONNECTION_ERROR";
  if (m.includes("ssl") || m.includes("certificate")) return "SSL_ERROR";
  if (m.includes("403")) return "HTTP_403";
  if (m.includes("404")) return "HTTP_404";
  if (m.includes("429")) return "HTTP_429";
  if (m.includes("500")) return "HTTP_500";
  if (m.includes("502")) return "HTTP_502";
  if (m.includes("503")) return "HTTP_503";
  return "NAVIGATION_ERROR";
}

function isHtmlContentType(ct: string | null | undefined): boolean {
  if (!ct) return true;
  const v = ct.toLowerCase();
  if (v.includes("text/html") || v.includes("application/xhtml")) return true;
  if (v.includes("json") || v.includes("image/") || v.includes("javascript") || v.includes("text/css") || v.includes("pdf") || v.includes("octet-stream")) {
    return false;
  }
  return true;
}

async function collectPageSnapshot(
  page: import("playwright").Page,
  extras: { httpStatus?: number | null; canonical?: string | null; finalUrl?: string | null; title?: string | null }
): Promise<NonNullable<DiscoveredPage["snapshot"]>> {
  const meta = await page
    .evaluate(() => {
      const text = (sel: string) => document.querySelector(sel)?.getAttribute("content") || "";
      const h1 = document.querySelector("h1")?.textContent?.replace(/\s+/g, " ").trim() || "";
      const images = Array.from(document.images)
        .slice(0, 40)
        .map((img) => ({ src: img.currentSrc || img.src || "", alt: img.alt || "" }))
        .filter((i) => i.src);
      const wordCount = (document.body?.innerText || "").trim().split(/\s+/).filter(Boolean).length;
      return {
        description: text('meta[name="description"]'),
        robots: text('meta[name="robots"]'),
        h1,
        images,
        wordCount,
      };
    })
    .catch(() => ({ description: "", robots: "", h1: "", images: [] as Array<{ src: string; alt: string }>, wordCount: 0 }));
  return {
    title: extras.title || null,
    description: meta.description || null,
    h1: meta.h1 || null,
    robots: meta.robots || null,
    canonical: extras.canonical || null,
    httpStatus: extras.httpStatus ?? null,
    finalUrl: extras.finalUrl || null,
    wordCount: meta.wordCount,
    images: meta.images,
  };
}

export interface CrawlCoverage {
  reachableHtmlPages: number;
  sitemapUrls: number;
  combinedUnique: number;
  sitemapOnly: number;
  externalLinks: number;
  maxDepth: number;
  statusCounts: Record<string, number>;
  sitemapKeys?: string[];
}

export async function runDiscoveryCrawl(options: CrawlOptions): Promise<{
  pages: DiscoveredPage[];
  edges: NavEdge[];
  authenticated: boolean;
  authMessage: string;
  coverage?: CrawlCoverage;
}> {
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
    const depthOf = new Map<string, number>([[dedupeKey(normalizedUrl), 0]]);
    const parentOf = new Map<string, string | null>([[dedupeKey(normalizedUrl), null]]);
    const methodOf = new Map<string, string>([[dedupeKey(normalizedUrl), "start_url"]]);
    const maxDepth = Math.max(1, options.maxDepth ?? 20);
    const paginationHops = new Map<string, number>();
    let externalLinkCount = 0;
    const statusCounts: Record<string, number> = {};
    const origin = originOf(normalizedUrl) || "";
    const respectRobots = process.env.CRAWL_IGNORE_ROBOTS !== "true" && !options.username;
    const robotsDisallows = respectRobots && origin ? await fetchRobotsDisallows(origin) : [];

    const enqueue = (rawUrl: string, parent: string | null, method: string) => {
      try {
        if (!isHtmlDocumentUrl(rawUrl)) return;
        if (!sameOrigin(rawUrl, normalizedUrl)) {
          externalLinkCount += 1;
          return;
        }
        if (DESTRUCTIVE_ACTION_PATTERN.test(new URL(rawUrl).pathname)) return;
        if (robotsDisallows.length && isRobotsDisallowed(rawUrl, robotsDisallows)) return;
        const key = dedupeKey(rawUrl);
        if (visited.has(key) || queuedKeys.has(key)) return;
        const parentKey = parent ? dedupeKey(parent) : "";
        const depth = parent ? (depthOf.get(parentKey) ?? 0) + 1 : 0;
        if (depth > maxDepth) return;
        if (method === "pagination") {
          const hops = paginationHops.get(parentKey) ?? 0;
          if (hops >= 15) return;
          paginationHops.set(parentKey, hops + 1);
        }
        queuedKeys.add(key);
        depthOf.set(key, depth);
        parentOf.set(key, parent);
        methodOf.set(key, method);
        queue.push(rawUrl);
      } catch {
        /* skip */
      }
    };

    // Re-crawl: re-visit previously discovered pages first so coverage isn't lost
    // when homepage/nav links change between runs.
    for (const known of sortUrlsByKey(options.knownUrls ?? [])) {
      enqueue(known, normalizedUrl, "manual_seed");
    }

    const incremental = (options.mode ?? "full") === "incremental";
    const knownCount = options.knownUrls?.length ?? 0;
    const skipSitemapFlood = incremental && knownCount >= Math.min(maxPages, 8);
    const sitemapLastmod = new Map<string, string | null>();
    const sitemapKeys = new Set<string>();
    const sitemapCap = Math.max(maxPages * 4, 500);
    const sitemapEntries = await fetchSitemapEntries(normalizedUrl, sitemapCap).catch(() => []);
    for (const entry of sitemapEntries) {
      const key = dedupeKey(entry.url);
      sitemapLastmod.set(key, entry.lastmod);
      sitemapKeys.add(key);
      if (!skipSitemapFlood) enqueue(entry.url, normalizedUrl, "sitemap");
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
      // Deterministic dispatch order within the batch.
      batch.sort((a, b) => dedupeKey(a).localeCompare(dedupeKey(b)));

      // Keyed by dedupeKey so worker-completion order can't change what gets
      // enqueued next (or in which order) for an otherwise identical site.
      const discoveredLinksThisBatch = new Map<string, ExtractedLink>();
      const discoveredFrom = new Map<string, string>();
      const noteLink = (link: ExtractedLink, fromUrl: string) => {
        const key = dedupeKey(link.url);
        const prior = discoveredLinksThisBatch.get(key);
        if (!prior || link.url.localeCompare(prior.url) < 0) discoveredLinksThisBatch.set(key, link);
        if (!discoveredFrom.has(key)) discoveredFrom.set(key, fromUrl);
      };
      const batchStart = results.length;

      await simplePool(batch, concurrency, async (targetUrl) => {
        // Defensive: sitemap XML should never be treated as a page (older queues / bad seeds).
        if (/\.xml$/i.test(targetUrl) || /sitemap/i.test(new URL(targetUrl).pathname) || !isHtmlDocumentUrl(targetUrl)) {
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
            // No navigation happened, so replay the stored adjacency: the flow
            // graph must look the same as on the run that actually scanned this
            // page, otherwise journey selection drifts every re-crawl.
            const storedLinks = baseline.links ?? [];
            for (const link of storedLinks) {
              edges.push({ from: targetUrl, to: link.url, via: link.label });
              noteLink(link, targetUrl);
            }
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
              links: storedLinks,
            });
            emitProgress(targetUrl);
            return;
          }
        }

        const page = await context.newPage();
        const capture = options.captureApi ? attachNetworkCapture(page) : null;
        const pageKey = dedupeKey(targetUrl);
        try {
          scannedBrowser++;
          let navError: unknown = null;
          let httpStatus: number | null = null;
          let contentType: string | null = null;
          page.on("response", (r) => {
            try {
              if (dedupeKey(r.url()) === pageKey || r.url() === targetUrl) {
                httpStatus = r.status();
                contentType = r.headers()["content-type"] || contentType;
              }
            } catch {
              /* ignore */
            }
          });
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              await loadPageWithOptimizedStrategy(page, targetUrl);
              navError = null;
              break;
            } catch (err) {
              navError = err;
              await page.waitForTimeout(300 * attempt * attempt);
            }
          }
          if (navError) throw navError;

          const finalUrl = page.url();
          contentType = contentType || (await page.evaluate(() => document.contentType).catch(() => null));
          if (httpStatus != null) statusCounts[String(httpStatus)] = (statusCounts[String(httpStatus)] || 0) + 1;
          if (contentType && !isHtmlContentType(contentType)) {
            results.push({
              url: targetUrl,
              title: `(skipped non-HTML: ${contentType})`,
              elements: [],
              apis: [],
              formCount: 0,
              componentInventory: [],
              httpStatus,
              contentType,
              finalUrl,
              depth: depthOf.get(pageKey) ?? 0,
              parentUrl: parentOf.get(pageKey) ?? null,
              discoveryMethod: methodOf.get(pageKey),
              errorCategory: "CONTENT_TYPE_UNSUPPORTED",
            });
            emitProgress(targetUrl);
            return;
          }

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
          const canonicalUrl = links.find((l) => l.method === "canonical")?.url ?? null;
          if (currentUrl !== targetUrl && sameOrigin(currentUrl, normalizedUrl) && !visited.has(dedupeKey(currentUrl))) {
            noteLink({ url: currentUrl, label: "navigation", method: "javascript_navigation" }, targetUrl);
            edges.push({ from: targetUrl, to: currentUrl, via: "navigation" });
          }

          for (const link of links) {
            if (!sameOrigin(link.url, normalizedUrl)) {
              externalLinkCount += 1;
              continue;
            }
            noteLink(link, targetUrl);
            edges.push({ from: currentUrl, to: link.url, via: link.label });
          }

          const snapshot = await collectPageSnapshot(page, {
            httpStatus,
            canonical: canonicalUrl,
            finalUrl: currentUrl,
            title,
          });

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
            links: links.filter((l) => sameOrigin(l.url, normalizedUrl)),
            httpStatus,
            contentType,
            canonicalUrl,
            finalUrl: currentUrl,
            depth: depthOf.get(pageKey) ?? 0,
            parentUrl: parentOf.get(pageKey) ?? null,
            discoveryMethod: methodOf.get(pageKey),
            snapshot,
          });
          emitProgress(targetUrl);
        } catch (err: any) {
          const cat = classifyNavError(err);
          statusCounts[cat] = (statusCounts[cat] || 0) + 1;
          results.push({
            url: targetUrl,
            title: `(failed to load: ${err.message})`,
            elements: [],
            apis: [],
            formCount: 0,
            componentInventory: [],
            errorCategory: cat,
            depth: depthOf.get(dedupeKey(targetUrl)) ?? 0,
            parentUrl: parentOf.get(dedupeKey(targetUrl)) ?? null,
            discoveryMethod: methodOf.get(dedupeKey(targetUrl)),
          });
        } finally {
          await page.close().catch(() => undefined);
        }
      });

      const batchPages = results.splice(batchStart);
      batchPages.sort((a, b) => dedupeKey(a.url).localeCompare(dedupeKey(b.url)));
      results.push(...batchPages);

      for (const key of Array.from(discoveredLinksThisBatch.keys()).sort((a, b) => a.localeCompare(b))) {
        const link = discoveredLinksThisBatch.get(key)!;
        enqueue(link.url, discoveredFrom.get(key) ?? normalizedUrl, link.method || "html_link");
      }
    }

    const reachableKeys = new Set(results.map((p) => dedupeKey(p.url)));
    let sitemapOnly = 0;
    for (const k of sitemapKeys) if (!reachableKeys.has(k)) sitemapOnly += 1;
    const combined = new Set([...reachableKeys, ...sitemapKeys]);
    const maxSeenDepth = Math.max(0, ...results.map((p) => p.depth ?? 0));

    return {
      pages: results,
      edges: sortEdges(edges),
      authenticated: login.succeeded,
      authMessage: login.message,
      coverage: {
        reachableHtmlPages: results.filter((p) => !p.errorCategory || p.errorCategory === "").length,
        sitemapUrls: sitemapKeys.size,
        combinedUnique: combined.size,
        sitemapOnly,
        externalLinks: externalLinkCount,
        maxDepth: maxSeenDepth,
        statusCounts,
        sitemapKeys: Array.from(sitemapKeys),
      },
    };
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}
