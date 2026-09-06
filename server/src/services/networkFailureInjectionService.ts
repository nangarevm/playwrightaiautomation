// Playbook §L -- Network / Failure Injection. Every check built so far in
// this engine PASSIVELY observes whatever the target app naturally does;
// this module is the first that ACTIVELY manufactures a failure condition
// (via Playwright's page.route() request interception) to see how the app
// recovers -- offline, aborted request, hung/timeout request, an injected
// HTTP error status, or a malformed/empty response body on a specific
// endpoint pattern, applied at the exact moment a critical action (login,
// search, save, checkout, upload, delete...) is triggered.
//
// This is deliberately NOT wired into the passive scanScreenForUiBugs() scan
// automatically -- injecting a failure is an active, scenario-specific
// action (which endpoint, at which trigger, in which mode) that only a
// caller who knows the app's critical actions can meaningfully configure,
// the same reasoning stateTransitionService.ts's declarative flows and
// uiApiConsistencyService.ts's declarative rules already follow: reliably
// auto-inferring "this button is the Pay button" isn't a safe heuristic, so
// a human/integration names the scenario once via runNetworkFailureScenario(),
// then it can be re-run automatically.
//
// FALSE-POSITIVE RISK: the "did it recover well" checks below
// (hasVisibleErrorIndicator / stuck-spinner) are heuristics over common CSS
// class names and ARIA roles -- an app with a genuinely different error-UI
// convention (e.g. a custom toast library with no role="alert" and no
// "error" class) will read as "no error shown" even when it actually showed
// one, producing a false positive. There is no per-app suppression list for
// this (an app-specific error selector, not a suppression, is the real fix)
// -- pass your own via NETWORK_FAILURE_CONFIG.errorIndicatorSelectors if the
// defaults don't match your app's convention.

import { chromium, type Page, type Route } from "playwright";
import { recordBugFinding, type BugFindingRow } from "./bugDetectionService.js";

export type NetworkFailureMode = "offline" | "abort" | "timeout" | "http_error" | "malformed_json" | "empty_response" | "high_latency";

export const NETWORK_FAILURE_CONFIG = {
  // How long to wait, after triggering the action, before checking whether
  // the app recovered (showed an error, stopped spinning) -- long enough for
  // a reasonable real-world error-handling path to run, short enough that a
  // scan doesn't hang.
  gracePeriodMs: 3000,
  // Default heuristics for "the app told the user something went wrong" --
  // common ARIA/CSS conventions. Not exhaustive; override per-app if your
  // error UI doesn't match (see the file-level false-positive-risk note).
  errorIndicatorSelectors: ['[role="alert"]', ".error", ".error-message", '[aria-invalid="true"]', ".toast-error", ".alert-danger", ".alert-error"] as string[],
  successIndicatorSelectors: [".success", ".success-message", ".toast-success", ".alert-success", '[data-testid*="success" i]'] as string[],
  spinnerSelectors: [".animate-spin:visible", "[role='progressbar']:visible"] as string[],
  highLatencyDelayMs: 6000,
  navTimeoutMs: 30000,
};

export interface NetworkFailureScenario {
  name: string;
  url: string;
  /** Playwright route glob/regex pattern for the request(s) to target, e.g. "**\/api/checkout" or /\/api\/orders/. */
  urlPattern: string | RegExp;
  mode: NetworkFailureMode;
  /** For mode: "http_error" -- the status code to inject. Defaults to 500. */
  httpStatus?: number;
  /** A plain CSS/text selector to click after navigating, to trigger the targeted request (e.g. a "Pay" button). Optional -- omit if the request fires on page load. */
  triggerSelector?: string;
  screenId?: string | null;
  runId?: string | null;
}

async function buildRouteHandler(mode: NetworkFailureMode, httpStatus: number | undefined) {
  return async (route: Route) => {
    switch (mode) {
      case "offline":
      case "abort":
        await route.abort("failed");
        return;
      case "timeout":
        // Deliberately never call route.fulfill/abort/continue -- the
        // request hangs forever, exactly simulating a request that never
        // completes (a dropped connection, a backend that never responds).
        return;
      case "high_latency":
        await new Promise((resolve) => setTimeout(resolve, NETWORK_FAILURE_CONFIG.highLatencyDelayMs));
        await route.continue();
        return;
      case "http_error":
        await route.fulfill({ status: httpStatus ?? 500, contentType: "application/json", body: JSON.stringify({ error: "Injected failure (network failure injection test)" }) });
        return;
      case "malformed_json":
        await route.fulfill({ status: 200, contentType: "application/json", body: "{not valid json for injection testing" });
        return;
      case "empty_response":
        await route.fulfill({ status: 200, contentType: "application/json", body: "" });
        return;
    }
  };
}

async function anyVisible(page: Page, selectors: string[]): Promise<boolean> {
  for (const sel of selectors) {
    const visible = await page.locator(sel).first().isVisible().catch(() => false);
    if (visible) return true;
  }
  return false;
}

/**
 * Runs one network-failure-injection scenario: navigates to the URL, injects
 * the configured failure on requests matching urlPattern, optionally clicks
 * triggerSelector, waits a grace period, then checks whether the app
 * recovered cleanly. Records a finding (category 'network-resilience') for
 * each broken-recovery signal observed:
 *   - a stuck spinner with no error shown (the classic "infinite spinner")
 *   - a success indicator visible despite the injected failure ("false success")
 *   - neither an error nor a success indicator appeared at all (silent failure)
 *   - an uncaught JS exception was thrown while handling the injected failure
 */
export async function runNetworkFailureScenario(scenario: NetworkFailureScenario): Promise<BugFindingRow[]> {
  const findings: BugFindingRow[] = [];
  const browser = await chromium.launch({ headless: true, executablePath: process.env.SCAN_CHROMIUM_PATH || undefined });
  const context = await browser.newContext();
  const page = await context.newPage();

  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message.slice(0, 300)));

  try {
    const handler = await buildRouteHandler(scenario.mode, scenario.httpStatus);
    await page.route(scenario.urlPattern, handler);

    await page.goto(scenario.url, { waitUntil: "domcontentloaded", timeout: NETWORK_FAILURE_CONFIG.navTimeoutMs }).catch(() => undefined);

    if (scenario.triggerSelector) {
      await page.locator(scenario.triggerSelector).first().click({ timeout: 8000 }).catch(() => undefined);
    }

    await page.waitForTimeout(NETWORK_FAILURE_CONFIG.gracePeriodMs);

    const stuckSpinner = await anyVisible(page, NETWORK_FAILURE_CONFIG.spinnerSelectors);
    const hasError = await anyVisible(page, NETWORK_FAILURE_CONFIG.errorIndicatorSelectors);
    const hasSuccess = await anyVisible(page, NETWORK_FAILURE_CONFIG.successIndicatorSelectors);

    const baseSteps = [
      `Navigate to: ${scenario.url}`,
      `Inject a "${scenario.mode}" failure on requests matching: ${scenario.urlPattern}`,
      ...(scenario.triggerSelector ? [`Click: ${scenario.triggerSelector}`] : []),
      `Wait ${NETWORK_FAILURE_CONFIG.gracePeriodMs}ms.`,
    ];

    if (stuckSpinner && !hasError) {
      findings.push(
        recordBugFinding({
          source: "ui_exploratory",
          category: "network-resilience",
          severity: "high",
          title: `Infinite spinner after injected "${scenario.mode}" failure: ${scenario.name}`,
          detail: `After injecting a ${scenario.mode} failure on ${scenario.urlPattern} and triggering "${scenario.name}", a loading indicator is still visible ${NETWORK_FAILURE_CONFIG.gracePeriodMs}ms later with no error message shown -- the app never recovered from the failure.`,
          screenId: scenario.screenId ?? null,
          runId: scenario.runId ?? null,
          evidence: { scenario: scenario.name, mode: scenario.mode, urlPattern: String(scenario.urlPattern), stuckSpinner, hasError },
          stepsToReproduce: [...baseSteps, "Observe: a loading spinner is still visible, and no error message was shown."],
        })
      );
    }

    if (hasSuccess && !hasError) {
      findings.push(
        recordBugFinding({
          source: "ui_exploratory",
          category: "network-resilience",
          severity: "critical",
          title: `False success after injected "${scenario.mode}" failure: ${scenario.name}`,
          detail: `After injecting a ${scenario.mode} failure on ${scenario.urlPattern} and triggering "${scenario.name}", the UI shows a SUCCESS indicator despite the request having failed -- this can mean the user believes an action (e.g. a payment or save) succeeded when it did not.`,
          screenId: scenario.screenId ?? null,
          runId: scenario.runId ?? null,
          evidence: { scenario: scenario.name, mode: scenario.mode, urlPattern: String(scenario.urlPattern), hasSuccess },
          stepsToReproduce: [...baseSteps, "Observe: a success indicator is shown even though the underlying request was made to fail."],
        })
      );
    }

    if (!stuckSpinner && !hasError && !hasSuccess) {
      findings.push(
        recordBugFinding({
          source: "ui_exploratory",
          category: "network-resilience",
          severity: "medium",
          title: `Silent failure after injected "${scenario.mode}" failure: ${scenario.name}`,
          detail: `After injecting a ${scenario.mode} failure on ${scenario.urlPattern} and triggering "${scenario.name}", the UI shows neither an error nor a success indicator, and no spinner -- the failure may have been silently swallowed with no user-visible feedback at all.`,
          screenId: scenario.screenId ?? null,
          runId: scenario.runId ?? null,
          evidence: { scenario: scenario.name, mode: scenario.mode, urlPattern: String(scenario.urlPattern) },
          stepsToReproduce: [...baseSteps, "Observe: no error, success, or loading indicator is visible -- the failure produced no user-visible feedback."],
        })
      );
    }

    if (pageErrors.length > 0) {
      findings.push(
        recordBugFinding({
          source: "ui_exploratory",
          category: "network-resilience",
          severity: "high",
          title: `Uncaught JS exception handling injected "${scenario.mode}" failure: ${scenario.name}`,
          detail: pageErrors.join("\n"),
          screenId: scenario.screenId ?? null,
          runId: scenario.runId ?? null,
          evidence: { scenario: scenario.name, mode: scenario.mode, pageErrors },
          stepsToReproduce: [...baseSteps, `Observe: an uncaught JavaScript exception is thrown -- ${pageErrors[0]}`],
        })
      );
    }
  } finally {
    await context.close();
    await browser.close();
  }

  return findings;
}

// ---- Named scenario builders for the playbook's own worked list (§L applied
// to login/search/save/checkout/payment/upload/delete) -- callers still
// supply the concrete URL/selectors (see file-level doc comment for why). ----

export function buildOfflineDuringSubmitScenario(params: { name: string; url: string; apiPattern: string | RegExp; submitSelector: string }): NetworkFailureScenario {
  return { name: params.name, url: params.url, urlPattern: params.apiPattern, mode: "offline", triggerSelector: params.submitSelector };
}

export function buildTimeoutDuringSubmitScenario(params: { name: string; url: string; apiPattern: string | RegExp; submitSelector: string }): NetworkFailureScenario {
  return { name: params.name, url: params.url, urlPattern: params.apiPattern, mode: "timeout", triggerSelector: params.submitSelector };
}

export function buildHttpErrorDuringSubmitScenario(params: { name: string; url: string; apiPattern: string | RegExp; submitSelector: string; httpStatus: number }): NetworkFailureScenario {
  return { name: params.name, url: params.url, urlPattern: params.apiPattern, mode: "http_error", httpStatus: params.httpStatus, triggerSelector: params.submitSelector };
}
