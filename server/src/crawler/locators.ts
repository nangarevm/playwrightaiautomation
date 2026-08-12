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
  // IMPORTANT: keep this evaluate callback free of nested function declarations.
  // tsx/esbuild injects `__name(...)` helpers for named/local functions, and those
  // helpers do not exist in the browser context -- which previously made every
  // locator extraction fail with "ReferenceError: __name is not defined" and left
  // crawl pages with zero elements/forms.
  const info = await handle.evaluate((node: Element) => {
    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();
    const testId = el.getAttribute("data-testid") || el.getAttribute("data-test") || el.getAttribute("data-qa");
    const role =
      el.getAttribute("role") ||
      (tag === "button"
        ? "button"
        : tag === "a"
          ? "link"
          : tag === "input"
            ? el.getAttribute("type") === "checkbox"
              ? "checkbox"
              : "textbox"
            : tag === "select"
              ? "combobox"
              : null);
    const id = el.id || null;
    const name = el.getAttribute("name") || null;
    // Collapse multi-line/wrapped element text so scenario titles/steps stay single-line.
    const text = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60);
    const ariaLabel = el.getAttribute("aria-label");
    const placeholder = el.getAttribute("placeholder");

    let labelText: string | null = null;
    if (id) {
      const labelEl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (labelEl) labelText = (labelEl.textContent || "").replace(/\s+/g, " ").trim();
    }
    if (!labelText) {
      const closestLabel = el.closest("label");
      if (closestLabel) labelText = (closestLabel.textContent || "").replace(/\s+/g, " ").trim();
    }

    const href = tag === "a" ? el.getAttribute("href") : null;
    const accessibleNameRaw = ariaLabel || labelText || text || placeholder || null;
    const accessibleName =
      accessibleNameRaw && !/^(https?:\/\/|www\.|mailto:)/i.test(accessibleNameRaw.trim())
        ? accessibleNameRaw
        : ariaLabel || labelText || placeholder || (text && !/^(https?:\/\/|www\.)/i.test(text) ? text : null);

    const closestForm = el.closest("form");
    const closestFormLabel =
      closestForm?.getAttribute("aria-label") ||
      closestForm?.getAttribute("name") ||
      (closestForm?.querySelector("h1,h2,h3,legend")?.textContent || "").replace(/\s+/g, " ").trim() ||
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
      name,
      href,
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
  // 2. ARIA role + accessible name (skip URL-like names — they fail getByRole matching)
  if (info.role && info.accessibleName && !/^(https?:\/\/|www\.|mailto:)/i.test(info.accessibleName)) {
    locators.push(`page.getByRole(${JSON.stringify(info.role)}, { name: ${JSON.stringify(info.accessibleName)} })`);
  }
  // 2b. Links with no usable accessible name: target by href
  if (info.tag === "a" && info.href && (!info.accessibleName || /^(https?:\/\/|www\.)/i.test(info.accessibleName))) {
    locators.push(`page.locator(${JSON.stringify(`a[href="${escapeForAttrSelector(info.href)}"]`)})`);
  }
  // 3. id (prefer over generic CSS, most specific)
  if (info.id) {
    locators.push(`page.locator("#${escapeForAttrSelector(info.id)}")`);
  }
  // 3b. name attribute (for form inputs, often more reliable than type-only selectors)
  if (info.name && (info.tag === "input" || info.tag === "select" || info.tag === "textarea")) {
    locators.push(`page.locator("[name=${JSON.stringify(info.name)}]")`);
  }
  // 4. label/visible text
  if (info.accessibleName) {
    locators.push(`page.getByText(${JSON.stringify(info.accessibleName)}, { exact: false })`);
  }
  // 5. CSS selector fallback (only if we still have fewer than 3 candidates)
  // For form inputs, prioritize more specific selectors over generic type selectors
  if (locators.length < 3) {
    let css: string | null = null;
    
    // Prefer id-based selectors for unambiguous targeting
    if (info.id) {
      css = `#${escapeForAttrSelector(info.id)}`;
    }
    // For inputs within forms, use form context to disambiguate
    else if (info.tag === "input" && info.closestFormLabel) {
      // Use form with input type: more specific than bare input[type="text"]
      css = `form:has-text("${info.closestFormLabel}") ${info.tag}${info.inputType ? `[type="${info.inputType}"]` : ""}`;
    }
    // Fallback: generic tag selector (only for non-input or standalone elements)
    else if (info.tag !== "input" || !info.inputType) {
      css = info.tag;
    }
    
    if (css) {
      locators.push(`page.locator(${JSON.stringify(css)})`);
    }
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
