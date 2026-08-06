// Component Inventory: a structural DOM scan distinct from locators.ts's
// per-INTERACTIVE-ELEMENT extraction. That module answers "what can I click/
// fill and how do I locate it"; this one answers a coarser, page-level
// question -- "what kinds of UI components does this page have" (header,
// navbar, forms, tables, modals, filters, pagination, cards, footer, ...) --
// so a reviewer can see page composition at a glance BEFORE test cases are
// generated, instead of only ever seeing a flat list of clickable elements.
//
// Heuristic and DOM-pattern-based (role/tag first, common class-name
// substrings as a fallback for sites that don't use semantic HTML/ARIA) --
// deliberately not exhaustive or ML-driven, consistent with the rest of this
// crawler's best-effort approach (see interaction.ts, spellcheck.ts).

import type { Page } from "playwright";

export interface ComponentInventoryItem {
  kind: string; // stable machine key, e.g. "forms"
  label: string; // display label, e.g. "Forms"
  count: number;
  samples: string[]; // up to 3 short identifying labels (form name, table caption, ...)
}

// NOTE: this callback is passed to page.evaluate(), which sends only the
// function's own toString() into the browser context -- it can't reference
// anything from the outer (Node-side) module scope. It deliberately avoids
// named `const foo = () => {}` helpers inside the callback: under tsx's dev
// transform those get wrapped in an esbuild `__name(fn, "foo")` call for
// name-preservation, and since `__name`'s own definition lives in the
// surrounding module (not sent to the browser), the callback fails at
// runtime with "ReferenceError: __name is not defined" the moment such a
// helper is invoked. Everything below is written inline for that reason.
export async function collectComponentInventory(page: Page): Promise<ComponentInventoryItem[]> {
  const raw = await page
    .evaluate(() => {
      // Every helper below is inlined at its call site (no named function
      // declarations/const-arrows) -- see the note above this function for why.
      const modalClassEls = Array.from(document.querySelectorAll("[class]")).filter((el) =>
        (el.getAttribute("class") || "").toLowerCase().includes("modal")
      );
      const filterClassEls = Array.from(document.querySelectorAll("[class]")).filter((el) =>
        (el.getAttribute("class") || "").toLowerCase().includes("filter")
      );
      const paginationClassEls = Array.from(document.querySelectorAll("[class]")).filter((el) =>
        (el.getAttribute("class") || "").toLowerCase().includes("pagination")
      );
      const cardClassEls = Array.from(document.querySelectorAll("[class]")).filter((el) =>
        (el.getAttribute("class") || "").toLowerCase().includes("card")
      );

      const buckets: Array<{ kind: string; label: string; els: Element[] }> = [
        { kind: "header", label: "Header", els: Array.from(document.querySelectorAll('header, [role="banner"]')) },
        { kind: "navbar", label: "Navbar", els: Array.from(document.querySelectorAll('nav, [role="navigation"]')) },
        { kind: "forms", label: "Forms", els: Array.from(document.querySelectorAll("form")) },
        {
          kind: "buttons",
          label: "Buttons",
          els: Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]')),
        },
        { kind: "dropdowns", label: "Dropdowns", els: Array.from(document.querySelectorAll('select, [role="listbox"], [role="combobox"]')) },
        { kind: "tables", label: "Tables", els: Array.from(document.querySelectorAll('table, [role="table"], [role="grid"]')) },
        {
          kind: "modals",
          label: "Modals",
          els: Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]')).concat(modalClassEls),
        },
        {
          kind: "filters",
          label: "Filters",
          els: Array.from(document.querySelectorAll('[aria-label*="filter" i]')).concat(filterClassEls),
        },
        {
          kind: "pagination",
          label: "Pagination",
          els: Array.from(document.querySelectorAll('[aria-label*="pagination" i], nav[aria-label*="page" i]')).concat(paginationClassEls),
        },
        {
          kind: "cards",
          label: "Cards",
          els: Array.from(document.querySelectorAll('article, [role="article"]')).concat(cardClassEls),
        },
        { kind: "footer", label: "Footer", els: Array.from(document.querySelectorAll('footer, [role="contentinfo"]')) },
      ];

      const out: Array<{ kind: string; label: string; count: number; samples: string[] }> = [];
      for (const b of buckets) {
        // De-dup elements matched by more than one selector in the same bucket
        // (e.g. a `<div role="dialog" class="modal">` matches both modal selectors).
        const unique = Array.from(new Set(b.els));
        const visible = unique.filter((el) => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });
        if (visible.length === 0) continue;
        const samples: string[] = [];
        for (const el of visible) {
          const t = (el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40);
          if (t.length > 0) samples.push(t);
          if (samples.length >= 3) break;
        }
        out.push({ kind: b.kind, label: b.label, count: visible.length, samples });
      }
      return out;
    })
    .catch(() => [] as ComponentInventoryItem[]);

  return raw;
}
