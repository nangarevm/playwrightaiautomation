// User-Defined Assertions Service
// Allows QA leads to create, manage, and apply custom validation rules

export type AssertionType = 
  | "element_visible" 
  | "element_contains_text" 
  | "element_attribute_equals" 
  | "page_title_equals" 
  | "page_url_contains" 
  | "api_response_status" 
  | "api_response_contains" 
  | "custom_javascript"
  | "dom_element_count"
  | "element_enabled"
  | "element_checked";

export interface AssertionRule {
  id: string;
  name: string;
  description: string;
  type: AssertionType;
  target: string;  // CSS selector, XPath, or element description
  expectedValue?: string | number | boolean;
  customCode?: string;  // For custom_javascript type
  errorMessage?: string;  // Custom error message
  severity: "critical" | "high" | "medium" | "low";
  applicable_to: string[];  // Test categories this applies to: ["Smoke", "Functional", "All"]
  created_by?: string;
  created_at?: string;
  updated_at?: string;
}

export interface AssertionResult {
  ruleId: string;
  ruleName: string;
  passed: boolean;
  message: string;
  actual?: any;
  expected?: any;
  duration?: number;
}

export interface AssertionViolation {
  rule: AssertionRule;
  result: AssertionResult;
  stackTrace?: string;
}

/**
 * Validates an element is visible on the page
 */
export function assertElementVisible(
  selector: string,
  getElement: (selector: string) => any,
  timeout?: number
): AssertionResult {
  const start = Date.now();
  try {
    const element = getElement(selector);
    if (!element) {
      return {
        ruleId: "element_visible",
        ruleName: "Element Visible",
        passed: false,
        message: `Element not found: ${selector}`,
        actual: null,
        expected: "visible element",
        duration: Date.now() - start,
      };
    }

    // Check if element is visible
    const isVisible =
      element.offsetParent !== null &&
      element.offsetWidth > 0 &&
      element.offsetHeight > 0;

    if (!isVisible) {
      return {
        ruleId: "element_visible",
        ruleName: "Element Visible",
        passed: false,
        message: `Element is not visible: ${selector}`,
        actual: "hidden",
        expected: "visible",
        duration: Date.now() - start,
      };
    }

    return {
      ruleId: "element_visible",
      ruleName: "Element Visible",
      passed: true,
      message: `Element is visible: ${selector}`,
      actual: "visible",
      expected: "visible",
      duration: Date.now() - start,
    };
  } catch (error: any) {
    return {
      ruleId: "element_visible",
      ruleName: "Element Visible",
      passed: false,
      message: `Error checking visibility: ${error.message}`,
      duration: Date.now() - start,
    };
  }
}

/**
 * Validates an element contains specific text
 */
export function assertElementContainsText(
  selector: string,
  expectedText: string,
  getElement: (selector: string) => any
): AssertionResult {
  const start = Date.now();
  try {
    const element = getElement(selector);
    if (!element) {
      return {
        ruleId: "element_contains_text",
        ruleName: "Element Contains Text",
        passed: false,
        message: `Element not found: ${selector}`,
        actual: null,
        expected: expectedText,
        duration: Date.now() - start,
      };
    }

    const actualText = element.textContent || element.innerText || "";
    const contains = actualText.includes(expectedText);

    return {
      ruleId: "element_contains_text",
      ruleName: "Element Contains Text",
      passed: contains,
      message: contains
        ? `Element contains text: "${expectedText}"`
        : `Element does not contain text: "${expectedText}"`,
      actual: actualText.slice(0, 100),
      expected: expectedText,
      duration: Date.now() - start,
    };
  } catch (error: any) {
    return {
      ruleId: "element_contains_text",
      ruleName: "Element Contains Text",
      passed: false,
      message: `Error checking text: ${error.message}`,
      duration: Date.now() - start,
    };
  }
}

/**
 * Validates element attribute value
 */
export function assertElementAttribute(
  selector: string,
  attributeName: string,
  expectedValue: string,
  getElement: (selector: string) => any
): AssertionResult {
  const start = Date.now();
  try {
    const element = getElement(selector);
    if (!element) {
      return {
        ruleId: "element_attribute_equals",
        ruleName: "Element Attribute",
        passed: false,
        message: `Element not found: ${selector}`,
        actual: null,
        expected: expectedValue,
        duration: Date.now() - start,
      };
    }

    const actualValue = element.getAttribute(attributeName);
    const matches = actualValue === expectedValue;

    return {
      ruleId: "element_attribute_equals",
      ruleName: "Element Attribute",
      passed: matches,
      message: matches
        ? `${attributeName} = "${expectedValue}"`
        : `${attributeName} = "${actualValue}" (expected "${expectedValue}")`,
      actual: actualValue,
      expected: expectedValue,
      duration: Date.now() - start,
    };
  } catch (error: any) {
    return {
      ruleId: "element_attribute_equals",
      ruleName: "Element Attribute",
      passed: false,
      message: `Error checking attribute: ${error.message}`,
      duration: Date.now() - start,
    };
  }
}

/**
 * Validates page title
 */
export function assertPageTitle(
  expectedTitle: string,
  getPageTitle: () => string
): AssertionResult {
  const start = Date.now();
  try {
    const actualTitle = getPageTitle();
    const matches = actualTitle === expectedTitle;

    return {
      ruleId: "page_title_equals",
      ruleName: "Page Title",
      passed: matches,
      message: matches
        ? `Page title matches: "${expectedTitle}"`
        : `Page title mismatch: "${actualTitle}" != "${expectedTitle}"`,
      actual: actualTitle,
      expected: expectedTitle,
      duration: Date.now() - start,
    };
  } catch (error: any) {
    return {
      ruleId: "page_title_equals",
      ruleName: "Page Title",
      passed: false,
      message: `Error checking page title: ${error.message}`,
      duration: Date.now() - start,
    };
  }
}

/**
 * Validates page URL contains substring
 */
export function assertPageUrl(
  expectedUrlPart: string,
  getPageUrl: () => string
): AssertionResult {
  const start = Date.now();
  try {
    const actualUrl = getPageUrl();
    const contains = actualUrl.includes(expectedUrlPart);

    return {
      ruleId: "page_url_contains",
      ruleName: "Page URL",
      passed: contains,
      message: contains
        ? `URL contains: "${expectedUrlPart}"`
        : `URL does not contain: "${expectedUrlPart}"`,
      actual: actualUrl,
      expected: expectedUrlPart,
      duration: Date.now() - start,
    };
  } catch (error: any) {
    return {
      ruleId: "page_url_contains",
      ruleName: "Page URL",
      passed: false,
      message: `Error checking page URL: ${error.message}`,
      duration: Date.now() - start,
    };
  }
}

/**
 * Validates API response status code
 */
export function assertApiResponseStatus(
  response: any,
  expectedStatus: number
): AssertionResult {
  const start = Date.now();
  try {
    const actualStatus = response.status || response.statusCode;
    const matches = actualStatus === expectedStatus;

    return {
      ruleId: "api_response_status",
      ruleName: "API Response Status",
      passed: matches,
      message: matches
        ? `API returned ${expectedStatus}`
        : `API returned ${actualStatus} (expected ${expectedStatus})`,
      actual: actualStatus,
      expected: expectedStatus,
      duration: Date.now() - start,
    };
  } catch (error: any) {
    return {
      ruleId: "api_response_status",
      ruleName: "API Response Status",
      passed: false,
      message: `Error checking API response: ${error.message}`,
      duration: Date.now() - start,
    };
  }
}

/**
 * Validates API response contains expected content
 */
export function assertApiResponseContains(
  response: any,
  expectedContent: string
): AssertionResult {
  const start = Date.now();
  try {
    const responseText = typeof response === "string" ? response : JSON.stringify(response);
    const contains = responseText.includes(expectedContent);

    return {
      ruleId: "api_response_contains",
      ruleName: "API Response Contains",
      passed: contains,
      message: contains
        ? `Response contains: "${expectedContent}"`
        : `Response does not contain: "${expectedContent}"`,
      actual: responseText.slice(0, 100),
      expected: expectedContent,
      duration: Date.now() - start,
    };
  } catch (error: any) {
    return {
      ruleId: "api_response_contains",
      ruleName: "API Response Contains",
      passed: false,
      message: `Error checking API response: ${error.message}`,
      duration: Date.now() - start,
    };
  }
}

/**
 * Executes custom JavaScript assertion
 */
export function assertCustomCode(
  code: string,
  context: Record<string, any>
): AssertionResult {
  const start = Date.now();
  try {
    const func = new Function(...Object.keys(context), `return (${code})`);
    const result = func(...Object.values(context));

    return {
      ruleId: "custom_javascript",
      ruleName: "Custom JavaScript",
      passed: Boolean(result),
      message: result ? "Custom assertion passed" : "Custom assertion failed",
      actual: result,
      expected: true,
      duration: Date.now() - start,
    };
  } catch (error: any) {
    return {
      ruleId: "custom_javascript",
      ruleName: "Custom JavaScript",
      passed: false,
      message: `Error executing custom code: ${error.message}`,
      duration: Date.now() - start,
    };
  }
}

/**
 * Counts DOM elements matching selector
 */
export function assertDomElementCount(
  selector: string,
  expectedCount: number,
  getElements: (selector: string) => any[]
): AssertionResult {
  const start = Date.now();
  try {
    const elements = getElements(selector);
    const actualCount = elements.length;
    const matches = actualCount === expectedCount;

    return {
      ruleId: "dom_element_count",
      ruleName: "DOM Element Count",
      passed: matches,
      message: matches
        ? `Found ${expectedCount} elements`
        : `Found ${actualCount} elements (expected ${expectedCount})`,
      actual: actualCount,
      expected: expectedCount,
      duration: Date.now() - start,
    };
  } catch (error: any) {
    return {
      ruleId: "dom_element_count",
      ruleName: "DOM Element Count",
      passed: false,
      message: `Error counting elements: ${error.message}`,
      duration: Date.now() - start,
    };
  }
}

/**
 * Validates element is enabled
 */
export function assertElementEnabled(
  selector: string,
  getElement: (selector: string) => any
): AssertionResult {
  const start = Date.now();
  try {
    const element = getElement(selector);
    if (!element) {
      return {
        ruleId: "element_enabled",
        ruleName: "Element Enabled",
        passed: false,
        message: `Element not found: ${selector}`,
        actual: null,
        expected: "enabled",
        duration: Date.now() - start,
      };
    }

    const isEnabled = !element.disabled;

    return {
      ruleId: "element_enabled",
      ruleName: "Element Enabled",
      passed: isEnabled,
      message: isEnabled ? `Element is enabled` : `Element is disabled`,
      actual: isEnabled ? "enabled" : "disabled",
      expected: "enabled",
      duration: Date.now() - start,
    };
  } catch (error: any) {
    return {
      ruleId: "element_enabled",
      ruleName: "Element Enabled",
      passed: false,
      message: `Error checking element state: ${error.message}`,
      duration: Date.now() - start,
    };
  }
}

/**
 * Validates element is checked (checkbox/radio)
 */
export function assertElementChecked(
  selector: string,
  getElement: (selector: string) => any,
  shouldBeChecked: boolean = true
): AssertionResult {
  const start = Date.now();
  try {
    const element = getElement(selector);
    if (!element) {
      return {
        ruleId: "element_checked",
        ruleName: "Element Checked",
        passed: false,
        message: `Element not found: ${selector}`,
        actual: null,
        expected: shouldBeChecked ? "checked" : "unchecked",
        duration: Date.now() - start,
      };
    }

    const isChecked = element.checked;
    const matches = isChecked === shouldBeChecked;

    return {
      ruleId: "element_checked",
      ruleName: "Element Checked",
      passed: matches,
      message: matches
        ? `Element is ${shouldBeChecked ? "checked" : "unchecked"}`
        : `Element is ${isChecked ? "checked" : "unchecked"} (expected ${shouldBeChecked ? "checked" : "unchecked"})`,
      actual: isChecked ? "checked" : "unchecked",
      expected: shouldBeChecked ? "checked" : "unchecked",
      duration: Date.now() - start,
    };
  } catch (error: any) {
    return {
      ruleId: "element_checked",
      ruleName: "Element Checked",
      passed: false,
      message: `Error checking element state: ${error.message}`,
      duration: Date.now() - start,
    };
  }
}

/**
 * Main function to execute an assertion rule
 */
export function executeAssertion(
  rule: AssertionRule,
  context: Record<string, any>
): AssertionResult {
  switch (rule.type) {
    case "element_visible":
      return assertElementVisible(
        rule.target,
        context.getElement || ((sel) => document.querySelector(sel))
      );

    case "element_contains_text":
      return assertElementContainsText(
        rule.target,
        rule.expectedValue as string,
        context.getElement || ((sel) => document.querySelector(sel))
      );

    case "element_attribute_equals":
      const [selector, attrName] = rule.target.split("::");
      return assertElementAttribute(
        selector,
        attrName,
        rule.expectedValue as string,
        context.getElement || ((sel) => document.querySelector(sel))
      );

    case "page_title_equals":
      return assertPageTitle(
        rule.expectedValue as string,
        context.getPageTitle || (() => document.title)
      );

    case "page_url_contains":
      return assertPageUrl(
        rule.expectedValue as string,
        context.getPageUrl || (() => window.location.href)
      );

    case "api_response_status":
      return assertApiResponseStatus(context.response, rule.expectedValue as number);

    case "api_response_contains":
      return assertApiResponseContains(context.response, rule.expectedValue as string);

    case "custom_javascript":
      return assertCustomCode(rule.customCode || "", context);

    case "dom_element_count":
      return assertDomElementCount(
        rule.target,
        rule.expectedValue as number,
        context.getElements || ((sel) => Array.from(document.querySelectorAll(sel)))
      );

    case "element_enabled":
      return assertElementEnabled(
        rule.target,
        context.getElement || ((sel) => document.querySelector(sel))
      );

    case "element_checked":
      return assertElementChecked(
        rule.target,
        context.getElement || ((sel) => document.querySelector(sel)),
        rule.expectedValue as boolean
      );

    default:
      return {
        ruleId: "unknown",
        ruleName: "Unknown Assertion",
        passed: false,
        message: `Unknown assertion type: ${rule.type}`,
      };
  }
}

/**
 * Executes multiple assertions and returns summary
 */
export function executeAssertions(
  rules: AssertionRule[],
  context: Record<string, any>
): {
  results: AssertionResult[];
  passed: number;
  failed: number;
  violations: AssertionViolation[];
} {
  const results = rules.map((rule) => executeAssertion(rule, context));
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const violations = results
    .filter((r) => !r.passed)
    .map((result) => {
      const rule = rules.find((r) => r.id === result.ruleId)!;
      return {
        rule,
        result,
      };
    });

  return { results, passed, failed, violations };
}

/**
 * Generates test code snippet for an assertion rule
 */
export function generateAssertionCode(rule: AssertionRule, language: "typescript" | "javascript" | "python" = "typescript"): string {
  if (language === "python") {
    switch (rule.type) {
      case "element_visible":
        return `assert page.locator("${rule.target}").is_visible(), "${rule.errorMessage || "Element not visible"}"`;
      case "element_contains_text":
        return `assert "${rule.expectedValue}" in page.locator("${rule.target}").inner_text(), "${rule.errorMessage || "Text not found"}"`;
      case "page_title_equals":
        return `assert page.title() == "${rule.expectedValue}", "${rule.errorMessage || "Title mismatch"}"`;
      default:
        return `# Custom assertion for ${rule.name}`;
    }
  }

  // TypeScript/JavaScript
  switch (rule.type) {
    case "element_visible":
      return `await expect(page.locator("${rule.target}")).toBeVisible(); // ${rule.name}`;
    case "element_contains_text":
      return `await expect(page.locator("${rule.target}")).toContainText("${rule.expectedValue}"); // ${rule.name}`;
    case "element_attribute_equals":
      const [sel, attr] = rule.target.split("::");
      return `await expect(page.locator("${sel}")).toHaveAttribute("${attr}", "${rule.expectedValue}"); // ${rule.name}`;
    case "page_title_equals":
      return `await expect(page).toHaveTitle("${rule.expectedValue}"); // ${rule.name}`;
    case "page_url_contains":
      return `await expect(page).toHaveURL(new RegExp("${rule.expectedValue}")); // ${rule.name}`;
    case "dom_element_count":
      return `await expect(page.locator("${rule.target}")).toHaveCount(${rule.expectedValue}); // ${rule.name}`;
    case "element_enabled":
      return `await expect(page.locator("${rule.target}")).toBeEnabled(); // ${rule.name}`;
    case "element_checked":
      return `await expect(page.locator("${rule.target}")).toBeChecked(); // ${rule.name}`;
    case "custom_javascript":
      return `// Custom assertion: ${rule.name}\nawait expect(async () => {\n  ${rule.customCode}\n}).toBeTruthy();`;
    default:
      return `// Assertion: ${rule.name}`;
  }
}
