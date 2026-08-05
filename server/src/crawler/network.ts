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

// Attaches request listeners that record XHR/fetch calls made while `label`
// (the last UI action) is current. Returns a handle exposing the current
// trigger label (set by the interaction loop) and the accumulated records.
export function attachNetworkCapture(page: Page): { records: ApiCallRecord[]; setTrigger: (label: string) => void } {
  const records: ApiCallRecord[] = [];
  let currentTrigger = "page load";

  page.on("request", (request) => {
    const resourceType = request.resourceType();
    if (resourceType !== "xhr" && resourceType !== "fetch") return;

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

    records.push({
      trigger: currentTrigger,
      method: request.method(),
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
