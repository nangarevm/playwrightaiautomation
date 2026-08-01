import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./generated",
  timeout: 15000,
  retries: 0,
  reporter: [["json", { outputFile: "test-results/last-run.json" }]],
  use: {
    screenshot: "only-on-failure",
    trace: "off",
    headless: true,
  },
  outputDir: "test-results/artifacts",
});
