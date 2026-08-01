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

CREATE TABLE IF NOT EXISTS execution_runs (
  id TEXT PRIMARY KEY,
  script_id TEXT NOT NULL,
  profile_id TEXT,
  status TEXT NOT NULL, -- queued/running/passed/failed/error/blocked
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
`);

function ensureColumn(tableName: string, columnName: string, columnDefinition: string) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
  }
}

ensureColumn("test_cases", "priority", "TEXT NOT NULL DEFAULT 'Medium'");
ensureColumn("test_cases", "traceability_context", "TEXT");
ensureColumn("test_cases", "explanation", "TEXT");
// FR-5.5/FR-5.6: self-healing sync state, tracked separately from review status
ensureColumn("test_cases", "automation_sync_state", "TEXT NOT NULL DEFAULT 'original-state'");
ensureColumn("test_cases", "needs_regeneration", "INTEGER NOT NULL DEFAULT 0");

ensureColumn("automation_scripts", "sync_state", "TEXT NOT NULL DEFAULT 'original-state'");
ensureColumn("automation_scripts", "needs_regeneration", "INTEGER NOT NULL DEFAULT 0");

// FR-9.3: track LLM generation lifecycle so outages degrade to queued/retry instead of a hard failure
ensureColumn("inputs", "generation_status", "TEXT NOT NULL DEFAULT 'none'"); // none/pending/queued/retrying/completed/failed
ensureColumn("inputs", "generation_attempts", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("inputs", "generation_last_error", "TEXT");

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
