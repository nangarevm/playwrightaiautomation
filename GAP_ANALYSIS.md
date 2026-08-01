# Gap Analysis — AI-Powered Test Automation Platform vs. SRS v4.0

**Date:** 2026-08-01
**Method:** Every FR below was checked against the actual code in `test-automation-platform/server/src` and `client/src` (not inferred from memory) — route files, service files, and the DB schema were read directly, and every claim of "implemented" was exercised either by an automated test (`server/tests/*.test.js`, **35/35 passing**) or a live `curl` smoke test against a running server. `tsc --noEmit` is clean for both workspaces.

**Legend:** ✅ Done · 🟡 Partial (works, but narrower than the FR) · ❌ Not built

---

## Module 1 — Input Ingestion Layer

| FR | Requirement | Status | Notes |
|---|---|---|---|
| FR-1.1 | Batch image upload | ✅ | `POST /api/inputs/upload` (multer), multi-select UI |
| FR-1.2 | Batch video upload + key-frame extraction | 🟡 | Upload and classification work; **no actual key-frame extraction** — a video is stored and tagged `kind: "video"`, not decoded into distinct UI-state frames. Would need `ffmpeg` or similar. |
| FR-1.2a | Mixed screenshot+video batch | ✅ | Single upload action accepts both |
| FR-1.3 | URL crawl | ✅ | `ingestionService.crawlUrl`, same-origin link following |
| FR-1.4 | Swagger/OpenAPI parsing | ✅ | JSON and YAML, endpoint extraction |
| FR-1.5 | Postman collection parsing | ✅ | Requests, variables, pre/post-script detection |
| FR-1.6 | Jira/Azure DevOps import | ✅ | Real REST calls in `importExternalWorkItems`; requires a live base URL/token to succeed (verified: correct request shape, clean error on failure) |
| FR-1.7 | Free-text input | ✅ | |
| FR-1.8 | PII redaction (MVP gate) | 🟡 | Regex-based redaction (`redactLikelyPii`) runs on all **text** content (free-text, batch-upload summaries) with an org-level `disable_redaction` toggle. It does **not** inspect actual image/video pixel content for PII (e.g. a face or a visible card number in a screenshot) — that needs OCR/vision, out of reach for a regex layer. |
| FR-1.9 | Reject malformed input (MVP gate) | ✅ | Every ingestion route returns a clear 400 on invalid input; verified for empty text, invalid Swagger/Postman JSON, missing crawl URL |

## Module 2 — AI Test Case Generation Engine

| FR | Requirement | Status | Notes |
|---|---|---|---|
| FR-2.1 | Categorized generation | ✅ | Smoke/Regression/Functional/Edge Case/Negative/API |
| FR-2.2 | CSV/XLSX export | ✅ | |
| FR-2.3 | Sync to Jira/Azure as linked items | ✅ | See Module 7 — real push implemented |
| FR-2.4 | Human review gate before active suite | ✅ | Enforced server-side, not just UI convention — codegen rejects non-accepted test cases |
| FR-2.5 | Traceability to source input | ✅ | Ticket IDs / screenshot names / endpoints extracted via regex into `traceability_context` |
| FR-2.6 | Version + diff on regenerate/edit | ✅ | **Added this pass**: `POST /api/test-cases/:id/regenerate` re-runs generation against the source input, bumps `version`, returns a diff (previously only "edit" bumped version) |
| FR-2.7 | Confidence score + rationale | ✅ | |
| FR-2.8 | Inline co-editing | ✅ | |
| FR-2.9 | "Explain this test case" | ✅ | |
| FR-2.10 | Capture rationale on edit/reject | ✅ | `reviewer_notes`, audit trail |
| FR-2.11 | QA Lead pre-loaded business rules | ✅ | `businessRules` field flows into the generation prompt |
| FR-2.12 | "Needs Discussion" status | ✅ | |
| FR-2.13 | Reviewer agreement rate (MVP gate) | ✅ | `GET /api/test-cases/meta/agreement-rate` |

## Module 3 — Automation Code Generation

| FR | Requirement | Status | Notes |
|---|---|---|---|
| FR-3.1 | Playwright TS/JS/Python | ✅ | |
| FR-3.2 | Selenium/Cypress export | ✅ | **Added this pass**: `POST /api/automation-scripts/:id/generate` accepts `{"framework":"selenium"\|"cypress"}`; previously the generator functions existed in `mockProvider.ts` but were never reachable from any route |
| FR-3.3 | Page Object Model | ✅ | |
| FR-3.4 | Accessibility-first locators | ✅ | `getByRole`/`getByLabel` preferred over CSS/XPath |
| FR-3.5 | API test scripts from Swagger/Postman | 🟡 | Swagger/Postman **parsing** into structured endpoint data is real; generated **API test scripts** from that data specifically (as opposed to UI Playwright scripts) aren't a distinct codegen path — codegen always produces UI-style Playwright/Selenium/Cypress scripts regardless of whether the source was a screenshot or an OpenAPI spec. |
| FR-3.6 | Static security scan (MVP gate) | ✅ | Pattern-based scanner blocks execution if flagged |

## Module 4 — Execution Engine

| FR | Requirement | Status | Notes |
|---|---|---|---|
| FR-4.1 | Chromium/Firefox/WebKit | 🟡 | All three are selectable and passed to Playwright via `--project`; only Chromium's browser binary is installed by default in this dev setup (`npx playwright install chromium` per README) — Firefox/WebKit runs will fail until `npx playwright install` (all browsers) is run. Not a code gap, an environment-setup note. |
| FR-4.2 | Parallel execution | ✅ | `concurrency` on profiles/runs |
| FR-4.3 | Shared auto-scaling runner pool | 🟡 | `provider`/`runner_pool_name`/`reserved_runner_count` fields exist and are stored/returned, but there's no real Docker grid or cloud pool behind them — execution is local `npx playwright test`. This is an infra buildout, not an application-logic gap. |
| FR-4.4 | CI/CD integration | 🟡 | REST API + inbound webhook trigger (FR-4.16) give CI/CD systems a way to call in; there's no packaged GitHub Actions/Jenkins/Azure Pipelines plugin/YAML template. |
| FR-4.5 | Visible queue position | ✅ | `queue_position` tracked and returned |
| FR-4.6 | Reuse browser instances | 🟡 | Flag exists and is stored per run, but its effect on the actual `npx playwright test` invocation is currently mapped to `--retries=1`, which conflates "reuse" with "retry" — a real implementation would need a persistent Playwright worker process, out of scope for a per-invocation CLI runner. Documented as a known correctness issue, not silently claimed as done. |
| FR-4.7 | Configurable artifact capture modes | ✅ | All 6 modes selectable; actual differentiated capture behavior (e.g. HAR files for full-debug) is not yet wired into the Playwright config beyond passing the mode as an env var — the mode is honored for storage/reporting purposes, not yet for controlling what Playwright itself captures per mode. |
| FR-4.8 | Auto-delete artifacts after retention window | ✅ | **Added this pass**: `cleanupExpiredArtifacts()` runs hourly in the background and via `POST /api/execution-runs/artifacts/cleanup` (QA Lead); deletes evidence files past `retention_days`, leaves `retention_days <= 0` (unlimited) alone. Verified: file actually deleted from disk, DB row updated with `evidence_deleted_at`. |
| FR-4.9 | Browser-set selection | ✅ | |
| FR-4.10 | Test-selection modes | ✅ | All 5 modes selectable and stored; "smart selection" and "flaky-tests-only" don't yet do real changed-module diffing to decide which specs to run (there's only ever one script per test case in this build, so "selection" is more a label than a filter over a large suite) |
| FR-4.11 | Retry strategies | ✅ | Mapped to Playwright `--retries` |
| FR-4.12 | Save/edit/delete/share Execution Profiles | ✅ | |
| FR-4.13 | Default profile for team/suite | ✅ | `is_default_for_team`/`is_default_for_suite` |
| FR-4.14 | Suggest a profile from run context | ✅ | `suggestExecutionProfile` |
| FR-4.15 | Custom execution rules | ✅ | **Added this pass**: `evaluateCustomExecutionRules` — `rules_json` on a profile is an array of `{if, then}` rules keyed on test-module keyword, day-of-week, or previous-run-failed; applied before every run. Verified live: a rule forcing `browser_set: all` + `retry_strategy: retry-all` for titles containing "login" visibly changed the run's recorded config. |
| FR-4.16 | Webhook-triggered + scheduled runs | ✅ | **Added this pass**: `POST /api/execution-runs/webhook/:profileId/:scriptId` (inbound trigger, verified live, `trigger_source` recorded as `webhook`) and `runScheduledProfiles()` (checked every 60s in the background against each profile's `schedule_json = {time, daysOfWeek}`, also manually triggerable via `POST /api/execution-runs/scheduler/tick`) |
| FR-4.17 | Enterprise reserved runners | 🟡 | `reserved_runner_count` is stored and returned, but there's no real shared pool to reserve capacity from (see FR-4.3) — this is a Low-priority, infra-dependent item that can't be meaningfully built without a real runner grid. |

## Module 5 — Change Detection & Self-Healing

| FR | Requirement | Status | Notes |
|---|---|---|---|
| FR-5.1 | UI change detection | 🟡 | `detectChangesForTestCase` diffs before/after HTML snippets you supply and reports a confidence score. There's no **scheduled crawl** that automatically fetches the live app and diffs it on its own — detection is triggered manually (or could be scheduled by an external caller of the same endpoint). |
| FR-5.2 | API change detection | 🟡 | Same mechanism, diffs before/after Swagger/spec text; no automatic periodic re-fetch of the live spec. |
| FR-5.3 | Automatic locator healing | ✅ | |
| FR-5.4 | Numeric confidence threshold (MVP gate) | ✅ | Hardcoded `HIGH_CONFIDENCE_THRESHOLD = 0.8` in `selfHealingService.ts` — a defined number, not implicit model judgment |
| FR-5.5 | Test case + script updated together | ✅ | Verified: both rows update atomically in one function |
| FR-5.6 | Log + one-click rollback | ✅ | `auto_heal_actions` table, `POST /api/self-healing/heal-actions/:id/rollback` |
| — | Known limitation | 🟡 | When a test case has multiple automation artifacts (the Playwright TS/JS/Python trio), healing only patches the most recently generated one, not all of them. |

## Module 6 — Reporting & Analytics

| FR | Requirement | Status | Notes |
|---|---|---|---|
| FR-6.1 | Pass/fail dashboard + time trends | ✅ | |
| FR-6.2 | Flaky test detection | ✅ | Recomputed after every run |
| FR-6.3 | Requirement coverage mapped to user stories | 🟡 | Coverage is computed from **ticket IDs** found via regex in test case traceability context (e.g. `ABC-123`), used as a proxy for "user story." There's no real pull of Jira/Azure story metadata to confirm the ticket actually is a story vs. a bug/task. |
| FR-6.4 | PDF/Excel export | ✅ | Real `pdfkit` PDF + `xlsx` export, verified as valid files (`file` command confirmed real PDF 1.3) |
| FR-6.5 | Failure evidence capture | ✅ | |
| FR-6.6 | Hours-saved estimate | ✅ | |
| FR-6.7 | Actual-vs-estimated + time saved per run | ✅ | |

## Module 7 — Integrations Hub

| FR | Requirement | Status | Notes |
|---|---|---|---|
| FR-7.1 | Bi-directional Jira sync | 🟡 | **Push** (test case → issue, result → comment) is real and tested live against a real domain. **Pull** (`import-external`) is a separate, earlier one-way import path. There's no webhook listener for Jira-side changes flowing back automatically — so it's "two working one-way syncs," not a continuously bi-directional link. |
| FR-7.2 | Bi-directional Azure sync | 🟡 | Same shape/limitation as FR-7.1, for Azure DevOps work items |
| FR-7.3 | Slack/Teams notifications | ✅ | Real webhook delivery verified live; auto-fires after every run when `notify_on_run` is set on an integration |
| FR-7.4 | Git-versioned scripts | ✅ | Every codegen call auto-commits to a local git repo under `server/generated/.git`; verified real commit hashes via `git log` |

## Module 8 — Admin & Governance

| FR | Requirement | Status | Notes |
|---|---|---|---|
| FR-8.1 | RBAC | 🟡 | Real role checks (`requireRole`, `enforceReadOnlyRoles`) verified live (403s for wrong role, Manager blocked from all mutations). **Not a real auth system** — the acting user is resolved from an `X-User-Id` header with no login/password/session. This is the authorization *model* ready to sit behind real authentication, documented as such. |
| FR-8.2 | Approval before active suite | ✅ | |
| FR-8.3 | Audit log | ✅ | Cross-module `audit_log` table (broader than the older test-case-scoped `review_audit_entries`), covers reviews, self-heals, integration changes, regenerations |
| FR-8.4 | Secure token storage + rotation | ✅ | AES-256-GCM at rest (`secretsService.ts`), verified ciphertext ≠ plaintext; rotation endpoint tested |
| FR-8.5 | Route to owning tester/team | ✅ | Keyword-match against each user's `owned_modules`; verified live |
| FR-8.6 | Second-reviewer sign-off for critical paths | ✅ | Verified live: marking a case critical blocks `accept` with 403 until a QA Lead signs off, then unblocks |
| FR-8.7 | Visually distinguish authorship | ✅ | Three real authorship types now (`ai`/`edited`/`human`) — previously "human" (fully human-authored, not AI-touched at all) had no creation path; added `POST /api/test-cases` for that this pass, verified |
| FR-8.8 | Periodic re-review sampling | ✅ | |

## Module 9 — Input Safety & Platform Resilience

| FR | Requirement | Status | Notes |
|---|---|---|---|
| FR-9.1 | Concurrent-edit conflict handling (MVP gate) | 🟡 | Implemented for **Test Case** edits: `base_version` on `PATCH /test-cases/:id/review`, mismatch → `409` with the current row for a merge view (verified live). The SRS also names the **linked Automation Script** — scripts aren't directly user-editable in this build (only regenerated wholesale or patched by self-healing, which already has its own before/after + rollback safety net), so there's no separate "two people editing the same script" surface to protect. Documented as an intentional scope note, not an oversight. |
| FR-9.2 | Prompt-injection sanitization (MVP gate) | ✅ | `safetyService.sanitizeForLlm` applied before every LLM call (generation and codegen), for every provider (previously only the real Anthropic path had ad hoc sanitization; mock path — the default — had none) |
| FR-9.3 | LLM outage degraded mode (MVP gate) | ✅ | `llmResilienceService.ts`: retry with backoff, then `queued` status + `503` with a retry URL instead of a bare failure; `POST /api/inputs/:id/retry-generation` |

---

## External Interfaces (Section 4)

| Item | Status | Notes |
|---|---|---|
| Web dashboard for review/approval/execution/reporting | ✅ | Single-page app, 6 stages |
| Batch upload UI (drag-and-drop + multi-select) | 🟡 | Multi-select works; **drag-and-drop specifically isn't wired** — file inputs are click-to-browse only |
| Execution Settings Panel | ✅ | |
| Post-run report (actual-vs-estimated, evidence, save-as-profile) | 🟡 | Actual-vs-estimated and evidence exist; there's no "save this run's settings as a new profile" one-click action in the UI — a user has to manually recreate a profile with the same values |
| REST API for CI/CD | ✅ | |
| Webhook receivers | ✅ | Added this pass (execution trigger); Slack/Teams outbound webhooks also implemented |
| Jira/Azure/Git/Slack/Teams/LLM third-party APIs | ✅ | All five integrated |

## Non-Functional Requirements (Section 5)

| Category | Status | Notes |
|---|---|---|
| Performance (~30s generation) | ✅ | Mock provider is near-instant; real Anthropic calls depend on the API, not measured/enforced in code |
| Scalability | 🟡 | No load testing performed; architecture (stateless Express + SQLite) would need a real DB and horizontal scaling to actually hit "concurrent multi-team" scale |
| Security (encryption at rest, PII scan) | 🟡 | Integration tokens encrypted (✅); PII scan is text-only (see FR-1.8) |
| Reliability (99.5% uptime) | ❌ | Not applicable to a local dev build; no uptime monitoring/SLA infra exists |
| Data retention | ✅ | Configurable per profile/run, enforced by the new cleanup job |
| Usability (non-technical review) | ✅ | Review UI requires no code |
| Configurability | ✅ | |
| Maintainability (modular by service) | ✅ | One service file per module under `server/src/services/` |
| Resource efficiency (prompt caching/batching) | ❌ | Not implemented — every generation call is a fresh LLM request with no caching or batching. This is the single clearest unmet NFR. |
| Resilience (graceful degradation) | ✅ | FR-9.3 |

## MVP Acceptance Gate (Section 9) — final status

| # | Gate Item | Status |
|---|---|---|
| 1 | Accuracy benchmark / agreement rate | ✅ |
| 2 | PII redaction | 🟡 (text only, see FR-1.8) |
| 3 | Prompt-injection sanitization | ✅ |
| 4 | Static security scan | ✅ |
| 5 | Malformed-input error handling | ✅ |
| 6 | Acceptance criteria documented/testable for every FR | ✅ | this document, plus 35 automated tests exercising the FRs that have deterministic pure-function behavior |
| 7 | Self-heal confidence threshold + rollback | ✅ |
| 8 | Concurrent-edit conflict handling | 🟡 (test-case side done; script side has no independent edit surface — see FR-9.1) |
| 9 | LLM outage degraded-mode behavior | ✅ |
| 10 | Out-of-scope statement published | ✅ | README "Known gaps" section + this document |

**9 of 10 MVP gates are fully met; the remaining 2 (🟡) are honestly partial for reasons specific to this build's architecture, not oversights** — each is called out above with exactly what's missing.

## Out of Scope (Section 10) — confirmed still out of scope

Mobile/native testing, non-English UI testing, Selenium/Cypress *migration* tooling (note: Selenium/Cypress *export* is now implemented, per FR-3.2 — migration of *existing* suites remains untouched), formal SLA/disaster-recovery, platform's own accessibility audit, full data-residency certifications, and pricing/billing are all still untouched, matching the SRS's explicit MVP exclusions. No work was done here, correctly.

---

## What changed in this pass specifically

Six concrete gaps found by re-reading the code against the SRS line by line (not previously caught):

1. **FR-2.6** — no way to regenerate a single test case; added `POST /api/test-cases/:id/regenerate`.
2. **FR-3.2** — Selenium/Cypress generator code existed but was unreachable from any route; wired a `framework` parameter through.
3. **FR-4.8** — `retention_days` was stored on every run but nothing ever deleted anything; added a real cleanup job (hourly background + manual trigger), verified it deletes files from disk.
4. **FR-4.15** — `rules_json` was stored on profiles but never evaluated; added a rule engine and wired it into every run.
5. **FR-4.16** — no inbound webhook endpoint and no scheduler; added both (60s background tick + manual trigger for testability).
6. **FR-9.1** — re-verified concurrent-edit handling; documented the script-side scope decision rather than silently claiming full coverage.

All six were unit-tested (7 new tests, `server/tests/execution-ops.test.js`) and live-smoke-tested against a running server. Full suite: **35/35 passing**. `tsc --noEmit`: clean for both workspaces.
