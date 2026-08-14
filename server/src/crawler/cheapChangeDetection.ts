// Cheap change detection BEFORE Playwright navigation.
// Uses HTTP conditional requests (ETag / Last-Modified / 304) and sitemap <lastmod>.

import { dedupeKey, normalizeUrl, originOf, sameOrigin } from "./urlUtils.js";

export interface HttpCacheHeaders {
  etag: string | null;
  lastModified: string | null;
  status: number;
  notModified: boolean;
}

export interface SitemapEntry {
  url: string;
  lastmod: string | null;
}

export interface CheapSkipDecision {
  skip: boolean;
  reason: "etag-304" | "last-modified" | "sitemap-lastmod" | "none";
  headers: HttpCacheHeaders | null;
}

/**
 * Conditional GET/HEAD against a URL using stored validators.
 * Returns notModified=true when the remote says content is unchanged (304)
 * or when Last-Modified matches the stored value on a 200.
 */
export async function probeHttpCache(
  url: string,
  prior?: { etag?: string | null; lastModified?: string | null }
): Promise<HttpCacheHeaders> {
  const headers: Record<string, string> = {
    "User-Agent": "PlaywrightAIAutomation-Recrawl/1.0",
    Accept: "text/html,application/xhtml+xml,*/*",
  };
  if (prior?.etag) headers["If-None-Match"] = prior.etag;
  if (prior?.lastModified) headers["If-Modified-Since"] = prior.lastModified;

  try {
    // Prefer HEAD (cheap). Some servers reject HEAD — fall back to GET with Range.
    let res = await fetch(normalizeUrl(url), {
      method: "HEAD",
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(6000),
    }).catch(() => null);

    if (!res || res.status === 405 || res.status === 501) {
      res = await fetch(normalizeUrl(url), {
        method: "GET",
        headers: { ...headers, Range: "bytes=0-0" },
        redirect: "follow",
        signal: AbortSignal.timeout(8000),
      });
    }

    const etag = res.headers.get("etag");
    const lastModified = res.headers.get("last-modified");
    const notModified =
      res.status === 304 ||
      (!!prior?.etag && !!etag && normalizeEtag(prior.etag) === normalizeEtag(etag)) ||
      (!!prior?.lastModified &&
        !!lastModified &&
        Date.parse(prior.lastModified) === Date.parse(lastModified) &&
        res.status >= 200 &&
        res.status < 400);

    return {
      etag,
      lastModified,
      status: res.status,
      notModified,
    };
  } catch {
    return { etag: null, lastModified: null, status: 0, notModified: false };
  }
}

function normalizeEtag(etag: string): string {
  return etag.replace(/^W\//, "").replace(/"/g, "").trim();
}

/**
 * Decide whether Playwright navigation can be skipped for this URL.
 */
export function decideCheapSkip(input: {
  incremental: boolean;
  hasBaseline: boolean;
  http: HttpCacheHeaders | null;
  sitemapLastmod?: string | null;
  priorLastSeen?: string | null;
}): CheapSkipDecision {
  if (!input.incremental || !input.hasBaseline) {
    return { skip: false, reason: "none", headers: input.http };
  }
  if (input.http?.notModified) {
    return {
      skip: true,
      reason: input.http.status === 304 ? "etag-304" : "last-modified",
      headers: input.http,
    };
  }
  // Sitemap lastmod older than (or equal to) last successful crawl → likely unchanged
  if (input.sitemapLastmod && input.priorLastSeen) {
    const sitemapMs = Date.parse(input.sitemapLastmod);
    const seenMs = Date.parse(input.priorLastSeen);
    if (Number.isFinite(sitemapMs) && Number.isFinite(seenMs) && sitemapMs <= seenMs) {
      return { skip: true, reason: "sitemap-lastmod", headers: input.http };
    }
  }
  return { skip: false, reason: "none", headers: input.http };
}

/** Disallow paths under User-agent: * (and unmatched agents). Empty if robots.txt missing. */
export async function fetchRobotsDisallows(origin: string): Promise<string[]> {
  try {
    const res = await fetch(`${origin}/robots.txt`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return [];
    const text = await res.text();
    const disallows: string[] = [];
    let applies = true;
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.replace(/#.*$/, "").trim();
      if (!line) continue;
      const ua = line.match(/^user-agent\s*:\s*(.+)$/i);
      if (ua) {
        applies = ua[1].trim() === "*";
        continue;
      }
      if (!applies) continue;
      const d = line.match(/^disallow\s*:\s*(.*)$/i);
      if (d) {
        const path = d[1].trim();
        if (path && path !== "/") disallows.push(path);
      }
    }
    return disallows;
  } catch {
    return [];
  }
}

export function isRobotsDisallowed(url: string, disallows: string[]): boolean {
  if (!disallows.length) return false;
  try {
    const path = new URL(url).pathname;
    return disallows.some((rule) => rule && (path === rule || path.startsWith(rule.endsWith("/") ? rule : `${rule}`)));
  } catch {
    return false;
  }
}

/** Sitemap URLs declared by robots.txt, in declaration order. */
async function fetchSitemapsFromRobots(origin: string): Promise<string[]> {
  try {
    const res = await fetch(`${origin}/robots.txt`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return [];
    const text = await res.text();
    const urls: string[] = [];
    for (const match of text.matchAll(/^\s*sitemap\s*:\s*(\S+)\s*$/gim)) {
      const raw = match[1].trim();
      if (!raw || !sameOrigin(raw, origin)) continue;
      urls.push(raw);
    }
    return urls;
  } catch {
    return [];
  }
}

/**
 * Fetch sitemap entries including optional <lastmod> per URL.
 */
export async function fetchSitemapEntries(siteUrl: string, maxUrls = 200): Promise<SitemapEntry[]> {
  const origin = originOf(siteUrl);
  if (!origin) return [];

  // robots.txt is authoritative: sites often publish the real sitemap at a
  // non-standard path, in which case the conventional guesses below 404 and the
  // crawl loses its deep-page seed entirely.
  const declared = await fetchSitemapsFromRobots(origin);
  const candidates = [
    ...declared,
    `${origin}/sitemap.xml`,
    `${origin}/sitemap_index.xml`,
    `${origin}/wp-sitemap.xml`,
    `${origin}/sitemap-index.xml`,
  ];
  const found: SitemapEntry[] = [];
  const visitedSitemaps = new Set<string>();

  async function ingest(sitemapUrl: string, depth = 0): Promise<void> {
    if (depth > 3 || found.length >= maxUrls) return;
    const key = dedupeKey(sitemapUrl);
    if (visitedSitemaps.has(key)) return;
    visitedSitemaps.add(key);

    try {
      const res = await fetch(sitemapUrl, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return;
      const text = await res.text();
      // Match <url>…</url> blocks when present; fall back to bare <loc>
      const urlBlocks = text.match(/<url>[\s\S]*?<\/url>/gi) || [];
      if (urlBlocks.length > 0) {
        for (const block of urlBlocks) {
          if (found.length >= maxUrls) break;
          const loc = block.match(/<loc>\s*([^<]+)\s*<\/loc>/i)?.[1]?.trim();
          if (!loc || !sameOrigin(loc, siteUrl)) continue;
          if (isSitemapPath(loc)) {
            await ingest(loc, depth + 1);
            continue;
          }
          const lastmod = block.match(/<lastmod>\s*([^<]+)\s*<\/lastmod>/i)?.[1]?.trim() || null;
          found.push({ url: loc, lastmod });
        }
      } else {
        for (const match of text.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)) {
          if (found.length >= maxUrls) break;
          const loc = match[1].trim();
          if (!sameOrigin(loc, siteUrl)) continue;
          if (isSitemapPath(loc)) {
            await ingest(loc, depth + 1);
            continue;
          }
          found.push({ url: loc, lastmod: null });
        }
      }
    } catch {
      /* optional */
    }
  }

  for (const c of candidates) {
    if (found.length >= maxUrls) break;
    await ingest(c);
  }

  const seen = new Set<string>();
  return found.filter((e) => {
    const k = dedupeKey(e.url);
    if (seen.has(k) || isSitemapPath(e.url)) return false;
    seen.add(k);
    return true;
  });
}

function isSitemapPath(url: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase();
    return path.endsWith(".xml") || /\/sitemap([._-]|$)/i.test(path) || path.endsWith("/sitemap");
  } catch {
    return /\.xml$/i.test(url);
  }
}
