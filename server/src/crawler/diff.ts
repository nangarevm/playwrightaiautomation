// Noise-normalized structural hashing — strip volatile tokens so re-crawls
// don't deep-scan on timestamps, ads, CSRF, counters, etc.

import crypto from "crypto";
import type { ElementRecord, PageDiff } from "./types.js";

const NOISE_LABEL =
  /\b(\d{1,2}:\d{2}(:\d{2})?|\d{4}-\d{2}-\d{2}|csrf|token|nonce|session|captcha|cookie|ads?bygoogle|advertisement|sponsored|©|®|™|\d+\s*(views?|likes?|comments?|shares?|followers?))\b/gi;

const NOISE_LOCATOR_ATTRS = /(csrf|nonce|token|timestamp|session|utm_|fbclid|gclid)/i;

export function normalizeLabel(label: string): string {
  return (label || "")
    .replace(NOISE_LABEL, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function normalizeLocator(locator: string): string {
  if (!locator) return "";
  // Drop volatile query/data attributes from locator strings
  return locator
    .replace(/\[(?:data-csrf|data-token|data-nonce|data-timestamp)[^\]]*\]/gi, "")
    .replace(/[?&](utm_[^=&]+|fbclid|gclid|msclkid|sid|sessionid?)=[^&"']*/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeElement(e: ElementRecord): { type: string; label: string; locator: string; component: string } {
  return {
    type: (e.type || "").toLowerCase(),
    label: normalizeLabel(e.label),
    locator: normalizeLocator(e.locators?.[0] || ""),
    component: normalizeLabel(e.component || ""),
  };
}

/** Full structural hash used for persist/classify (noise-normalized). */
export function hashElements(elements: ElementRecord[]): string {
  const structural = elements
    .map((e) => {
      const n = normalizeElement(e);
      // Prefer type|label for stability; include locator only when not noisy
      const loc = NOISE_LOCATOR_ATTRS.test(n.locator) ? "" : n.locator;
      return `${n.type}|${n.label}|${loc}`;
    })
    .filter((s) => !/^\|+$/.test(s.replace(/\|/g, "")))
    .sort();
  return crypto.createHash("sha256").update(JSON.stringify(structural)).digest("hex");
}

function elementKey(e: ElementRecord): string {
  const n = normalizeElement(e);
  return `${n.type}::${n.label}`;
}

export function diffElements(before: ElementRecord[], after: ElementRecord[]): PageDiff {
  const beforeMap = new Map(before.map((e) => [elementKey(e), e]));
  const afterMap = new Map(after.map((e) => [elementKey(e), e]));

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const [key, afterEl] of afterMap) {
    const beforeEl = beforeMap.get(key);
    if (!beforeEl) {
      added.push(key);
    } else {
      const a = normalizeElement(afterEl);
      const b = normalizeElement(beforeEl);
      if (a.locator !== b.locator || a.component !== b.component) {
        changed.push(key);
      }
    }
  }
  for (const key of beforeMap.keys()) {
    if (!afterMap.has(key)) removed.push(key);
  }

  return { added, removed, changed };
}

export type ChangeStatus = "new" | "changed" | "unchanged" | "removed";

export function classifyChange(previousHash: string | null | undefined, currentHash: string): ChangeStatus {
  if (!previousHash) return "new";
  return previousHash === currentHash ? "unchanged" : "changed";
}

/** Structure-only fingerprint (type + label, noise-normalized). */
export function structureFingerprint(elements: ElementRecord[]): string {
  const structural = elements
    .map((e) => {
      const n = normalizeElement(e);
      return `${n.type}|${n.label}`;
    })
    .filter((s) => s !== "|")
    .sort();
  return crypto.createHash("sha256").update(JSON.stringify(structural)).digest("hex");
}

export function structureMatches(a: ElementRecord[], b: ElementRecord[]): boolean {
  return structureFingerprint(a) === structureFingerprint(b);
}

/** Hash an accessibility-tree text dump (noise-normalized). */
export function hashA11yTree(treeText: string): string {
  const cleaned = (treeText || "")
    .replace(NOISE_LABEL, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return crypto.createHash("sha256").update(cleaned).digest("hex");
}

/** Perceptual-ish hash of a screenshot buffer (fast average-hash style). */
export function hashScreenshotBuffer(buf: Buffer | null | undefined): string | null {
  if (!buf || buf.length < 64) return null;
  // Content hash of PNG bytes is fine for "looks different" signal without image libs
  return crypto.createHash("sha256").update(buf).digest("hex").slice(0, 32);
}
