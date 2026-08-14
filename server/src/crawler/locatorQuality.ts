/**
 * Shared locator preference + accessible-name cleanup used by crawl extraction,
 * scenario ranking, codegen, and deterministic script healing.
 *
 * Scoring follows Smart Playwright Execution strategy (0–100).
 */

/** Loading / busy labels that must never be baked into stable locators. */
export const TRANSIENT_LOADING_LABEL_RE =
  /\b(sending|loading|please wait|processing|submitting|saving|working)[.…]*\b/i;

export const HEAL_AUTO_MIN = 90;
export const HEAL_SUGGEST_MIN = 70;

export const LOADING_SETTLE_SNIPPET =
  `await page.locator('[aria-busy="true"], [role="progressbar"], .spinner, .loader, .loading').first().waitFor({ state: 'hidden', timeout: 8000 }).catch(() => {});`;

const DYNAMIC_CLASS_RE = /\.(?:css|sc|emotion|jsx)-[a-zA-Z0-9_-]{4,}/;
const RANDOM_ID_RE = /#(?:[a-zA-Z]+-?)?\d{5,}|#(?:ember|react|vue)[-_]\S+/;
const NTH_RE = /:nth(?:-child|-of-type)?\s*\(|\.nth\s*\(/;
const XPATH_RE = /xpath\s*=|\/\/\w+\[/;

export function stripTransientLoadingLabel(name: string): string {
  let s = String(name || "").replace(/\s+/g, " ").trim();
  if (!s) return s;
  s = s.replace(/\s+(Sending|Loading|Please wait|Processing|Submitting|Saving|Working)[.…]*$/i, "");
  s = s.replace(/\b(Sending|Loading|Please wait|Processing|Submitting|Saving|Working)[.…]*\b/gi, " ");
  return s.replace(/\s+/g, " ").trim();
}

export function hasTransientLoadingLabel(name: string): boolean {
  return TRANSIENT_LOADING_LABEL_RE.test(String(name || ""));
}

/**
 * Score Playwright locator expressions for stability (0–100).
 * Prefer testid / role / label / placeholder over CSS, XPath, nth, random ids.
 */
export function scoreStableLocator(loc: string): number {
  const expr = String(loc || "");
  let s = 20;
  if (/getByTestId/.test(expr)) s = 100;
  else if (/getByRole/.test(expr) && /name\s*:/.test(expr)) s = 95;
  else if (/getByLabel/.test(expr)) s = 93;
  else if (/getByPlaceholder/.test(expr)) s = 88;
  else if (/getByAltText/.test(expr)) s = 86;
  else if (/getByTitle/.test(expr)) s = 82;
  else if (/getByText/.test(expr)) s = 80;
  else if (/locator\(["']\[name=/.test(expr) || /\[name=/.test(expr)) s = 78;
  else if (/getByRole/.test(expr)) s = 70;
  else if (XPATH_RE.test(expr)) s = 35;
  else if (/locator\(["']#/.test(expr)) s = 40;
  else if (/locator\(/.test(expr)) s = 65;

  if (/getByRole\(\s*["']button["']/.test(expr)) s = Math.min(100, s + 2);

  const nameMatch =
    expr.match(/name:\s*["']([^"']+)["']/) ||
    expr.match(/getBy(?:Text|Label|Placeholder|AltText|Title|TestId)\(\s*["']([^"']+)["']/);
  if (nameMatch && hasTransientLoadingLabel(nameMatch[1])) s -= 60;
  if (nameMatch && /^(https?:\/\/|www\.|mailto:)/i.test(nameMatch[1])) s -= 40;
  if (/locator\(\s*["']a["']\s*\)/.test(expr)) s -= 25;
  if (NTH_RE.test(expr)) s = Math.min(s, 10);
  if (DYNAMIC_CLASS_RE.test(expr)) s = Math.min(s, 15);
  if (RANDOM_ID_RE.test(expr)) s = Math.min(s, 10);
  if (XPATH_RE.test(expr) && s > 35) s = 35;
  return Math.max(0, Math.min(100, s));
}

export function pickPreferredLocator(locators: string[]): string | undefined {
  const ranked = [...(locators || [])].filter(Boolean);
  ranked.sort((a, b) => scoreStableLocator(b) - scoreStableLocator(a));
  return ranked[0];
}

export function stableRoleNameExpr(rawName: string): { exact: string; regexSource: string } | null {
  const cleaned = stripTransientLoadingLabel(rawName);
  if (!cleaned && !hasTransientLoadingLabel(rawName)) return null;
  if (cleaned === String(rawName || "").replace(/\s+/g, " ").trim() && !hasTransientLoadingLabel(rawName)) {
    return null;
  }
  const idle =
    cleaned ||
    String(rawName || "")
      .replace(TRANSIENT_LOADING_LABEL_RE, "")
      .replace(/\s+/g, " ")
      .trim();
  if (!idle) return null;
  const escaped = idle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return { exact: idle, regexSource: escaped };
}

export function normalizeLocatorExpression(expr: string): string {
  let next = String(expr || "").trim();
  if (!next) return next;

  next = next.replace(
    /getByRole\(\s*(['"])(\w+)\1\s*,\s*\{\s*name:\s*(['"])([^'"]+)\3\s*\}\s*\)/g,
    (_m, q1, role, _q2, name) => {
      const stable = stableRoleNameExpr(name);
      if (!stable) return `getByRole(${q1}${role}${q1}, { name: ${JSON.stringify(name)} })`;
      return `getByRole(${q1}${role}${q1}, { name: /${stable.regexSource}/i })`;
    }
  );

  next = next.replace(
    /getByText\(\s*(['"])([^'"]+)\1(\s*,\s*\{[^}]*\})?\s*\)/g,
    (full, _q, name, opts = "") => {
      const stable = stableRoleNameExpr(name);
      if (!stable) return full;
      return `getByText(/${stable.regexSource}/i${opts || ""})`;
    }
  );

  if (!next.startsWith("page.") && /^(getBy|locator)\(/.test(next)) {
    next = `page.${next}`;
  }
  return next;
}

function band(score: number): "excellent" | "good" | "medium" | "risky" {
  if (score >= 90) return "excellent";
  if (score >= 75) return "good";
  if (score >= 60) return "medium";
  return "risky";
}

const LOCATOR_CALL_RE =
  /page\.(getByRole|getByText|getByLabel|getByTestId|getByPlaceholder|getByAltText|getByTitle|locator)\([^;]*?\)(?:\.first\(\))?/g;

export interface LocatorQualityReport {
  totalLocators: number;
  excellent: number;
  good: number;
  medium: number;
  risky: number;
  hardWaits: number;
  xpathLocators: number;
  nthLocators: number;
  dynamicClasses: number;
  randomIds: number;
  averageScore: number;
  recommendedActions: string[];
  readiness: {
    overall: number;
    locatorRobustness: number;
    waitRobustness: number;
    assertionQuality: number;
    dataStability: number;
    retrySafety: number;
    label: "production_ready" | "review_recommended" | "risky" | "needs_improvement";
  };
}

export function analyzeGeneratedScript(code: string): LocatorQualityReport {
  const src = String(code || "");
  const locators = src.match(LOCATOR_CALL_RE) || [];
  const scores = locators.map((l) => scoreStableLocator(l));
  const buckets = { excellent: 0, good: 0, medium: 0, risky: 0 };
  for (const s of scores) buckets[band(s)]++;
  const hardWaits = (src.match(/waitForTimeout\s*\(/g) || []).length;
  const xpathLocators = locators.filter((l) => XPATH_RE.test(l)).length;
  const nthLocators = locators.filter((l) => NTH_RE.test(l)).length;
  const dynamicClasses = locators.filter((l) => DYNAMIC_CLASS_RE.test(l)).length;
  const randomIds = locators.filter((l) => RANDOM_ID_RE.test(l)).length;
  const averageScore = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 100;

  const recommendedActions: string[] = [];
  if (buckets.risky) recommendedActions.push(`${buckets.risky} locator(s) should be improved`);
  if (hardWaits) recommendedActions.push(`${hardWaits} hard wait(s) should be replaced with application-state waits`);
  if (xpathLocators) recommendedActions.push(`${xpathLocators} XPath locator(s) should be last-resort only`);
  if (nthLocators) recommendedActions.push(`${nthLocators} nth()/nth-child locator(s) are brittle`);

  const waitRobustness = hardWaits ? Math.max(20, 100 - hardWaits * 25) : 95;
  const assertionQuality = /expect\s*\(/.test(src) ? 95 : 55;
  const retrySafety = 100;
  const dataStability = 90;
  const overall = Math.round(
    averageScore * 0.4 + waitRobustness * 0.2 + assertionQuality * 0.2 + dataStability * 0.1 + retrySafety * 0.1
  );
  const label =
    overall >= 90 ? "production_ready" : overall >= 75 ? "review_recommended" : overall >= 60 ? "risky" : "needs_improvement";

  return {
    totalLocators: locators.length,
    ...buckets,
    hardWaits,
    xpathLocators,
    nthLocators,
    dynamicClasses,
    randomIds,
    averageScore,
    recommendedActions,
    readiness: {
      overall,
      locatorRobustness: averageScore,
      waitRobustness,
      assertionQuality,
      dataStability,
      retrySafety,
      label,
    },
  };
}

export function scoreHealCandidate(input: {
  originalRole?: string | null;
  originalName?: string | null;
  candidateLocator: string;
  candidateLabel?: string | null;
}): number {
  let score = scoreStableLocator(input.candidateLocator);
  const want = String(input.originalName || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  const got = String(input.candidateLabel || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (want && got) {
    if (want === got) score = Math.max(score, 95);
    else if (got.includes(want) || want.includes(got)) score = Math.max(score, 88);
    else {
      const a = new Set(want.split(" ").filter(Boolean));
      const b = new Set(got.split(" ").filter(Boolean));
      const overlap = [...a].filter((t) => b.has(t)).length;
      const ratio = overlap / Math.max(a.size, b.size, 1);
      if (ratio >= 0.6) score = Math.max(score, 80);
      else if (ratio >= 0.4) score = Math.max(score, 72);
      else score = Math.min(score, 55);
    }
  }
  if (input.originalRole && new RegExp(`getByRole\\(\\s*['"]${input.originalRole}['"]`, "i").test(input.candidateLocator)) {
    score = Math.min(100, score + 3);
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function stripHardWaits(code: string): { code: string; replaced: number } {
  let replaced = 0;
  const next = String(code || "").replace(
    /await\s+page\.waitForTimeout\(\s*\d+\s*\)\s*;?/g,
    () => {
      replaced++;
      return `await page.waitForLoadState('domcontentloaded')`;
    }
  );
  return { code: next, replaced };
}

export function ensureLoadingSettle(code: string): string {
  const src = String(code || "");
  if (!src.includes("waitForLoadState") || src.includes("[aria-busy=\"true\"]")) return src;
  return src.replace(
    /(await page\.waitForLoadState\(['"]domcontentloaded['"]\)\s*;)/,
    `$1\n  ${LOADING_SETTLE_SNIPPET}`
  );
}
