// Playbook §B -- Auth (deep-link probe, the one gap authzTestingService.ts
// deliberately doesn't cover). That service already probes two DIFFERENT
// aspects of authorization: IDOR (does identity B get identity A's resource)
// and vertical escalation (does a lower-privilege identity reach a
// primary-only URL) -- both are plain API-level GET replays with an
// explicit second identity's credentials.
//
// This module checks a third, more basic thing neither of those do: does a
// COMPLETELY UNAUTHENTICATED browser (a brand-new context -- no cookies, no
// localStorage/sessionStorage, nothing) navigating DIRECTLY to a URL that's
// supposed to require login get correctly gated (redirected to a login
// page / shown an auth prompt), rather than either (a) the protected
// content rendering anyway -- a real, classic, severe auth-bypass bug where
// a route guard only runs client-side after the page has already rendered,
// or checks a token that was never actually validated -- or (b) a blank/
// broken page with no explanation at all.
//
// FALSE-POSITIVE RISK: `protectedContentSelector` is only as good as the
// caller's own claim about what should be gated -- pointing it at content
// that's intentionally public produces a false "bypass" finding. Likewise
// the login-indicator check is a heuristic over common redirect/prompt
// conventions (see AUTH_DEEP_LINK_CONFIG.loginIndicatorSelectors) -- an app
// using an unusual convention for its login gate may read as "no auth gate
// shown" even when it correctly denied access via some other UI. Pass your
// own loginIndicatorSelectors if the defaults don't match your app.

import { chromium, type Page } from "playwright";
import { recordBugFinding, type BugFindingRow } from "./bugDetectionService.js";

export const AUTH_DEEP_LINK_CONFIG = {
  graceMs: 1000,
  navTimeoutMs: 30000,
  loginIndicatorSelectors: [
    'input[type="password"]',
    '[data-testid*="login" i]',
    '[data-testid*="signin" i]',
    'form[action*="login" i]',
    'h1:has-text("Log in")',
    'h1:has-text("Sign in")',
  ] as string[],
};

export interface AuthDeepLinkScenario {
  name: string;
  /** A URL that should require authentication -- navigated to directly, with NO prior login step, from a brand-new (cookie-less) browser context. */
  protectedUrl: string;
  /** A selector for content that should NEVER be visible to an unauthenticated visitor (e.g. an account dashboard element, a "Welcome, {name}" banner). */
  protectedContentSelector: string;
  loginIndicatorSelectors?: string[];
  graceMs?: number;
  screenId?: string | null;
  runId?: string | null;
}

async function anyVisible(page: Page, selectors: string[]): Promise<boolean> {
  for (const sel of selectors) {
    const visible = await page.locator(sel).first().isVisible().catch(() => false);
    if (visible) return true;
  }
  return false;
}

/**
 * Navigates DIRECTLY to scenario.protectedUrl from a brand-new, completely
 * unauthenticated browser context (no cookies, no prior navigation, no
 * login step of any kind) and checks whether the app correctly gates it.
 * Records a CRITICAL finding if the protected content renders anyway (an
 * auth bypass), or a MEDIUM finding if neither the protected content nor a
 * recognizable login gate is shown (an unclear/broken denial, worth review).
 * No finding when a login indicator is shown and the protected content is
 * not -- that is the correct, expected behavior.
 */
export async function runAuthDeepLinkScenario(scenario: AuthDeepLinkScenario): Promise<BugFindingRow[]> {
  const findings: BugFindingRow[] = [];
  const grace = scenario.graceMs ?? AUTH_DEEP_LINK_CONFIG.graceMs;
  const loginSelectors = scenario.loginIndicatorSelectors ?? AUTH_DEEP_LINK_CONFIG.loginIndicatorSelectors;

  const browser = await chromium.launch({ headless: true, executablePath: process.env.SCAN_CHROMIUM_PATH || undefined });
  // A fresh context per run, deliberately never reused across scenarios --
  // this check's entire premise is "zero prior authentication state".
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(scenario.protectedUrl, { waitUntil: "domcontentloaded", timeout: AUTH_DEEP_LINK_CONFIG.navTimeoutMs }).catch(() => undefined);
    await page.waitForTimeout(grace);

    const protectedContentVisible = await anyVisible(page, [scenario.protectedContentSelector]);
    const loginGateVisible = await anyVisible(page, loginSelectors);

    const baseSteps = [`Start a brand-new browser session with no prior login.`, `Navigate directly to: ${scenario.protectedUrl}`, `Wait ${grace}ms.`];

    if (protectedContentVisible) {
      findings.push(
        recordBugFinding({
          source: "ui_exploratory",
          category: "security",
          severity: "critical",
          title: `Unauthenticated deep-link access to protected content: ${scenario.name}`,
          detail: `Navigating directly to "${scenario.protectedUrl}" with NO prior login rendered protected content ("${scenario.protectedContentSelector}") anyway -- this is a real auth-bypass bug, likely a route guard that only runs client-side after the page has already rendered, or a token check that never actually validates against the server.`,
          screenId: scenario.screenId ?? null,
          runId: scenario.runId ?? null,
          evidence: { scenario: scenario.name, protectedUrl: scenario.protectedUrl, protectedContentVisible, loginGateVisible },
          stepsToReproduce: [...baseSteps, `Observe: "${scenario.protectedContentSelector}" is visible despite never having logged in.`],
        })
      );
    } else if (!loginGateVisible) {
      findings.push(
        recordBugFinding({
          source: "ui_exploratory",
          category: "security",
          severity: "medium",
          title: `No clear auth gate shown on direct deep-link: ${scenario.name}`,
          detail: `Navigating directly to "${scenario.protectedUrl}" with no prior login correctly did NOT show the protected content, but also showed no recognizable login/redirect indicator -- worth a manual check that this is a real denial (e.g. a proper redirect this check's selectors don't recognize) rather than a broken/blank page.`,
          screenId: scenario.screenId ?? null,
          runId: scenario.runId ?? null,
          evidence: { scenario: scenario.name, protectedUrl: scenario.protectedUrl, protectedContentVisible, loginGateVisible },
          stepsToReproduce: [...baseSteps, `Observe: neither the protected content nor a recognizable login gate is visible.`],
        })
      );
    }
  } finally {
    await context.close();
    await browser.close();
  }

  return findings;
}
