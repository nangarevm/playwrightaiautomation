import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, "..", "platform.db");

export const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS inputs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS test_cases (
  id TEXT PRIMARY KEY,
  input_id TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  steps TEXT NOT NULL,        -- JSON array of strings
  expected_result TEXT NOT NULL,
  confidence_score REAL NOT NULL,
  source_rationale TEXT,
  status TEXT NOT NULL DEFAULT 'draft', -- draft/accepted/edited/rejected/needs_discussion
  authorship_type TEXT NOT NULL DEFAULT 'ai', -- ai/human/edited
  version INTEGER NOT NULL DEFAULT 1,
  reviewer_notes TEXT,
  priority TEXT NOT NULL DEFAULT 'Medium',
  traceability_context TEXT,
  explanation TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (input_id) REFERENCES inputs(id)
);

CREATE TABLE IF NOT EXISTS review_audit_entries (
  id TEXT PRIMARY KEY,
  test_case_id TEXT NOT NULL,
  action TEXT NOT NULL,
  reviewer_notes TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (test_case_id) REFERENCES test_cases(id)
);

CREATE TABLE IF NOT EXISTS sync_records (
  id TEXT PRIMARY KEY,
  test_case_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  external_id TEXT,
  status TEXT NOT NULL,
  payload TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (test_case_id) REFERENCES test_cases(id)
);

CREATE TABLE IF NOT EXISTS automation_scripts (
  id TEXT PRIMARY KEY,
  test_case_id TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'typescript',
  framework TEXT NOT NULL DEFAULT 'playwright',
  code TEXT NOT NULL,
  file_path TEXT NOT NULL,
  security_scan_status TEXT NOT NULL DEFAULT 'pending', -- pending/passed/flagged
  security_scan_notes TEXT,
  last_run_status TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (test_case_id) REFERENCES test_cases(id)
);

CREATE TABLE IF NOT EXISTS execution_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  browser_set TEXT NOT NULL DEFAULT 'chromium',
  concurrency INTEGER NOT NULL DEFAULT 1,
  artifact_capture_mode TEXT NOT NULL DEFAULT 'logs-only',
  retention_days INTEGER NOT NULL DEFAULT 30,
  selection_mode TEXT NOT NULL DEFAULT 'full-suite',
  retry_strategy TEXT NOT NULL DEFAULT 'no-retry',
  provider TEXT NOT NULL DEFAULT 'local',
  runner_pool_name TEXT,
  reserved_runner_count INTEGER NOT NULL DEFAULT 0,
  headless_mode INTEGER NOT NULL DEFAULT 1,
  reuse_browser_instances INTEGER NOT NULL DEFAULT 0,
  is_default_for_team INTEGER NOT NULL DEFAULT 0,
  is_default_for_suite INTEGER NOT NULL DEFAULT 0,
  rules_json TEXT,
  schedule_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Module 8: Admin & Governance
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL, -- QA Lead / Tester / Developer / Manager
  email TEXT,
  owned_modules TEXT, -- comma-separated keywords used for review routing (FR-8.5)
  created_at TEXT NOT NULL
);

-- FR-8.3: general-purpose audit log for AI-generated changes, approvals, and governance
-- actions across modules (broader than review_audit_entries, which is test-case-scoped only)
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT,
  actor_role TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  details TEXT,
  created_at TEXT NOT NULL
);

-- Module 7: Integrations Hub (Section 6 data model). Tokens are stored encrypted
-- (see services/secretsService.ts) -- token_encrypted/token_iv/token_tag replace the
-- plain "token_ref" from the SRS data model sketch.
CREATE TABLE IF NOT EXISTS integrations (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL, -- jira/azure/git/slack/teams
  org_id TEXT,
  base_url TEXT,
  webhook_url TEXT,
  token_encrypted TEXT,
  token_iv TEXT,
  token_tag TEXT,
  scopes TEXT,
  notify_on_run INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS change_detections (
  id TEXT PRIMARY KEY,
  test_case_id TEXT NOT NULL,
  change_types TEXT NOT NULL,
  confidence_score REAL NOT NULL,
  detected_at TEXT NOT NULL,
  source TEXT NOT NULL,
  ui_before_html TEXT,
  ui_after_html TEXT,
  api_before_spec TEXT,
  api_after_spec TEXT,
  FOREIGN KEY (test_case_id) REFERENCES test_cases(id)
);

CREATE TABLE IF NOT EXISTS auto_heal_actions (
  id TEXT PRIMARY KEY,
  test_case_id TEXT NOT NULL,
  detection_id TEXT NOT NULL,
  before_state TEXT NOT NULL,
  after_state TEXT NOT NULL,
  confidence_score REAL NOT NULL,
  applied INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  rolled_back INTEGER NOT NULL DEFAULT 0,
  rollback_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (test_case_id) REFERENCES test_cases(id),
  FOREIGN KEY (detection_id) REFERENCES change_detections(id)
);

-- FR-6.10/FR-9.5/FR-9.6/FR-9.7: LLM gateway usage log -- records every generation
-- request's cache/compression/routing/failover outcome and estimated cost, so the
-- reporting dashboard can surface real usage and the savings the gateway produced.
CREATE TABLE IF NOT EXISTS llm_usage_log (
  id TEXT PRIMARY KEY,
  call_type TEXT NOT NULL, -- test_case_generation / script_generation
  input_id TEXT,
  provider TEXT NOT NULL,
  model_tier TEXT NOT NULL, -- primary / economy
  cache_hit INTEGER NOT NULL DEFAULT 0,
  compressed INTEGER NOT NULL DEFAULT 0,
  failover_used INTEGER NOT NULL DEFAULT 0,
  input_tokens_before INTEGER NOT NULL DEFAULT 0,
  input_tokens_after INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  cost_usd_without_optimization REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS execution_runs (
  id TEXT PRIMARY KEY,
  script_id TEXT NOT NULL,
  profile_id TEXT,
  status TEXT NOT NULL, -- queued/running/passed/failed/error/blocked/stopped
  duration_ms INTEGER,
  stdout TEXT,
  stderr TEXT,
  evidence_path TEXT,
  browser_set TEXT NOT NULL DEFAULT 'chromium',
  concurrency INTEGER NOT NULL DEFAULT 1,
  artifact_capture_mode TEXT NOT NULL DEFAULT 'logs-only',
  retention_days INTEGER NOT NULL DEFAULT 30,
  selection_mode TEXT NOT NULL DEFAULT 'full-suite',
  retry_strategy TEXT NOT NULL DEFAULT 'no-retry',
  queue_position INTEGER NOT NULL DEFAULT 0,
  provider TEXT NOT NULL DEFAULT 'local',
  execution_context TEXT,
  trigger_source TEXT,
  reserved_runner_count INTEGER NOT NULL DEFAULT 0,
  headless_mode INTEGER NOT NULL DEFAULT 1,
  reuse_browser_instances INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (script_id) REFERENCES automation_scripts(id),
  FOREIGN KEY (profile_id) REFERENCES execution_profiles(id)
);

-- FR-1.10/FR-2.14/FR-5.7/FR-5.8/FR-5.9/FR-4.18: Screen entity -- a distinct,
-- catalogued UI state/page/module discovered from any input type, used to
-- group/scope test cases and change detection (Section 6 data model).
CREATE TABLE IF NOT EXISTS screens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  module_name TEXT,
  source_input_id TEXT,
  url_or_path TEXT,
  last_captured_state_hash TEXT,
  change_status TEXT NOT NULL DEFAULT 'new', -- new/changed/unchanged
  last_compared_at TEXT,
  visual_baseline_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- FR-4.19/FR-4.20: named Environment (Dev/Staging/Prod/custom), each with its
-- own target URL, credentials, and default Execution Profile.
CREATE TABLE IF NOT EXISTS environments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  target_url TEXT NOT NULL,
  credentials_encrypted TEXT,
  credentials_iv TEXT,
  credentials_tag TEXT,
  default_profile_id TEXT,
  last_health_check_status TEXT, -- reachable/unreachable/unknown
  last_health_check_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- FR-2.16: near-duplicate test case flags, offered as merge/discard rather
-- than silently letting both into the approved suite.
CREATE TABLE IF NOT EXISTS test_case_duplicate_flags (
  id TEXT PRIMARY KEY,
  test_case_id TEXT NOT NULL,
  duplicate_of_test_case_id TEXT NOT NULL,
  similarity REAL NOT NULL,
  resolution TEXT NOT NULL DEFAULT 'pending', -- pending/merged/discarded/kept-both
  created_at TEXT NOT NULL
);

-- FR-2.17: data-driven/parameterized test cases -- one case, many rows.
CREATE TABLE IF NOT EXISTS test_case_data_rows (
  id TEXT PRIMARY KEY,
  test_case_id TEXT NOT NULL,
  row_index INTEGER NOT NULL,
  input_values TEXT NOT NULL, -- JSON object of param name -> value
  last_run_status TEXT,
  created_at TEXT NOT NULL
);

-- FR-1.8: org-level PII redaction toggle. A single-row settings table (this
-- build has one implicit org) rather than a per-request client-supplied flag,
-- so the toggle is a real, auditable org policy instead of something any caller
-- could flip per-request.
CREATE TABLE IF NOT EXISTS org_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  pii_redaction_disabled INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);

-- FR-2.11: QA-Lead-managed domain/business rules that generation must account
-- for, persisted as a real entity rather than a free-text string passed per call.
CREATE TABLE IF NOT EXISTS business_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- FR-1.2: key frames extracted from an uploaded video, each traceable back to
-- its source video file.
CREATE TABLE IF NOT EXISTS video_frames (
  id TEXT PRIMARY KEY,
  source_video_name TEXT NOT NULL,
  frame_index INTEGER NOT NULL,
  timestamp_seconds REAL NOT NULL,
  frame_url TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- FR-6.12: per-user notification channel/frequency, overriding the org
-- default set by FR-6.9/FR-7.3.
CREATE TABLE IF NOT EXISTS user_notification_prefs (
  user_id TEXT PRIMARY KEY,
  channel TEXT NOT NULL DEFAULT 'org-default', -- slack/teams/email/org-default
  frequency TEXT NOT NULL DEFAULT 'per-run', -- per-run/digest
  updated_at TEXT NOT NULL
);

-- FR-4.21: secrets/env-vars that generated automation scripts need at runtime
-- (API keys, test-account passwords). Encrypted at rest (secretsService AES-256-GCM);
-- injected into the execution child-process env only, never written to script
-- source, logs, or the Git-committed script.
CREATE TABLE IF NOT EXISTS platform_secrets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE, -- referenced by scripts as process.env[name]
  value_encrypted TEXT NOT NULL,
  value_iv TEXT NOT NULL,
  value_tag TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- FR-4.23: version every edit to a saved Execution Profile, with a diff and
-- the editor's identity per version (mirrors FR-2.6 test case versioning).
CREATE TABLE IF NOT EXISTS execution_profile_versions (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  edited_by TEXT,
  created_at TEXT NOT NULL
);

-- FR-6.5: per-failed-test evidence entries for a run, parsed from Playwright's own JSON
-- reporter output (test title/file + its own artifact list), instead of one evidence_path
-- for the whole run. Genuinely per-failed-test granularity; NOT per-step -- Playwright's
-- JSON reporter output does not include a stable per-action/per-step breakdown to parse.
CREATE TABLE IF NOT EXISTS execution_evidence (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  test_title TEXT,
  test_file TEXT,
  status TEXT,
  evidence_path TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES execution_runs(id)
);
-- error_message added below via ensureColumn: the actual Playwright error text
-- (e.g. "Test timeout of 15000ms exceeded... waiting for getByLabel('Username')")
-- for this specific failed test, parsed from the JSON reporter's per-test result.
-- Previously only title/file/status were kept, so the failure report had no way
-- to show *why* a test failed short of opening the raw artifacts on disk.

-- SR-FR-0.4: short-TTL idempotency store for state-mutating POST endpoints. A
-- repeated Idempotency-Key + method + path within the TTL window replays the
-- original stored response instead of re-executing the mutation. No Redis in
-- this environment -- a SQLite table with a TTL check on lookup is the honest
-- in-process equivalent.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  idem_key TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (idem_key, method, path)
);

-- AI Crawler: one row per distinct site the crawler has ever been pointed at,
-- so a repeat run of the same URL is auto-detected as "known" and switches to
-- diff mode instead of the user having to pick a toggle.
CREATE TABLE IF NOT EXISTS crawl_sites (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'running', -- running/completed/failed/paused
  pages_discovered INTEGER NOT NULL DEFAULT 0,
  forms_discovered INTEGER NOT NULL DEFAULT 0,
  scenarios_discovered INTEGER NOT NULL DEFAULT 0,
  current_page TEXT,
  error TEXT,
  is_rerun INTEGER NOT NULL DEFAULT 0,
  capture_api INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_crawled_at TEXT
);

-- One row per page discovered on a site. dom_hash/screenshot_hash form the
-- Phase 4 baseline; elements_json/apis_json store the full locator + captured
-- network inventory for that page as of the most recent crawl.
CREATE TABLE IF NOT EXISTS crawl_pages (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT,
  dom_hash TEXT,
  screenshot_hash TEXT,
  elements_json TEXT NOT NULL DEFAULT '[]',
  apis_json TEXT NOT NULL DEFAULT '[]',
  change_status TEXT NOT NULL DEFAULT 'new', -- new/changed/unchanged
  diff_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (site_id) REFERENCES crawl_sites(id)
);

-- Phase 3/Phase 7: one row per generated scenario, with a stable id independent
-- of list position/index so deletion still targets the right item after re-runs
-- or re-ordering. status supports a session-scoped soft-delete/undo (Phase 7).
CREATE TABLE IF NOT EXISTS crawl_scenarios (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  title TEXT NOT NULL,
  type TEXT NOT NULL, -- positive/negative/flow
  flow_group TEXT,
  steps_json TEXT NOT NULL, -- JSON array of human-readable Given/When/Then steps
  locators_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active', -- active/soft_deleted
  deleted_at TEXT,
  generated_test_case_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (site_id) REFERENCES crawl_sites(id),
  FOREIGN KEY (page_id) REFERENCES crawl_pages(id)
);

-- SR-FR-7.2: closest honest approximation of a message-queue DLQ available in
-- this monolith -- outbound Slack/Teams notifications and Jira/Azure bug-filing
-- retry with backoff; once retries are exhausted the failed delivery is logged
-- here so it's visible rather than silently dropped.
CREATE TABLE IF NOT EXISTS failed_deliveries (
  id TEXT PRIMARY KEY,
  delivery_type TEXT NOT NULL, -- 'slack_teams_notification' | 'auto_file_bug'
  target_ref TEXT,             -- integration id or provider name
  payload TEXT,                -- JSON context (message/testCase/run)
  attempts INTEGER NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL
);

-- Bug Detection Engine: proactively discovered defects, distinct from
-- FR-7.6's reactive "previously-passing test now fails" regression filing.
-- A finding can come from an exploratory UI scan (broken images, console/page
-- errors, server errors while walking a Screen) or an API fuzz pass (an
-- endpoint returning 5xx on a boundary/malformed/negative-id input) -- run
-- automatically right after an execution run completes, or on demand.
CREATE TABLE IF NOT EXISTS bug_findings (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,            -- 'ui_exploratory' | 'api_fuzz' | 'regression'
  severity TEXT NOT NULL,          -- 'critical' | 'high' | 'medium' | 'low'
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  screen_id TEXT,
  run_id TEXT,
  evidence TEXT,                   -- JSON: url/endpoint/status/stack/console lines
  steps_to_reproduce TEXT,         -- JSON array of ordered human-readable steps
  screenshot_url TEXT,             -- /uploads/... path to a screenshot at the moment of failure
  video_url TEXT,                  -- /uploads/... path to a screen recording of the scan, when captured
  status TEXT NOT NULL DEFAULT 'open', -- 'open' | 'acknowledged' | 'resolved' | 'ignored'
  filed_provider TEXT,             -- 'jira' | 'azure' once filed
  filed_external_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (screen_id) REFERENCES screens(id),
  FOREIGN KEY (run_id) REFERENCES execution_runs(id)
);

-- Evidence-first QA scan telemetry. Unlike execution_runs (one generated
-- script), this records exploratory UI/API work and the false-positive gate.
CREATE TABLE IF NOT EXISTS qa_scan_runs (
  id TEXT PRIMARY KEY,
  site_id TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  scenarios_executed INTEGER NOT NULL DEFAULT 0,
  workflows_executed INTEGER NOT NULL DEFAULT 0,
  api_calls_analyzed INTEGER NOT NULL DEFAULT 0,
  ui_states_analyzed INTEGER NOT NULL DEFAULT 0,
  automation_failures INTEGER NOT NULL DEFAULT 0,
  environment_failures INTEGER NOT NULL DEFAULT 0,
  duplicate_issues INTEGER NOT NULL DEFAULT 0,
  false_positives_rejected INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (site_id) REFERENCES crawl_sites(id)
);
`);

function ensureColumn(tableName: string, columnName: string, columnDefinition: string) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
  }
}

ensureColumn("bug_findings", "steps_to_reproduce", "TEXT");
ensureColumn("bug_findings", "screenshot_url", "TEXT");
ensureColumn("bug_findings", "video_url", "TEXT");
ensureColumn("bug_findings", "root_cause", "TEXT NOT NULL DEFAULT 'UNKNOWN_REQUIRES_INVESTIGATION'");
ensureColumn("bug_findings", "priority", "TEXT NOT NULL DEFAULT 'P2'");
ensureColumn("bug_findings", "environment_json", "TEXT NOT NULL DEFAULT '{}'");
ensureColumn("bug_findings", "preconditions_json", "TEXT NOT NULL DEFAULT '[]'");
ensureColumn("bug_findings", "test_data_json", "TEXT NOT NULL DEFAULT '{}'");
ensureColumn("bug_findings", "expected_result", "TEXT");
ensureColumn("bug_findings", "actual_result", "TEXT");
ensureColumn("bug_findings", "reproduction_attempts", "INTEGER NOT NULL DEFAULT 1");
ensureColumn("bug_findings", "reproduction_successes", "INTEGER NOT NULL DEFAULT 1");
ensureColumn("bug_findings", "validation_status", "TEXT NOT NULL DEFAULT 'candidate'");
ensureColumn("bug_findings", "fingerprint", "TEXT");
ensureColumn("bug_findings", "occurrence_count", "INTEGER NOT NULL DEFAULT 1");
ensureColumn("bug_findings", "affected_scenarios_json", "TEXT NOT NULL DEFAULT '[]'");
ensureColumn("bug_findings", "site_id", "TEXT");
// Findings created before the evidence gate have no fingerprint/reproduction
// proof. Keep them visible for investigation but never count them as real bugs.
db.prepare(`
  UPDATE bug_findings
  SET validation_status = 'candidate',
      root_cause = 'UNKNOWN_REQUIRES_INVESTIGATION'
  WHERE fingerprint IS NULL
`).run();

ensureColumn("test_cases", "priority", "TEXT NOT NULL DEFAULT 'Medium'");
ensureColumn("test_cases", "traceability_context", "TEXT");
ensureColumn("test_cases", "explanation", "TEXT");
// FR-5.5/FR-5.6: self-healing sync state, tracked separately from review status
ensureColumn("test_cases", "automation_sync_state", "TEXT NOT NULL DEFAULT 'original-state'");
ensureColumn("test_cases", "needs_regeneration", "INTEGER NOT NULL DEFAULT 0");
// FR-9.6: tag whether the generation prompt for this test case had FR-9.6 prompt
// compression applied, so reviewer-agreement-rate (FR-2.13) can be broken down
// compressed-vs-uncompressed to measure whether compression degrades accuracy.
ensureColumn("test_cases", "generated_with_compression", "INTEGER NOT NULL DEFAULT 0");

ensureColumn("automation_scripts", "sync_state", "TEXT NOT NULL DEFAULT 'original-state'");
ensureColumn("automation_scripts", "needs_regeneration", "INTEGER NOT NULL DEFAULT 0");

// FR-9.3: track LLM generation lifecycle so outages degrade to queued/retry instead of a hard failure
ensureColumn("inputs", "generation_status", "TEXT NOT NULL DEFAULT 'none'"); // none/pending/queued/retrying/completed/failed
ensureColumn("inputs", "generation_attempts", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("inputs", "generation_last_error", "TEXT");

// FR-5.2: API (Swagger/OpenAPI) change detection -- identify re-imports of the
// same spec (by title) and diff their structural hash so a real schema change
// is flagged Changed/Unchanged instead of only counting openapi_spec inputs.
ensureColumn("inputs", "spec_title", "TEXT");
ensureColumn("inputs", "content_hash", "TEXT");
ensureColumn("inputs", "change_status", "TEXT"); // new/changed/unchanged (openapi_spec inputs only)
ensureColumn("inputs", "source_url", "TEXT"); // set only when the spec was fetched from a live URL, enabling scheduled re-fetch

ensureColumn("execution_runs", "profile_id", "TEXT");
ensureColumn("execution_runs", "browser_set", "TEXT NOT NULL DEFAULT 'chromium'");
ensureColumn("execution_runs", "concurrency", "INTEGER NOT NULL DEFAULT 1");
ensureColumn("execution_runs", "artifact_capture_mode", "TEXT NOT NULL DEFAULT 'logs-only'");
ensureColumn("execution_runs", "retention_days", "INTEGER NOT NULL DEFAULT 30");
ensureColumn("execution_runs", "selection_mode", "TEXT NOT NULL DEFAULT 'full-suite'");
ensureColumn("execution_runs", "retry_strategy", "TEXT NOT NULL DEFAULT 'no-retry'");
ensureColumn("execution_runs", "queue_position", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("execution_runs", "provider", "TEXT NOT NULL DEFAULT 'local'");
ensureColumn("execution_runs", "execution_context", "TEXT");
ensureColumn("execution_runs", "trigger_source", "TEXT");
ensureColumn("execution_runs", "reserved_runner_count", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("execution_runs", "headless_mode", "INTEGER NOT NULL DEFAULT 1");
ensureColumn("execution_runs", "reuse_browser_instances", "INTEGER NOT NULL DEFAULT 0");

// FR-4.8: retention-based artifact cleanup
ensureColumn("execution_runs", "evidence_deleted_at", "TEXT");

// FR-4.16: scheduled runs -- avoid re-triggering the same profile twice in one day
ensureColumn("execution_profiles", "last_scheduled_run_date", "TEXT");

// Module 6: Reporting & Analytics
ensureColumn("automation_scripts", "is_flaky", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("execution_runs", "estimated_duration_ms", "INTEGER");
ensureColumn("execution_runs", "time_saved_ms", "INTEGER");

// Module 8: Admin & Governance
ensureColumn("test_cases", "owner_user_id", "TEXT"); // FR-8.5: routed to the tester/team owning the module
ensureColumn("test_cases", "critical_path", "INTEGER NOT NULL DEFAULT 0"); // FR-8.6
ensureColumn("test_cases", "second_reviewer_required", "INTEGER NOT NULL DEFAULT 0"); // FR-8.6
ensureColumn("test_cases", "second_reviewer_status", "TEXT"); // pending/approved/rejected
ensureColumn("test_cases", "second_reviewer_id", "TEXT");
ensureColumn("test_cases", "flagged_for_re_review", "INTEGER NOT NULL DEFAULT 0"); // FR-8.8
ensureColumn("test_cases", "last_sampled_at", "TEXT");

// FR-2.14: tag every test case + linked script with the Screen/module it belongs to
ensureColumn("test_cases", "screen_id", "TEXT");
ensureColumn("automation_scripts", "screen_id", "TEXT");
// FR-3.7: shared setup/teardown fixture file each script in the same screen references
ensureColumn("automation_scripts", "fixture_path", "TEXT");
ensureColumn("screens", "fixture_path", "TEXT");
// FR-4.21: comma-separated platform_secrets.name values this script references at runtime
ensureColumn("automation_scripts", "secrets_ref", "TEXT");
// FR-4.22: whether this run's outcome should be reported as blocking for CI/CD gating
ensureColumn("execution_runs", "gate_result", "TEXT"); // null / 'pass' / 'block'
// FR-6.8: "stale" coverage-gap detection needs to know when a case was last (re-)approved
ensureColumn("test_cases", "last_approved_at", "TEXT");

// FR-4.19: execution runs/profiles can target a named Environment
ensureColumn("execution_runs", "environment_id", "TEXT");
ensureColumn("execution_profiles", "default_environment_id", "TEXT");

// FR-4.22: CI/CD-triggered runs can be configured to gate (fail) the pipeline/PR check
ensureColumn("execution_profiles", "gate_on_failure", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("execution_runs", "gate_on_failure", "INTEGER NOT NULL DEFAULT 0");

// FR-4.23: version every edit to a saved Execution Profile (mirrors FR-2.6 test case versioning)
ensureColumn("execution_profiles", "version", "INTEGER NOT NULL DEFAULT 1");
ensureColumn("execution_profiles", "last_edited_by", "TEXT");

// FR-4.10: custom-selection mode's user-picked tags/modules (comma-separated keywords
// matched against test case title/category) -- makes "custom-selection" restrict which
// scripts run instead of being stored but inert.
ensureColumn("execution_profiles", "custom_selection_query", "TEXT");

// FR-8.9: platform SSO/SAML login (distinct from in-app RBAC) -- identity-provider linkage
ensureColumn("users", "sso_subject_id", "TEXT");
ensureColumn("users", "sso_provider", "TEXT");
ensureColumn("users", "sso_disabled_at", "TEXT"); // set when the IdP disables the user; revokes platform access

// FR-8.11: audit log retention window (immutability is enforced at the route layer -- no
// UPDATE/DELETE route exists for audit_log at all, see routes/admin.ts)
ensureColumn("audit_log", "retain_until", "TEXT");

// FR-4.4: which CI/CD tool triggered a webhook-invoked run (github-actions/jenkins/
// azure-pipelines/gitlab-ci/unknown), for per-tool attribution of results.
ensureColumn("execution_runs", "ci_source", "TEXT");

// FR-4.6: instrumentation proving actual browser-reuse behavior from the Playwright run,
// rather than only inferring it from the REUSE_BROWSER_INSTANCES config flag.
ensureColumn("execution_runs", "actual_worker_count", "INTEGER");
ensureColumn("execution_runs", "browser_launch_count", "INTEGER");

// FR-5.4: QA-Lead-editable self-heal high-confidence threshold, replacing the
// previously hardcoded 0.8 constant in selfHealingService.ts/client Testing.tsx.
ensureColumn("org_settings", "self_heal_confidence_threshold", "REAL NOT NULL DEFAULT 0.8");

// Single-QA cost-saving mode: routes more generation calls to the cheap
// "economy" model tier by raising chooseModelTier's length threshold
// (llmGatewayService.ts). Defaults ON: this platform's primary user is a
// solo QA running everything locally, where the primary tier's extra quality
// matters far less than keeping token cost/latency down on the large majority
// of day-to-day generation calls. Still a one-click opt-out from Settings for
// anyone who wants the higher-quality tier on every call.
ensureColumn("org_settings", "cost_saving_mode", "INTEGER NOT NULL DEFAULT 1");
ensureColumn("org_settings", "economy_tier_length_threshold", "INTEGER NOT NULL DEFAULT 1200");

// v4.6 FR4.24-FR4.30: Execution Speed Modes (Ultrafast vs. Fast, single-user).
// speed_mode defaults to 'fast' on both tables per the SRS Section 12.9 backward-
// compat note, so every pre-existing run/profile is treated as Fast Mode (its
// existing checkpointed behavior) rather than silently reinterpreted as Ultrafast.
ensureColumn("execution_runs", "speed_mode", "TEXT NOT NULL DEFAULT 'fast'");
ensureColumn("execution_profiles", "default_speed_mode", "TEXT NOT NULL DEFAULT 'fast'");
// Speed fix: legacy profiles defaulted concurrency=1 which serialized large suites.
// Normalize to 5 workers (current cap) — also clamp any temporary higher values.
try {
  db.prepare("UPDATE execution_profiles SET concurrency = 5 WHERE concurrency IS NULL OR concurrency <= 1 OR concurrency > 5").run();
} catch {
  /* best-effort */
}
// FR-4.26: QA-Lead-editable confidence threshold Ultrafast Mode uses to auto-accept
// a generated test case, mirroring the self_heal_confidence_threshold pattern above.
ensureColumn("org_settings", "ultrafast_confidence_threshold", "REAL NOT NULL DEFAULT 0.85");
// FR-4.26: non-blocking "needs review later" queue -- a case below the Ultrafast
// threshold is flagged here (status stays 'draft', untouched) instead of pausing
// the run or overloading the existing needs_discussion status, which is a manual
// reviewer decision, not an automated below-threshold routing outcome.
ensureColumn("test_cases", "needs_review_later", "INTEGER NOT NULL DEFAULT 0");

// FR-4.29: review_audit_entries previously recorded no reviewer at all, so an accept/edit/
// reject could not be tied to a named reviewer -- the review route now requires and records
// this on every entry (a real user id for a human reviewer, or "system:ultrafast" for
// Ultrafast Mode's auto-accept, itself already a named/attributable actor type per FR-4.30).
ensureColumn("review_audit_entries", "reviewer_user_id", "TEXT");

// SR-FR-3.4: locator strategy as queryable structured metadata (accessibility vs
// css_xpath_fallback), not just an inline code comment -- populated at generation
// time in codegenService.ts so FR-3.4 compliance is reportable via a real query
// instead of grepping generated source.
ensureColumn("automation_scripts", "locator_strategy", "TEXT"); // 'accessibility' | 'css_xpath_fallback' | 'mixed' | 'n/a'

// AI Crawler: spelling check over crawled page titles/element labels
// (crawler/spellcheck.ts). Per-page issues live alongside elements_json/apis_json;
// the site-level count mirrors the existing pages_discovered/forms_discovered/
// scenarios_discovered aggregate pattern for the crawl progress UI.
ensureColumn("crawl_pages", "spelling_issues_json", "TEXT NOT NULL DEFAULT '[]'");
ensureColumn("crawl_sites", "spelling_issues_found", "INTEGER NOT NULL DEFAULT 0");

ensureColumn("execution_evidence", "error_message", "TEXT");

// AI Crawler: per-page structural component inventory (header/navbar/forms/
// tables/modals/filters/pagination/cards/footer/...) -- see
// crawler/componentInventory.ts. Distinct from elements_json (per-clickable-
// element locator data); this is the page-composition summary shown as its
// own step before scenario/test-case review.
ensureColumn("crawl_pages", "component_inventory_json", "TEXT NOT NULL DEFAULT '[]'");

// AI Crawler: which of the three test suites a scenario belongs to --
// smoke (one core happy path per page/form), functional (edge/negative/
// boundary/multi-step coverage), or regression (a previously-existing
// scenario carried forward unchanged because its page didn't change on a
// re-crawl -- see crawlerService.ts's persistCrawlResult). Existing rows
// predate this column and default to NULL from ensureColumn's plain ADD
// COLUMN, so backfill them from `type` with the same smoke/functional split
// generation-time code now applies, rather than leaving old scenarios
// uncategorized in the UI.
ensureColumn("crawl_scenarios", "tier", "TEXT");
db.prepare("UPDATE crawl_scenarios SET tier = 'functional' WHERE tier IS NULL AND type IN ('negative', 'flow', 'api')").run();
db.prepare("UPDATE crawl_scenarios SET tier = 'smoke' WHERE tier IS NULL AND type = 'positive'").run();

// Re-crawl tracking: last_seen_at marks pages still present; recrawl_summary_json
// stores new/changed/unchanged/removed counts from the latest run.
ensureColumn("crawl_pages", "last_seen_at", "TEXT");
ensureColumn("crawl_sites", "recrawl_summary_json", "TEXT");
ensureColumn("crawl_sites", "last_full_crawl_date", "TEXT");
ensureColumn("crawl_pages", "is_persisted_from_previous_crawl", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("crawl_sites", "crawl_mode", "TEXT"); // incremental | full
ensureColumn("crawl_pages", "etag", "TEXT");
ensureColumn("crawl_pages", "last_modified", "TEXT");
ensureColumn("crawl_pages", "a11y_hash", "TEXT");
ensureColumn("crawl_pages", "change_signals_json", "TEXT NOT NULL DEFAULT '{}'");
// AI Crawler: the page's same-origin outbound links as of its last real scan.
// Cheap-skipped pages (HTTP 304 / sitemap lastmod) never navigate, so discovery
// replays this adjacency into the nav graph -- without it the flow graph shrinks
// on every incremental re-crawl and journey selection becomes nondeterministic.
ensureColumn("crawl_pages", "links_json", "TEXT NOT NULL DEFAULT '[]'");
ensureColumn("crawl_pages", "miss_count", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("crawl_pages", "http_status", "INTEGER");
ensureColumn("crawl_sites", "schedule_cron", "TEXT");
ensureColumn("crawl_sites", "watch_enabled", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("crawl_sites", "ci_webhook_secret", "TEXT");
ensureColumn("crawl_sites", "last_progress_json", "TEXT");
// Heuristic classification of *why* a test failed -- 'automation_issue' (the
// generated script's own locator/timeout, not the product), 'environment_issue'
// (target unreachable/DNS/connection refused), or 'possible_bug' (an assertion
// genuinely mismatched real page/API content). Lets the customer-facing bug
// report distinguish "our script needs fixing" from "your product has a defect"
// instead of dumping every failure into one undifferentiated list.
ensureColumn("execution_evidence", "failure_class", "TEXT");
ensureColumn("execution_evidence", "failure_label", "TEXT");
ensureColumn("execution_evidence", "failure_category", "TEXT");
ensureColumn("automation_scripts", "locator_quality_json", "TEXT");
ensureColumn("automation_scripts", "readiness_score", "REAL");
ensureColumn("automation_scripts", "heal_events_json", "TEXT NOT NULL DEFAULT '[]'");
ensureColumn("org_settings", "self_heal_suggest_threshold", "REAL NOT NULL DEFAULT 0.7");

// Feature #7: Interaction Validation - stores validation results for user interactions
// detected during test execution (clicks, form inputs, navigation, etc.)
db.exec(`
CREATE TABLE IF NOT EXISTS interaction_validations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  test_file TEXT,
  interaction_type TEXT NOT NULL,  -- click | input | submit | navigate | scroll | hover | focus | blur
  element_selector TEXT,
  element_text TEXT,
  is_valid INTEGER NOT NULL,
  violations_json TEXT NOT NULL DEFAULT '[]',  -- JSON array of violations
  warnings_json TEXT NOT NULL DEFAULT '[]',    -- JSON array of warnings
  suggestions_json TEXT NOT NULL DEFAULT '[]', -- JSON array of suggestions
  duration_ms INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES execution_runs(id)
);
`);

// Feature #8: User-Defined Assertions - QA-Lead-managed custom validation rules
db.exec(`
CREATE TABLE IF NOT EXISTS assertion_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL,  -- element_visible | element_contains_text | page_title_equals | etc.
  target TEXT NOT NULL,  -- CSS selector or custom target
  expected_value TEXT,  -- Expected value for assertion
  custom_code TEXT,  -- For custom_javascript type
  error_message TEXT,
  severity TEXT NOT NULL DEFAULT 'high',  -- critical | high | medium | low
  applicable_to TEXT NOT NULL DEFAULT 'All',  -- JSON array of test categories
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assertion_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  test_name TEXT,
  passed INTEGER NOT NULL,
  message TEXT,
  actual_value TEXT,
  expected_value TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES execution_runs(id),
  FOREIGN KEY (rule_id) REFERENCES assertion_rules(id)
);
`);

// Feature #9: Cost Transparency Dashboard - tracks execution costs
db.exec(`
CREATE TABLE IF NOT EXISTS execution_costs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  estimated_cost REAL NOT NULL,
  actual_cost REAL NOT NULL,
  costs_accumulated REAL NOT NULL,
  test_count INTEGER NOT NULL,
  cost_per_test REAL NOT NULL,
  breakdown_json TEXT NOT NULL,  -- JSON breakdown of cost components
  timestamp INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES execution_runs(id)
);
`);

// Feature #10: Incremental Crawl - tracks page change detection
db.exec(`
CREATE TABLE IF NOT EXISTS page_change_detections (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  url TEXT NOT NULL,
  status TEXT NOT NULL,  -- unchanged | changed | new
  old_dom_hash TEXT,
  new_dom_hash TEXT,
  changes_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  FOREIGN KEY (site_id) REFERENCES crawl_sites(id),
  FOREIGN KEY (page_id) REFERENCES crawl_pages(id)
);
`);

// Feature #11: Fast Mode - tracks execution with different speed modes
db.exec(`
CREATE TABLE IF NOT EXISTS fast_mode_executions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  mode TEXT NOT NULL,  -- balanced | performance | thorough | custom
  strategy TEXT NOT NULL,  -- all-tests | critical-path | smoke-only | custom-selection
  parallel_workers INTEGER NOT NULL,
  test_selection_percent REAL NOT NULL,
  actual_tests INTEGER NOT NULL,
  actual_duration_seconds INTEGER NOT NULL,
  actual_cost REAL NOT NULL,
  tests_passed INTEGER NOT NULL,
  tests_failed INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES execution_runs(id)
);
`);

// Feature #12: Smart Test Presets - pre-configured execution profiles
db.exec(`
CREATE TABLE IF NOT EXISTS execution_presets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL,  -- smoke | regression | full | ci_cd | development | nightly | custom
  is_builtin INTEGER NOT NULL DEFAULT 0,
  test_selection_strategy TEXT NOT NULL,
  parallel_workers INTEGER NOT NULL,
  timeout_seconds INTEGER NOT NULL,
  fast_mode_config_json TEXT NOT NULL,
  capture_artifacts TEXT NOT NULL,  -- minimal | screenshots | full | video
  gate_on_failure INTEGER NOT NULL,
  retry_strategy TEXT NOT NULL,  -- no-retry | failed-only | all
  notify_on_complete INTEGER NOT NULL,
  estimated_duration_seconds INTEGER,
  estimated_cost REAL,
  best_for_json TEXT NOT NULL,  -- JSON array
  created_by TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS preset_usage (
  id TEXT PRIMARY KEY,
  preset_id TEXT NOT NULL,
  used_at TEXT NOT NULL,
  FOREIGN KEY (preset_id) REFERENCES execution_presets(id)
);
`);

// Seed a default user per SRS user class (FR-8.1) so RBAC is usable out of the box
const userCount = (db.prepare("SELECT COUNT(*) as count FROM users").get() as any).count as number;
if (userCount === 0) {
  const now = new Date().toISOString();
  const seedUsers = [
    { id: "user-qa-lead", name: "Priya (QA Lead)", role: "QA Lead", email: "priya@example.com", owned_modules: "login,auth,payments" },
    { id: "user-tester", name: "Sam (Tester)", role: "Tester", email: "sam@example.com", owned_modules: "checkout,cart" },
    { id: "user-developer", name: "Alex (Developer)", role: "Developer", email: "alex@example.com", owned_modules: "" },
    { id: "user-manager", name: "Jordan (Manager)", role: "Manager", email: "jordan@example.com", owned_modules: "" },
  ];
  const insertUser = db.prepare(
    "INSERT INTO users (id, name, role, email, owned_modules, created_at) VALUES (@id, @name, @role, @email, @owned_modules, @created_at)"
  );
  for (const u of seedUsers) insertUser.run({ ...u, created_at: now });
}

// FR-1.8: seed the single org_settings row so the redaction toggle always has a value
const orgSettingsExist = (db.prepare("SELECT COUNT(*) as count FROM org_settings").get() as any).count as number;
if (orgSettingsExist === 0) {
  db.prepare("INSERT INTO org_settings (id, pii_redaction_disabled, updated_by, updated_at) VALUES (1, 0, NULL, ?)").run(new Date().toISOString());
}
