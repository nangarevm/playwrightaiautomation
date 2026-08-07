// Route-discovery setup (step 3). ASSUMPTION (flagged): the target app
// (client/src/App.tsx) has no client-side router at all -- there is exactly
// one URL, and navigation is pure React state via Sidebar (client/src/components/Sidebar.tsx,
// keys home/run/library/reports/settings) and, within some sections, a
// TabBar (client/src/components/TabBar.tsx). "Same-origin link following"
// therefore has nothing to follow -- there is one <a href> graph node. This
// script adapts the spirit of route discovery to this app's real navigation
// model: it BFS-walks the Sidebar (depth 1) and, for whichever section has a
// visible TabBar, its tabs (depth 2), and records each reachable
// nav+tab combination as a "virtual route" -- the closest honest equivalent
// of discovered-routes.json for a router-less SPA.
//
// Depth is capped at 2 because that's the actual max nesting depth in this
// app today (verified by reading every page under client/src/pages/) --
// this is not an arbitrary crawl-depth limit that would silently truncate a
// deeper site.
import { test } from "../fixtures.js";
import fs from "node:fs";
import path from "node:path";

export interface DiscoveredRoute {
  id: string; // e.g. "library/scripts" -- used as the Playwright test title
  clickPath: string[]; // data-testid values to click in order, from a fresh "/" load
}

const OUTPUT_PATH = path.join(process.cwd(), "discovered-routes.json");

test("discover virtual routes", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  const navTestIds = await page.locator('[data-testid^="nav-"]').evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")!));

  const routes: DiscoveredRoute[] = [];

  for (const navTestId of navTestIds) {
    await page.goto("/");
    await page.getByTestId(navTestId).first().click();
    await page.waitForLoadState("networkidle");

    // Only tabs currently visible belong to this section -- previously
    // visited sections stay mounted (display:none) per App.tsx's lazy-tab
    // design, so an unscoped query would leak sibling sections' tabs in.
    const tabTestIds = await page
      .locator('[data-testid^="tab-"]:visible')
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")!));

    if (tabTestIds.length === 0) {
      routes.push({ id: navTestId.replace("nav-", ""), clickPath: [navTestId] });
      continue;
    }

    for (const tabTestId of tabTestIds) {
      routes.push({
        id: `${navTestId.replace("nav-", "")}/${tabTestId.replace("tab-", "")}`,
        clickPath: [navTestId, tabTestId],
      });
    }
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(routes, null, 2));
  console.log(`Discovered ${routes.length} virtual route(s), written to ${OUTPUT_PATH}`);
});
