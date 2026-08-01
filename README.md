# AI-Powered Test Automation Platform — MVP Core (local dev build)

This is a working, runnable slice of the platform described in the SRS (v4.0), now covering
**all 9 functional modules**:

**Ingest → AI-generate test cases → human review/approve (with governance) → Playwright codegen
(Git-versioned) → execute → self-heal → report → sync/notify → see results**

It's built to run entirely on your machine with **zero API keys required** — a built-in
mock "LLM" provider generates realistic test cases and Playwright scripts so you can
verify the whole pipeline end-to-end before wiring in a real model or deploying anywhere.

This README was last verified against the code on 2026-08-01: every route/service file was
read, the full server test suite (`npm test` in `server/`, run sequentially via
`--test-concurrency=1` to avoid cross-file races on the shared SQLite file — **28 tests**) was
run, and `tsc --noEmit` was checked clean for both `server/` and `client/`. Every module below
was also exercised live against a running server (`curl` smoke tests), not just unit-tested.

## RBAC note for local testing

Module 8 adds role-based access control. The server seeds four demo users on first boot
(`user-qa-lead`, `user-tester`, `user-developer`, `user-manager`) and resolves the acting user
from an `X-User-Id` request header (a local-dev stand-in for a real login system — see
`services/adminService.ts`). The client has a role switcher in the header; requests with no
header default to a permissive Tester identity. QA Lead is required for integration
management and most `/api/admin/*` routes; the Manager role is blocked from all mutations.

## What's actually implemented (mapped to the SRS)

| SRS item | Implemented as |
|---|---|
| FR-1.1/1.2/1.2a (batch screenshot/video upload) | `POST /api/inputs/upload` (multer), mixed batch UI |
| FR-1.3 (URL crawl) | `POST /api/inputs/url-crawl` → `ingestionService.crawlUrl` |
| FR-1.4/1.5 (Swagger/OpenAPI, Postman import) | `POST /api/inputs/import-openapi`, `/import-postman` |
| FR-1.6 (Jira/Azure DevOps import) | `POST /api/inputs/import-external` (real REST calls, needs a live base URL/token) |
| FR-1.7 (free-text input) | Ingest textarea → `POST /api/inputs` |
| FR-1.8 (PII redaction) | `ingestionService.redactLikelyPii`, org-level `disable_redaction` toggle |
| FR-1.9 (reject malformed input) | 400s with clear messages across all ingestion routes |
| Module 2 (AI generation) | `server/src/llm/mockProvider.ts` (default) or `anthropicProvider.ts` (real API) |
| FR-2.1–2.12 (categorized generation, export, sync, review, versioning, diff, explain, traceability, business rules, needs-discussion) | `generationService.ts`, `testCaseFeatures.ts`, review UI |
| FR-2.13 (reviewer agreement rate, MVP gate) | `GET /api/test-cases/meta/agreement-rate`, shown in the header |
| FR-3.1–3.5 (multi-language Playwright/Selenium/Cypress codegen, POM, accessibility-first locators, API test scripts) | `codegenService.ts` + `llm/mockProvider.ts` |
| FR-3.6 (static security scan, MVP gate) | Pattern-based scanner in `codegenService.ts`; blocks execution if flagged |
| Module 4 (configurable execution: browser sets, concurrency, artifact modes, retry strategies, selection modes, profiles, queueing, suggestion) | `executionService.ts`, `execution_profiles`/`execution_runs` tables, full profile editor in the UI |
| FR-6.5 (failure evidence capture) | Playwright screenshot-on-failure, linked to the run |
| **Module 5 — change detection & self-healing (FR-5.1–5.6, MVP gate)** | `selfHealingService.ts` + `routes/selfHealing.ts`, `change_detections`/`auto_heal_actions` tables, UI panel per script |
| **FR-9.1 — concurrent-edit conflict handling (MVP gate)** | `PATCH /api/test-cases/:id/review` takes `base_version`; mismatch → `409` with the current row for a merge view |
| **FR-9.2 — LLM input sanitization (MVP gate)** | `services/safetyService.ts`, applied before every provider call (generation *and* codegen), not just the real Anthropic path |
| **FR-9.3 — LLM outage degraded mode (MVP gate)** | `services/llmResilienceService.ts`: retries with backoff, then marks the input `queued` and returns `503` with a retry URL instead of a bare failure; `POST /api/inputs/:id/retry-generation` |
| **Module 6 — Reporting & Analytics** (FR-6.1–6.4, 6.6–6.7) | `services/reportingService.ts` + `routes/reporting.ts`: pass/fail dashboard with execution-time trend, flaky-test detection (recomputed after every run), requirement coverage (ticket IDs → approved test cases), hours-saved estimate, PDF export (`pdfkit`) and XLSX export |
| **Module 7 — Integrations Hub** (FR-7.1–7.4) | `services/integrationsService.ts` + `routes/integrations.ts`: real Jira/Azure REST push (create + comment-on-result), Slack/Teams webhook notifications (auto-fired after every run when `notify_on_run` is set), and generated scripts auto-committed to a local Git repo under `server/generated/.git` |
| **Module 8 — Admin & Governance** (FR-8.1–8.8) | `services/adminService.ts` + `routes/admin.ts`: RBAC via `X-User-Id` (4 seeded users/roles, Manager is read-only), general audit log across modules, encrypted token storage + rotation (`services/secretsService.ts`, also used by Module 7), reviewer routing by owned-module keyword match, second-reviewer sign-off gate on critical-path test cases (blocks `accept` until signed off), human-authored test cases (third `authorship_type` alongside ai/edited), periodic re-review sampling |
| Data model (Section 6) | SQLite schema in `server/src/db.ts` |

## Known gaps (verified, not yet built)

These are real, checked gaps — not guesses — as of this pass:

- **Module 7 sync direction**: Jira/Azure push (test case → tracker, result → comment) is real
  and tested; the *pull* side (`import-external`) was already one-way import from an earlier
  pass. There's no webhook listener for tracker-side changes flowing back automatically — a
  user has to trigger each direction explicitly, so call it "two one-way syncs" rather than a
  continuously-synced bi-directional link.
- **Self-healing limitation**: when a test case has multiple automation artifacts (e.g. the
  TS/JS/Python trio codegen produces), `applySelfHealingForTestCase` heals only the most
  recently generated one, not all of them — worth fixing before this goes past a demo.
- **Reviewer merge UI**: FR-9.1 now returns a structured 409 conflict payload, but the
  frontend just surfaces the error message — there's no actual side-by-side merge view yet.
- **RBAC is header-based, not a real auth system**: `X-User-Id` is a deliberate local-dev
  stand-in (see the RBAC note above) — there's no login, password, or session/token issuance.
  Treat Module 8's RBAC as the authorization *model* (roles, permission checks, audit trail)
  ready to sit behind a real authentication layer, not a finished auth system.
- **Encryption key management**: `secretsService.ts` auto-generates a dev-only key at
  `server/.dev-encryption-key` if `INTEGRATION_ENCRYPTION_KEY` isn't set (gitignored). Set the
  env var explicitly before deploying anywhere real.

The architecture (separate services per module, a shared LLM abstraction, a real DB schema)
made all three of the above slot in without touching Modules 1–5/9.

## Prerequisites

- Node.js 20+ (works fine on the 22.x you likely have)
- No API key needed to start

## Setup

```bash
# from the project root
npm install
npx playwright install chromium
```

If `npm install` at the root doesn't pick up both workspaces, run it in each folder:

```bash
cd server && npm install && cd ../client && npm install && cd ..
```

## Run it

Two terminals:

```bash
# terminal 1 — backend on http://localhost:4100
npm run dev:server

# terminal 2 — frontend on http://localhost:5173
npm run dev:client
```

Open **http://localhost:5173**.

## Verifying it works

1. **Ingest**: the textarea is pre-filled with a login-page scenario. Click
   "Submit & generate test cases." You should see 3 test cases appear (Smoke,
   Negative, Edge Case) with confidence scores and rationale.
2. **Review**: click **Accept** on the "Successful login" test case.
3. Click **Generate Playwright script →**. Expand "View generated code" to see
   the actual script (uses `getByLabel`/`getByRole`, structured as a Page Object).
   You should see a green `scan: passed` pill.
4. Click **Run test**. This actually launches headless Chromium via Playwright
   against a bundled demo login page (`server/src/demo-app/login.html`, served at
   `http://localhost:4100/demo/login.html`) and reports **passed** or **failed**
   with duration. Try accepting and running the "incorrect password" and "empty
   fields" cases too — they should also pass, since they assert the *expected*
   (correct) behavior of the demo app.
5. To see a **failure**, open `server/src/demo-app/login.html` and change
   `VALID_PASS` to something else, save, re-run the "Successful login" test — it
   should now report **failed**, and a screenshot will be saved under
   `server/test-results/artifacts/`.
6. Expand **"Change detection & self-healing"** under a generated script, paste a
   before/after DOM snippet (e.g. `<input id="username" />` → `<input id="user-name" />`),
   run detection, then supply before/after locators and a confidence value. At ≥0.8 the
   locator is healed in place and the script updates; below that it's flagged for
   regeneration instead. Every heal action can be rolled back.
7. Scroll to **"Reporting & analytics"** (Stage 4) to see the pass/fail dashboard, flaky-test
   list, requirement coverage, and hours-saved estimate update live as you run tests. Export a
   release report as PDF or XLSX.
8. In **"Integrations hub"** (Stage 5), add a Slack/Teams integration (any webhook URL that
   accepts a POST works for testing — try `https://postman-echo.com/post`) with "notify on
   every run" checked, then run a script again and it fires automatically. Add a Jira/Azure
   integration and click "Push to jira/azure" on a script row — against a real instance this
   creates a linked issue; against a fake URL you'll get a clear error instead of a silent
   failure. "View git history" on a script shows its local commit log (Module 7's stand-in for
   "versioned in a connected Git repo").
9. In **"Admin & governance"** (Stage 6), switch users with the header dropdown. As Tester,
   try mutating an integration — blocked (QA Lead only). Switch to QA Lead, mark a test case
   "critical path," and note the Accept button now requires a second-reviewer sign-off before
   it succeeds. The audit log at the bottom records every governance action.

## Switching to the real Anthropic API

```bash
cp server/.env.example server/.env
```

Edit `server/.env`:
```
USE_MOCK_LLM=false
ANTHROPIC_API_KEY=sk-ant-...
```

Restart `npm run dev:server`. Generation and codegen will now call
`claude-sonnet-4-6` instead of the mock provider — no other code changes needed,
since both providers implement the same `LlmProvider` interface
(`server/src/llm/types.ts`).

## Troubleshooting

- **`better-sqlite3` fails to build**: it compiles a native binding on install.
  If you hit node-gyp errors, make sure you have Python 3 and build tools
  installed (`xcode-select --install` on macOS, `build-essential` on Debian/Ubuntu),
  then re-run `npm install` in `server/`.
- **Playwright can't launch Chromium**: re-run `npx playwright install chromium`
  from the `server/` folder specifically.
- **Port already in use**: change `PORT` in `server/.env`, and update the proxy
  target in `client/vite.config.ts` to match.
- **CORS or 404 on `/api/...` from the frontend**: confirm the backend is running
  on port 4100 (check terminal 1's log line) and that `client/vite.config.ts`'s
  proxy target matches.

## Project layout

```
test-automation-platform/
  server/
    src/
      db.ts                  # SQLite schema
      index.ts               # Express entrypoint
      demo-app/login.html    # bundled app-under-test
      llm/                   # pluggable LLM provider (mock + Anthropic)
      routes/                # inputs, test-cases, automation-scripts, execution-runs, self-healing,
                              # reporting, integrations, admin
      services/               # generation, codegen (+ security scan), execution, self-healing,
                               # safetyService (FR-9.2), llmResilienceService (FR-9.3),
                               # reportingService (Module 6), integrationsService + secretsService
                               # (Module 7), adminService (Module 8, also used by Module 7 for tokens)
    generated/                # AI-generated Playwright specs land here, git-versioned (Module 7)
    test-results/             # run output + failure screenshots
  client/
    src/
      App.tsx                # single-page pipeline dashboard
      api.ts                 # typed fetch client
```

## Once this is verified locally → moving to cloud

When you're happy with local behavior, the natural next steps are:
1. Swap SQLite for Postgres (schema is already close to Section 6's data model).
2. Containerize `server/` and `client/` separately (they're already split as
   independent workspaces).
3. Replace the bundled demo app with your real target application's URL.
4. Add the pieces marked out-of-scope above, prioritized by what you need next.

Happy to help with any of these when you're ready.
