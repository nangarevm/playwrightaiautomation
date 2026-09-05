// Deeper Bug Detection #4 -- DOM-level UI checks. Runs as a single page.evaluate()
// pass after each page load/navigation (see bugDetectionService.scanScreenForUiBugs),
// so it needs no baseline data and adds no extra navigation. Looks for structural
// signs of a broken layout: elements with real text content that render at zero
// width/height (a likely CSS/layout bug -- elements hidden on purpose via
// display:none/visibility:hidden/opacity:0/aria-hidden are excluded, since that's
// not a bug), overlapping interactive elements (two clickable targets whose boxes
// significantly intersect -- a click may land on the wrong one), text that
// clips instead of wrapping/ellipsizing/line-clamping (overflow:hidden with no
// ellipsis and no -webkit-line-clamp, content wider/taller than the box), and
// interactive elements positioned entirely outside the horizontal viewport
// while still not marked aria-hidden (a mouse user can never reach them, but
// they may still be tab-focusable).
//
// NOTE ON STYLE: every helper below is inlined at its call site inside the
// page.evaluate() callback -- no local `const foo = () => {}` function
// declarations. Under tsx's dev transform those get wrapped in an esbuild
// `__name(fn, "foo")` call for name-preservation, and since `__name`'s own
// definition lives in the surrounding (Node-side) module scope -- which
// page.evaluate() does NOT send into the browser context, only the callback's
// own toString() -- such a helper fails at runtime with "ReferenceError:
// __name is not defined" the moment it's invoked. See componentInventory.ts's
// header comment for the same constraint, hit first in that module.

import type { Page } from "playwright";
import { db } from "../db.js";

export type DomIssueKind = "zero_size_with_content" | "overlapping_elements" | "text_overflow" | "off_viewport";

export interface DomIssue {
  kind: DomIssueKind;
  severity: "critical" | "high" | "medium" | "low";
  message: string;
  samples: string[]; // up to 3 short identifying labels
  count: number;
}

// Phase 4 config: every tunable value for DOM-level checks lives here.
export const DOM_CHECKS_CONFIG = {
  // Overlap detection is O(n^2) over interactive elements -- skip it on a
  // page with an unusually large interactive-element count rather than hang
  // the scan.
  maxElementsForOverlapCheck: 300,
  // Caps the sample list for any one check so a badly-broken page can't
  // produce an unbounded finding list in one pass.
  maxSamplesPerCheck: 10,
  // Global CSS selectors excluded from EVERY DOM check below. Empty by
  // default -- known-intentional patterns (an off-canvas drawer positioned
  // off-screen until opened, a deliberately overlapping notification badge)
  // are app-specific, so we don't guess them. Add your own here, or
  // per-screen via getDomCheckIgnoreSelectors/setDomCheckIgnoreSelectors
  // (PUT /api/screens/:id/dom-check-ignore-selectors) for a pattern that's
  // only intentional on one specific screen.
  defaultIgnoreSelectors: [] as string[],
};

export function getDomCheckIgnoreSelectors(screenId: string): string[] {
  const row = db.prepare("SELECT dom_check_ignore_selectors_json FROM screens WHERE id = ?").get(screenId) as { dom_check_ignore_selectors_json: string } | undefined;
  if (!row) return DOM_CHECKS_CONFIG.defaultIgnoreSelectors;
  try {
    return JSON.parse(row.dom_check_ignore_selectors_json);
  } catch {
    return DOM_CHECKS_CONFIG.defaultIgnoreSelectors;
  }
}

export function setDomCheckIgnoreSelectors(screenId: string, selectors: string[]): void {
  if (!Array.isArray(selectors) || !selectors.every((s) => typeof s === "string")) {
    throw new Error("selectors must be an array of CSS selector strings");
  }
  db.prepare("UPDATE screens SET dom_check_ignore_selectors_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(selectors), new Date().toISOString(), screenId);
}

export async function runDomChecks(page: Page, ignoreSelectors: string[] = []): Promise<DomIssue[]> {
  const raw = await page
    .evaluate(
      ({ maxForOverlap, maxSamples, ignoreSelectors }: { maxForOverlap: number; maxSamples: number; ignoreSelectors: string[] }) => {
        const issues: Array<{ kind: string; severity: string; message: string; samples: string[]; count: number }> = [];

        // Pre-expand each matched element's full descendant subtree into the
        // Set up front -- so every later check is a plain `ignored.has(el)`
        // Set lookup, never a function call. (No `isIgnored(el)` helper here
        // on purpose: a named function declaration inside this callback would
        // get wrapped in tsx's `__name()` for name-preservation, which throws
        // "ReferenceError: __name is not defined" in the browser context --
        // see this file's own header comment for the constraint this
        // sidesteps; hit for real once already while writing this check.)
        const ignored = new Set<Element>();
        for (const sel of ignoreSelectors) {
          try {
            document.querySelectorAll(sel).forEach((el) => {
              ignored.add(el);
              el.querySelectorAll("*").forEach((child) => ignored.add(child));
            });
          } catch {
            /* an invalid selector should never crash the scan */
          }
        }

        // 1. Zero-size elements with non-empty text content.
        const allLeafEls = Array.from(document.querySelectorAll("body *")).filter((el) => el.children.length === 0);
        const zeroSize: string[] = [];
        for (const el of allLeafEls) {
          if (zeroSize.length >= maxSamples) break;
          if (ignored.has(el)) continue;
          const text = (el.textContent || "").trim();
          if (text.length === 0) continue;
          if (el.getAttribute("aria-hidden") === "true") continue;
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity || "1") === 0) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) {
            zeroSize.push(`${el.tagName.toLowerCase()}: "${text.slice(0, 60)}"`);
          }
        }
        if (zeroSize.length > 0) {
          issues.push({
            kind: "zero_size_with_content",
            severity: "medium",
            message: `${zeroSize.length} element(s) have real text content but render at zero width/height -- likely a layout/CSS bug (not intentionally hidden).`,
            samples: zeroSize.slice(0, 3),
            count: zeroSize.length,
          });
        }

        // Shared interactive-element set for checks 2 and 4.
        const interactiveSelector = 'a, button, [role="button"], [role="link"], input, select, textarea, [onclick], [tabindex]:not([tabindex="-1"])';
        const interactiveAll = Array.from(document.querySelectorAll(interactiveSelector));
        const interactive: Element[] = [];
        for (const el of interactiveAll) {
          if (ignored.has(el)) continue;
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity || "1") === 0) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) interactive.push(el);
        }

        // 2. Overlapping interactive elements.
        const overlaps: string[] = [];
        if (interactive.length > 0 && interactive.length <= maxForOverlap) {
          const rects = interactive.map((el) => el.getBoundingClientRect());
          for (let i = 0; i < rects.length && overlaps.length < maxSamples; i++) {
            for (let j = i + 1; j < rects.length && overlaps.length < maxSamples; j++) {
              const a = rects[i];
              const b = rects[j];
              const aContainsB = a.left <= b.left && a.top <= b.top && a.right >= b.right && a.bottom >= b.bottom;
              const bContainsA = b.left <= a.left && b.top <= a.top && b.right >= a.right && b.bottom >= a.bottom;
              // A parent/child pair (one fully contains the other) is a normal
              // nested-interactive pattern (e.g. an icon button inside a bigger
              // clickable card), not two competing targets -- skip it.
              if (aContainsB || bContainsA) continue;
              const intersects = a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
              if (!intersects) continue;
              const overlapArea = (Math.min(a.right, b.right) - Math.max(a.left, b.left)) * (Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
              const smallerArea = Math.min(a.width * a.height, b.width * b.height);
              if (smallerArea === 0 || overlapArea / smallerArea < 0.3) continue; // trivial edge-touching, not a real overlap
              const labelA = (interactive[i].getAttribute("aria-label") || interactive[i].textContent || interactive[i].tagName).toString().trim().slice(0, 30);
              const labelB = (interactive[j].getAttribute("aria-label") || interactive[j].textContent || interactive[j].tagName).toString().trim().slice(0, 30);
              overlaps.push(`"${labelA}" overlaps "${labelB}"`);
            }
          }
        }
        if (overlaps.length > 0) {
          issues.push({
            kind: "overlapping_elements",
            severity: "high",
            message: `${overlaps.length} pair(s) of interactive elements significantly overlap -- a click may land on the wrong element.`,
            samples: overlaps.slice(0, 3),
            count: overlaps.length,
          });
        }

        // 3. Text overflow/truncation: content wider/taller than its box,
        // overflow hidden, and no ellipsis/-webkit-line-clamp affordance
        // signaling the truncation is intentional. -webkit-line-clamp is a
        // very common multi-line-truncation technique (card summaries, list
        // previews) distinct from the single-line text-overflow:ellipsis
        // pattern -- excluding only the latter would false-positive on
        // every clamped card.
        const overflow: string[] = [];
        for (const el of allLeafEls) {
          if (overflow.length >= maxSamples) break;
          if (ignored.has(el)) continue;
          const text = (el.textContent || "").trim();
          if (text.length < 3) continue;
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity || "1") === 0) continue;
          const hidesOverflow = style.overflow === "hidden" || style.overflowX === "hidden";
          const hasEllipsis = style.textOverflow === "ellipsis";
          const usesLineClamp = (style as any).webkitLineClamp && (style as any).webkitLineClamp !== "none";
          const htmlEl = el as HTMLElement;
          const clipsHorizontally = htmlEl.scrollWidth > htmlEl.clientWidth + 2;
          const clipsVertically = htmlEl.scrollHeight > htmlEl.clientHeight + 2;
          if (hidesOverflow && (clipsHorizontally || clipsVertically) && !hasEllipsis && !usesLineClamp) {
            overflow.push(`${el.tagName.toLowerCase()}: "${text.slice(0, 40)}"`);
          }
        }
        if (overflow.length > 0) {
          issues.push({
            kind: "text_overflow",
            severity: "low",
            message: `${overflow.length} element(s) clip their text (content wider/taller than the box, overflow hidden, no ellipsis or line-clamp) -- likely truncated/unreadable text.`,
            samples: overflow.slice(0, 3),
            count: overflow.length,
          });
        }

        // 4. Off-viewport interactive elements: entirely outside the horizontal
        // viewport and not explicitly aria-hidden -- a sighted mouse user can never
        // reach them, but they may still be keyboard-focusable (so this is a real
        // finding, not necessarily an intentional off-canvas element).
        const vw = window.innerWidth;
        const offViewport: string[] = [];
        for (const el of interactive) {
          if (offViewport.length >= maxSamples) break;
          if (el.getAttribute("aria-hidden") === "true") continue;
          const rect = el.getBoundingClientRect();
          const offHorizontally = rect.right <= 0 || rect.left >= vw;
          if (offHorizontally) {
            const label = (el.getAttribute("aria-label") || el.textContent || el.tagName).toString().trim().slice(0, 40);
            offViewport.push(`${el.tagName.toLowerCase()}: "${label}"`);
          }
        }
        if (offViewport.length > 0) {
          issues.push({
            kind: "off_viewport",
            severity: "medium",
            message: `${offViewport.length} interactive element(s) are positioned entirely outside the horizontal viewport (not marked aria-hidden) -- unreachable by a sighted mouse user.`,
            samples: offViewport.slice(0, 3),
            count: offViewport.length,
          });
        }

        return issues;
      },
      { maxForOverlap: DOM_CHECKS_CONFIG.maxElementsForOverlapCheck, maxSamples: DOM_CHECKS_CONFIG.maxSamplesPerCheck, ignoreSelectors }
    )
    .catch(() => [] as Array<{ kind: string; severity: string; message: string; samples: string[]; count: number }>);

  return raw as DomIssue[];
}
