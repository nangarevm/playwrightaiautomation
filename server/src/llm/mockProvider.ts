import { AutomationArtifacts, GeneratedTestCase, LlmProvider } from "./types.js";
import {
  normalizeLocatorExpression,
  scoreStableLocator,
  stripTransientLoadingLabel,
  stableRoleNameExpr,
} from "../crawler/locatorQuality.js";

// A deterministic "AI" stand-in so the whole pipeline is runnable/demo-able
// with zero API keys. Swap for AnthropicProvider once a key is available.
export const mockProvider: LlmProvider = {
  name: "mock",

  async generateTestCases(inputText: string, _options?: { tier?: "primary" | "economy" }): Promise<GeneratedTestCase[]> {
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
    const crawlMeta = extractCrawlMeta(options?.apiSpecHint);
    const isLogin = isLoginFlowTest(testCase);

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

    // Crawler-discovered scenarios: use the real page URL and locators captured during crawl.
    if (crawlMeta.url || crawlMeta.locators.length > 0) {
      return buildCrawledPlaywrightScript(testCase, language, crawlMeta);
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
  const fallbackBase = (process.env.TARGET_URL || "http://localhost:4100").replace(/\/$/, "");
  const safePath = endpointPath.replace(/'/g, "\\'");

  if (language === "python") {
    return `import os
import pytest
from playwright.sync_api import APIRequestContext

# Auto-generated API test (FR-3.5) -- generated directly from the parsed Swagger/Postman input
def test_${slugify(testCase.title).replace(/-/g, "_")}(playwright):
    base_url = os.environ.get("TARGET_URL", "${fallbackBase.replace(/"/g, '\\"')}").rstrip("/")
    request_context = playwright.request.new_context(base_url=base_url)
    response = request_context.${method}("${safePath}")
    assert response.ok, f"Expected a successful response from ${method.toUpperCase()} ${safePath}"
    request_context.dispose()
`;
  }

  // Resolve TARGET_URL at execution time (set by executionService) so Generate+Run
  // against a crawled site does not bake localhost into the script at codegen time.
  return `import { test, expect } from '@playwright/test';

// Auto-generated API test (FR-3.5) -- generated directly from the parsed Swagger/Postman
// input (FR-1.4/FR-1.5), using Playwright's request fixture rather than a browser page.
test('${testCase.title.replace(/'/g, "\\'")}', async ({ request }) => {
  const base = (process.env.TARGET_URL || '${fallbackBase.replace(/'/g, "\\'")}').replace(/\\/$/, '');
  const response = await request.${method}(\`\${base}${safePath.startsWith("/") ? "" : "/"}${safePath}\`);
  const status = response.status();
  expect(status, \`Expected 2xx from ${method.toUpperCase()} ${safePath}, got \${status}\`).toBeGreaterThanOrEqual(200);
  expect(status).toBeLessThan(300);
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

/** Page titles like "Login Portal" are not login-form tests unless steps mention credentials. */
function isLoginFlowTest(testCase: { title: string; steps: string[] }): boolean {
  const stepsText = testCase.steps.join(" ").toLowerCase();
  const title = testCase.title.toLowerCase();
  if (/username|password|log in|sign in|credentials/.test(stepsText)) return true;
  if (/\b(login fails|log in with|sign in with|incorrect password|empty.*field|valid credentials)\b/.test(title)) return true;
  return false;
}

function extractCrawlMeta(hint?: string): { url?: string; locators: string[] } {
  if (!hint) return { locators: [] };
  const url =
    hint.match(/CRAWL_URL=(\S+)/)?.[1] ??
    hint.match(/Discovered by the AI crawler on (https?:\/\/\S+)/)?.[1]?.replace(/\.$/, "");
  const locMatch = hint.match(/LOCATORS=(\[[\s\S]*?\])(?:\s|$)/);
  let locators: string[] = [];
  if (locMatch) {
    try {
      locators = JSON.parse(locMatch[1]);
    } catch {
      locators = [];
    }
  }
  return { url, locators: Array.isArray(locators) ? locators : [] };
}

/**
 * Build a Playwright script from crawl locators without calling an LLM.
 * Used by codegen when CRAWL_TEMPLATE_FIRST is enabled (default) to save tokens.
 */
export function tryBuildCrawledScriptWithoutLlm(
  testCase: { title: string; steps: string[]; expected_result: string; category?: string },
  language: "typescript" | "javascript" | "python",
  hint?: string
): string | null {
  if (testCase.category === "API") return null;
  const crawlMeta = extractCrawlMeta(hint);
  if (!crawlMeta.url && crawlMeta.locators.length === 0) return null;
  return buildCrawledPlaywrightScript(testCase, language, crawlMeta);
}

function resolveTargetUrl(crawlUrl?: string): string {
  return crawlUrl || process.env.TARGET_URL || "http://localhost:4100/demo/login.html";
}

function escapeForTsString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/** Build a script from crawler-captured URL + Playwright locator expressions. */
function buildCrawledPlaywrightScript(
  testCase: { title: string; steps: string[]; expected_result: string },
  language: "typescript" | "javascript" | "python",
  crawlMeta: { url?: string; locators: string[] }
): string {
  const fallbackUrl = resolveTargetUrl(crawlMeta.url);
  const title = escapeForTsString(testCase.title);
  const isFlow = /end-to-end flow/i.test(testCase.title);
  const isSearchScenario =
    /\bsite search\b/i.test(testCase.title) ||
    (/\bsearch\b/i.test(testCase.title) && !/end-to-end flow/i.test(testCase.title)) ||
    testCase.steps.some((s) =>
      /\b(search term|fills? in "[^"]*search|submits? the search|presses Enter to submit the search)\b/i.test(s)
    );
  const gotoExprTs = `process.env.TARGET_URL || '${escapeForTsString(fallbackUrl)}'`;
  const gotoExprPy = `os.environ.get("TARGET_URL", "${escapeForTsString(fallbackUrl)}")`;

  const locators = normalizeCrawlLocators(
    (crawlMeta.locators || [])
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => (l.startsWith("page.") ? l : `page.${l}`))
  );

  const navHopCount = testCase.steps.filter((s) =>
    /\bnavigates?\s+to\b|\bto\s+reach\b|clicks?\s+.+\s+to\s+reach/i.test(s)
  ).length;
  // Multi-hop flows need headroom beyond the suite's fast 25s default.
  const flowTimeoutMs = isFlow
    ? Math.max(90_000, (navHopCount + 1) * 25_000)
    : navHopCount >= 2
      ? Math.max(60_000, (navHopCount + 1) * 20_000)
      : 0;

  const stepLines: string[] = [];
  const used = new Set<number>();
  let lastClickLocator: string | null = null;
  let openedSearchUi = false;

  const ensureSearchUiOpen = () => {
    if (openedSearchUi || !isSearchScenario) return;
    openedSearchUi = true;
    stepLines.push(`  // Open collapsed search UI when present`);
    stepLines.push(
      `  await page.getByRole('button', { name: /toggle search|open search|show search/i }).first().click({ timeout: 5000 }).catch(() => {});`
    );
    stepLines.push(
      `  await page.locator('input[type="search"], input[name="query"]').first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});`
    );
  };

  for (const step of testCase.steps) {
    const stepLower = step.toLowerCase();
    const collapsed = collapseWhitespace(step);

    // Setup / assertion narrative — keep as comments
    if (/^\s*(given|then)\b/i.test(step) || (/navigat/.test(stepLower) && /\bgiven\b/.test(stepLower))) {
      stepLines.push(`  // ${collapsed}`);
      continue;
    }

    // Explicit URL navigation (used for multi-page flow hops)
    // Also accept malformed "navigates to reach <url>" leftovers.
    const navUrl =
      step.match(/\bnavigates?\s+to\s+["']((?:https?:\/\/|\/)[^"']+)["']/i)?.[1] ||
      step.match(/\bnavigates?\s+to\s+reach\s+["']((?:https?:\/\/|\/)[^"']+)["']/i)?.[1];
    if (navUrl) {
      if (/cdn-cgi/i.test(navUrl)) {
        stepLines.push(`  // ${collapsed} — skipped CDN/challenge URL`);
        continue;
      }
      stepLines.push(`  // ${collapsed}`);
      stepLines.push(`  await page.goto(${JSON.stringify(navUrl)}, { waitUntil: 'domcontentloaded', timeout: 45000 });`);
      stepLines.push(`  await page.waitForLoadState('domcontentloaded');`);
      lastClickLocator = null;
      continue;
    }

    // "navigates to reach <page title>" — no URL yet; skip rather than invent a brittle click
    if (/\bnavigates?\s+to\s+reach\b/i.test(step)) {
      stepLines.push(`  // ${collapsed} — skipped unresolved title hop`);
      continue;
    }

    // Legacy "clicks X to reach Y" flow hops: when Y is a URL, always navigate
    // directly — never click brittle marketing/card link names. Same-page hops
    // (non-URL target) still use a robust force click.
    const clickToReach =
      step.match(
        /\bclicks?\s+(?:"([^"]+)"|'([^']+)'|(.+?))\s+to\s+reach\s+(?:"([^"]+)"|'([^']+)'|(\S.+))\s*$/i
      ) ||
      step.match(
        /\bclicks?\s+(?:"([^"]+)"|'([^']+)'|(.+?))\s+(?:to\s+(?:go\s+to|open)|→|->)\s+(?:"([^"]+)"|'([^']+)'|(\S.+))\s*$/i
      );
    if (clickToReach) {
      stepLines.push(`  // ${collapsed}`);
      const label = (clickToReach[1] || clickToReach[2] || clickToReach[3] || "").trim();
      const target = (clickToReach[4] || clickToReach[5] || clickToReach[6] || "")
        .trim()
        .replace(/[."']+$/, "");
      const targetLooksLikeUrl =
        /^https?:\/\//i.test(target) ||
        (/^\//.test(target) && target.length > 1) ||
        looksLikeUrlName(target);

      if (targetLooksLikeUrl) {
        if (/cdn-cgi/i.test(target)) {
          stepLines.push(`  // Skipped CDN/challenge hop → ${target}`);
        } else {
          const abs =
            /^https?:\/\//i.test(target) || target.startsWith("/")
              ? target
              : `https://${target.replace(/^\/\//, "")}`;
          stepLines.push(
            `  await page.goto(${JSON.stringify(abs)}, { waitUntil: 'domcontentloaded', timeout: 45000 });`
          );
          stepLines.push(`  await page.waitForLoadState('domcontentloaded');`);
        }
        lastClickLocator = null;
      } else {
        const clickLocator = emitRobustClickLocator(label, locators, used);
        if (clickLocator) {
          stepLines.push(...emitRobustClickLines(clickLocator));
          lastClickLocator = withFirst(clickLocator);
        } else {
          stepLines.push(`  // Skipped fragile hop "${label}" — no stable locator; flow continues`);
        }
      }
      continue;
    }

    const quoted = step.match(/["']([^"']+)["']/)?.[1];
    const locator = resolveCrawlLocatorForStep(step, locators, used);

    if (/\bfills?\s+in\b|\benters?\b|\btypes?\b|\bpastes?\b|\battach(?:es)?\b/.test(stepLower)) {
      stepLines.push(`  // ${collapsed}`);
      ensureSearchUiOpen();
      if (locator) {
        const value = inferFillValue(stepLower, quoted);
        // Prefer fill directly — scrollIntoView times out on hidden/collapsed controls.
        stepLines.push(`  await ${withFirst(locator)}.fill(${JSON.stringify(value)}, { timeout: 10000 });`);
        lastClickLocator = null;
      }
      continue;
    }

    if (/\bchecks?\b|\bticks?\b/.test(stepLower)) {
      stepLines.push(`  // ${collapsed}`);
      if (locator) {
        stepLines.push(`  await ${withFirst(locator)}.check({ force: true, timeout: 10000 });`);
        lastClickLocator = null;
      }
      continue;
    }

    if (/\bselects?\b/.test(stepLower) && !/\bsubmits?\b/.test(stepLower)) {
      stepLines.push(`  // ${collapsed}`);
      if (locator) {
        stepLines.push(`  await ${withFirst(locator)}.selectOption({ index: 1 });`);
        lastClickLocator = null;
      }
      continue;
    }

    if (/\bpress(?:es)?\s+enter\b|\bkeyboard\b/.test(stepLower)) {
      stepLines.push(`  // ${collapsed}`);
      stepLines.push(`  await page.keyboard.press('Enter');`);
      stepLines.push(`  await page.waitForLoadState('domcontentloaded');`);
      lastClickLocator = null;
      continue;
    }

    if (/\bclicks?\b|\bsubmits?\b|\btoggles?\b|\bpress(?:es)?\b/.test(stepLower)) {
      stepLines.push(`  // ${collapsed}`);
      ensureSearchUiOpen();

      // Empty-submit / generic submit: prefer a real Search/Submit control, else Enter.
      const isGenericSubmit = /\bsubmits?\b/.test(stepLower) && !quoted;
      let clickLocator =
        isGenericSubmit || /\bsubmits?\b/.test(stepLower)
          ? pickSubmitLocator(locators, used) || (quoted ? locator : null)
          : locator || pickSubmitLocator(locators, used);

      if (clickLocator && isFilterChipLocator(clickLocator)) {
        clickLocator = pickSubmitLocator(locators, used);
      }

      // Synthesize a role click from the quoted label when crawl locators omitted it
      if (!clickLocator && quoted && !isFilterChipLocator(`name: "${quoted}"`) && !looksLikeUrlName(quoted)) {
        clickLocator = emitRobustClickLocator(quoted, locators, used);
      }

      if (clickLocator) {
        const normalized = withFirst(clickLocator);
        if (lastClickLocator === normalized) {
          continue;
        }
        stepLines.push(...emitRobustClickLines(clickLocator));
        lastClickLocator = normalized;
      } else if (isGenericSubmit || isSearchScenario) {
        stepLines.push(`  await page.keyboard.press('Enter');`);
        stepLines.push(`  await page.waitForLoadState('domcontentloaded');`);
        lastClickLocator = null;
      }
      continue;
    }

    // Leaves empty / blank — no interaction
    if (/\bleaves?\b|doesn't|does not|without entering|\bblank\b|\bempty\b/.test(stepLower)) {
      stepLines.push(`  // ${collapsed}`);
      continue;
    }

    stepLines.push(`  // ${collapsed}`);
  }

  if (language === "python") {
    return `import os
from playwright.sync_api import sync_playwright, expect

# Auto-generated from crawler-discovered scenario (mock provider)
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.goto(${gotoExprPy}, wait_until="domcontentloaded", timeout=45000)
    page.wait_for_load_state("domcontentloaded")
    expect(page).to_have_title(/.+/)
    browser.close()
`;
  }

  const flowAssertion = isFlow
    ? `  await expect(page.locator('body')).toBeVisible();\n  await expect(page).toHaveTitle(/.+/);`
    : `  await expect(page).toHaveTitle(/.+/);\n  await expect(page.locator('body')).toBeVisible();`;

  return `import { test, expect } from '@playwright/test';

// Auto-generated from crawler-discovered scenario (mock provider)
test('${title}', async ({ page }) => {
${flowTimeoutMs ? `  test.setTimeout(${flowTimeoutMs});\n` : ""}  await page.goto(${gotoExprTs}, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForLoadState('domcontentloaded');
  await page.locator('[aria-busy="true"], [role="progressbar"], .spinner, .loader, .loading').first().waitFor({ state: 'hidden', timeout: 8000 }).catch(() => {});
${stepLines.length ? stepLines.join("\n") + "\n" : ""}${flowAssertion}
});
`;
}

function normalizeCrawlLocators(locators: string[]): string[] {
  return locators
    .map((l) => {
      // Prefer label/CSS for search fields — role mapping differs across engines and
      // "Search term" is often only exposed via <label for=...>, not as searchbox name.
      if (/Search term/i.test(l) || (/[Ss]earch/.test(l) && /textbox|searchbox/.test(l))) {
        return `page.getByLabel(${JSON.stringify("Search term")}).or(page.locator('input[type="search"], input[name="query"]'))`;
      }
      let next = l.replace(
        /getByRole\(\s*(['"])textbox\1\s*,\s*\{\s*name:\s*(['"])([^'"]*[Ss]earch[^'"]*)\2/g,
        'getByRole("searchbox", { name: "$3"'
      );
      next = next.replace(
        /getByRole\(\s*(['"])textbox\1\s*,\s*\{\s*name:\s*(['"])Search term\2/g,
        'getByRole("searchbox", { name: "Search term"'
      );
      // Never bake transient loading labels into button/link locators.
      next = normalizeLocatorExpression(next);
      return next;
    })
    .sort((a, b) => scoreStableLocator(b) - scoreStableLocator(a));
}

function isFilterChipLocator(locator: string): boolean {
  const label = locatorLabel(locator) || "";
  // Only treat short facet names as non-submit when they are buttons.
  if (!/button|getByRole\(\s*["']button["']/i.test(locator) && !/^name:\s*/.test(locator)) {
    // synthetic "name: \"X\"" checks from click synthesis still need chip detection
    if (!/^name:\s*/.test(locator)) return false;
  }
  return /^(all|none|images?|videos?|audio|filter|filters|sort|close|more|\d+)$/i.test(label.trim());
}

function withFirst(locator: string): string {
  if (/\.first\s*\(/.test(locator)) return locator;
  return `${locator}.first()`;
}

/** Prefer short, stable accessible-name matching; avoid exact matches on card blurbs. */
function emitRobustClickLocator(label: string, locators: string[], used: Set<number>): string | null {
  const cleaned = collapseWhitespace(label);
  if (!cleaned || looksLikeUrlName(cleaned) || isFragileClickLabel(cleaned)) return null;

  // Prefer an existing crawl locator whose label matches
  const want = cleaned.toLowerCase();
  const fromInventory = locators.findIndex((l, i) => {
    if (used.has(i)) return false;
    const locLabel = (locatorLabel(l) || "").toLowerCase();
    return locLabel === want || locLabel.startsWith(want.slice(0, 24));
  });
  if (fromInventory >= 0) {
    used.add(fromInventory);
    return locators[fromInventory];
  }

  // Long marketing/card titles are unstable — match by prefix regex instead of exact name
  if (cleaned.length > 36) {
    const prefix = cleaned.slice(0, 28).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return `page.getByRole('link', { name: /${prefix}/i })`;
  }

  return `page.getByRole('link', { name: ${JSON.stringify(cleaned)} })`;
}

function isFragileClickLabel(label: string): boolean {
  const v = label.trim();
  if (v.length < 2) return true;
  if (/cdn-cgi|^#|^(https?:\/\/|www\.)/i.test(v)) return true;
  // Extremely long truncated card blurbs almost always animate / truncate in DOM
  if (v.length > 90) return true;
  return false;
}

function emitRobustClickLines(locator: string): string[] {
  const normalized = withFirst(locator);
  return [
    // force:true tolerates CSS transitions / carousels that never report "stable"
    `  await ${normalized}.click({ timeout: 8000, force: true });`,
    `  await page.waitForLoadState('domcontentloaded');`,
  ];
}

function looksLikeUrlName(value: string): boolean {
  return /^(https?:\/\/|www\.|\/[\w.-]+)/i.test(value.trim());
}

function locatorLabel(locator: string): string | null {
  const m =
    locator.match(/name:\s*["']([^"']+)["']/) ||
    locator.match(/getBy(?:Text|Label|Placeholder|TestId)\(\s*["']([^"']+)["']/) ||
    locator.match(/locator\(\s*["']#([^"']+)["']/) ||
    locator.match(/name=["']([^"']+)["']/);
  return m?.[1] || null;
}

function resolveCrawlLocatorForStep(step: string, locators: string[], used: Set<number>): string | null {
  const quoted = step.match(/["']([^"']+)["']/)?.[1];
  const wantsClick = /\bclicks?\b|\bsubmits?\b|\btoggles?\b|\bpress(?:es)?\b/.test(step.toLowerCase());
  const wantsFill = /\bfills?\s+in\b|\benters?\b|\btypes?\b|\bpastes?\b|\battach(?:es)?\b/.test(step.toLowerCase());
  if (quoted) {
    const want = stripTransientLoadingLabel(quoted).toLowerCase() || quoted.toLowerCase();
    const ranked = locators
      .map((l, i) => {
        const label = stripTransientLoadingLabel(locatorLabel(l) || "").toLowerCase();
        let score = -1;
        if (label === want) score = 100;
        else if (label.startsWith(want + " ") || label.endsWith(" " + want)) score = 60;
        else if (want.length >= 4 && label.includes(want)) score = 40;
        else if (want.length >= 4 && want.includes(label) && label.length >= 3) score = 30;
        if (score < 0) return null;
        // Prefer a11y locators over raw #id for fills/clicks.
        score += Math.min(20, Math.max(0, scoreStableLocator(l) / 5));
        if (wantsClick) {
          if (/getByRole\(\s*["']button["']|type=["']submit["']/i.test(l)) score += 50;
          if (/getByRole\(\s*["'](textbox|searchbox)["']/i.test(l)) score -= 40;
        }
        if (wantsFill) {
          if (/getByLabel|getByPlaceholder|getByRole\(\s*["'](textbox|searchbox)["']/i.test(l)) score += 35;
          if (/locator\(["']#/.test(l)) score -= 25;
        }
        if (used.has(i) && label !== want) score -= 20;
        return { l, i, score };
      })
      .filter(Boolean) as Array<{ l: string; i: number; score: number }>;
    ranked.sort((a, b) => b.score - a.score);
    if (ranked[0] && ranked[0].score >= 40) {
      used.add(ranked[0].i);
      // If the best match is still a brittle #id for a fill, synthesize label/role.
      if (wantsFill && /locator\(["']#/.test(ranked[0].l)) {
        const idle = stripTransientLoadingLabel(quoted);
        return `page.getByLabel(${JSON.stringify(idle)}).or(page.getByRole('textbox', { name: ${JSON.stringify(idle)} }))`;
      }
      return normalizeLocatorExpression(ranked[0].l);
    }
    // No inventory match: for fills, still prefer label/role over inventing CSS.
    if (wantsFill) {
      const idle = stripTransientLoadingLabel(quoted);
      if (idle) {
        return `page.getByLabel(${JSON.stringify(idle)}).or(page.getByRole('textbox', { name: ${JSON.stringify(idle)} }))`;
      }
    }
    if (wantsClick) {
      const idle = stripTransientLoadingLabel(quoted);
      const stable = stableRoleNameExpr(quoted);
      if (stable) {
        return `page.getByRole('button', { name: /${stable.regexSource}/i })`;
      }
      if (idle) {
        return `page.getByRole('button', { name: ${JSON.stringify(idle)} })`;
      }
    }
  }
  // Fall back only for quoted targets that soft-failed ranking. Do NOT claim a
  // random unused locator for narrative steps like "submits the form without
  // entering any values" — that stole the submit button before pickSubmitLocator ran.
  if (!quoted) return null;
  const rankedFallback = locators
    .map((l, i) => ({ l, i, score: scoreStableLocator(l) }))
    .filter(({ l, i }) => {
      if (used.has(i)) return false;
      const label = locatorLabel(l) || "";
      return !looksLikeUrlName(label) && !isFilterChipLocator(l);
    })
    .sort((a, b) => b.score - a.score);
  if (rankedFallback[0]) {
    used.add(rankedFallback[0].i);
    return normalizeLocatorExpression(rankedFallback[0].l);
  }
  return null;
}

function pickSubmitLocator(locators: string[], used: Set<number>): string | null {
  const scored = locators
    .map((l, i) => ({ l, i }))
    .filter(({ l, i }) => !used.has(i) && !isFilterChipLocator(l))
    .map(({ l, i }) => {
      let score = scoreStableLocator(l);
      if (/type=["']submit["']/i.test(l)) score += 50;
      if (/getByRole\(\s*["']button["']/i.test(l)) score += 20;
      const label = stripTransientLoadingLabel(locatorLabel(l) || "");
      if (/\b(search|submit|go|find|send|save|login|sign|subscribe)\b/i.test(label)) score += 40;
      if (/button|submit/i.test(l)) score += 5;
      return { l: normalizeLocatorExpression(l), i, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored[0]) {
    used.add(scored[0].i);
    return scored[0].l;
  }
  return null;
}

function inferFillValue(stepLower: string, quoted?: string): string {
  if (/invalid email|bad email|malformed/.test(stepLower)) return "not-an-email";
  if (/whitespace|spaces only|blank spaces/.test(stepLower)) return "   ";
  if (/extremely long|very long|too long/.test(stepLower)) return "x".repeat(256);
  if (/empty|leave(?:s|ing)? .* empty|without/.test(stepLower)) return "";
  if (/email/.test(stepLower) || /email/i.test(quoted || "")) return "user@example.com";
  if (/password|passcode/.test(stepLower)) return "ValidPass123!";
  if (/phone|tel|mobile/.test(stepLower)) return "5551234567";
  // Word-boundary: avoid matching "age" inside "Message".
  if (/\b(number|qty|amount|age|zip|postal)\b/.test(stepLower) || /\b(number|qty|amount|age|zip|postal)\b/i.test(quoted || "")) {
    return "42";
  }
  if (/url|website/.test(stepLower)) return "https://example.com";
  return "test value";
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
