// Playbook §35 -- Chaos Exploration Engine. exploratoryAgentService.ts
// (master prompt's own numbered "AI Exploratory Agent", §16) is the CAREFUL
// explorer: one LLM call per step choosing the highest-value next action,
// read-only by default (buttons/links only, no form-fill/checkbox/dropdown,
// destructive-looking labels excluded). This module is its deliberate
// opposite -- no LLM, no "best" action reasoning, just a bounded run of
// RANDOM interactions (including filling inputs with edge-case "chaos"
// values, toggling checkboxes, picking random <select> options) intended to
// stumble into the erratic, unplanned sequences a careful/guided explorer
// would never choose, and that a human tester is unlikely to think to try
// by hand -- classic "monkey testing", the thing this class of tool is
// actually good for: crash discovery, not coverage-guided reasoning.
//
// Deliberately deterministic despite being "random": every run is driven by
// an explicit seed (default: randomly chosen once, but always recorded in
// the resulting finding's evidence and returned to the caller) via a
// hand-rolled seeded PRNG (mulberry32 -- fast, dependency-free, matching
// this codebase's existing preference for hand-rolled utilities over a new
// dependency for something this small). Re-running with the SAME seed
// reproduces the exact same action sequence, which is what makes a chaos-
// discovered crash actually reproducible/debuggable rather than a one-off
// nobody can chase down again.
//
// Still reuses the crawler's own DESTRUCTIVE_ACTION_PATTERN denylist (the
// same "never auto-click anything that looks destructive" rule
// exploratoryAgentService.ts follows) -- chaos exploration is meant to be
// MORE aggressive in the TYPES of interaction it tries (form-fills,
// checkboxes, dropdowns), not reckless about real data loss on whatever
// target it's pointed at.
//
// FALSE-POSITIVE / RISK NOTE: same as exploratoryAgentService.ts's own note
// -- random interaction against a real app can trigger real side effects
// (a "like" button, a counter, a non-idempotent GET), and unlike the guided
// agent this module ALSO fills forms and toggles checkboxes/selects, which
// is a materially larger blast radius. This is the accepted, documented cost
// of chaos/monkey testing, not a bug in this service -- run it only against
// a specifically designated test environment, with a conservative
// maxActions budget (the default), never against production.

import { chromium, type Page } from "playwright";
import { recordBugFinding, type BugFindingRow } from "./bugDetectionService.js";
import { DESTRUCTIVE_ACTION_PATTERN } from "../crawler/types.js";

export const CHAOS_CONFIG = {
  maxActions: 25,
  actionDelayMs: 150,
  navTimeoutMs: 30000,
  interactiveSelector: 'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="checkbox"]',
  // Deliberately adversarial/edge-case values -- empty, very long, unicode,
  // markup/script-shaped, and common "falsy-looking" strings -- chosen to
  // stress client-side rendering/validation, not as a dedicated security
  // scanner (authzTestingService.ts already owns that ground; a reflected
  // <script> string surviving here is a useful bonus signal, not this
  // module's primary purpose).
  chaosTextValues: [
    "",
    " ",
    "a".repeat(3000),
    "😀🔥💯 chaos",
    "<script>alert(1)</script>",
    "'; DROP TABLE users; --",
    "0",
    "-1",
    "NaN",
    "null",
    "undefined",
    "   leading and trailing spaces   ",
    "line1\nline2\nline3",
    "../../../etc/passwd",
  ] as string[],
};

// mulberry32: a small, fast, dependency-free seeded PRNG. Not
// cryptographically secure and not meant to be -- this only needs to be
// deterministic given the same seed, exactly like bugFingerprintService's
// own hand-rolled FNV-1a hash a few files over.
function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return function random() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ChaosExplorationOptions {
  url: string;
  /** Drives every random choice in this run. Omit to get a fresh random seed (returned in the result so the run can be replayed later). */
  seed?: number;
  maxActions?: number;
  actionDelayMs?: number;
  screenId?: string | null;
  runId?: string | null;
}

export interface ChaosExplorationResult {
  findings: BugFindingRow[];
  seed: number;
  actionsTaken: number;
  actionLog: string[];
}

async function describeElement(page: Page, index: number, selector: string): Promise<{ tag: string; inputType: string | null; label: string }> {
  const el = page.locator(selector).nth(index);
  const tag = await el.evaluate((node) => node.tagName.toLowerCase()).catch(() => "unknown");
  const inputType = tag === "input" ? await el.getAttribute("type").catch(() => null) : null;
  const label = (
    (await el.textContent().catch(() => "")) ||
    (await el.getAttribute("aria-label").catch(() => "")) ||
    (await el.getAttribute("placeholder").catch(() => "")) ||
    tag
  )
    .trim()
    .slice(0, 60);
  return { tag, inputType, label };
}

/**
 * Runs a bounded, seeded-random sequence of interactions against `url` --
 * clicking buttons/links (occasionally with force:true, to try clicking
 * through whatever would normally block a real click), filling text inputs/
 * textareas with adversarial edge-case values, and picking random <select>
 * options -- watching for an uncaught JS exception or unhandled promise
 * rejection at any point. Stops immediately once one is observed (further
 * actions against an already-crashed page are meaningless) and records a
 * single finding carrying the full action log + seed, so the exact
 * sequence that caused it can be replayed.
 */
export async function runChaosExploration(options: ChaosExplorationOptions): Promise<ChaosExplorationResult> {
  const seed = options.seed ?? Math.floor(Math.random() * 0xffffffff);
  const rng = mulberry32(seed);
  const maxActions = options.maxActions ?? CHAOS_CONFIG.maxActions;
  const delay = options.actionDelayMs ?? CHAOS_CONFIG.actionDelayMs;

  const actionLog: string[] = [];
  const findings: BugFindingRow[] = [];
  const pageErrors: string[] = [];

  const browser = await chromium.launch({ headless: true, executablePath: process.env.SCAN_CHROMIUM_PATH || undefined });
  const context = await browser.newContext();
  const page = await context.newPage();

  page.on("pageerror", (err) => pageErrors.push(err.message.slice(0, 300)));
  await page.exposeFunction("__chaosReportUnhandledRejection", (message: string) => pageErrors.push(String(message).slice(0, 300)));
  await page.addInitScript(() => {
    window.addEventListener("unhandledrejection", (event) => {
      const reason: any = (event as any).reason;
      const message = reason && reason.message ? String(reason.message) : String(reason);
      // @ts-ignore -- installed by page.exposeFunction above
      if (typeof window.__chaosReportUnhandledRejection === "function") window.__chaosReportUnhandledRejection(message);
    });
  });

  let actionsTaken = 0;
  let crashed = false;

  try {
    await page.goto(options.url, { waitUntil: "domcontentloaded", timeout: CHAOS_CONFIG.navTimeoutMs }).catch(() => undefined);

    for (let step = 0; step < maxActions; step++) {
      const errorsBefore = pageErrors.length;
      const candidates = page.locator(CHAOS_CONFIG.interactiveSelector);
      const count = await candidates.count().catch(() => 0);
      if (count === 0) break;

      const eligibleIndexes: number[] = [];
      for (let idx = 0; idx < count; idx++) {
        const { label } = await describeElement(page, idx, CHAOS_CONFIG.interactiveSelector);
        if (!DESTRUCTIVE_ACTION_PATTERN.test(label)) eligibleIndexes.push(idx);
      }
      if (eligibleIndexes.length === 0) break;

      const chosenIndex = eligibleIndexes[Math.floor(rng() * eligibleIndexes.length)];
      const el = candidates.nth(chosenIndex);
      const { tag, inputType, label } = await describeElement(page, chosenIndex, CHAOS_CONFIG.interactiveSelector);

      let actionDescription: string;
      if (tag === "select") {
        const optionLabels = await el.locator("option").allTextContents().catch(() => []);
        if (optionLabels.length > 0) {
          const choice = optionLabels[Math.floor(rng() * optionLabels.length)];
          await el.selectOption({ label: choice }).catch(() => undefined);
          actionDescription = `select "${choice}" in <select> "${label}"`;
        } else {
          actionDescription = `(no options in <select> "${label}", skipped)`;
        }
      } else if (tag === "textarea" || (tag === "input" && !["checkbox", "radio", "submit", "button"].includes(inputType ?? ""))) {
        const value = CHAOS_CONFIG.chaosTextValues[Math.floor(rng() * CHAOS_CONFIG.chaosTextValues.length)];
        await el.fill(value, { timeout: 5000 }).catch(() => undefined);
        actionDescription = `fill "${label}" (${tag}) with chaos value "${value.length > 30 ? value.slice(0, 30) + "..." : value}"`;
      } else {
        const useForce = rng() < 0.2;
        await el.click({ timeout: 5000, force: useForce }).catch(() => undefined);
        actionDescription = `click "${label}" (${tag}${useForce ? ", force" : ""})`;
      }

      actionsTaken++;
      actionLog.push(actionDescription);
      await page.waitForTimeout(delay);

      if (pageErrors.length > errorsBefore) {
        crashed = true;
        break;
      }
    }
  } finally {
    if (crashed) {
      const lastError = pageErrors[pageErrors.length - 1] ?? "unknown error";
      findings.push(
        recordBugFinding({
          source: "ui_exploratory",
          category: "functional",
          severity: "high",
          title: `Chaos exploration triggered an uncaught exception`,
          detail: lastError,
          screenId: options.screenId ?? null,
          runId: options.runId ?? null,
          evidence: { seed, actionsTaken, actionLog, pageErrors },
          stepsToReproduce: [
            `Navigate to ${options.url}`,
            `Re-run chaos exploration with seed=${seed} (the same seed reproduces this exact action sequence)`,
            ...actionLog.map((action, idx) => `Action ${idx + 1}: ${action}`),
            `Observe: an uncaught exception is thrown -- ${lastError}`,
          ],
        })
      );
    }
    await context.close();
    await browser.close();
  }

  return { findings, seed, actionsTaken, actionLog };
}
