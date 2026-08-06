// Phase 9 (API capture -> test cases): turns the raw XHR/fetch calls the
// crawler already records per page (network.ts, gated behind --capture-api)
// into reviewable, generatable scenarios -- mirroring what buildScenariosForPage
// does for UI elements. Two things a naive "one scenario per captured call"
// approach would get wrong, both handled here:
//
// 1. Dedup across the WHOLE site, not per page. The same backend endpoint
//    (e.g. a WordPress admin-ajax handler) gets called from nearly every page,
//    so deduping only within a page still produces one near-identical scenario
//    per page. Dedup key is METHOD + pathname (query string dropped -- it's
//    usually per-request tracking noise, not a distinct endpoint).
// 2. Same-origin only. network.ts captures every XHR/fetch a page makes,
//    which includes third-party analytics/widget/CDN traffic (Google
//    Analytics, embedded social widgets, map-tile services) alongside the
//    site's own backend calls. None of those are "the site's API" in the
//    QA-automation sense, so anything whose host doesn't match the crawled
//    site is dropped, along with common static-asset extensions that
//    occasionally ride the xhr/fetch resource type (fonts, images, wasm).

import { nanoid } from "nanoid";
import type { ApiCallRecord, ScenarioRecord } from "./types.js";

const STATIC_ASSET_EXT = /\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot|otf|wasm|pbf|mp4|mp3|css|map)(\?|$)/i;

// Infrastructure paths that ride on the site's own origin (proxied through it,
// e.g. Cloudflare) but are never the site owner's application code -- same
// same-origin check above can't tell these apart from a real endpoint.
const INFRA_PATH_PREFIX = /^\/(cdn-cgi|__vercel|\.well-known|_next\/static)\//i;

export interface PageApiInput {
  url: string;
  apis: ApiCallRecord[];
}

// Returns, per page URL, the API scenarios first discovered on that page --
// each unique endpoint is attached to exactly one page (the first one it was
// seen on) so re-running "Generate tests" doesn't produce duplicate scenarios
// for an endpoint called from every page on the site.
export function buildApiScenariosForSite(siteHost: string, pages: PageApiInput[]): Map<string, ScenarioRecord[]> {
  const seen = new Set<string>();
  const byPage = new Map<string, ScenarioRecord[]>();

  for (const page of pages) {
    for (const call of page.apis) {
      if (!call.host || call.host !== siteHost) continue;
      const pathname = call.endpoint.split("?")[0];
      if (!pathname || pathname === "/") continue;
      if (STATIC_ASSET_EXT.test(pathname) || INFRA_PATH_PREFIX.test(pathname)) continue;

      const method = call.method.toUpperCase();
      const key = `${method} ${pathname}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const scenario: ScenarioRecord = {
        id: nanoid(10),
        title: `Verify ${key} returns a successful response`,
        type: "api",
        tier: "functional", // endpoint verification, not a single core UI happy path
        flowGroup: key,
        steps: [
          `Given the API endpoint "${key}" was observed during the crawl (triggered by: ${call.trigger})`,
          `When a ${method} request is sent to "${pathname}"`,
          `Then the response is successful (2xx) and matches the shape observed during the crawl`,
        ],
        locators: [],
      };

      const list = byPage.get(page.url) ?? [];
      list.push(scenario);
      byPage.set(page.url, list);
    }
  }

  return byPage;
}
