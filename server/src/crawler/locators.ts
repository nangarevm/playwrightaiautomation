// Phase 2: locator extraction + priority ranking.
//
// Priority order (highest first):
//   1. data-testid/data-test/data-qa
//   2. ARIA role + accessible name (getByRole) — loading-state labels stripped
//   3. label (getByLabel) / placeholder (getByPlaceholder)
//   4. id / name attribute (CSS fallback)
//   5. visible text (getByText)
//   6. CSS selector / XPath (last resort)
//
// Only the top 2-3 candidates are kept per element (self-healing fallback set).

import type { Locator, Page } from "playwright";
import {
  pickPreferredLocator,
  scoreStableLocator,
  stripTransientLoadingLabel,
  isBrowserChromeLabel,
  isBrowserChromeElement,
  isMapChromeLabel,
} from "./locatorQuality.js";

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
          : tag === "textarea"
            ? "textbox"
            : tag === "input"
              ? el.getAttribute("type") === "checkbox"
                ? "checkbox"
                : el.getAttribute("type") === "search"
                  ? "searchbox"
                  : el.getAttribute("type") === "radio"
                    ? "radio"
                    : el.getAttribute("type") === "submit" || el.getAttribute("type") === "button"
                      ? "button"
                      : "textbox"
              : tag === "select"
                ? "combobox"
                : null);
    const id = el.id || null;
    const name = el.getAttribute("name") || null;
    const className = typeof el.className === "string" ? el.className : "";
    // Prefer direct/own text over deep textContent so nested "Sending…" spans
    // on submit buttons are not concatenated into the accessible name.
    const ownText = Array.from(el.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => (n.textContent || "").trim())
      .filter(Boolean)
      .join(" ");
    const valueText =
      tag === "input" || tag === "button" ? String((el as HTMLInputElement).value || "").trim() : "";
    // Collapse multi-line/wrapped element text so scenario titles/steps stay single-line.
    const text = (ownText || valueText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60);
    const ariaLabel = el.getAttribute("aria-label");
    const placeholder = el.getAttribute("placeholder");
    const alt = el.getAttribute("alt");
    const title = el.getAttribute("title");

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
    // Prefer aria/label/placeholder over raw concatenated text for controls.
    const accessibleNameRaw =
      ariaLabel || labelText || (tag === "button" || role === "button" ? ownText || valueText || text : text) || placeholder || null;
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
      labelText,
      placeholder,
      alt,
      title,
      elementType,
      required: el.hasAttribute("required"),
      inputType: tag === "input" ? el.getAttribute("type") || "text" : null,
      closestFormLabel,
      closestSectionLabel,
      className,
    };
  });

  const cleanName = info.accessibleName ? stripTransientLoadingLabel(info.accessibleName) : "";
  const cleanLabel = info.labelText ? stripTransientLoadingLabel(info.labelText) : "";
  const cleanPlaceholder = info.placeholder ? stripTransientLoadingLabel(info.placeholder) : "";
  const cleanAlt = info.alt ? stripTransientLoadingLabel(info.alt) : "";
  const cleanTitle = info.title ? stripTransientLoadingLabel(info.title) : "";

  if (
    isBrowserChromeLabel(cleanName) ||
    isBrowserChromeLabel(cleanLabel) ||
    isBrowserChromeLabel(cleanTitle) ||
    isMapChromeLabel(cleanName) ||
    isBrowserChromeElement({
      id: info.id,
      name: info.name,
      className: info.className,
      label: cleanName || cleanLabel || cleanPlaceholder,
    })
  ) {
    return null;
  }

  const candidates: string[] = [];

  // 1. data-testid/data-test/data-qa
  if (info.testId) {
    candidates.push(`page.getByTestId(${JSON.stringify(info.testId)})`);
  }
  // 2. ARIA role + accessible name (skip URL-like / empty names)
  if (info.role && cleanName && !/^(https?:\/\/|www\.|mailto:)/i.test(cleanName)) {
    candidates.push(`page.getByRole(${JSON.stringify(info.role)}, { name: ${JSON.stringify(cleanName)} })`);
  }
  // 3. label / placeholder (prefer over raw #id for form fields)
  if (cleanLabel && (info.tag === "input" || info.tag === "select" || info.tag === "textarea")) {
    candidates.push(`page.getByLabel(${JSON.stringify(cleanLabel)})`);
  }
  if (cleanPlaceholder && (info.tag === "input" || info.tag === "textarea")) {
    candidates.push(`page.getByPlaceholder(${JSON.stringify(cleanPlaceholder)})`);
  }
  if (cleanAlt && (info.tag === "img" || info.tag === "area" || info.role === "img")) {
    candidates.push(`page.getByAltText(${JSON.stringify(cleanAlt)})`);
  }
  if (cleanTitle) {
    candidates.push(`page.getByTitle(${JSON.stringify(cleanTitle)})`);
  }
  if (info.closestFormLabel && info.role && cleanName) {
    candidates.push(
      `page.locator("form").filter({ hasText: ${JSON.stringify(info.closestFormLabel)} }).getByRole(${JSON.stringify(info.role)}, { name: ${JSON.stringify(cleanName)} })`
    );
  }
  // 2b. Links with no usable accessible name: target by href
  if (info.tag === "a" && info.href && (!cleanName || /^(https?:\/\/|www\.)/i.test(cleanName))) {
    candidates.push(`page.locator(${JSON.stringify(`a[href="${escapeForAttrSelector(info.href)}"]`)})`);
  }
  // 4. id / name attribute (CSS fallback — brittle, ranked lower)
  if (info.id) {
    candidates.push(`page.locator("#${escapeForAttrSelector(info.id)}")`);
  }
  if (info.name && (info.tag === "input" || info.tag === "select" || info.tag === "textarea")) {
    candidates.push(`page.locator("[name=${JSON.stringify(info.name)}]")`);
  }
  // 5. label/visible text
  if (cleanName) {
    candidates.push(`page.getByText(${JSON.stringify(cleanName)}, { exact: false })`);
  }
  // 6. CSS selector fallback (only if we still have fewer than 3 candidates after ranking)
  if (candidates.length < 3) {
    let css: string | null = null;

    if (info.id && !/^(?:ember|react|vue)?-?\d{5,}$/i.test(info.id)) {
      css = `#${escapeForAttrSelector(info.id)}`;
    } else if (info.tag === "input" && info.closestFormLabel) {
      css = `form:has-text("${info.closestFormLabel}") ${info.tag}${info.inputType ? `[type="${info.inputType}"]` : ""}`;
    } else if (info.tag !== "input" || !info.inputType) {
      css = info.tag;
    }

    if (css && !/\.(?:css|sc)-[a-zA-Z0-9_-]{4,}/.test(css)) {
      candidates.push(`page.locator(${JSON.stringify(css)})`);
    }
  }
  // 7. XPath, last resort, only if nothing better was found at all
  if (candidates.length === 0) {
    candidates.push(`page.locator("xpath=//${info.tag}")`);
  }

  const unique = Array.from(new Set(candidates));
  unique.sort((a, b) => scoreStableLocator(b) - scoreStableLocator(a));
  const locators = unique.slice(0, 5);

  if (locators.length === 0) return null;

  return {
    locators,
    label: cleanName || cleanLabel || cleanPlaceholder || info.id || info.tag,
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

export { INTERACTIVE_SELECTOR, pickPreferredLocator, scoreStableLocator, stripTransientLoadingLabel };
