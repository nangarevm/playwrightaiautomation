// Phase 2: locator extraction + priority ranking.
//
// Priority order (highest first), matching the brief exactly:
//   1. data-testid/data-test/data-qa
//   2. ARIA role + accessible name (getByRole)
//   3. id
//   4. label/visible text (getByText/getByLabel)
//   5. CSS selector fallback
//   6. XPath (last resort)
//
// Only the top 2-3 candidates are kept per element (self-healing fallback set).

import type { Locator, Page } from "playwright";

export interface RankedLocators {
  locators: string[]; // Playwright-expression strings, ranked best-first
  label: string;
  type: string;
  component: string;
  required: boolean;
  inputType: string | null;
}

const INTERACTIVE_SELECTOR =
  "button, a[href], input, select, textarea, [role='button'], [role='link'], [role='checkbox'], [role='tab'], [role='menuitem'], [contenteditable='true']";

function escapeForAttrSelector(value: string): string {
  return value.replace(/"/g, '\\"');
}

function guessComponentName(el: {
  closestFormLabel?: string | null;
  closestSectionLabel?: string | null;
}): string {
  return el.closestSectionLabel || el.closestFormLabel || "Page";
}

export async function extractElementLocators(page: Page, handle: Locator): Promise<RankedLocators | null> {
  const info = await handle.evaluate((node: Element) => {
    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();
    const testId = el.getAttribute("data-testid") || el.getAttribute("data-test") || el.getAttribute("data-qa");
    const role = el.getAttribute("role") || (tag === "button" ? "button" : tag === "a" ? "link" : tag === "input" ? (el.getAttribute("type") === "checkbox" ? "checkbox" : "textbox") : tag === "select" ? "combobox" : null);
    const id = el.id || null;
    // Multi-line/wrapped element text (e.g. a button label that wraps across
    // lines in the DOM) carries literal newlines/tabs in textContent -- .trim()
    // only strips the ends, not internal whitespace. Collapsing to single spaces
    // here (not just at codegen time) keeps every downstream consumer of this
    // label -- scenario titles/steps, generated code comments -- newline-free.
    const collapseWhitespace = (s: string) => s.replace(/\s+/g, " ").trim();
    const text = collapseWhitespace(el.textContent || "").slice(0, 60);
    const ariaLabel = el.getAttribute("aria-label");
    const placeholder = el.getAttribute("placeholder");

    let labelText: string | null = null;
    if (id) {
      const labelEl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (labelEl) labelText = collapseWhitespace(labelEl.textContent || "");
    }
    if (!labelText) {
      const closestLabel = el.closest("label");
      if (closestLabel) labelText = collapseWhitespace(closestLabel.textContent || "");
    }

    const accessibleName = ariaLabel || labelText || text || placeholder || null;

    const closestForm = el.closest("form");
    const closestFormLabel =
      closestForm?.getAttribute("aria-label") ||
      closestForm?.getAttribute("name") ||
      collapseWhitespace(closestForm?.querySelector("h1,h2,h3,legend")?.textContent || "") ||
      (closestForm ? "Form" : null);

    const closestSection = el.closest("[role='navigation'], nav, header, footer, section, [aria-label]");
    const closestSectionLabel =
      closestSection?.getAttribute("aria-label") ||
      (closestSection?.tagName.toLowerCase() === "nav" ? "Nav Bar" : null) ||
      (closestSection?.tagName.toLowerCase() === "header" ? "Header" : null) ||
      (closestSection?.tagName.toLowerCase() === "footer" ? "Footer" : null);

    let elementType = "button";
    if (tag === "a") elementType = "link";
    else if (tag === "select") elementType = "dropdown";
    else if (tag === "textarea") elementType = "textarea";
    else if (tag === "input") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      elementType = t === "checkbox" ? "checkbox" : t === "radio" ? "radio" : t === "submit" ? "button" : "input";
    } else if (role === "checkbox") elementType = "checkbox";

    return {
      tag,
      testId,
      role,
      id,
      accessibleName,
      elementType,
      required: el.hasAttribute("required"),
      inputType: tag === "input" ? el.getAttribute("type") || "text" : null,
      closestFormLabel,
      closestSectionLabel,
    };
  });

  const locators: string[] = [];

  // 1. data-testid/data-test/data-qa
  if (info.testId) {
    locators.push(`page.getByTestId(${JSON.stringify(info.testId)})`);
  }
  // 2. ARIA role + accessible name
  if (info.role && info.accessibleName) {
    locators.push(`page.getByRole(${JSON.stringify(info.role)}, { name: ${JSON.stringify(info.accessibleName)} })`);
  }
  // 3. id
  if (info.id) {
    locators.push(`page.locator("#${escapeForAttrSelector(info.id)}")`);
  }
  // 4. label/visible text
  if (info.accessibleName) {
    locators.push(`page.getByText(${JSON.stringify(info.accessibleName)}, { exact: false })`);
  }
  // 5. CSS selector fallback (only if we still have fewer than 3 candidates)
  if (locators.length < 3) {
    const css = info.id ? `#${escapeForAttrSelector(info.id)}` : `${info.tag}${info.inputType ? `[type="${info.inputType}"]` : ""}`;
    locators.push(`page.locator(${JSON.stringify(css)})`);
  }
  // 6. XPath, last resort, only if nothing better was found at all
  if (locators.length === 0) {
    locators.push(`page.locator("xpath=//${info.tag}")`);
  }

  if (locators.length === 0) return null;

  return {
    locators: locators.slice(0, 3),
    label: info.accessibleName || info.id || info.tag,
    type: info.elementType,
    component: guessComponentName(info),
    // Previously computed here but never returned, so buildFormScenarios in
    // scenarios.ts always saw `required: undefined` (making every field look
    // required) and `inputType: undefined` (making the invalid-format
    // negative scenario impossible to generate at all). Threading these
    // through is what makes both scenario types accurate/reachable.
    required: info.required,
    inputType: info.inputType,
  };
}

export { INTERACTIVE_SELECTOR };
