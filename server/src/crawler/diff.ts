// Noise-normalized structural hashing — strip volatile tokens so re-crawls
// don't deep-scan on timestamps, ads, CSRF, counters, etc.

import crypto from "crypto";
import type { ChangeEvent, ElementRecord, PageDiff, PageSnapshot } from "./types.js";

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

export type ChangeStatus = "new" | "changed" | "unchanged" | "removed" | "restored" | "temporarily_unavailable" | "error";

export function classifyChange(previousHash: string | null | undefined, currentHash: string): ChangeStatus {
  if (!previousHash) return "new";
  return previousHash === currentHash ? "unchanged" : "changed";
}

function sha(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 32);
}

export function fingerprintSnapshot(snap: PageSnapshot | null | undefined): {
  title: string;
  description: string;
  h1: string;
  robots: string;
  canonical: string;
  links: string;
  images: string;
  seo: string;
} {
  const s = snap || {};
  const title = sha(normalizeLabel(s.title || ""));
  const description = sha(normalizeLabel(s.description || ""));
  const h1 = sha(normalizeLabel(s.h1 || ""));
  const robots = sha((s.robots || "").toLowerCase().replace(/\s+/g, ""));
  const canonical = sha((s.canonical || "").toLowerCase());
  const images = sha(
    JSON.stringify(
      (s.images || [])
        .map((i) => `${(i.src || "").split("?")[0]}|${normalizeLabel(i.alt || "")}`)
        .sort()
    )
  );
  const seo = sha(`${title}|${description}|${h1}|${robots}|${canonical}`);
  return { title, description, h1, robots, canonical, links: "", images, seo };
}

function event(
  type: string,
  severity: ChangeEvent["severity"],
  oldValue?: string | number | null,
  newValue?: string | number | null
): ChangeEvent {
  return {
    type,
    severity,
    oldValue: oldValue == null ? undefined : String(oldValue),
    newValue: newValue == null ? undefined : String(newValue),
  };
}

function robotsNoindex(value?: string | null): boolean {
  return /noindex/i.test(value || "");
}

/** Level-2 component comparison: named change events instead of a single hash flip. */
export function compareSnapshots(prev: PageSnapshot | null | undefined, next: PageSnapshot | null | undefined): ChangeEvent[] {
  if (!prev || !next) return [];
  const events: ChangeEvent[] = [];
  if ((prev.title || "") !== (next.title || "")) {
    events.push(event("TITLE_CHANGED", "medium", prev.title, next.title));
  }
  if ((prev.description || "") !== (next.description || "")) {
    events.push(event("DESCRIPTION_CHANGED", "medium", prev.description, next.description));
  }
  if ((prev.h1 || "") !== (next.h1 || "")) {
    events.push(event("H1_CHANGED", "medium", prev.h1, next.h1));
  }
  if ((prev.canonical || "") !== (next.canonical || "")) {
    events.push(event("CANONICAL_CHANGED", "high", prev.canonical, next.canonical));
  }
  const prevRobots = prev.robots || "";
  const nextRobots = next.robots || "";
  if (prevRobots !== nextRobots) {
    const critical = !robotsNoindex(prevRobots) && robotsNoindex(nextRobots);
    events.push(event("ROBOTS_CHANGED", critical ? "critical" : "medium", prevRobots, nextRobots));
  }
  if (prev.httpStatus != null && next.httpStatus != null && prev.httpStatus !== next.httpStatus) {
    const critical = prev.httpStatus < 400 && next.httpStatus >= 400;
    const restored = prev.httpStatus >= 400 && next.httpStatus < 400;
    events.push(event("STATUS_CHANGED", critical || restored ? "critical" : "high", prev.httpStatus, next.httpStatus));
  }
  if (prev.finalUrl && next.finalUrl && prev.finalUrl !== next.finalUrl) {
    events.push(event("REDIRECT_CHANGED", "high", prev.finalUrl, next.finalUrl));
  }
  const prevImgs = new Map((prev.images || []).map((i) => [i.src.split("?")[0], i.alt || ""]));
  const nextImgs = new Map((next.images || []).map((i) => [i.src.split("?")[0], i.alt || ""]));
  for (const [src, alt] of nextImgs) {
    if (!prevImgs.has(src)) events.push(event("IMAGE_ADDED", "medium", undefined, src));
    else if (prevImgs.get(src) !== alt) events.push(event("ALT_TEXT_CHANGED", "medium", prevImgs.get(src), alt));
  }
  for (const src of prevImgs.keys()) {
    if (!nextImgs.has(src)) events.push(event("IMAGE_REMOVED", "medium", src, undefined));
  }
  const prevWords = prev.wordCount ?? 0;
  const nextWords = next.wordCount ?? 0;
  if (prevWords && nextWords && Math.abs(nextWords - prevWords) / Math.max(prevWords, 1) >= 0.15) {
    events.push(event("CONTENT_CHANGED", "high", prevWords, nextWords));
  }
  return events;
}

export function compareLinkSets(
  prev: Array<{ url: string; label: string }> | undefined,
  next: Array<{ url: string; label: string }> | undefined
): ChangeEvent[] {
  const a = new Set((prev || []).map((l) => l.url));
  const b = new Set((next || []).map((l) => l.url));
  const events: ChangeEvent[] = [];
  for (const url of b) if (!a.has(url)) events.push(event("LINK_ADDED", "low", undefined, url));
  for (const url of a) if (!b.has(url)) events.push(event("LINK_REMOVED", "high", url, undefined));
  return events;
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
