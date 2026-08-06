import { AutomationArtifacts, GeneratedTestCase, LlmProvider } from "./types.js";

// A deterministic "AI" stand-in so the whole pipeline is runnable/demo-able
// with zero API keys. Swap for AnthropicProvider once a key is available.
export const mockProvider: LlmProvider = {
  name: "mock",

  async generateTestCases(inputText: string): Promise<GeneratedTestCase[]> {
    const lower = inputText.toLowerCase();
    const isLogin = lower.includes("login") || lower.includes("log in") || lower.includes("sign in");

    if (isLogin) {
      return [
        {
          title: "Successful login with valid credentials",
          category: "Smoke",
          steps: [
            "Navigate to the login page",
            "Enter a valid username in the 'Username' field",
            "Enter a valid password in the 'Password' field",
            "Click the 'Log in' button",
          ],
          expected_result: "User is redirected to the dashboard and sees a welcome message",
          confidence_score: 0.93,
          source_rationale: "Derived from input sentence describing the login form and its fields",
        },
        {
          title: "Login fails with incorrect password",
          category: "Negative",
          steps: [
            "Navigate to the login page",
            "Enter a valid username in the 'Username' field",
            "Enter an incorrect password in the 'Password' field",
            "Click the 'Log in' button",
          ],
          expected_result: "An inline error message 'Invalid username or password' is displayed and the user remains on the login page",
          confidence_score: 0.88,
          source_rationale: "Standard negative counterpart inferred from presence of a credentialed login form",
        },
        {
          title: "Login blocked when required fields are empty",
          category: "Edge Case",
          steps: [
            "Navigate to the login page",
            "Leave the 'Username' and 'Password' fields empty",
            "Click the 'Log in' button",
          ],
          expected_result: "Validation errors are shown for both fields and no navigation occurs",
          confidence_score: 0.81,
          source_rationale: "Edge case generated from the required-field constraint implied by a standard login form",
        },
      ];
    }

    // Generic fallback: turn each sentence of the input into a lightweight functional test case
    const sentences = inputText
      .split(/[.\n]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 8)
      .slice(0, 3);

    if (sentences.length === 0) {
      return [
        {
          title: "Basic smoke check of described functionality",
          category: "Smoke",
          steps: ["Navigate to the target page", "Verify the page loads without errors"],
          expected_result: "Page loads successfully with no console errors",
          confidence_score: 0.6,
          source_rationale: "Input text too short to extract specific behavior; generic smoke test generated",
        },
      ];
    }

    return sentences.map((s, i) => ({
      title: `Verify that ${s.slice(0, 60).replace(/\.+$/, "")}`,
      category: i === 0 ? "Functional" : i === 1 ? "Smoke" : "Edge Case",
      steps: [
        "Navigate to the relevant page or endpoint",
        `Follow the flow described in the input: "${s}"`,
        "Observe the resulting application state",
      ],
      expected_result: `The application behaves as described: ${s}`,
      confidence_score: 0.7 - i * 0.05,
      source_rationale: `Generated directly from input sentence ${i + 1}`,
    }));
  },

  async generatePlaywrightScript(testCase, options): Promise<string> {
    const language = options?.language ?? "typescript";
    const framework = options?.framework ?? "playwright";
    const isLogin = testCase.title.toLowerCase().includes("login");

    // FR-3.5: API-category test cases (generated from Swagger/Postman input) get
    // a distinct request-based script -- Playwright's APIRequestContext hitting
    // the parsed endpoint directly -- instead of a UI browser automation script.
    if (framework === "playwright" && testCase.category === "API") {
      return buildApiTestScript(testCase, language, options?.apiSpecHint);
    }

    if (framework === "selenium") {
      return buildSeleniumScript(testCase, language);
    }

    if (framework === "cypress") {
      return buildCypressScript(testCase, language);
    }

    if (isLogin) {
      const wrongPassword = testCase.title.toLowerCase().includes("incorrect");
      const emptyFields = testCase.title.toLowerCase().includes("empty");

      if (wrongPassword) {
        return buildLoginScript(testCase.title, {
          username: "demo_user",
          password: "wrong_password",
          expectError: true,
        }, language);
      }
      if (emptyFields) {
        return buildLoginScript(testCase.title, {
          username: "",
          password: "",
          expectError: true,
        }, language);
      }
      return buildLoginScript(testCase.title, {
        username: "demo_user",
        password: "demo_pass_123",
        expectError: false,
      }, language);
    }

    // Generic fallback script
    return buildPlaywrightScript(testCase, language);
  },

  async generateAutomationArtifacts(testCase, options) {
    const artifacts: AutomationArtifacts[] = [];
    const base = {
      title: testCase.title,
      steps: testCase.steps,
      expected_result: testCase.expected_result,
      category: testCase.category,
    };

    artifacts.push({
      language: "typescript",
      framework: "playwright",
      code: await this.generatePlaywrightScript(base, { language: "typescript", framework: "playwright", apiSpecHint: options?.apiSpecHint }),
      fileName: `${slugify(testCase.title)}.spec.ts`,
    });
    artifacts.push({
      language: "javascript",
      framework: "playwright",
      code: await this.generatePlaywrightScript(base, { language: "javascript", framework: "playwright", apiSpecHint: options?.apiSpecHint }),
      fileName: `${slugify(testCase.title)}.spec.js`,
    });
    artifacts.push({
      language: "python",
      framework: "playwright",
      code: await this.generatePlaywrightScript(base, { language: "python", framework: "playwright", apiSpecHint: options?.apiSpecHint }),
      fileName: `${slugify(testCase.title)}.py`,
    });

    return artifacts;
  },
};

// FR-3.5: generates a Playwright API-request test rather than a UI browser
// script -- extracts a "METHOD /path" pair from apiSpecHint (populated from the
// parsed Swagger/Postman endpoint list, see FR-1.4/FR-1.5) when available,
// falling back to a GET against the endpoint implied by the test case title.
function buildApiTestScript(
  testCase: { title: string; steps: string[]; expected_result: string },
  language: "typescript" | "javascript" | "python",
  apiSpecHint?: string
): string {
  const match = apiSpecHint?.match(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\S+)/i);
  const method = (match?.[1] ?? "GET").toLowerCase();
  const endpointPath = match?.[2] ?? "/api/status";

  if (language === "python") {
    return `import pytest
from playwright.sync_api import APIRequestContext

# Auto-generated API test (FR-3.5) -- generated directly from the parsed Swagger/Postman input
def test_${slugify(testCase.title).replace(/-/g, "_")}(playwright):
    request_context = playwright.request.new_context(base_url="${process.env.TARGET_URL || "http://localhost:4100"}")
    response = request_context.${method}("${endpointPath}")
    assert response.ok, f"Expected a successful response from ${method.toUpperCase()} ${endpointPath}"
    request_context.dispose()
`;
  }

  // Playwright's `request` fixture only resolves a relative path against a
  // `baseURL` configured in playwright.config.ts -- this project doesn't set
  // one (targets vary per run via TARGET_URL), so `request.get('/some/path')`
  // threw "apiRequestContext.get: Invalid URL" on every single API test case,
  // before the request was even sent. Build the full absolute URL at
  // generation time instead, the same way the Python branch above already
  // does via `new_context(base_url=...)`.
  const baseUrl = (process.env.TARGET_URL || "http://localhost:4100").replace(/\/$/, "");
  const fullUrl = `${baseUrl}${endpointPath.startsWith("/") ? "" : "/"}${endpointPath}`;
  return `import { test, expect } from '@playwright/test';

// Auto-generated API test (FR-3.5) -- generated directly from the parsed Swagger/Postman
// input (FR-1.4/FR-1.5), using Playwright's request fixture rather than a browser page.
test('${testCase.title.replace(/'/g, "\\'")}', async ({ request }) => {
  const response = await request.${method}('${fullUrl.replace(/'/g, "\\'")}');
  expect(response.ok()).toBeTruthy();
});
`;
}

// FR-3.4: accessibility-first locators by default; a CSS/XPath selector only
// when a step names a target with no role/label-ish vocabulary at all, and the
// fallback is flagged in the generated code (not silently substituted).
const ROLE_HINT_PATTERN = /\b(button|link|field|input|checkbox|radio|label|heading|menu|tab|dialog|username|password|email)\b/i;

// A step's text can carry embedded newlines/tabs (most commonly a crawled
// element label that wrapped across lines in the DOM) -- interpolated raw
// into a single-line `//` comment below, that breaks the comment early and
// turns the remainder of the step into unparseable code, which is why every
// generated script sharing a step with such a label failed with the same
// "Unterminated string constant" syntax error. Collapsing whitespace here is
// a defensive backstop; locators.ts/discovery.ts also normalize at the source.
function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function resolveLocatorForStep(stepText: string, language: "typescript" | "javascript" | "python"): { code: string; usedFallback: boolean } {
  stepText = collapseWhitespace(stepText);
  const quotedTarget = stepText.match(/["']([^"']+)["']/)?.[1];
  const hasRoleHint = ROLE_HINT_PATTERN.test(stepText);

  if (hasRoleHint || !quotedTarget) {
    const code = language === "python" ? `page.get_by_text("${(quotedTarget ?? stepText).slice(0, 60)}")` : `page.getByText('${(quotedTarget ?? stepText).slice(0, 60).replace(/'/g, "\\'")}')`;
    return { code, usedFallback: false };
  }

  // No accessible role/label vocabulary in this step -- fall back to a CSS
  // selector built from the quoted target, flagged so a reviewer knows it's
  // the brittle fallback path rather than an accessibility-first locator.
  const cssGuess = `[data-testid="${quotedTarget.toLowerCase().replace(/\s+/g, "-")}"], .${quotedTarget.toLowerCase().replace(/\s+/g, "-")}`;
  const code = language === "python"
    ? `page.locator('${cssGuess}')  # FR-3.4 fallback: no accessible role/label found for "${quotedTarget}", using a CSS selector`
    : `page.locator('${cssGuess}') /* FR-3.4 fallback: no accessible role/label found for "${quotedTarget}", using a CSS selector */`;
  return { code, usedFallback: true };
}

// Generic (non-login) fallback: previously this always appended a hardcoded
// LoginPage.login() call and asserted a 'Welcome' heading regardless of what
// the test case actually describes. That's correct ONLY for a login scenario;
// for any other scenario (e.g. "verify <page> loads successfully", crawled
// against a real site with no login form at all) it made every single
// generated script fail identically: getByLabel('Username') never resolves
// on a page with no username field, so the run hangs until Playwright's
// 15s timeout. The generic script now only navigates and asserts the page
// itself loaded -- matching what a "page loads / renders" test case actually
// needs -- and otherwise just exercises the per-step locators (FR-3.4).
function buildPlaywrightScript(testCase: { title: string; steps: string[]; expected_result: string }, language: "typescript" | "javascript" | "python") {
  if (language === "python") {
    return `from playwright.sync_api import sync_playwright

# Auto-generated by AI Test Automation Platform (mock provider)
# Generic page-load check -- no login flow assumed unless the test case is
# specifically about logging in (see the dedicated login script path).
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.goto("${process.env.TARGET_URL || "http://localhost:4100/demo/login.html"}", wait_until="load")
    page.wait_for_load_state("domcontentloaded")
    assert page.title() != "", "Expected the page to load with a non-empty title"
    browser.close()
`;
  }

  // FR-3.4: resolve a locator per step -- role/label-first, CSS/XPath fallback
  // (flagged in a comment) only when a step names a target with no accessible
  // vocabulary at all.
  const stepLocators = testCase.steps.map((step) => resolveLocatorForStep(step, "typescript"));

  const importLine = language === "javascript" ? "import { test, expect } from '@playwright/test';" : "import { test, expect } from '@playwright/test';";
  return `${importLine}

// Auto-generated by AI Test Automation Platform (mock provider)
// Generic page-load check -- no login flow assumed unless the test case is
// specifically about logging in (see the dedicated login script path).
// FR-3.4: accessibility-first locators (CSS/XPath fallback flagged in a
// comment where no accessible locator could be found)
test('${testCase.title.replace(/'/g, "\\'")}', async ({ page }) => {
  await page.goto(process.env.TARGET_URL || 'http://localhost:4100/demo/login.html');
  // Per-step locators derived from the test case's steps (FR-3.4):
${stepLocators.map((l, i) => `  // Step ${i + 1}: ${collapseWhitespace(testCase.steps[i])}\n  void ${l.code};`).join("\n")}
  await page.waitForLoadState('domcontentloaded');
  await expect(page).toHaveTitle(/.+/);
});
`;
}

function buildSeleniumScript(testCase: { title: string; steps: string[]; expected_result: string }, language: "typescript" | "javascript" | "python") {
  if (language === "python") {
    return `from selenium import webdriver
from selenium.webdriver.common.by import By

# Auto-generated scaffold for Selenium export (FR-3.2)

driver = webdriver.Chrome()
driver.get("http://localhost:4100/demo/login.html")
driver.find_element(By.ID, "username").send_keys("demo")
driver.find_element(By.ID, "password").send_keys("demo")
driver.quit()
`;
  }

  return `// Auto-generated Selenium scaffold (FR-3.2)
// ${testCase.title}
`;
}

function buildCypressScript(testCase: { title: string; steps: string[]; expected_result: string }, language: "typescript" | "javascript" | "python") {
  return `// Auto-generated Cypress scaffold (FR-3.2)
// ${testCase.title}
describe('${testCase.title.replace(/'/g, "\\'")}', () => {
  it('passes', () => {
    cy.visit('/demo/login.html');
    cy.contains('Log in').click();
  });
});
`;
}

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function buildLoginScript(
  title: string,
  opts: { username: string; password: string; expectError: boolean },
  language: "typescript" | "javascript" | "python" = "typescript"
): string {
  // FR-3.1: this dedicated login-script path previously ignored `language` entirely
  // and always returned TypeScript, even when Python (or plain JS) was requested --
  // branch on language here the same way buildPlaywrightScript() does.
  if (language === "python") {
    const assertion = opts.expectError
      ? `page.get_by_role("alert").wait_for()`
      : `page.get_by_role("heading", name="Welcome").wait_for()`;
    return `from playwright.sync_api import sync_playwright

# Auto-generated by AI Test Automation Platform (mock provider)
# Uses accessibility-first (role/label) locators per FR-3.4, structured as a lightweight Page Object (FR-3.3)
class LoginPage:
    def __init__(self, page):
        self.page = page

    def goto(self):
        self.page.goto("${process.env.TARGET_URL || "http://localhost:4100/demo/login.html"}")

    def login(self, username, password):
        self.page.get_by_label("Username").fill(username)
        self.page.get_by_label("Password").fill(password)
        self.page.get_by_role("button", name="Log in").click()


def test_${slugify(title).replace(/-/g, "_")}():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        login_page = LoginPage(page)
        login_page.goto()
        login_page.login("${opts.username}", "${opts.password}")
        ${assertion}
        browser.close()
`;
  }

  const typeAnnotation = language === "javascript" ? "" : ": import('@playwright/test').Page";
  const paramTypes = language === "javascript" ? "" : ": string";
  // TypeScript's `constructor(private page: Foo) {}` parameter-property shorthand
  // is NOT valid JavaScript syntax -- `private` is a reserved word there. Emitting
  // it unconditionally meant every generated .spec.js login script failed to even
  // parse (SyntaxError: Unexpected reserved word 'private'), so Playwright never
  // ran a single test in that file and no Allure result was ever written for it --
  // surfacing downstream as "run failed instantly" with nothing to report on.
  const constructorLine = language === "javascript"
    ? `constructor(page) {\n    this.page = page;\n  }`
    : `constructor(private page${typeAnnotation}) {}`;
  return `import { test, expect } from '@playwright/test';

// Auto-generated by AI Test Automation Platform (mock provider)
// Uses accessibility-first (role/label) locators per FR-3.4, structured as a lightweight Page Object (FR-3.3)
class LoginPage {
  ${constructorLine}

  async goto() {
    await this.page.goto(process.env.TARGET_URL || 'http://localhost:4100/demo/login.html');
  }

  async login(username${paramTypes}, password${paramTypes}) {
    await this.page.getByLabel('Username').fill(username);
    await this.page.getByLabel('Password').fill(password);
    await this.page.getByRole('button', { name: 'Log in' }).click();
  }
}

test('${title.replace(/'/g, "\\'")}', async ({ page }) => {
  const loginPage = new LoginPage(page);
  await loginPage.goto();
  await loginPage.login('${opts.username}', '${opts.password}');

  ${
    opts.expectError
      ? `await expect(page.getByRole('alert')).toBeVisible();`
      : `await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();`
  }
});
`;
}
