// ASSUMPTION (flagged): this target app has no real login system. RBAC is a
// dev-only stand-in (server/src/services/adminService.ts's attachUser) that
// resolves an X-User-Id header set by the *client's own JS state* -- there is
// no cookie/session/localStorage-backed auth, so a literal Playwright
// storageState file (which restores cookies + localStorage) cannot represent
// "logged in as X" here: currentUserId lives in an in-memory JS module
// variable that always resets to "user-qa-lead" on page load.
//
// The only way to actually change identity is to drive the real UI the app
// ships: Settings -> Team -> switch to Enterprise mode -> pick a user from
// the dropdown (client/src/pages/SettingsHub.tsx). switchToRole() below does
// exactly that, so the app's own fetch calls end up sending the real
// X-User-Id header for the chosen role -- this is the closest honest
// equivalent of "auth state" for this app, standing in for step 7's
// storageState files.
//
// Seeded users (server/src/db.ts) and how they map onto the requested
// logged-out/standard-user/admin trio:
//   - "default"  -> logged-out equivalent: never switch away from the app's
//                   own default identity (server treats a missing/unrecognized
//                   header as a permissive Tester identity).
//   - "user-tester"  -> standard user (Tester role).
//   - "user-qa-lead" -> admin equivalent (QA Lead: the only role most
//                   mutation endpoints require, per requireRole("QA Lead")
//                   guards across server/src/routes/*.ts).
// "user-manager" is also seeded and is read-only platform-wide
// (enforceReadOnlyRoles blocks all mutations for it) -- included here in case
// you want a 4th describe block for read-only-role coverage.
import type { Page } from "@playwright/test";

export interface Role {
  id: string;
  label: string;
  userId: string | null; // null = don't switch; use the app's own default identity
}

export const ROLES: Role[] = [
  { id: "default", label: "Default (logged-out equivalent)", userId: null },
  { id: "standard-user", label: "Standard user (Tester)", userId: "user-tester" },
  { id: "admin", label: "Admin (QA Lead)", userId: "user-qa-lead" },
];

export async function switchToRole(page: Page, role: Role): Promise<void> {
  if (role.userId === null) return; // already the default identity on a fresh page load

  await page.goto("/");
  await page.getByTestId("nav-settings").first().click();
  await page.getByTestId("tab-team").first().click();
  await page.getByTestId("mode-enterprise").first().click();
  await page.getByTestId("user-switcher").selectOption(role.userId);
}
