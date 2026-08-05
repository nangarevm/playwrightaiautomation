// One test per discovered virtual route x role (step 4 + step 7). Reads
// discovered-routes.json written by discover.setup.ts -- the "crawl" project
// declares a dependency on "discover" in playwright.config.ts so this file
// always sees a fresh file when run via `npx playwright test`.
import fs from "node:fs";
import path from "node:path";
import { test, expect } from "../fixtures.js";
import { ROLES, switchToRole } from "../auth/roles.js";
import type { DiscoveredRoute } from "./discover.setup.js";

const ROUTES_PATH = path.join(process.cwd(), "discovered-routes.json");

let routes: DiscoveredRoute[] = [];
if (fs.existsSync(ROUTES_PATH)) {
  routes = JSON.parse(fs.readFileSync(ROUTES_PATH, "utf-8"));
} else {
  console.warn(`discovered-routes.json not found at ${ROUTES_PATH} -- run the "discover" project first. Falling back to an empty route list.`);
}

// Grace period after networkidle before checking for a still-spinning
// loading indicator -- some sections legitimately show a brief spinner while
// their mount-time fetch resolves (e.g. dashboard aggregation queries), so
// checking at the instant of networkidle would false-positive on those.
const SPINNER_GRACE_MS = 1500;

for (const role of ROLES) {
  test.describe(`role: ${role.label}`, () => {
    for (const route of routes) {
      test(`route: ${route.id}`, async ({ page, issues }) => {
        await test.step(`switch to role ${role.label}`, async () => {
          await switchToRole(page, role);
        });

        await test.step(`navigate to ${route.id}`, async () => {
          await page.goto("/");
          for (const testId of route.clickPath) {
            await page.getByTestId(testId).click();
          }
          await page.waitForLoadState("networkidle");
        });

        await test.step("check for broken images", async () => {
          const brokenImages = await page.locator("img:visible").evaluateAll((imgs) =>
            (imgs as HTMLImageElement[])
              .filter((img) => img.complete && img.naturalWidth === 0)
              .map((img) => img.src)
          );
          expect(brokenImages, `broken image(s) found on ${route.id}: ${brokenImages.join(", ")}`).toEqual([]);
        });

        await test.step("check for stuck loading spinners", async () => {
          await page.waitForTimeout(SPINNER_GRACE_MS);
          const stuckSpinners = await page.locator(".animate-spin:visible").count();
          // Soft: spinner timing is a heuristic (mock-LLM/self-heal calls can
          // legitimately run long), so this reports without failing the run.
          expect.soft(stuckSpinners, `${stuckSpinners} spinner(s) still animating ${SPINNER_GRACE_MS}ms after networkidle on ${route.id}`).toBe(0);
        });

        await test.step("assert no page errors or server errors", async () => {
          const pageErrors = issues.errors().filter((i) => i.type === "pageerror");
          const serverErrors = issues.serverErrors();
          expect(pageErrors, JSON.stringify(pageErrors, null, 2)).toEqual([]);
          expect(serverErrors, JSON.stringify(serverErrors, null, 2)).toEqual([]);
        });
      });
    }
  });
}
