import { db } from "../db.js";

export type TitleToUrlMap = Map<string, string> | Record<string, string>;

function asMap(titleToUrl?: TitleToUrlMap): Map<string, string> {
  if (!titleToUrl) return new Map();
  return titleToUrl instanceof Map ? titleToUrl : new Map(Object.entries(titleToUrl));
}

function urlQuality(url: string): number {
  if (/cdn-cgi/i.test(url)) return 0;
  if (/[?#]/.test(url)) return 1;
  return 2;
}

/** Prefer stable absolute page URLs over challenge/CDN or query variants. */
export function buildPageTitleUrlIndex(siteId?: string): Map<string, string> {
  const rows = (
    siteId
      ? db.prepare("SELECT title, url FROM crawl_pages WHERE site_id = ?").all(siteId)
      : db.prepare("SELECT title, url FROM crawl_pages").all()
  ) as Array<{ title?: string; url?: string }>;

  const map = new Map<string, string>();
  for (const row of rows) {
    const title = String(row.title || "").trim();
    const url = String(row.url || "").trim();
    if (!title || !url || !/^https?:\/\//i.test(url)) continue;
    const prev = map.get(title);
    if (!prev || urlQuality(url) > urlQuality(prev)) {
      map.set(title, url);
    }
  }
  return map;
}

function resolveTargetUrl(target: string, titleMap: Map<string, string>): string | null {
  const t = target.trim().replace(/[."']+$/, "");
  if (!t) return null;
  if (/^https?:\/\//i.test(t)) return t;
  if (t.startsWith("/") && t.length > 1) return t;

  if (titleMap.has(t)) return titleMap.get(t)!;
  const lower = t.toLowerCase();
  for (const [title, url] of titleMap) {
    if (title.toLowerCase() === lower) return url;
  }

  // Truncated / suffix-bearing titles from older crawls
  let best: { url: string; score: number } | null = null;
  for (const [title, url] of titleMap) {
    const tl = title.toLowerCase();
    if (!(tl.startsWith(lower) || lower.startsWith(tl) || tl.includes(lower) || lower.includes(tl))) {
      continue;
    }
    const score = urlQuality(url) * 1000 + Math.min(title.length, t.length);
    if (!best || score > best.score) best = { url, score };
  }
  return best?.url ?? null;
}

/**
 * Rewrite brittle "clicks … to reach …" hops into direct URL navigation before codegen.
 * Resolves page-title targets via crawl_pages when a title→URL index is provided.
 */
export function normalizeFlowStepsForCodegen(
  steps: string[],
  opts?: { titleToUrl?: TitleToUrlMap }
): string[] {
  const titleMap = asMap(opts?.titleToUrl);

  return steps.map((step) => {
    const s = String(step || "").trim();

    // Malformed legacy: "navigates to reach <title|url>"
    const navReach = s.match(
      /^(Given|When|And|Then)?(?:\s+the\s+user)?\s*navigates?\s+to\s+reach\s+(?:"([^"]+)"|'([^']+)'|(.+))\s*$/i
    );
    if (navReach) {
      const connector = (navReach[1] || "").trim();
      const target = (navReach[2] || navReach[3] || navReach[4] || "").trim().replace(/[."']+$/, "");
      const url = resolveTargetUrl(target, titleMap);
      if (url) {
        const lead = connector ? `${connector} the user ` : "";
        return `${lead}navigates to "${url}"`;
      }
    }

    const m =
      s.match(
        /^(Given|When|And|Then)?(?:\s+the\s+user)?\s*clicks?\s+(?:"([^"]+)"|'([^']+)'|(.+?))\s+to\s+reach\s+(?:"([^"]+)"|'([^']+)'|(.+))\s*$/i
      ) ||
      s.match(
        /^(Given|When|And|Then)?(?:\s+the\s+user)?\s*clicks?\s+(?:"([^"]+)"|'([^']+)'|(.+?))\s+(?:to\s+(?:go\s+to|open)|→|->)\s+(?:"([^"]+)"|'([^']+)'|(.+))\s*$/i
      );
    if (!m) return s;

    const connector = (m[1] || "").trim();
    const target = (m[5] || m[6] || m[7] || "").trim().replace(/[."']+$/, "");
    const url = resolveTargetUrl(target, titleMap);
    if (!url) {
      // Keep original when we cannot resolve — mockProvider still hardens/skips.
      return s;
    }

    const lead = connector ? `${connector} the user ` : "";
    return `${lead}navigates to "${url}"`;
  });
}
