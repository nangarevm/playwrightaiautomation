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
  // Bounded infinite-scroll: stop when height stops growing (max_no_change) or
  // after max_scrolls — never scroll forever (strategy §11).
  const maxScrolls = 8;
  const maxNoChange = 2;
  let lastHeight = await page.evaluate(() => document.body.scrollHeight).catch(() => 0);
  let noChange = 0;
  for (let i = 0; i < maxScrolls; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => undefined);
    await page.waitForTimeout(450);
    const newHeight = await page.evaluate(() => document.body.scrollHeight).catch(() => lastHeight);
    if (newHeight <= lastHeight) {
      noChange += 1;
      if (noChange >= maxNoChange) break;
    } else {
      noChange = 0;
      lastHeight = newHeight;
    }
  }
}

const SAFE_PAGINATION_CLICK = /^(next|next page|older posts|load more|show more)$/i;

async function triggerSafePaginationControls(page: Page): Promise<void> {
  const locators = [
    'a[rel="next"]',
    'link[rel="next"]',
    'button:has-text("Load more")',
    'button:has-text("Show more")',
    'a:has-text("Load more")',
    'a:has-text("Next")',
    'a:has-text("Older posts")',
  ];
  let clicks = 0;
  for (const sel of locators) {
    if (clicks >= 4) break;
    const loc = page.locator(sel).first();
    const visible = await loc.isVisible().catch(() => false);
    if (!visible) continue;
    const label = ((await loc.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
    if (label && DESTRUCTIVE_ACTION_PATTERN.test(label)) continue;
    if (label && !SAFE_PAGINATION_CLICK.test(label) && !/rel=["']?next/i.test(sel)) continue;
    await loc.click({ timeout: 1200 }).catch(() => undefined);
    await page.waitForTimeout(350);
    clicks += 1;
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
    await triggerSafePaginationControls(page);
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
