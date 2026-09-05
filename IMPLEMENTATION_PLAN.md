# Implementation Plan — Autonomous AI QA / Bug Discovery Engine

Companion to `ARCHITECTURE_ANALYSIS.md`. This plan sequences the master prompt's asks against
what the repository already has, following the master prompt's own five phases but reordered
where the analysis found a dependency the original ordering missed (see §0). **No implementation
in this document — this is the plan to approve before Phase 1 work begins.**

---

## 0. Guiding principles (carried through every phase)

1. **Extend `bugDetectionService.scanScreenForUiBugs()`; never build a parallel pipeline.** Every
   new check is a function called from there, writing through the existing `recordBugFinding()` /
   `bug_findings` table with a new `category` value.
2. **Config before code.** Every threshold, ignore-list, and budget is an `org_settings` column
   (or per-screen `_ignore_json` column) with a getter/setter in `adminService.ts` and a GET/PUT in
   `routes/admin.ts` — no hardcoded numbers, per master prompt §25/§30.
3. **Deterministic rules first, LLM second.** Classification/severity/schema-diffing stays
   hand-rolled (as `consoleErrorService.ts`/`apiSchemaService.ts` already do); LLM calls are
   reserved for exploratory next-action selection and root-cause narrative generation.
4. **Correlation and deduplication are not "last."** The analysis found this is the one piece of
   real new architecture (§7 of `ARCHITECTURE_ANALYSIS.md`), and delaying it to "Phase 5" while
   Phases 2-4 add more independent checks would multiply noisy, duplicate findings — directly
   against the master prompt's own optimization target. **This plan builds the correlation/
   fingerprint/confidence skeleton in Phase 1B, immediately after the first new check ships**, then
   every later phase's checks plug into it from day one instead of being retrofitted.
5. **Every phase ends with:** run existing test suite (`npm test` in `server/`) + new phase tests
   + `tsc --noEmit`, live-verify the new check against a real fixture page (the pattern established
   this session — a hand-built `server/src/demo-app/*.html` fixture proving the exact
   definition-of-done, not just an assertion), confirm no regression, then commit.

---

## 1. New DB schema (consolidated — introduced incrementally per phase below, listed together for review)

All additive (`ensureColumn` / `CREATE TABLE IF NOT EXISTS`), matching the existing migration
style in `db.ts`. No destructive changes to any existing table.

```sql
-- Phase 1B: correlation, dedup, confidence (bug_findings extensions)
ALTER TABLE bug_findings ADD COLUMN fingerprint TEXT;              -- deterministic hash: page+action+error_type+endpoint+normalized_message
ALTER TABLE bug_findings ADD COLUMN correlation_group_id TEXT;     -- findings sharing this = one underlying bug
ALTER TABLE bug_findings ADD COLUMN confidence_score REAL;         -- 0.0-1.0, deterministic + AI-assisted
ALTER TABLE bug_findings ADD COLUMN priority TEXT;                 -- P0/P1/P2/P3, derived from severity+confidence
ALTER TABLE bug_findings ADD COLUMN reproducibility_attempts INTEGER NOT NULL DEFAULT 1;
ALTER TABLE bug_findings ADD COLUMN reproducibility_successes INTEGER NOT NULL DEFAULT 1;
ALTER TABLE bug_findings ADD COLUMN root_cause_narrative TEXT;      -- AI-generated, always inference
ALTER TABLE bug_findings ADD COLUMN root_cause_is_inferred INTEGER NOT NULL DEFAULT 1; -- always 1 when root_cause_narrative is set -- never claim it as observed fact
ALTER TABLE bug_findings ADD COLUMN environment_info_json TEXT;    -- browser/OS/viewport at capture time

-- Phase 2: accessibility
ALTER TABLE screens ADD COLUMN accessibility_ignore_rules_json TEXT NOT NULL DEFAULT '[]'; -- axe rule IDs to suppress, per screen
-- org_settings: accessibility_enabled, accessibility_wcag_level ('A'|'AA'|'AAA', default 'AA')

-- Phase 3: state-transition testing
CREATE TABLE state_transition_flows (
  id TEXT PRIMARY KEY,
  screen_id TEXT,                 -- optional: scoped to a screen/site
  name TEXT NOT NULL,
  steps_json TEXT NOT NULL,       -- ordered action list (navigate/click/fill/submit/refresh/back/...)
  invariants_json TEXT NOT NULL,  -- assertions that must hold at each step ("record no longer visible after delete")
  created_at TEXT NOT NULL
);
CREATE TABLE state_transition_runs (
  id TEXT PRIMARY KEY,
  flow_id TEXT NOT NULL,
  status TEXT NOT NULL,           -- passed/failed/inconsistent
  violated_invariants_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (flow_id) REFERENCES state_transition_flows(id)
);

-- Phase 4: security/authz
ALTER TABLE environments ADD COLUMN secondary_credentials_encrypted TEXT; -- a second, lower-privilege identity for authz comparison
ALTER TABLE environments ADD COLUMN secondary_credentials_iv TEXT;
ALTER TABLE environments ADD COLUMN secondary_credentials_tag TEXT;
-- org_settings: authz_testing_enabled (explicit opt-in -- never runs unless the environment is marked authorized for security testing)

-- Phase 4: performance
-- org_settings: slow_api_threshold_ms, slow_page_threshold_ms, max_requests_per_page (all configurable, sensible defaults)

-- Phase 4: exploratory agent
CREATE TABLE exploration_sessions (
  id TEXT PRIMARY KEY,
  site_id TEXT,
  status TEXT NOT NULL,           -- running/completed/budget_exhausted/stopped
  actions_taken INTEGER NOT NULL DEFAULT 0,
  max_actions INTEGER NOT NULL,   -- exploration budget, from org_settings default at session start
  max_depth INTEGER NOT NULL,
  visited_states_json TEXT NOT NULL DEFAULT '[]',
  action_history_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- org_settings: exploration_default_max_actions, exploration_default_max_depth
```

---

## Phase 1 — Browser monitoring, network, broken resources, API status, evidence (master prompt Phase 1)

**Status: ~90% already shipped.** Remaining deltas only:

| Task | File | Notes |
|---|---|---|
| `unhandledrejection` as its own signal (distinct from generic `pageerror`) | `bugDetectionService.ts` | Currently folded into pageerror; add a dedicated listener + category tag so root-cause narratives can say "unhandled promise rejection" specifically |
| Malformed-JSON response detection | `apiSchemaService.ts` | `checkAndRecordApiResponse` already receives a parse failure as `body: undefined`; add an explicit `api-status` finding when `content-type: application/json` but parsing failed, instead of silently skipping |
| Duplicate/excessive API call detection | new: fold into `bugDetectionService.ts`'s response listener | Count identical `method+path` calls within one page visit; flag above a configurable `org_settings.max_duplicate_requests` (new column) |
| Empty-response-where-data-expected | `apiSchemaService.ts` | Extend `looksLikeErrorBody`-style heuristic: a 2xx JSON array/object response that's empty where the endpoint's baseline always had data |

**No new files, no new tables.** This phase is pure hardening of existing modules — same
pattern as the six "Deeper Bug Detection" fixes already made this session.

**Exit criteria:** existing 124 server tests still pass, `tsc --noEmit` clean, live-verify each new
detection against an extended `buggy-fixture.html`.

---

## Phase 1B — Correlation, deduplication, confidence skeleton (pulled forward from master prompt Phase 5)

This is the structural piece flagged in `ARCHITECTURE_ANALYSIS.md` §7 as needing to land early.
Building it now, while there are only ~7-8 check types instead of 15+, keeps it simple and lets
every subsequent phase's checks plug into a working skeleton instead of retrofitting one later.

**New modules:**
- `server/src/services/bugFingerprintService.ts` — `computeFingerprint(finding): string`. Combines
  normalized `(screen_id or url) + category + normalized_error_message + endpoint_key`. Used both
  for **within-scan correlation** (multiple findings from the same page visit sharing a
  fingerprint-adjacent signal) and **cross-scan dedup** (the same bug found on run N and run N+1
  should not create a second row — bump `reproducibility_attempts`/`reproducibility_successes`
  instead).
- `server/src/services/bugCorrelationService.ts` — `correlateFindings(findings: BugFindingRow[]):
  void`, called once at the end of `scanScreenForUiBugs()` after all checks have written their
  rows for this scan. Groups findings from the *same scan* that share screen + a time-window +
  overlapping evidence (e.g. an `api-status` 500 on `POST /api/order` + a `ui-dom` stuck-spinner
  finding + a `console-error` TypeError, all within the same run) into one `correlation_group_id`.
  Deterministic rule-based grouping first (shared endpoint/timestamp-window/DOM element), not an
  LLM call — matches the master prompt's own worked example (§17) exactly, which is expressible as
  rules, not semantic reasoning.
- `server/src/services/bugConfidenceService.ts` — `scoreConfidence(finding, correlatedGroup):
  number`. Deterministic signal-weighted score per master prompt §20 (API 5xx +, reproducible +,
  console exception +, visual anomaly +, schema violation +; dynamic-content/animation/flaky- ,
  timing-sensitive -). Also derives `priority` (P0-P3) from severity × confidence.

**Modified:** `bugDetectionService.recordBugFinding()` gains fingerprint computation on every
insert; `scanScreenForUiBugs()` calls `correlateFindings()` once per scan, after all checks run.

**Exit criteria:** a new fixture reproducing the master prompt's own worked example (§17 — a failed
`POST /api/order`, a stuck spinner, and a console TypeError from one click) produces **one**
correlation group containing all three findings, with a computed confidence score, verified live.

---

## Phase 2 — DOM/UI, visual regression, accessibility, responsive (master prompt Phase 2)

**Status:** DOM checks, visual regression, and responsive are done (Deeper Bug Detection phases
3-5). **Accessibility is entirely net-new** — the only substantial work in this phase.

**New dependency:** `@axe-core/playwright` (added to `server/package.json`, same as
`pixelmatch`/`pngjs` were added for visual regression — no new deployment topology).

**New module:** `server/src/services/accessibilityService.ts`
- `runAccessibilityChecks(page, ignoreRules: string[]): AccessibilityIssue[]` — injects axe-core,
  runs against the already-loaded page (same "reuse the open page, no extra navigation" discipline
  as `domChecksService.runDomChecks`), configurable WCAG level (`org_settings.
  accessibility_wcag_level`).
- Findings recorded with `category: 'accessibility'`, `evidence: { wcagRule, impact, targetSelector
  }`, severity mapped from axe's own impact levels (critical/serious/moderate/minor → this
  platform's critical/high/medium/low).
- Per-screen suppression via `screens.accessibility_ignore_rules_json` (empty by default — same
  "don't guess app-specific exceptions" principle as every other ignore-list this session).

**Wiring:** one new call inside `scanScreenForUiBugs()`, gated by `org_settings.
accessibility_enabled` (default on, since axe-core has no false-positive risk comparable to visual
noise — unlike the ignore-selector lists, there's no reason to default this off).

**Also in this phase:** consolidate `visualDetectionService.ts` (the older byte-buffer pixel-diff)
into `screensService.ts`'s pixelmatch-based path where they overlap (image-loading/text-rendering
heuristics) — flagged as debt in the architecture analysis, cheap to fix while already in this
code.

**Exit criteria:** a fixture page with a deliberate missing `alt`, a missing form label, and a
contrast violation produces three `accessibility` findings with correct WCAG rule IDs, verified
live; an ignored rule via the per-screen suppression list is confirmed silenced.

---

## Phase 3 — API schema, negative testing, boundary testing, state-transition (master prompt Phase 3)

**Status:** schema validation done. Negative/boundary generation is LLM-driven and functional but
not deterministic-field-aware. State-transition testing is entirely net-new.

### 3a. Deterministic field-type-aware mutation (upgrades §8/§9, doesn't replace the LLM path)

**New module:** `server/src/services/fieldTypeInferenceService.ts` — classifies a crawler-captured
`ElementRecord` (which already carries `inputType`, e.g. `email`/`tel`/`date`/`number`, from
`crawler/types.ts`) into a mutation strategy, then generates the boundary/negative value set
deterministically (empty/whitespace/min/max/over-max/unicode/emoji/negative/zero/decimal/
extreme-large per field type) rather than relying on LLM prose per case. This **feeds** the
existing `generationService.ts`/`mockProvider.ts` pipeline as a structured hint (same role
`traceability_context` already plays), not a replacement for it.

**New:** field-combination matrix generation (A valid + B invalid + C empty) for
multi-field forms, using the crawler's already-captured form/field relationships.

### 3b. State-transition testing (net-new)

**New module:** `server/src/services/stateTransitionService.ts`
- `defineFlow(steps, invariants)` / `runFlow(flowId)` against `state_transition_flows`/
  `state_transition_runs` (schema in §1).
- Built-in flow templates matching the master prompt's own list: create→edit→delete→refresh→
  verify-gone; duplicate-submit; rapid-click; back/forward after mutation; session-expiry mid-flow.
- Findings recorded with `category: 'functional'` (state-transition bugs are a *kind* of
  functional/regression defect, not a new top-level category) plus `evidence: { violatedInvariant,
  stepIndex }`.

**Exit criteria:** a fixture app with a deliberate "deleted record still appears after refresh" bug
is caught by a `create→delete→refresh→verify-gone` flow, live-verified.

---

## Phase 4 — Security/authorization, performance, advanced exploratory testing (master prompt Phase 4)

**Status:** all three are net-new. This is the highest-risk phase — flagged explicitly for review
before implementation given the security-testing angle.

### 4a. Authorization testing (opt-in, explicitly authorized environments only)

**New module:** `server/src/services/authzTestingService.ts`
- Requires `org_settings.authz_testing_enabled` **and** the target `environments` row to have a
  `secondary_credentials_*` identity configured — the check **refuses to run** against any
  environment that hasn't explicitly opted in, per the master prompt's own instruction ("never
  perform destructive/security testing outside explicitly authorized test environments").
  Enforcement lives in the service itself, not just the UI, mirroring `requireRole()`'s
  server-side-always pattern.
- IDOR probe: for a URL/API call containing a resource ID (captured during the primary crawl),
  replay the same call authenticated as the secondary identity; a 200 where a 403/404 is expected
  is the finding. `category: 'security'`, severity `critical` by default (authz failures are
  high-signal, low-false-positive by nature).
- Vertical escalation probe: attempt secondary (lower-privilege) identity against primary-only
  actions discovered during the crawl.
- **Never mutates data as part of a probe** — read-only verification requests only, consistent
  with "never perform destructive testing."

### 4b. Performance thresholds

**Extends existing tracking**, no new service: `bugDetectionService.ts`'s response listener
already sees `response.request().timing()`; add a check against `org_settings.
slow_api_threshold_ms`/`slow_page_threshold_ms` (new columns), `category: 'performance'`. Duplicate
excessive-request detection from Phase 1's remaining task naturally lives here too.

### 4c. Exploratory AI agent

**New module:** `server/src/services/exploratoryAgentService.ts`
- Consumes: Application Map (existing crawler graph), `exploration_sessions` history
  (visited states, prior actions, prior bugs from `bug_findings`), a bounded budget
  (`max_actions`/`max_depth`, defaulted from `org_settings.exploration_default_*`).
- One LLM call per decision point ("given this state and history, what's the highest-value next
  action?") routed through the existing `llmGatewayService.ts` (semantic cache + cost-aware
  tiering already built) — this is the one place in the whole plan where an LLM call is the right
  tool, per the master prompt's own §16/§26 guidance.
- Hard budget enforcement (actions-taken counter, max-depth check) prevents infinite loops
  regardless of what the LLM suggests — a deterministic guardrail wrapping the LLM decision, not
  trusting it to self-limit.
- Calls into *existing* interaction/navigation primitives (`crawler/interaction.ts`'s click
  helpers, `executionService`'s run triggers) — does not reimplement browser automation.

**Exit criteria:** a bounded exploration session (`max_actions: 20`) against a fixture app
terminates within budget, visits no state twice, and its action history is fully reconstructable
from `exploration_sessions.action_history_json`.

---

## Phase 5 — Remaining Phase 5 work (fingerprint/correlation/confidence already landed in Phase 1B)

With the skeleton already in place since Phase 1B, this phase is about **developer-ready output**,
not new detection logic:

**New module:** `server/src/services/bugReportingService.ts`
- `formatBugReport(findingOrGroup): string` — produces the exact master-prompt §24 template
  (Title/Severity/Priority/Confidence/Category/URL/Steps/Expected/Actual/Evidence/Probable Root
  Cause), reading from the fields Phase 1B added to `bug_findings`. Explicitly labels the root
  cause section "AI Inference (not confirmed)" whenever `root_cause_is_inferred = 1` — never
  presented as fact, per master prompt §19.
- `getBugDashboard()` — extends `reportingService.ts`'s existing dashboard pattern with the
  category-level rollups the master prompt asks for in §23 (top failing pages/APIs, bugs by
  category, new vs. regression vs. duplicate counts) — this is additive to the existing dashboard
  function, not a new dashboard.

**New routes:** `GET /api/bugs/dashboard`, `GET /api/bugs/:id/report` (formatted export),
`GET /api/bugs/groups/:correlationGroupId` (the correlated view).

**Flaky-vs-confirmed for proactive findings:** extend the existing retry/flaky-classification
pattern (`is_flaky`, `detectFlakyScripts` in `reportingService.ts`) to `bug_findings`: a
high-confidence finding should be re-verified (bounded retry, reusing `reproducibility_attempts`/
`reproducibility_successes` from Phase 1B) before its confidence score is finalized, matching
master prompt §21's "a bug should ideally be reproduced before assigning high confidence."

**Exit criteria:** the master-prompt §24 worked example (checkout page stuck after payment API
500) is reproduced end-to-end against a fixture and the generated report text matches that
template's shape, field-for-field.

---

## Cross-cutting: what does NOT change

- No new backend framework, no new datastore, no new deployment process (per
  `ARCHITECTURE_ANALYSIS.md` §8's equivalent principle already established for the edition
  roadmap).
- `client/` (React UI) is out of scope for this plan except adding read surfaces for new data
  (accessibility findings, correlation groups, dashboard rollups) into the existing Bugs tab —
  no new frontend architecture.
- Existing SRS functional requirements (Modules 1-9, `GAP_ANALYSIS.md`) are untouched; this plan is
  purely additive to the Bug Detection Engine.

---

## Sequencing / dependency graph

```
Phase 1 (hardening)
   └─▶ Phase 1B (correlation/dedup/confidence skeleton)  ◀── must land before Phase 2 adds more check volume
          ├─▶ Phase 2 (accessibility)         ─┐
          ├─▶ Phase 3 (negative/boundary,       │  independent of each other,
          │           state-transition)         │  can proceed in parallel
          └─▶ Phase 4 (authz, perf, exploratory)─┘
                 └─▶ Phase 5 (developer-ready reporting) — consumes every category above
```

Phases 2, 3, and 4 do not depend on each other and can be built in any order (or in parallel)
once Phase 1B's fingerprint/correlation/confidence fields exist for them to populate. Phase 5 is
last because it reports on categories Phases 2-4 produce.

---

## Risks requiring explicit sign-off before implementation

1. **Authz testing (4a) requires a second set of real credentials per target environment.** This
   is qualitatively different from every other check in this plan (which are all single-identity,
   read-only observation) — it needs explicit environment-level opt-in and should default to
   *disabled* everywhere until a user configures it for a specifically authorized test environment.
2. **Exploratory agent (4c) is the first component that takes autonomous actions beyond the
   existing deterministic crawl** — even with a hard budget, it will click things no one explicitly
   asked it to click. Recommend starting with a conservative default budget (e.g. 20 actions, depth
   3) and read-only-by-default action selection (no form submission/data mutation) until validated
   against a real target.
3. **New LLM call volume** (one per exploratory decision point, one per root-cause narrative) adds
   real cost — both already route through `llmGatewayService.ts`'s existing cost controls, but
   worth confirming budget expectations before Phase 4/5 go live.
