// Shared URL normalization and deduplication for discovery + persistence.
// Using the same key everywhere prevents the same logical page from being
// crawled, stored, or scenario-generated multiple times under tracking-param variants.

const VOLATILE_QUERY_PARAMS =
  /^(utm_|fbclid$|gclid$|msclkid$|mc_cid$|mc_eid$|ref$|referrer$|source$|sid$|session(id)?$|_ga$|_gl$)/i;

/** Binary/asset URLs that are not HTML pages (strategy §3). */
const NON_HTML_PATH =
  /\.(?:jpe?g|png|gif|webp|svg|ico|bmp|mp4|mov|avi|mp3|wav|ogg|css|js|mjs|map|woff2?|ttf|eot|otf|zip|rar|7z|gz|pdf|json|xml|csv|docx?|xlsx?)$/i;

export function normalizeUrl(raw: string): string {
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

export function dedupeKey(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    u.hostname = u.hostname.toLowerCase();
    if ((u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80")) {
      u.port = "";
    }
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

export function isHtmlDocumentUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    if (/^(mailto|tel|javascript|data):/i.test(u.protocol)) return false;
    return !NON_HTML_PATH.test(u.pathname);
  } catch {
    return false;
  }
}

export function isPaginationUrl(rawUrl: string, label = ""): boolean {
  const path = rawUrl.split(/[?#]/)[0] || "";
  if (/[?&](?:page|p|paged)=\d+/i.test(rawUrl)) return true;
  if (/\/page\/\d+\/?$/i.test(path)) return true;
  if (/\/(offset|start)\/\d+\/?$/i.test(path)) return true;
  return /^(next|next page|older posts|load more|show more|previous|prev)$/i.test(label.trim());
}

export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

export function originOf(rawUrl: string): string | null {
  try {
    return new URL(normalizeUrl(rawUrl)).origin;
  } catch {
    return null;
  }
}

// Best-effort sitemap seeding so BFS doesn't miss pages only linked from sitemap.xml.
// Recursively expands sitemap indexes and never returns nested *.xml sitemap URLs
// as crawl targets (those are indexes, not user-facing pages).
export async function fetchSitemapUrls(siteUrl: string, maxUrls = 200): Promise<string[]> {
  const origin = originOf(siteUrl);
  if (!origin) return [];

  const candidates = [
    `${origin}/sitemap.xml`,
    `${origin}/sitemap_index.xml`,
    `${origin}/wp-sitemap.xml`,
    `${origin}/sitemap-index.xml`,
  ];
  const found: string[] = [];
  const visitedSitemaps = new Set<string>();

  async function ingestSitemap(sitemapUrl: string, depth = 0): Promise<void> {
    if (depth > 3 || found.length >= maxUrls) return;
    const key = dedupeKey(sitemapUrl);
    if (visitedSitemaps.has(key)) return;
    visitedSitemaps.add(key);

    try {
      const res = await fetch(sitemapUrl, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return;
      const text = await res.text();
      const locMatches = text.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi);
      for (const match of locMatches) {
        if (found.length >= maxUrls) break;
        const loc = match[1].trim();
        if (!sameOrigin(loc, siteUrl)) continue;
        // Nested sitemap index entries -- expand instead of crawling as a page.
        if (isSitemapUrl(loc)) {
          await ingestSitemap(loc, depth + 1);
          continue;
        }
        found.push(loc);
      }
    } catch {
      // sitemap is optional -- BFS still works without it
    }
  }

  for (const sitemapUrl of candidates) {
    if (found.length >= maxUrls) break;
    await ingestSitemap(sitemapUrl);
  }

  const seen = new Set<string>();
  return found.filter((url) => {
    const key = dedupeKey(url);
    if (seen.has(key) || isSitemapUrl(url)) return false;
    seen.add(key);
    return true;
  });
}

function isSitemapUrl(url: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase();
    return path.endsWith(".xml") || /\/sitemap([._-]|$)/i.test(path) || path.endsWith("/sitemap");
  } catch {
    return /\.xml$/i.test(url);
  }
}
