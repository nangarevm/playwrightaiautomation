// Extends Playwright's base test with an `issues` fixture that auto-captures
// everything a route-crawl needs to catch as a potential bug: console
// errors/warnings, uncaught page exceptions, failed network requests, and
// any HTTP response >= 400. Every test that imports `test` from this file
// gets this instrumentation for free, and the collected issues are attached
// to the HTML report as JSON regardless of pass/fail.

import { test as base, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

export type IssueType = "console-error" | "console-warning" | "pageerror" | "requestfailed" | "http-error";

export interface CapturedIssue {
  type: IssueType;
  message: string;
  url?: string;
  status?: number;
  timestamp: string;
}

export class IssueCollector {
  readonly issues: CapturedIssue[] = [];

  attach(page: Page) {
    page.on("console", (msg) => {
      const type = msg.type();
      if (type === "error") {
        this.issues.push({ type: "console-error", message: msg.text(), url: page.url(), timestamp: new Date().toISOString() });
      } else if (type === "warning") {
        this.issues.push({ type: "console-warning", message: msg.text(), url: page.url(), timestamp: new Date().toISOString() });
      }
    });

    page.on("pageerror", (err) => {
      this.issues.push({ type: "pageerror", message: err.message, url: page.url(), timestamp: new Date().toISOString() });
    });

    page.on("requestfailed", (req) => {
      // Navigation-triggered aborts (e.g. a page navigating away mid-request)
      // are noise, not bugs -- skip them so the report isn't dominated by
      // false positives from normal SPA tab-switching.
      const failure = req.failure()?.errorText ?? "unknown";
      if (failure.includes("net::ERR_ABORTED")) return;
      this.issues.push({ type: "requestfailed", message: `${req.method()} ${req.url()} — ${failure}`, url: req.url(), timestamp: new Date().toISOString() });
    });

    page.on("response", (res) => {
      if (res.status() >= 400) {
        this.issues.push({ type: "http-error", message: `${res.request().method()} ${res.url()} — ${res.status()}`, url: res.url(), status: res.status(), timestamp: new Date().toISOString() });
      }
    });
  }

  errors() {
    return this.issues.filter((i) => i.type === "pageerror" || i.type === "console-error");
  }

  serverErrors() {
    return this.issues.filter((i) => i.type === "http-error" && (i.status ?? 0) >= 500);
  }
}

export const test = base.extend<{ issues: IssueCollector }>({
  issues: async ({ page }, use, testInfo) => {
    const collector = new IssueCollector();
    collector.attach(page);

    await use(collector);

    // Attach whatever was captured -- even on a passing test -- so the HTML
    // report always shows what the crawler saw, not just what failed it.
    await testInfo.attach("captured-issues", {
      body: JSON.stringify(collector.issues, null, 2),
      contentType: "application/json",
    });
  },
});

export { expect };
