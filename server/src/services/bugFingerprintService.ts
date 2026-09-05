// Phase 1B -- Correlation/dedup/confidence skeleton, step 1: deterministic
// fingerprinting. A fingerprint is a stable hash of "what defect is this,
// independent of when/how it was observed" -- normalized so the same
// underlying bug produces the same fingerprint across:
//  - repeated scans of the same screen (cross-scan dedup, used by
//    bugDetectionService.recordBugFinding to bump reproducibility counts
//    instead of inserting a duplicate row), and
//  - multiple findings from ONE scan that describe the same root cause from
//    different signals (within-scan correlation, used by
//    bugCorrelationService.correlateFindings).
//
// Deliberately a hand-rolled string-normalize + FNV-1a hash, not a crypto
// hash or hashing library -- this isn't security-sensitive, and every other
// analysis service in this codebase (consoleErrorService, apiSchemaService)
// is hand-rolled the same way rather than reaching for a dependency.

export interface FingerprintInput {
  screenId?: string | null;
  category?: string | null;
  title: string;
  detail: string;
  evidence?: Record<string, any>;
}

// Strip the volatile parts of a message (URLs with query strings, raw
// numbers -- ids/counts/timestamps/pixel-diff percentages -- and long hex
// strings/hashes) so two occurrences of "the same bug" that differ only in
// which specific id/timestamp/count they mention still normalize to the same
// string. This is a heuristic, not a guarantee: a message that legitimately
// differs only in prose (two distinct defects that happen to read similarly)
// could theoretically collide -- see the false-positive-risk note on
// bugCorrelationService.correlateFindings for how that's bounded.
function normalizeMessage(text: string): string {
  return text
    .toLowerCase()
    .replace(/https?:\/\/[^\s"')]+/g, "<url>")
    .replace(/[0-9a-f]{8,}/gi, "<hex>")
    .replace(/\b\d+(\.\d+)?\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

// Endpoint identity, when the finding's evidence carries one -- the single
// most reliable correlation signal available (an api-status/api-schema
// finding always sets evidence.endpointKey; a UI finding that names a URL
// falls back to that URL's pathname).
function extractEndpointKey(evidence: Record<string, any> | undefined): string {
  if (!evidence) return "";
  if (typeof evidence.endpointKey === "string") return evidence.endpointKey;
  if (typeof evidence.url === "string") {
    try {
      return new URL(evidence.url).pathname;
    } catch {
      return evidence.url;
    }
  }
  return "";
}

// FNV-1a 32-bit: fast, dependency-free, deterministic across processes/runs --
// exactly what a non-cryptographic dedup key needs.
function fnv1aHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function computeFingerprint(input: FingerprintInput): string {
  const parts = [
    input.screenId ?? "no-screen",
    input.category ?? "uncategorized",
    extractEndpointKey(input.evidence),
    normalizeMessage(input.detail || input.title),
  ];
  return fnv1aHash(parts.join("::"));
}
