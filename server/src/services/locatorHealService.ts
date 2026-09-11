// Deterministic locator self-heal for changed crawl pages.
// Rewrites stale locators using fresh ElementRecords and emits actionable suggestions.

import fs from "fs";
import { db } from "../db.js";
import type { ElementRecord } from "../crawler/types.js";
import { normalizeLabel } from "../crawler/diff.js";
import {
  normalizeLocatorExpression,
  scoreStableLocator,
  stripTransientLoadingLabel,
  stableRoleNameExpr,
  analyzeGeneratedScript,
  scoreHealCandidate,
  HEAL_AUTO_MIN,
  HEAL_SUGGEST_MIN,
  stripHardWaits,
  ensureLoadingSettle,
  extractQuotedFieldLabel,
  fieldLocatorFallbacks,
  isBrowserChromeLabel,
} from "../crawler/locatorQuality.js";

export interface HealSuggestion {
  from: string;
  to: string;
  reason: string;
  confidence?: number;
  applied?: boolean;
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
  // Prefer a11y locators; demote raw #id and loading-state names.
  const score = (loc: string): number => {
    let s = scoreStableLocator(loc);
    if (preferredRole && new RegExp(`getByRole\\(\\s*['"]${preferredRole}['"]`).test(loc)) s += 10;
    return s;
  };
  if (el.label) {
    const idle = stripTransientLoadingLabel(el.label);
    if (idle && (el.type === "button" || preferredRole === "button")) {
      ranked.push(`page.getByRole("button", { name: ${JSON.stringify(idle)} })`);
    }
    if (idle && (el.type === "input" || el.type === "textarea" || preferredRole === "textbox")) {
      ranked.push(`page.getByLabel(${JSON.stringify(idle)})`);
      ranked.push(`page.getByRole("textbox", { name: ${JSON.stringify(idle)} })`);
    }
  }
  ranked.sort((a, b) => score(b) - score(a));
  const best = ranked[0];
  return best ? ensureFirst(normalizeLocatorExpression(best)) : null;
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

    const tc = db.prepare(`SELECT title FROM test_cases WHERE id = ?`).get(tcId) as { title: string } | undefined;
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
        const from = match;
        const to = best;
        if (stripPagePrefix(from).replace(/\.first\(\)/g, "") === stripPagePrefix(to).replace(/\.first\(\)/g, "")) {
          if (!/\.first\s*\(/.test(match)) {
            const next = `${match}.first()`;
            suggestions.push({ from: match, to: next, reason: "Add .first() to avoid strict-mode multi-match failures", confidence: 78, applied: true });
            return next;
          }
          return match;
        }
        const confidence = scoreHealCandidate({
          originalRole: parts.role,
          originalName: parts.name,
          candidateLocator: to,
          candidateLabel: el.label,
        });
        let reason = "Refresh locator from latest crawl element inventory";
        if (looksLikeUrl(parts.name || "")) reason = "Replace URL-like accessible name with a stable locator";
        else if (parts.name && el.label && normalizeLabel(parts.name) !== normalizeLabel(el.label)) {
          reason = `Label drifted ("${parts.name}" → "${el.label}")`;
        } else if (/getByTestId|getByLabel|getByRole|getByPlaceholder/.test(to)) {
          reason = "Prefer accessibility locators over brittle CSS ids";
        }
        if (confidence < HEAL_SUGGEST_MIN) {
          suggestions.push({ from, to, reason: `${reason} — rejected (confidence ${confidence} < ${HEAL_SUGGEST_MIN})`, confidence, applied: false });
          return match;
        }
        if (confidence < HEAL_AUTO_MIN) {
          suggestions.push({ from, to, reason: `${reason} — suggest only (confidence ${confidence})`, confidence, applied: false });
          return match;
        }
        suggestions.push({ from, to, reason, confidence, applied: true });
        return to;
      }
    );

    // 2) textbox/searchbox/input .click() → .fill(...) (common crawl codegen bug)
    code = code.replace(
      /(await\s+)(page\.(?:getByRole\(\s*['"]textbox['"][^)]*\)|getByRole\(\s*['"]searchbox['"][^)]*\)|getByLabel\([^)]*\)|getByPlaceholder\([^)]*\)|locator\([^)]*\))(?:\.first\(\))?)\.click\(\)/g,
      (_m, awaitKw, locatorExpr) => {
        const to = `${awaitKw}${locatorExpr}.fill('test value', { timeout: 10000 })`;
        suggestions.push({
          from: `${awaitKw}${locatorExpr}.click()`,
          to,
          reason: "Inputs should be filled, not clicked — click times out when the field is obscured/hidden",
        });
        return to;
      }
    );

    // 2b) input[type=search] is role searchbox, not textbox
    if (/getByRole\(\s*['"]textbox['"]/.test(code) && /[Ss]earch/.test(code)) {
      const next = code.replace(
        /getByRole\(\s*(['"])textbox\1(\s*,\s*\{\s*name:\s*(['"])([^'"]*[Ss]earch[^'"]*)\3)/g,
        'getByRole("searchbox"$2'
      );
      if (next !== code) {
        suggestions.push({
          from: 'getByRole("textbox", { name: "...Search..." })',
          to: 'getByRole("searchbox", { name: "...Search..." })',
          reason: "HTML search inputs use ARIA role searchbox",
        });
        code = next;
      }
    }

    // 2c) Never click filter chips like All as if they were submit
    if (/getByRole\(\s*['"]button['']\s*,\s*\{\s*name:\s*['"]All['"]/.test(code)) {
      const next = code.replace(
        /page\.getByRole\(\s*['"]button['']\s*,\s*\{\s*name:\s*['"]All['']\s*\}\)(?:\.first\(\))?/g,
        'page.getByRole("button", { name: /Search/i }).first()'
      );
      if (next !== code) {
        suggestions.push({
          from: 'getByRole("button", { name: "All" })',
          to: 'getByRole("button", { name: /Search/i })',
          reason: '"All" is a filter chip, not the search submit control',
        });
        code = next;
      }
    }

    // 2d) Remove scrollIntoViewIfNeeded — it times out on collapsed/hidden controls
    if (code.includes("scrollIntoViewIfNeeded")) {
      const next = code.replace(/^\s*await [^\n]+\.scrollIntoViewIfNeeded\(\);\s*\n/gm, "");
      if (next !== code) {
        suggestions.push({
          from: "await locator.scrollIntoViewIfNeeded()",
          to: "(removed)",
          reason: "scrollIntoViewIfNeeded times out when the target is hidden (e.g. collapsed search)",
        });
        code = next;
      }
    }

    // 2e) For search scenarios, open toggle before fill when missing
    if (/\bsearch\b/i.test(tc?.title || "") && !/toggle search/i.test(code) && /\.fill\(/.test(code)) {
      code = code.replace(
        /(await page\.waitForLoadState\(['"]domcontentloaded['"]\);\s*\n)/,
        `$1  await page.getByRole('button', { name: /toggle search|open search|show search/i }).first().click({ timeout: 3000 }).catch(() => {});\n`
      );
      suggestions.push({
        from: "search fill",
        to: "open Toggle search then fill",
        reason: "Search field is often inside a collapsed panel",
      });
    }

    // 2f) Harden plain .click() — carousels/animations never report "stable"
    {
      const next = code.replace(
        /\.click\(\s*\{([^}]*)\}\s*\)/g,
        (full, inner: string) => {
          if (/\bforce\s*:/.test(inner)) return full;
          const trimmed = inner.trim().replace(/,\s*$/, "");
          return `.click({ ${trimmed}${trimmed ? ", " : ""}force: true })`;
        }
      ).replace(/\.click\(\s*\)/g, ".click({ force: true })");
      if (next !== code) {
        suggestions.push({
          from: ".click(...)",
          to: ".click({ ..., force: true })",
          reason: "force:true avoids Timeout waiting for element to be stable (carousels/CSS transitions)",
        });
        code = next;
      }
    }

    // 2g–2i) Deterministic heals that do not require a fresh element inventory
    {
      const det = applyDeterministicScriptHeals(code);
      if (det.code !== code) {
        suggestions.push(...det.suggestions);
        code = det.code;
      }
    }

    // 3) Soft suggestion only — do not re-inject scrollIntoView (it caused product-bug false positives)
    if (suggestions.length > 0 && !code.includes("force: true") && /await page\./.test(code)) {
      suggestions.push({
        from: "interaction",
        to: "prefer visible targets / open collapsed panels before fill",
        reason: "Prefer opening collapsed UI (Toggle search) over scrolling hidden elements",
      });
    }

    const uniqueSuggestions = dedupeSuggestions(suggestions);
    const codeChanged = code !== script.code;
    if (codeChanged) {
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
        replacements: uniqueSuggestions.filter((s) => s.from !== "interaction" && s.applied !== false).length,
        healed: codeChanged,
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
    persistScriptQuality(script.id, codeChanged ? code : script.code, uniqueSuggestions);
  }

  return results;
}

function persistScriptQuality(scriptId: string, code: string, suggestions?: HealSuggestion[]) {
  try {
    const report = analyzeGeneratedScript(code);
    const prior = db.prepare("SELECT heal_events_json FROM automation_scripts WHERE id = ?").get(scriptId) as
      | { heal_events_json?: string }
      | undefined;
    let events: unknown[] = [];
    try {
      events = JSON.parse(prior?.heal_events_json || "[]");
      if (!Array.isArray(events)) events = [];
    } catch {
      events = [];
    }
    if (suggestions?.length) {
      events.push({
        at: new Date().toISOString(),
        suggestions: suggestions.slice(0, 40),
      });
    }
    db.prepare(
      "UPDATE automation_scripts SET locator_quality_json = ?, readiness_score = ?, heal_events_json = ? WHERE id = ?"
    ).run(JSON.stringify(report), report.readiness.overall, JSON.stringify(events.slice(-20)), scriptId);
  } catch {
    /* quality columns may not exist yet on very old DBs mid-migration */
  }
}

export { persistScriptQuality };

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
 * Inventory-free heals applied to any generated Playwright script:
 * - strip loading-state button names ("Sending…", "Loading…", …)
 * - rewrite brittle locator('#id').fill after a labeled fill comment to getByLabel/role
 * - raise test.setTimeout for multi-hop page.goto flows
 */
export function applyDeterministicScriptHeals(code: string): { code: string; suggestions: HealSuggestion[] } {
  let next = code;
  const suggestions: HealSuggestion[] = [];

  // Loading-state accessible names → stable regex
  next = next.replace(
    /getByRole\(\s*(['"])(button|link)\1\s*,\s*\{\s*name:\s*(['"])([^'"]+)\3\s*\}\s*\)/g,
    (full, q1, role, _q2, name) => {
      const stable = stableRoleNameExpr(name);
      if (!stable) return full;
      const to = `getByRole(${q1}${role}${q1}, { name: /${stable.regexSource}/i })`;
      suggestions.push({
        from: full,
        to,
        reason: "Strip transient loading-state label from button/link accessible name",
      });
      return to;
    }
  );

  next = next.replace(
    /^\s*await page\.(getByRole|getByLabel|getByText)\([^;\n]*(Switch to dark mode|Report this website|Close report abuse|report abuse panel)[^;\n]*;\s*\n/gim,
    "  // skipped browser/hosting chrome control\n"
  );

  next = next.replace(
    /page\.getByLabel\(\s*['"]t a valid email into['"]\)(?:\.or\(page\.getByRole\('textbox',\s*\{\s*name:\s*['"]t a valid email into['"]\s*\}\)\))?/g,
    fieldLocatorFallbacks("email")
  );
  next = next.replace(
    /page\.getByRole\(\s*['"]textbox['"]\s*,\s*\{\s*name:\s*['"]Your email\*['"]\s*\}\)/g,
    fieldLocatorFallbacks("email")
  );

  // locator('#id').fill preceded by a fill comment → label/type locator (double-quoted field only)
  next = next.replace(
    /(\/\/[^\n]*\n)(\s*)await\s+page\.locator\(\s*["']#([^"']+)["']\s*\)(\.first\(\))?\.fill\(/g,
    (full, comment, indent, _id, first = ".first()") => {
      const label = extractQuotedFieldLabel(comment);
      if (!label || isBrowserChromeLabel(label)) return full;
      const loc = fieldLocatorFallbacks(label);
      const to = `${comment}${indent}await ${loc}${first || ".first()"}.fill(`;
      suggestions.push({
        from: `locator("#${_id}").fill`,
        to: `${loc}.fill`,
        reason: "Prefer label/type locators over brittle #id for form fills",
      });
      return to;
    }
  );

  // Multi-hop flows: ensure an adequate per-test timeout when many gotos exist
  const gotoCount = (next.match(/page\.goto\(/g) || []).length;
  if (gotoCount >= 3 && !/test\.setTimeout\s*\(/.test(next)) {
    const timeoutMs = Math.max(90_000, gotoCount * 25_000);
    const withTimeout = next.replace(
      /(test\([^\n]+,\s*async\s*\(\s*\{\s*page\s*\}\s*\)\s*=>\s*\{\s*\n)/,
      `$1  test.setTimeout(${timeoutMs});\n`
    );
    if (withTimeout !== next) {
      suggestions.push({
        from: "test(...)",
        to: `test.setTimeout(${timeoutMs})`,
        reason: "Multi-hop page.goto flows need more than the suite fast-mode 25s budget",
      });
      next = withTimeout;
    }
  }

  // Normalize any remaining loading-state names via shared helper
  const normalized = next.replace(
    /page\.(getByRole|getByText)\([^;]*?\)/g,
    (expr) => {
      const healed = normalizeLocatorExpression(expr);
      if (healed !== expr) {
        suggestions.push({
          from: expr,
          to: healed,
          reason: "Normalize locator expression (strip loading-state names)",
        });
      }
      return healed;
    }
  );
  next = normalized;

  const waits = stripHardWaits(next);
  if (waits.replaced > 0) {
    suggestions.push({
      from: "page.waitForTimeout(...)",
      to: "page.waitForLoadState('domcontentloaded')",
      reason: "Replace hard-coded waits with application-state synchronization",
      applied: true,
      confidence: 92,
    });
    next = waits.code;
  }
  const withSettle = ensureLoadingSettle(next);
  if (withSettle !== next) {
    suggestions.push({
      from: "waitForLoadState",
      to: "waitForLoadState + loading indicator settle",
      reason: "Wait for aria-busy/progressbar/spinner to disappear before continuing",
      applied: true,
      confidence: 85,
    });
    next = withSettle;
  }

  return { code: next, suggestions: dedupeSuggestions(suggestions) };
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
           WHERE site_id = ? AND change_status IN ('changed', 'new', 'restored')`
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
