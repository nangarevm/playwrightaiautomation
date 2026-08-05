# Code Completions — Current Implementation Snapshot

**Date:** 2026-08-03
**Relationship to other docs:** [`GAP_ANALYSIS.md`](GAP_ANALYSIS.md) (dated 2026-08-02) is the authoritative, live-verified FR/AC-level record — 109 acceptance criteria individually checked against a running server. This doc does **not** replace that rigor. Its job is narrower: the client has grown substantially since that pass, and GAP_ANALYSIS.md's biggest finding — *"Screen Explorer and ~10 other feature areas are backend-only, no frontend UI"* — is now stale. This snapshot corrects that specific claim by reading the current `client/src` and points back to GAP_ANALYSIS.md for anything not mentioned here.

**Method:** static inspection, not live testing — grepped `client/src/pages/*.tsx` (11 pages, ~4,200 lines) for FR-tagged comments and feature keywords, cross-checked against `server/src/routes/*`. Anything claiming "done" below is "a UI for it exists and calls the right endpoint," not "re-verified live against a running server." Treat this as a map of *where things live*, not a substitute for re-running GAP_ANALYSIS.md's acceptance-criteria pass.

---

## 1. Frontend UI built since the last gap-analysis pass

GAP_ANALYSIS.md's "What genuinely remains open" section listed these as backend-complete, API-only. All now have a page:

| Feature | FR(s) | Page | Notes |
|---|---|---|---|
| Screen Explorer | FR-1.10, FR-2.14, FR-4.18, FR-5.7–5.10, FR-6.8 | `Screens.tsx` | The single largest gap called out in GAP_ANALYSIS.md — list, changed/unchanged filter, screen-scoped run, visual-diff view, coverage-gap flags all present |
| Duplicate/near-dup resolution | FR-2.16 | `Screens.tsx` | Flag review + resolve (merge/discard/keep-both) |
| Bulk test-case actions | FR-2.15 | `AiStudio.tsx` | |
| Data-driven test rows | FR-2.17 | `AiStudio.tsx` | |
| Library search/filter | FR-2.18 | `AiStudio.tsx` | |
| Environments management | FR-4.19, FR-4.20 | `Environments.tsx` | Named environments, credentials, pre-flight health check |
| Secrets registry + injection | FR-4.21 | `Execution.tsx` | |
| Execution-profile version history | FR-4.23 | `Execution.tsx` | |
| Ultrafast/Fast speed modes (SRS v4.6) | FR-4.24–4.30 | `Execution.tsx`, `AiStudio.tsx`, `Crawler.tsx`, `Settings.tsx` | |
| TestRail/Zephyr/qTest push | FR-7.5 | `AiStudio.tsx` | |
| SSO admin + project export/import | FR-8.9, FR-8.10 | `Settings.tsx` | |
| Scheduled digest / notification prefs | FR-6.9, FR-6.12 | `Settings.tsx` | |

Not found in the client (still API-only, matching GAP_ANALYSIS.md): shared-fixture visibility (FR-3.7 — arguably doesn't need one, it's transparent to the user), CI-gate non-2xx signal (FR-4.22, a caller-side concern not a UI concern).

## 2. Per-module snapshot

| Module | Backend | Frontend | Key open gap |
|---|---|---|---|
| 1 — Input Ingestion | Strong | Strong (upload, crawl, Screens.tsx catalog) | No drag-and-drop upload; video key-frame extraction needs `ffmpeg` (not present) |
| 2 — AI Test Case Generation | Strong | Strong (AiStudio.tsx covers review, bulk, dedup, search, data rows) | FR-2.11 business rules still free-text, not a managed entity |
| 3 — Automation Code Generation | Strong | Adequate | Cypress output is a fixed stub, not case-specific |
| 4 — Execution Engine | Strong | Strong (Execution.tsx is the largest page at 717 lines — modes, profiles, secrets, gating) | Multi-browser (`browser_set: all`) confirmed broken in GAP_ANALYSIS.md; real runner-pool autoscaling is infra, not code |
| 5 — Change Detection & Self-Healing | Strong | Now has Screen Explorer UI | Visual diffing is content-hash, not real pixel comparison |
| 6 — Reporting & Analytics | Strong | Strong (Home.tsx, Reports.tsx, Insights.tsx, Settings.tsx digest prefs) | Requirement coverage still a ticket-ID regex proxy, not real Jira metadata |
| 7 — Integrations Hub | Strong | Now includes TestRail/Zephyr/qTest push UI | True bi-directional sync still two one-way paths, no inbound webhook listener |
| 8 — Admin & Governance | Strong | Now includes SSO admin + export/import UI (Settings.tsx) | No real SAML/OIDC handshake; RBAC identity via `X-User-Id` header, not real login |
| 9 — Input Safety & Resilience | Strong | N/A (mostly server-side gateway behavior) | Concurrent-edit protection only covers test cases, not scripts |

## 3. Still open (carried from GAP_ANALYSIS.md, not re-verified this pass)

Real infra, not application code:
- Docker/cloud runner pool (FR-4.3/4.17)
- Video key-frame extraction — needs `ffmpeg` (FR-1.2)
- Firefox/WebKit browser binaries not installed (FR-4.1)
- Real login/session system in place of `X-User-Id` header (FR-8.1)
- Real SAML/OIDC IdP handshake (FR-8.9)

Application-level:
- Drag-and-drop upload
- Save-run-as-profile one-click action
- Real headless-browser autonomous traversal (FR-1.3b) vs. current static-HTML link/form discovery
- Real pixel-level visual diffing (FR-5.9) vs. content-hash approximation
- Real scheduled API-spec re-fetch (FR-5.2) — most specs are imported as pasted text
- True bi-directional Jira/Azure sync (FR-7.1/7.2) — no inbound webhook listener
- Real story-metadata coverage check (FR-6.3) vs. ticket-ID regex

GAP_ANALYSIS.md's acceptance-criteria pass (Section "2026-08-02 acceptance-criteria verification pass") found several **FAIL**s that are worth re-checking now that more UI exists, since a couple were UI-shaped ("zero client component renders it"): FR-6.10 (LLM cost dashboard), FR-6.12 (notification prefs) — Settings.tsx now appears to cover notification prefs per section 1 above, so that FAIL is likely stale too; worth a live re-check rather than assuming.

## 5. Single QA end-to-end run (2026-08-03, live, not static)

Unlike sections 1–4 (grep-based), this section is from an actual live run: both servers started, all 11 pages driven in a real headless-Chromium session in Single QA mode, and a full pipeline pushed through the real UI (free-text scenario → AI Studio generate/accept → Ultrafast quick-trigger → report). Zero console errors on any of the 11 pages before or after the changes below.

**Which screens Single QA actually needs — mapped against Home's own 6-step pipeline:**

| Step (Home.tsx) | Screen |
|---|---|
| Upload / Analysis | Projects |
| Generate / Review | AI Studio |
| Execute | Execution (Ultrafast quick-trigger) or Testing (per-script Fast-mode run) |
| Report | Reports / Home |

Those 6 pages (Home, Projects, AI Studio, Testing, Execution, Reports) are the **Workflow** set — everything a solo QA needs for the core loop, confirmed by actually running it. The remaining 5 (Screen Explorer, AI Crawler, Environments, Insights, Settings) are real and independently useful (Screen Explorer for change tracking, AI Crawler for automated discovery, Insights for cost/risk) but are exploratory/setup screens, not steps in the pipeline itself.

**Optimization applied:** `Sidebar.tsx` was a flat list of 11 items regardless of mode. Split into two labeled groups — **Workflow** (the 6 above) and **Tools & insights** (the other 5) — so the sidebar visually mirrors the pipeline a Single QA user is actually running, instead of making them scan 11 undifferentiated items every time.

**Bugs found and fixed while driving the flow:**
1. **Execution page showed no script list on the default "All tests" tab** (`Execution.tsx`) — the script-picker list was gated behind `scope === "selected"` only, so a fresh page load (default scope: "all") showed the toolbar and an empty "Recent runs" table with nothing else — a user couldn't see what "Create pipeline (N)" would actually include. Fixed: the list now always renders; checkboxes only appear in "selected" scope, a read-only dot marker in "all" scope.
2. **Scripts were visually indistinguishable duplicates** (`Testing.tsx`, `Settings.tsx`) — generating a script produces 3 language artifacts (TS/Python/JS) by design (FR-3.1), but the list only showed the test-case title, so 3 rows read as pure duplicates unless you noticed the truncated file extension. Fixed: added a small language badge next to the title in both places; `Settings.tsx` also had a computed-but-unused `fileName` variable that's now actually displayed.

**Confirmed working, not a bug:** a brand-new Single QA workspace has **zero Execution Profiles and zero Environments** configured (verified via `GET /execution-runs/profiles` and `GET /environments` — both return `[]`). The per-script "Run test" button on the Testing page is correctly disabled in that state (it requires an explicit profile+environment per FR-4.28, which is a Fast Mode requirement). The actual solo-QA path around this is the Execution page's **Ultrafast quick-trigger**, which gracefully falls back to "no Execution Profile configured" / "no Environment configured" and still runs — verified live, produced a real run (`FAILED`, since the mock LLM provider generates a generic login-page script regardless of the test case's actual content — a known limitation already documented elsewhere, not new). The interactive HTML report opened correctly afterward.

## 6. Keeping this current

This snapshot is grep-based and will drift the moment either page inventory or FR tagging conventions change. When re-checking:
- `grep -rhoE "FR-[0-9]+\.[0-9]+[a-z]?" client/src/pages client/src/components | sort -u` — cheap way to see what the client claims to cover.
- For anything load-bearing (a release decision, a customer-facing claim), re-run GAP_ANALYSIS.md's live-curl acceptance-criteria method instead of trusting this file — it catches things static reading can't (e.g. FR-4.1's broken `playwright.config.ts` `projects` array, which reads fine in code but throws at runtime).
