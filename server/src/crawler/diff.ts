// Phase 4: baseline snapshot + structural diff engine.
//
// A "cheap structural diff first" pass compares a hash of the page's
// accessibility-relevant structure (element type + label + locator, sorted)
// against the last stored baseline. Only pages whose hash actually changed
// go through full locator/scenario re-capture on a re-run -- that's what
// makes re-runs fast (this module implements the classification; the caller
// in crawler/index.ts is what skips re-capture for "unchanged" pages).

import crypto from "crypto";
import type { ElementRecord, PageDiff } from "./types.js";

export function hashElements(elements: ElementRecord[]): string {
  const structural = elements
    .map((e) => `${e.type}|${e.label}|${e.locators[0] ?? ""}`)
    .sort();
  return crypto.createHash("sha256").update(JSON.stringify(structural)).digest("hex");
}

function elementKey(e: ElementRecord): string {
  return `${e.type}::${e.label}`;
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
    } else if (beforeEl.locators[0] !== afterEl.locators[0] || beforeEl.component !== afterEl.component) {
      changed.push(key);
    }
  }
  for (const key of beforeMap.keys()) {
    if (!afterMap.has(key)) removed.push(key);
  }

  return { added, removed, changed };
}

export type ChangeStatus = "new" | "changed" | "unchanged";

export function classifyChange(previousHash: string | null | undefined, currentHash: string): ChangeStatus {
  if (!previousHash) return "new";
  return previousHash === currentHash ? "unchanged" : "changed";
}
