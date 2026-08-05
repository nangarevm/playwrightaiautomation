// AI Crawler: spelling check over user-visible page copy (page titles, button/
// link/label text) discovered during a crawl. Backed by a real Hunspell
// dictionary (nspell + dictionary-en), not a heuristic word list, so it catches
// genuine typos ("Plase enter your email") rather than just flagging anything
// unfamiliar.

import nspell from "nspell";
import dictionary from "dictionary-en";
import type { ElementRecord, SpellingIssue } from "./types.js";

// UI/product terms that are correct in context but absent from (or flagged
// oddly by) a general-English dictionary -- kept short and deliberately
// conservative so real typos still surface.
const CUSTOM_ALLOWLIST = new Set([
  "dropdown", "dropdowns", "checkbox", "checkboxes", "signup", "signin", "signout",
  "logout", "login", "logins", "wishlist", "checkout", "backend", "frontend",
  "hyperlink", "hyperlinks", "sitemap", "changelog", "homepage", "filename",
  "filenames", "username", "usernames", "hostname", "hostnames", "whitelist",
  "blocklist", "allowlist", "denylist", "autofill", "autocomplete", "breadcrumb",
  "breadcrumbs", "onboarding", "unsubscribe", "subtotal", "webpage", "webpages",
  "url", "urls", "api", "apis", "faq", "faqs", "sku", "skus", "ui", "ux", "cta",
  "otp", "pdf", "csv", "jpg", "png",
]);

let speller: ReturnType<typeof nspell> | null = null;
function getSpeller() {
  if (!speller) speller = nspell(dictionary as any);
  return speller;
}

// A token is skipped (not spell-checked) rather than flagged when it's more
// likely to be an identifier/placeholder than prose: camelCase/PascalCase
// (e.g. "userId"), ALLCAPS acronyms, anything with a digit, or single/double
// letter tokens.
function looksLikeIdentifier(word: string): boolean {
  if (word.length <= 2) return true;
  if (/\d/.test(word)) return true;
  if (word === word.toUpperCase()) return true; // acronym, not a typo target
  if (/[a-z][A-Z]/.test(word)) return true; // camelCase/PascalCase
  return false;
}

export function checkText(text: string, context: string): SpellingIssue[] {
  if (!text) return [];
  const spell = getSpeller();
  const words = text.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g) ?? [];

  const issues: SpellingIssue[] = [];
  const seen = new Set<string>();
  for (const word of words) {
    const lower = word.toLowerCase();
    if (seen.has(lower)) continue;
    if (looksLikeIdentifier(word)) continue;
    if (CUSTOM_ALLOWLIST.has(lower)) continue;
    if (spell.correct(word)) continue;
    seen.add(lower);
    issues.push({ word, suggestions: spell.suggest(word).slice(0, 3), context });
  }
  return issues;
}

// Aggregates spelling issues for a whole crawled page: the title plus every
// interactive element's visible label (buttons, links, form labels, etc.).
export function collectPageSpellingIssues(title: string, elements: ElementRecord[]): SpellingIssue[] {
  const issues: SpellingIssue[] = [...checkText(title, "page title")];
  for (const el of elements) {
    issues.push(...checkText(el.label, `${el.type} label`));
  }
  return issues;
}
