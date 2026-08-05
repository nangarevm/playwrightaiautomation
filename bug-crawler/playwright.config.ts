import { defineConfig, devices } from "@playwright/test";

// Isolated Playwright project (step 1/6). Deliberately NOT the same config as
// ../server/playwright.config.ts -- that file is load-bearing for the
// platform's own execution engine (Module 4: executionService.ts spawns
// `npx playwright test` against it with env-var-driven artifact/concurrency
// settings the rest of the app depends on). Overwriting it with this
// project's retries/reporters/projects would break AI-generated test
// execution across the whole platform, so this crawler gets its own
// completely separate config, package.json, and node_modules instead.
//
// ASSUMPTION (flagged): baseURL points at the client Vite dev server, which
// must already be running (npm run dev:client in ../client) before this
// project's UI tests (discover/crawl) run -- there is no webServer block
// starting it automatically, since the platform's dev workflow already runs
// server+client in two terminals (see ../README.md) and duplicating that
// here risked port conflicts with an already-running instance.
const BASE_URL = process.env.CRAWL_BASE_URL ?? "http://localhost:5173";

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  retries: 2,
  reporter: [
    ["html", { outputFolder: "playwright-report", open: "never" }],
    ["json", { outputFile: "test-results/results.json" }],
    ["list"],
  ],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "discover",
      testMatch: /.*\.setup\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "crawl",
      testMatch: /crawl\.spec\.ts/,
      dependencies: ["discover"],
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "api-fuzz",
      testMatch: /api-fuzz\.spec\.ts/,
      use: {},
    },
  ],
  outputDir: "test-results/artifacts",
});
