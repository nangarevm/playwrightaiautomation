# How to Run — AI-Powered Test Automation Platform

This covers everything needed to get the app running locally: install, boot, log in as
different roles, and where to look when something breaks.

## 1. Prerequisites

- **Node.js 20+** (22.x is what this was built/tested against)
- **Git** (used by Module 7 to version generated scripts — already required if you cloned this repo)
- No API keys needed to start — a built-in mock LLM provider is used by default

## 2. Install

From the project root (`test-automation-platform/`):

```bash
npm install
npx playwright install chromium
```

If the root `npm install` doesn't pick up both workspaces, install them individually:

```bash
cd server && npm install
cd ../client && npm install
cd ..
```

## 3. Run it

Two terminals, from the project root:

```bash
# Terminal 1 — backend, http://localhost:4100
npm run dev:server

# Terminal 2 — frontend, http://localhost:5173
npm run dev:client
```

Open **http://localhost:5173** in your browser. That's the whole app — frontend proxies
`/api/*` calls to the backend on port 4100.

On first boot the backend:
- creates `server/platform.db` (SQLite) and seeds it with the schema and 4 demo users
- generates `server/.dev-encryption-key` (used to encrypt any Jira/Azure/Slack tokens you save) if `INTEGRATION_ENCRYPTION_KEY` isn't set in the environment
- starts two background jobs: a scheduler tick (every 60s) and a retention-cleanup sweep (hourly)

You'll see log lines like:

```
[llm] using provider: mock
[secretsService] INTEGRATION_ENCRYPTION_KEY not set -- generated a dev-only key at ...
AI Test Automation Platform server listening on http://localhost:4100
Demo app-under-test available at http://localhost:4100/demo/login.html
```

That's normal — no action needed unless you're deploying somewhere real (see §6).

## 4. Switching users / roles (RBAC)

The header has a role switcher. Four demo users are seeded automatically:

| User | Role | Notes |
|---|---|---|
| Priya | QA Lead | Full access — only role that can manage integrations, users, critical-path flags, second-reviewer sign-off, scheduler/cleanup triggers |
| Sam | Tester | Reviews/edits test cases, runs tests |
| Alex | Developer | Views results, triggers CI/CD-style runs |
| Jordan | Manager | **Read-only** — any mutating action returns a 403 |

Pick a role from the dropdown before trying admin-only actions (e.g. adding an integration,
marking a test case critical-path) or you'll get a permission error.

## 5. Walking through the pipeline

1. **Ingest** (Stage 1) — the textarea is pre-filled with a login-page scenario. Click
   **"Submit & generate test cases."** You'll see 3 AI-generated test cases appear.
2. **Review** (Stage 2) — click **Accept** on one. Try **Regenerate** to see versioning/diff,
   or **Explain this test case** for the plain-language rationale.
3. Pick a framework (Playwright/Selenium/Cypress) and click **Generate script →**. Expand
   "View generated code" — you'll see a green `scan: passed` pill (static security scan).
4. Click **Run test**. This launches headless Chromium against a bundled demo login page
   and reports pass/fail with duration.
5. Expand **"Change detection & self-healing"** under the script to try a locator heal.
6. Check **Stage 4 (Reporting)** for the live dashboard, flaky-test list, coverage, and
   PDF/XLSX export.
7. In **Stage 5 (Integrations)**, add a Slack webhook (any URL that accepts POST works for
   testing, e.g. `https://postman-echo.com/post`) with "notify on every run" checked, then
   re-run a script — it fires automatically.
8. In **Stage 6 (Admin)**, switch to a non-QA-Lead role and try a QA-Lead-only action to see
   RBAC enforcement; mark a test case "critical path" and note Accept now requires sign-off.

To see a **failure**: edit `server/src/demo-app/login.html`, change `VALID_PASS` to
something else, save, and re-run the "Successful login" test.

## 6. Switching to the real Anthropic API (optional)

```bash
cp server/.env.example server/.env
```

Edit `server/.env`:

```
USE_MOCK_LLM=false
ANTHROPIC_API_KEY=sk-ant-...
```

Restart `npm run dev:server`. No other code changes needed — both providers implement the
same interface (`server/src/llm/types.ts`).

## 7. Running the tests

```bash
cd server
npm test
```

Runs the full suite (`node --import tsx --test --test-concurrency=1 tests/*.test.js`) —
sequential on purpose, since all test files share one SQLite connection. Should print
`# pass 35` / `# fail 0`.

Typecheck without emitting:

```bash
npx tsc -p . --noEmit     # from server/
npx tsc -p . --noEmit     # from client/
```

## 8. Resetting to a clean state

If the demo data gets messy, stop the server and delete the generated/local state:

```bash
cd server
rm -f platform.db platform.db-shm platform.db-wal .dev-encryption-key
rm -rf generated/.git generated/*.spec.ts generated/*.spec.js generated/*.py generated/*.cy.js generated/*.selenium.js
```

Restart `npm run dev:server` — the schema and seed users are recreated automatically.

## 9. Troubleshooting

| Symptom | Fix |
|---|---|
| `better-sqlite3` fails to build during `npm install` | It compiles a native binding. Install Python 3 + build tools (`xcode-select --install` on macOS, `build-essential` on Debian/Ubuntu), then re-run `npm install` in `server/`. |
| Playwright can't launch Chromium | Re-run `npx playwright install chromium` from `server/` specifically. |
| Firefox/WebKit runs fail | Only Chromium is installed by default. Run `npx playwright install` (no browser name) to get all three. |
| Port already in use | Change `PORT` in `server/.env`, and update the proxy target in `client/vite.config.ts` to match. |
| CORS or 404 on `/api/...` from the frontend | Confirm the backend is running on port 4100 and `client/vite.config.ts`'s proxy target matches. |
| `403` on an action you expect to work | Check the role switcher in the header — some actions (integrations, admin, critical-path, scheduler/cleanup triggers) are QA-Lead-only, and Manager is fully read-only. |
| Getting a `409 conflict` on Accept/Edit | Someone (or another tab) changed that test case since you loaded it — FR-9.1 concurrency protection. Refresh and retry. |

## Project layout (for reference)

```
test-automation-platform/
  server/
    src/
      db.ts                  # SQLite schema
      index.ts               # Express entrypoint + background jobs (scheduler, retention cleanup)
      demo-app/login.html    # bundled app-under-test
      llm/                   # pluggable LLM provider (mock + Anthropic)
      routes/                # inputs, test-cases, automation-scripts, execution-runs,
                              # self-healing, reporting, integrations, admin
      services/               # one service file per SRS module
    tests/                    # 35 automated tests, run with `npm test`
    generated/                # AI-generated scripts land here, git-versioned
    test-results/             # run output + failure screenshots
  client/
    src/
      App.tsx                # single-page dashboard, 6 stages
      api.ts                 # typed fetch client
```

See `README.md` for the full SRS-mapped feature list and `GAP_ANALYSIS.md` for what's done
vs. partial vs. not built.
