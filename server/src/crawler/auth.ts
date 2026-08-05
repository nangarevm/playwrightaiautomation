// Phase 1: session/login handling. Reuses one authenticated browser context
// across the whole crawl (login once, never per-page) -- the context object
// itself carries cookies forward for every subsequent page.navigate call.

import type { BrowserContext } from "playwright";

export interface LoginResult {
  attempted: boolean;
  succeeded: boolean;
  message: string;
}

// Best-effort generic login: find a password field anywhere on the target page,
// its associated username/email field, and the nearest submit control, fill and
// submit. This is deliberately generic (no site-specific selectors) since the
// crawler must work against an arbitrary target site.
export async function loginIfCredentialsProvided(
  context: BrowserContext,
  url: string,
  username?: string,
  password?: string
): Promise<LoginResult> {
  if (!username && !password) {
    return { attempted: false, succeeded: false, message: "No credentials supplied -- crawling anonymously." };
  }

  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });

    const passwordField = page.locator('input[type="password"]').first();
    const hasPasswordField = (await passwordField.count()) > 0;
    if (!hasPasswordField) {
      await page.close();
      return { attempted: true, succeeded: false, message: "No password field found on the target page -- proceeding without authentication." };
    }

    const usernameField = page
      .locator(
        'input[type="email"], input[type="text"][name*="user" i], input[type="text"][id*="user" i], input[name*="email" i], input[id*="email" i], input[autocomplete="username"]'
      )
      .first();

    if (username && (await usernameField.count()) > 0) {
      await usernameField.fill(username);
    }
    if (password) {
      await passwordField.fill(password);
    }

    const submitButton = page
      .locator('button[type="submit"], input[type="submit"], button:has-text("Log in"), button:has-text("Login"), button:has-text("Sign in")')
      .first();

    const navigationWait = page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => undefined);
    if ((await submitButton.count()) > 0) {
      await submitButton.click();
    } else {
      await passwordField.press("Enter");
    }
    await navigationWait;

    // Failure heuristic: password field still present and visible after
    // submit almost always means the login was rejected.
    const stillOnLoginForm = (await page.locator('input[type="password"]').count()) > 0 && (await page.locator('input[type="password"]').first().isVisible().catch(() => false));
    await page.close();

    if (stillOnLoginForm) {
      return { attempted: true, succeeded: false, message: "Login form still present after submit -- authentication likely failed (check credentials)." };
    }
    return { attempted: true, succeeded: true, message: "Authenticated session established; cookies will be reused for the rest of the crawl." };
  } catch (err: any) {
    await page.close().catch(() => undefined);
    return { attempted: true, succeeded: false, message: `Login attempt failed: ${err.message}` };
  }
}
