// Playbook §N -- Multi-Tab / Multi-Context Testing (entirely net-new). Real
// users routinely have the same app open in two tabs -- most apps are never
// explicitly tested for it, and it's a rich source of state-sync defects:
// logging out in one tab that leaves the other still showing authenticated
// content, two tabs concurrently editing the same record with the second
// save silently clobbering the first (a "lost update"), or a session that
// expires in one tab without the other noticing until its next action.
//
// Modeled the same way as stateTransitionService.ts's declarative flows --
// a scenario is an ordered list of steps (each naming which of the two tabs
// it runs on: "a" or "b") plus invariants checked against a specific tab at
// a specific point in that sequence. The two tabs are two Pages in the SAME
// BrowserContext (this is deliberate: real browser tabs in the same window
// share cookies/localStorage/sessionStorage automatically -- using one
// context is what makes this actually simulate "two tabs", as opposed to
// two unrelated logged-in-separately sessions, which is just running the
// same flow twice).
//
// FALSE-POSITIVE RISK: same as stateTransitionService.ts -- a scenario's
// steps/invariants are only as good as the selectors a human/integration
// supplied; a stale selector reads as "the app broke" when the scenario
// definition is actually stale. There's no auto-detection for that
// distinction here either -- review/edit the scenario before trusting a
// sudden run of failures.

import { chromium, type Page, type BrowserContext } from "playwright";
import { recordBugFinding, type BugFindingRow } from "./bugDetectionService.js";

export type MultiTabId = "a" | "b";

export type MultiTabStep =
  | { tab: MultiTabId; action: "navigate"; url: string }
  | { tab: MultiTabId; action: "click"; selector: string }
  | { tab: MultiTabId; action: "fill"; selector: string; value: string }
  | { tab: MultiTabId; action: "press"; key: string }
  | { tab: MultiTabId; action: "refresh" }
  | { tab: MultiTabId; action: "clear_cookies" } // context-level (shared by both tabs); which tab issues it doesn't matter
  | { tab: MultiTabId; action: "wait"; ms: number };

export type MultiTabInvariant =
  | { afterStep: number; tab: MultiTabId; type: "not_visible"; selector: string; message: string }
  | { afterStep: number; tab: MultiTabId; type: "visible"; selector: string; message: string }
  | { afterStep: number; tab: MultiTabId; type: "text_contains"; selector: string; text: string; message: string }
  | { afterStep: number; tab: MultiTabId; type: "text_not_contains"; selector: string; text: string; message: string }
  | { afterStep: number; tab: MultiTabId; type: "text_equals"; selector: string; text: string; message: string };

export interface MultiTabScenario {
  name: string;
  steps: MultiTabStep[];
  invariants: MultiTabInvariant[];
  screenId?: string | null;
  runId?: string | null;
}

function validateScenario(scenario: MultiTabScenario): void {
  if (!scenario.steps.length) throw new Error("A multi-tab scenario needs at least one step.");
  if (!scenario.invariants.length) throw new Error("A multi-tab scenario needs at least one invariant, or there's nothing to check.");
  for (const inv of scenario.invariants) {
    if (inv.afterStep < 0 || inv.afterStep >= scenario.steps.length) {
      throw new Error(`Invariant afterStep (${inv.afterStep}) must be a valid index into steps (0-${scenario.steps.length - 1}).`);
    }
  }
}

function describeStep(step: MultiTabStep, index: number): string {
  const tab = `tab ${step.tab.toUpperCase()}`;
  switch (step.action) {
    case "navigate":
      return `Step ${index + 1} (${tab}): navigate to ${step.url}`;
    case "click":
      return `Step ${index + 1} (${tab}): click "${step.selector}"`;
    case "fill":
      return `Step ${index + 1} (${tab}): enter "${step.value}" into "${step.selector}"`;
    case "press":
      return `Step ${index + 1} (${tab}): press "${step.key}"`;
    case "refresh":
      return `Step ${index + 1} (${tab}): refresh`;
    case "clear_cookies":
      return `Step ${index + 1} (${tab}): clear cookies (simulate session expiry, affects BOTH tabs -- same browser context)`;
    case "wait":
      return `Step ${index + 1} (${tab}): wait ${step.ms}ms`;
  }
}

async function executeStep(page: Page, step: MultiTabStep): Promise<void> {
  switch (step.action) {
    case "navigate":
      await page.goto(step.url, { waitUntil: "domcontentloaded", timeout: 30000 });
      return;
    case "click":
      await page.locator(step.selector).first().click({ timeout: 10000 });
      return;
    case "fill":
      await page.locator(step.selector).first().fill(step.value, { timeout: 10000 });
      return;
    case "press":
      await page.keyboard.press(step.key);
      return;
    case "refresh":
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
      return;
    case "clear_cookies":
      await page.context().clearCookies();
      return;
    case "wait":
      await page.waitForTimeout(step.ms);
      return;
  }
}

async function checkInvariant(page: Page, invariant: MultiTabInvariant): Promise<boolean> {
  switch (invariant.type) {
    case "not_visible":
      return !(await page.locator(invariant.selector).first().isVisible().catch(() => false));
    case "visible":
      return await page.locator(invariant.selector).first().isVisible().catch(() => false);
    case "text_contains": {
      const text = await page.locator(invariant.selector).first().textContent().catch(() => null);
      return !!text && text.includes(invariant.text);
    }
    case "text_not_contains": {
      const text = await page.locator(invariant.selector).first().textContent().catch(() => null);
      return !text || !text.includes(invariant.text);
    }
    case "text_equals": {
      const text = await page.locator(invariant.selector).first().textContent().catch(() => null);
      return (text ?? "").trim() === invariant.text;
    }
  }
}

/**
 * Runs a declarative multi-tab scenario against a single shared
 * BrowserContext with two Pages ("a" and "b", opened lazily on first use),
 * executing steps in order and checking every invariant due at its step,
 * recording a bug_findings row (category 'functional') for each violation.
 * Never throws on a step execution failure (a stale selector, a timeout) --
 * that's recorded as a violation of every invariant from that step onward,
 * same reasoning as stateTransitionService.runFlow.
 */
export async function runMultiTabScenario(scenario: MultiTabScenario): Promise<BugFindingRow[]> {
  validateScenario(scenario);

  const violated: Array<{ invariant: MultiTabInvariant; reason: string }> = [];
  const browser = await chromium.launch({ headless: true, executablePath: process.env.SCAN_CHROMIUM_PATH || undefined });
  const context: BrowserContext = await browser.newContext();
  const pages: Partial<Record<MultiTabId, Page>> = {};

  async function pageFor(tab: MultiTabId): Promise<Page> {
    if (!pages[tab]) pages[tab] = await context.newPage();
    return pages[tab]!;
  }

  try {
    for (let i = 0; i < scenario.steps.length; i++) {
      const step = scenario.steps[i];
      const page = await pageFor(step.tab);
      try {
        await executeStep(page, step);
      } catch (err: any) {
        for (const inv of scenario.invariants.filter((inv) => inv.afterStep >= i)) {
          violated.push({ invariant: inv, reason: `Step ${i + 1} (tab ${step.tab.toUpperCase()}, ${step.action}) failed to execute: ${err.message}` });
        }
        break;
      }
      for (const inv of scenario.invariants.filter((inv) => inv.afterStep === i)) {
        const invPage = await pageFor(inv.tab);
        const ok = await checkInvariant(invPage, inv);
        if (!ok) violated.push({ invariant: inv, reason: inv.message });
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }

  const stepDescriptions = scenario.steps.map(describeStep);
  const findings: BugFindingRow[] = [];
  for (const v of violated) {
    findings.push(
      recordBugFinding({
        source: "ui_exploratory",
        category: "functional",
        severity: "high",
        title: `Multi-tab invariant violated: ${scenario.name}`,
        detail: v.reason,
        screenId: scenario.screenId ?? null,
        runId: scenario.runId ?? null,
        evidence: { violatedInvariant: v.invariant, stepIndex: v.invariant.afterStep, tab: v.invariant.tab },
        stepsToReproduce: [...stepDescriptions, `Observe (tab ${v.invariant.tab.toUpperCase()}): ${v.reason}`],
      })
    );
  }

  return findings;
}

// ---- Named scenario builders for the playbook's own worked multi-tab
// patterns -- callers still supply concrete selectors/values (scenario
// content stays data, per the file-level doc comment). ----

/**
 * Tab A logs out; tab B (already open and authenticated) is then refreshed.
 * A correct app must no longer show authenticated-only content in tab B
 * after the refresh -- logging out in one tab must invalidate the session
 * everywhere, not just in the tab that clicked logout.
 */
export function buildLogoutInOneTabTemplate(params: {
  url: string;
  logoutSelector: string;
  authenticatedOnlySelector: string;
}): { steps: MultiTabStep[]; invariants: MultiTabInvariant[] } {
  const steps: MultiTabStep[] = [
    { tab: "a", action: "navigate", url: params.url },
    { tab: "b", action: "navigate", url: params.url },
    { tab: "a", action: "click", selector: params.logoutSelector },
    { tab: "b", action: "refresh" },
  ];
  return {
    steps,
    invariants: [
      {
        afterStep: 3,
        tab: "b",
        type: "not_visible",
        selector: params.authenticatedOnlySelector,
        message: `Logging out in tab A did not invalidate tab B's session -- "${params.authenticatedOnlySelector}" (authenticated-only content) is still visible in tab B after refresh`,
      },
    ],
  };
}

/**
 * Both tabs open the same record for editing; tab A saves one value, then
 * tab B saves a different value without ever having seen tab A's change.
 * After tab A refreshes, if tab A's own save is silently gone (replaced by
 * tab B's value with no conflict warning), that's a lost-update bug --
 * concurrent edits should be detected/merged/warned about, not silently
 * clobbered.
 */
export function buildConcurrentEditLostUpdateTemplate(params: {
  url: string;
  fillSelector: string;
  valueA: string;
  valueB: string;
  saveSelector: string;
  savedValueSelector: string;
}): { steps: MultiTabStep[]; invariants: MultiTabInvariant[] } {
  const steps: MultiTabStep[] = [
    { tab: "a", action: "navigate", url: params.url },
    { tab: "b", action: "navigate", url: params.url },
    { tab: "a", action: "fill", selector: params.fillSelector, value: params.valueA },
    { tab: "a", action: "click", selector: params.saveSelector },
    { tab: "b", action: "fill", selector: params.fillSelector, value: params.valueB },
    { tab: "b", action: "click", selector: params.saveSelector },
    { tab: "a", action: "refresh" },
  ];
  return {
    steps,
    invariants: [
      {
        afterStep: 6,
        tab: "a",
        type: "text_not_contains",
        selector: params.savedValueSelector,
        text: params.valueB,
        message: `Tab B's concurrent save ("${params.valueB}") silently overwrote tab A's edit with no conflict warning -- a lost-update bug (expected some form of conflict detection, not a silent clobber)`,
      },
    ],
  };
}

/**
 * Tab A's session expires (simulated via clearing cookies, which -- since
 * both tabs share one browser context -- affects both tabs at the cookie
 * layer, exactly like a real session/cookie expiry would). Tab B then
 * attempts an authenticated action. A correct app must react to the now-
 * invalid session (show a login prompt / redirect) rather than letting a
 * stale in-memory client state silently continue to act as if authenticated.
 */
export function buildSessionExpiryOtherTabTemplate(params: {
  url: string;
  authenticatedActionSelector: string;
  loginPromptSelector: string;
}): { steps: MultiTabStep[]; invariants: MultiTabInvariant[] } {
  const steps: MultiTabStep[] = [
    { tab: "a", action: "navigate", url: params.url },
    { tab: "b", action: "navigate", url: params.url },
    { tab: "a", action: "clear_cookies" },
    { tab: "b", action: "click", selector: params.authenticatedActionSelector },
    { tab: "b", action: "wait", ms: 1500 },
  ];
  return {
    steps,
    invariants: [
      {
        afterStep: 4,
        tab: "b",
        type: "visible",
        selector: params.loginPromptSelector,
        message: `After the session expired (cookies cleared), tab B's authenticated action did not surface a login prompt / re-auth flow ("${params.loginPromptSelector}" not shown) -- the client may be silently treating a now-invalid session as still authenticated`,
      },
    ],
  };
}
