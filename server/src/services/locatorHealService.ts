// Deterministic locator self-heal for changed crawl pages.
// Rewrites stale locators using fresh ElementRecords and emits actionable suggestions.

import fs from "fs";
import { db } from "../db.js";
import type { ElementRecord } from "../crawler/types.js";
import { normalizeLabel } from "../crawler/diff.js";

export interface HealSuggestion {
  from: string;
  to: string;
  reason: string;
}

export interface HealResult {
  scriptId: string;
  testCaseId: string;
  replacements: number;
  healed: boolean;
  suggestions: HealSuggestion[];
}

function looksLikeUrl(value: string): boolean {
  return /^(https?:\/\/|www\.|\/[\w.-]+)/i.test(value.trim()) || /^https?:\/\//i.test(value);
}

function stripPagePrefix(expr: string): string {
  return expr.replace(/^page\./, "");
}

function ensureFirst(expr: string): string {
  let withPage = expr.trim();
  if (!withPage.startsWith("page.")) withPage = `page.${withPage}`;
  if (/\.first\s*\(\s*\)\s*$/.test(withPage)) return withPage;
  return `${withPage}.first()`;
}

function pickBestLocator(el: ElementRecord, preferredRole?: string): string | null {
  const ranked = [...(el.locators || [])];
  // Prefer non-URL role/text names, then id/name CSS, then anything else
  const score = (loc: string): number => {
    let s = 0;
    if (/getByTestId/.test(loc)) s += 50;
    if (/locator\(["']#/.test(loc)) s += 45;
    if (/locator\(["']\[name=/.test(loc)) s += 42;
    if (/getByLabel/.test(loc)) s += 40;
    if (/getByRole/.test(loc)) s += 35;
    if (/getByPlaceholder/.test(loc)) s += 30;
    if (/getByText/.test(loc)) s += 20;
    if (preferredRole && new RegExp(`getByRole\\(\\s*['"]${preferredRole}['"]`).test(loc)) s += 10;
    const nameMatch = loc.match(/name:\s*['"]([^'"]+)['"]/) || loc.match(/getByText\(\s*['"]([^'"]+)['"]/);
    if (nameMatch && looksLikeUrl(nameMatch[1])) s -= 40;
    if (/locator\(\s*['"]a['"]\s*\)/.test(loc)) s -= 20; // too generic
    return s;
  };
  ranked.sort((a, b) => score(b) - score(a));
  const best = ranked[0];
  return best ? ensureFirst(best) : null;
}

function mapRoleToType(role: string): string {
  const r = role.toLowerCase();
  if (r === "button") return "button";
  if (r === "link") return "link";
  if (r === "textbox" || r === "searchbox") return "input";
  if (r === "checkbox") return "checkbox";
  if (r === "combobox" || r === "listbox") return "dropdown";
  return r;
}

function findBestElement(elements: ElementRecord[], role: string | null, name: string): ElementRecord | undefined {
  const wantType = role ? mapRoleToType(role) : null;
  const want = normalizeLabel(name);
  let best: ElementRecord | undefined;
  let bestScore = 0;
  for (const el of elements) {
    const elType = (el.type || "").toLowerCase();
    if (wantType && elType !== wantType && !(wantType === "input" && (elType === "textarea" || elType === "input"))) {
      // still allow cross-type if labels match strongly (role drift)
      if (normalizeLabel(el.label) !== want) continue;
    }
    const label = normalizeLabel(el.label);
    if (!label && !el.locators?.length) continue;
    let score = 0;
    if (label === want) score = 1;
    else if (label && (label.includes(want) || want.includes(label))) score = 0.72;
    else if (label) {
      const a = new Set(want.split(" ").filter(Boolean));
      const b = new Set(label.split(" ").filter(Boolean));
      const overlap = [...a].filter((t) => b.has(t)).length;
      score = overlap / Math.max(a.size, b.size, 1);
    }
    // Prefer elements that don't use URL-like labels
    if (looksLikeUrl(el.label || "")) score *= 0.2;
    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return bestScore >= 0.45 ? best : undefined;
}

function extractLocatorParts(match: string): { role: string | null; name: string | null; raw: string } {
  const roleName = match.match(/getByRole\(\s*['"](\w+)['"]\s*,\s*\{\s*name:\s*['"]([^'"]+)['"]/);
  if (roleName) return { role: roleName[1], name: roleName[2], raw: match };
  const byText = match.match(/getBy(?:Text|Label|Placeholder)\(\s*['"]([^'"]+)['"]/);
  if (byText) return { role: null, name: byText[1], raw: match };
  const byTestId = match.match(/getByTestId\(\s*['"]([^'"]+)['"]/);
  if (byTestId) return { role: null, name: byTestId[1], raw: match };
  const locator = match.match(/locator\(\s*['"]([^'"]+)['"]/);
  if (locator) return { role: null, name: locator[1], raw: match };
  return { role: null, name: null, raw: match };
}

/**
 * For each generated test case linked to scenarios on this page, rewrite
 * stale locators using the new element inventory and produce suggestions.
 */
export function healScriptsForChangedPage(pageId: string, elements: ElementRecord[]): HealResult[] {
  const scenarios = db
    .prepare(
      `SELECT generated_test_case_id FROM crawl_scenarios
       WHERE page_id = ? AND status = 'active' AND generated_test_case_id IS NOT NULL`
    )
    .all(pageId) as Array<{ generated_test_case_id: string }>;

  const results: HealResult[] = [];
  const byKey = new Map<string, ElementRecord>();
  for (const el of elements) {
    byKey.set(`${(el.type || "").toLowerCase()}::${normalizeLabel(el.label)}`, el);
  }

  for (const s of scenarios) {
    const tcId = s.generated_test_case_id;
    const script = db
      .prepare(
        `SELECT id, code, file_path FROM automation_scripts
         WHERE test_case_id = ? ORDER BY created_at DESC LIMIT 1`
      )
      .get(tcId) as { id: string; code: string; file_path: string | null } | undefined;
    if (!script?.code) continue;

    let code = script.code;
    const suggestions: HealSuggestion[] = [];

    // 1) Rewrite locator expressions that drifted or use weak/URL names
    code = code.replace(
      /page\.(getByRole|getByText|getByLabel|getByTestId|getByPlaceholder|locator)\([^;]*?\)(?:\.first\(\))?/g,
      (match) => {
        const parts = extractLocatorParts(match);
        if (!parts.name && !parts.role) return match;

        let el: ElementRecord | undefined;
        if (parts.role && parts.name) {
          el = byKey.get(`${mapRoleToType(parts.role)}::${normalizeLabel(parts.name)}`);
        }
        if (!el && parts.name) {
          el = findBestElement(elements, parts.role, parts.name);
        }

        // URL used as accessible name — try to find a better link/button on the page
        if ((!el || looksLikeUrl(parts.name || "")) && parts.role === "link") {
          const nonUrlLinks = elements.filter((e) => e.type === "link" && !looksLikeUrl(e.label || ""));
          if (nonUrlLinks.length === 1) el = nonUrlLinks[0];
          else if (parts.name) {
            const hrefNeedle = parts.name.replace(/^https?:\/\//, "").slice(0, 40);
            el =
              elements.find(
                (e) =>
                  e.type === "link" &&
                  (e.locators || []).some((l) => l.includes(hrefNeedle) || l.includes(parts.name!))
              ) || el;
          }
        }

        if (!el) {
          // Still ensure .first() for stability
          if (!/\.first\s*\(/.test(match)) {
            const next = `${match}.first()`;
            suggestions.push({
              from: match,
              to: next,
              reason: "Add .first() to avoid strict-mode multi-match failures",
            });
            return next;
          }
          return match;
        }

        const best = pickBestLocator(el, parts.role || undefined);
        if (!best) return match;
        const from = match.endsWith(".first()") ? match : match;
        const to = best;
        if (stripPagePrefix(from).replace(/\.first\(\)/g, "") !== stripPagePrefix(to).replace(/\.first\(\)/g, "")) {
          let reason = "Refresh locator from latest crawl element inventory";
          if (looksLikeUrl(parts.name || "")) reason = "Replace URL-like accessible name with a stable locator";
          else if (parts.name && el.label && normalizeLabel(parts.name) !== normalizeLabel(el.label)) {
            reason = `Label drifted ("${parts.name}" → "${el.label}")`;
          } else if (/getByTestId|locator\(["']#|locator\(["']\[name=/.test(to)) {
            reason = "Prefer testid/id/name over role/text for stability";
          }
          suggestions.push({ from, to, reason });
          return to;
        }
        if (!/\.first\s*\(/.test(match)) {
          const next = `${match}.first()`;
          suggestions.push({ from: match, to: next, reason: "Add .first() to avoid strict-mode multi-match failures" });
          return next;
        }
        return match;
      }
    );

    // 2) textbox/searchbox/input .click() → .fill(...) (common crawl codegen bug)
    code = code.replace(
      /(await\s+)(page\.(?:getByRole\(\s*['"]textbox['"][^)]*\)|getByRole\(\s*['"]searchbox['"][^)]*\)|getByLabel\([^)]*\)|getByPlaceholder\([^)]*\)|locator\([^)]*\))(?:\.first\(\))?)\.click\(\)/g,
      (_m, awaitKw, locatorExpr) => {
        const to = `${awaitKw}${locatorExpr}.fill('test@example.com')`;
        suggestions.push({
          from: `${awaitKw}${locatorExpr}.click()`,
          to,
          reason: "Inputs should be filled, not clicked — click times out when the field is obscured/hidden",
        });
        return to;
      }
    );

    // 3) Before click/fill, suggest scrollIntoView when missing (inject helper once)
    if (suggestions.length > 0 && !code.includes("scrollIntoViewIfNeeded") && /await page\./.test(code)) {
      // Soft suggestion only recorded — avoid rewriting every interaction line aggressively
      suggestions.push({
        from: "interaction",
        to: "await locator.scrollIntoViewIfNeeded()",
        reason: "Scroll target into view before click/fill when elements are off-screen or in collapsed panels",
      });
    }

    const uniqueSuggestions = dedupeSuggestions(suggestions);
    if (uniqueSuggestions.length > 0 && uniqueSuggestions.some((s) => s.from !== "interaction")) {
      db.prepare("UPDATE automation_scripts SET code = ? WHERE id = ?").run(code, script.id);
      if (script.file_path) {
        try {
          fs.writeFileSync(script.file_path, code, "utf-8");
        } catch (err: any) {
          console.warn(`[heal] failed to write ${script.file_path}: ${err?.message || err}`);
        }
      }
      results.push({
        scriptId: script.id,
        testCaseId: tcId,
        replacements: uniqueSuggestions.filter((s) => s.from !== "interaction").length,
        healed: true,
        suggestions: uniqueSuggestions,
      });
    } else {
      results.push({
        scriptId: script.id,
        testCaseId: tcId,
        replacements: 0,
        healed: false,
        suggestions: uniqueSuggestions,
      });
    }
  }

  return results;
}

function dedupeSuggestions(items: HealSuggestion[]): HealSuggestion[] {
  const seen = new Set<string>();
  const out: HealSuggestion[] = [];
  for (const s of items) {
    const key = `${s.from}=>${s.to}::${s.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/**
 * Heal scripts for pages marked changed/new in a site.
 * Optional pageIds limits healing to the impact-suite plan.
 */
export function healScriptsForSiteDelta(
  siteId: string,
  pageIds?: string[]
): { healed: number; checked: number; details: HealResult[]; suggestions: HealSuggestion[] } {
  const pages = pageIds?.length
    ? (db
        .prepare(
          `SELECT id, elements_json FROM crawl_pages
           WHERE site_id = ? AND id IN (${pageIds.map(() => "?").join(",")})`
        )
        .all(siteId, ...pageIds) as Array<{ id: string; elements_json: string }>)
    : (db
        .prepare(
          `SELECT id, elements_json FROM crawl_pages
           WHERE site_id = ? AND change_status IN ('changed', 'new')`
        )
        .all(siteId) as Array<{ id: string; elements_json: string }>);

  const details: HealResult[] = [];
  for (const p of pages) {
    let elements: ElementRecord[] = [];
    try {
      elements = JSON.parse(p.elements_json || "[]");
    } catch {
      continue;
    }
    details.push(...healScriptsForChangedPage(p.id, elements));
  }
  return {
    healed: details.filter((d) => d.healed).length,
    checked: details.length,
    details,
    suggestions: details.flatMap((d) => d.suggestions).slice(0, 50),
  };
}
