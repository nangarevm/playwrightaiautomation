// Phase 1 (interaction) + Phase 2 (locator extraction) combined for a single
// already-loaded page: enumerate every visible interactive element, extract
// its ranked locators, and (for elements that don't navigate away) click
// dropdowns/accordions/modals open so their revealed contents are captured
// too. Destructive-looking actions (delete/logout/remove/confirm-payment/...)
// are skipped unless explicitly whitelisted, per the crawl-safety requirement.

import type { Page } from "playwright";
import { DESTRUCTIVE_ACTION_PATTERN, type ElementRecord } from "./types.js";
import { extractElementLocators, INTERACTIVE_SELECTOR } from "./locators.js";

const MAX_INTERACTIONS_PER_PAGE = 20;

export interface PageInteractionResult {
  elements: ElementRecord[];
  formCount: number;
}

async function triggerInfiniteScroll(page: Page): Promise<void> {
  // Best-effort: scroll to bottom up to 3 times, stopping early once the
  // page stops growing (a real "load more"/infinite-scroll page will grow;
  // a normal page won't, so this is a bounded no-op for most sites).
  let lastHeight = await page.evaluate(() => document.body.scrollHeight).catch(() => 0);
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => undefined);
    await page.waitForTimeout(400);
    const newHeight = await page.evaluate(() => document.body.scrollHeight).catch(() => lastHeight);
    if (newHeight <= lastHeight) break;
    lastHeight = newHeight;
  }
}

export async function discoverPageInteractions(
  page: Page,
  onNetworkTrigger?: (label: string) => void,
  options?: { shallow?: boolean }
): Promise<PageInteractionResult> {
  const shallow = Boolean(options?.shallow);
  if (!shallow) {
    await triggerInfiniteScroll(page);
  }

  const formCount = await page.locator("form").count().catch(() => 0);

  const elements: ElementRecord[] = [];
  const handles = page.locator(INTERACTIVE_SELECTOR);
  const count = Math.min(await handles.count().catch(() => 0), shallow ? 80 : 200);

  let interactionsUsed = 0;

  for (let i = 0; i < count; i++) {
    const el = handles.nth(i);
    let visible: boolean;
    try {
      visible = await el.isVisible();
    } catch {
      continue;
    }
    if (!visible) continue;

    const ranked = await extractElementLocators(page, el).catch(() => null);
    if (!ranked) continue;

    elements.push({
      type: ranked.type,
      label: ranked.label,
      locators: ranked.locators,
      component: ranked.component,
      required: ranked.required,
      inputType: ranked.inputType ?? undefined,
    });

    // Shallow mode: locator inventory only -- no exploratory clicks (fast re-crawl probe).
    if (shallow) continue;

    const isDestructive = DESTRUCTIVE_ACTION_PATTERN.test(ranked.label);
    const isLikelyToggle = ranked.type === "button" && interactionsUsed < MAX_INTERACTIONS_PER_PAGE;
    if (isLikelyToggle && !isDestructive) {
      try {
        const tagName = await el.evaluate((node: Element) => node.tagName.toLowerCase());
        const hasHref = tagName === "a" && (await el.getAttribute("href"));
        if (!hasHref) {
          onNetworkTrigger?.(`click "${ranked.label}"`);
          await el.click({ timeout: 1500, trial: false }).catch(() => undefined);
          interactionsUsed += 1;
        }
      } catch {
        // best-effort -- a failed exploratory click must never abort the crawl
      }
    }
  }

  return { elements, formCount };
}
