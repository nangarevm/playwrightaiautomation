// Shared URL normalization and deduplication for discovery + persistence.
// Using the same key everywhere prevents the same logical page from being
// crawled, stored, or scenario-generated multiple times under tracking-param variants.

const VOLATILE_QUERY_PARAMS = /^(utm_|fbclid$|gclid$|msclkid$|ref$|referrer$|source$|sid$|session(id)?$|_ga$|_gl$)/i;

export function normalizeUrl(raw: string): string {
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

export function dedupeKey(rawUrl: string): string {
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
export async function fetchSitemapUrls(siteUrl: string, maxUrls = 200): Promise<string[]> {
  const origin = originOf(siteUrl);
  if (!origin) return [];

  const candidates = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
  const found: string[] = [];

  for (const sitemapUrl of candidates) {
    if (found.length >= maxUrls) break;
    try {
      const res = await fetch(sitemapUrl, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const text = await res.text();
      const locMatches = text.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi);
      for (const match of locMatches) {
        const loc = match[1].trim();
        if (sameOrigin(loc, siteUrl)) found.push(loc);
        if (found.length >= maxUrls) break;
      }
    } catch {
      // sitemap is optional -- BFS still works without it
    }
  }

  const seen = new Set<string>();
  return found.filter((url) => {
    const key = dedupeKey(url);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
