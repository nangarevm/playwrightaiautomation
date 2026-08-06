// Phase 5: API capture, correlated to the specific UI action that triggered it.
// Gated behind the --capture-api flag / captureApi option by the caller.

import type { Page } from "playwright";
import type { ApiCallRecord } from "./types.js";

function inferSchema(body: unknown): Record<string, unknown> {
  if (body === null || body === undefined) return {};
  if (Array.isArray(body)) {
    return { type: "array", itemType: body.length > 0 ? typeof body[0] : "unknown" };
  }
  if (typeof body === "object") {
    const shape: Record<string, string> = {};
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      shape[key] = Array.isArray(value) ? "array" : typeof value;
    }
    return { type: "object", fields: shape };
  }
  return { type: typeof body };
}

/** True when a captured xhr/fetch response looks like a real API payload, not an HTML page route. */
export function isLikelyApiResponse(contentType: string, url: string): boolean {
  const ct = contentType.toLowerCase();
  if (ct.includes("text/html")) return false;

  let pathname = "";
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url;
  }

  if (
    /application\/(json|graphql)|application\/vnd\.api\+json|application\/x-protobuf|text\/xml/i.test(ct) ||
    /\/api\/|\/v\d+\/|\/graphql|\/rest\/|\/_api\//i.test(pathname) ||
    /\.(json|xml)$/i.test(pathname)
  ) {
    return true;
  }

  // SPA router prefetches often ride xhr/fetch with no JSON content-type -- still not APIs.
  if (/^\/[a-z0-9][a-z0-9-]*$/i.test(pathname)) return false;

  return !ct;
}

// Attaches response listeners that record xhr/fetch calls made while `label`
// (the last UI action) is current. Returns a handle exposing the current
// trigger label (set by the interaction loop) and the accumulated records.
export function attachNetworkCapture(page: Page): { records: ApiCallRecord[]; setTrigger: (label: string) => void } {
  const records: ApiCallRecord[] = [];
  const seen = new Set<string>();
  let currentTrigger = "page load";

  page.on("response", (response) => {
    const request = response.request();
    const resourceType = request.resourceType();
    if (resourceType !== "xhr" && resourceType !== "fetch") return;

    const contentType = response.headers()["content-type"] || "";
    if (!isLikelyApiResponse(contentType, response.url())) return;

    // Only endpoints that returned 2xx during the crawl become API scenarios --
    // avoids generating tests that false-fail on routes that only work as full page loads.
    if (response.status() < 200 || response.status() >= 300) return;

    let schema: Record<string, unknown> = {};
    try {
      const postData = request.postDataJSON?.();
      schema = inferSchema(postData);
    } catch {
      // non-JSON body -- structure not captured, by design (privacy/size)
    }

    let endpoint = request.url();
    let host: string | undefined;
    try {
      const parsed = new URL(request.url());
      endpoint = parsed.pathname + parsed.search;
      host = parsed.host;
    } catch {
      // leave as full URL if it doesn't parse
    }

    const method = request.method().toUpperCase();
    const pathname = endpoint.split("?")[0];
    const key = `${method} ${pathname}`;
    if (seen.has(key)) return;
    seen.add(key);

    records.push({
      trigger: currentTrigger,
      method,
      endpoint,
      schema,
      host,
    });
  });

  return {
    records,
    setTrigger: (label: string) => {
      currentTrigger = label;
    },
  };
}
