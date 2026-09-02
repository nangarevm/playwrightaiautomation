import { defineConfig, devices } from "@playwright/test";

// FR-4.7: artifact capture mode is set per-run by executionService (env var
// ARTIFACT_CAPTURE_MODE) and must actually change what Playwright captures --
// previously this file hardcoded screenshot/trace regardless of the mode.
const artifactMode = process.env.ARTIFACT_CAPTURE_MODE || "logs-only";
const speedMode = process.env.SPEED_MODE || "fast";
const isFast = speedMode === "fast" || speedMode === "ultrafast";

const screenshotSetting: "off" | "on" | "only-on-failure" =
  artifactMode === "logs-only" ? "off"
  : artifactMode === "failures-only" ? "only-on-failure"
  : artifactMode === "all-screenshots" ? "on"
  : artifactMode === "video-failures" || artifactMode === "video-all" || artifactMode === "full-debug" ? "on"
  : "only-on-failure";

// Video is expensive. Fast mode: off (screenshots/logs still available).
// Non-fast: retain on failure so debugging still works.
const videoSetting: "off" | "on" | "retain-on-failure" =
  isFast ? "off"
  : artifactMode === "video-all" ? "on"
  : "retain-on-failure";

const traceSetting: "off" | "on" = artifactMode === "full-debug" ? "on" : "off";

// FR-4.9: headless/headed is per-run, not hardcoded
const headlessSetting = process.env.HEADLESS_MODE !== "0";

// FR-4.2: concurrency actually controls Playwright's worker count now (previously
// stored but never passed through). FR-4.6's "reuse browser instances" still wins
// when both are requested, since --workers=1 is what makes reuse meaningful.
const reuseBrowser = process.env.REUSE_BROWSER_INSTANCES === "1";
const requestedConcurrency = Number(process.env.EXECUTION_CONCURRENCY) || 5;
const workers = reuseBrowser ? 1 : Math.max(1, Math.min(5, requestedConcurrency));

// FR-4.1/FR-4.9: real Chromium/Firefox/WebKit projects -- previously this array
// didn't exist at all, so `--project=firefox`/`--project=webkit` failed with
// "Project(s) ... not found" on every multi-browser run.
export default defineConfig({
  testDir: "./generated",
  // Fast timeouts cut idle waits that dominated the previous ~2.5h suite runs.
  timeout: isFast ? 25000 : 45000,
    expect: { timeout: isFast ? 8000 : 10000 },
    retries: process.env.RETRY_STRATEGY === "retry-all" ? 2 : process.env.RETRY_STRATEGY === "retry-flaky" ? 1 : 0,
  workers,
  fullyParallel: true,
  forbidOnly: false,
  // Phase 6: real Allure reporting, not just Playwright's own JSON/HTML report.
  // allure-playwright writes raw results to allure-results/ -- those are NOT a
  // viewable report by themselves; services/allureService.ts's generateAllureReport()
  // runs the Allure commandline (`allure generate`) against this folder to produce
  // the actual static allure-report/ site.
  reporter: [
    ["json", { outputFile: "test-results/last-run.json" }],
    ["allure-playwright", { resultsDir: "allure-results" }],
  ],
  use: {
    screenshot: screenshotSetting,
    video: videoSetting,
    trace: traceSetting,
    headless: headlessSetting,
    navigationTimeout: isFast ? 15000 : 30000,
    actionTimeout: isFast ? 10000 : 15000,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  outputDir: "test-results/artifacts",
});
