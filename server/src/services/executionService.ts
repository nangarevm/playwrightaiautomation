import { nanoid } from "nanoid";
import { execFile } from "child_process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { db } from "../db.js";
import { recordTimeBreakdownForRun, updateFlakyFlagForScript } from "./reportingService.js";
import { notifyAllOnRunComplete } from "./integrationsService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.join(__dirname, "..", "..");

const BROWSER_SETS = new Set(["chromium", "chromium+firefox", "all", "headless"]);
const ARTIFACT_MODES = new Set(["logs-only", "failures-only", "all-screenshots", "video-failures", "video-all", "full-debug"]);
const SELECTION_MODES = new Set(["smart-selection", "full-suite", "custom-selection", "flaky-tests-only", "scheduled-regression"]);
const RETRY_STRATEGIES = new Set(["no-retry", "retry-flaky", "retry-all", "smart-retry"]);

export function getNpxCommand(): string {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

// FR-4.15: custom execution rules conditioned on test attributes, schedule, or the outcome of
// the prior run. Rules are stored as JSON on the profile: an array of { if, then } objects,
// applied in order (later rules win on conflicting keys).
export interface ExecutionRule {
  if: { testModuleContains?: string; dayOfWeek?: string; previousRunFailed?: boolean };
  then: Partial<{ browser_set: string; artifact_capture_mode: string; retry_strategy: string; selection_mode: string }>;
}

export interface RuleContext {
  testCaseTitle?: string;
  dayOfWeek?: string; // "Monday".."Sunday"
  previousRunFailed?: boolean;
}

export function evaluateCustomExecutionRules(rulesJson: string | null | undefined, context: RuleContext): Record<string, string> {
  if (!rulesJson) return {};
  let rules: ExecutionRule[];
  try {
    const parsed = JSON.parse(rulesJson);
    rules = Array.isArray(parsed) ? parsed : [];
  } catch {
    return {};
  }

  const overrides: Record<string, string> = {};
  for (const rule of rules) {
    const cond = rule.if || {};
    let matches = true;
    if (cond.testModuleContains) {
      matches = matches && Boolean(context.testCaseTitle?.toLowerCase().includes(cond.testModuleContains.toLowerCase()));
    }
    if (cond.dayOfWeek) {
      matches = matches && context.dayOfWeek === cond.dayOfWeek;
    }
    if (typeof cond.previousRunFailed === "boolean") {
      matches = matches && context.previousRunFailed === cond.previousRunFailed;
    }
    if (matches && rule.then) {
      Object.assign(overrides, rule.then);
    }
  }
  return overrides;
}

function getDayOfWeek(date = new Date()): string {
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][date.getDay()];
}

function getPreviousRunFailed(scriptId: string): boolean {
  const lastRun = db
    .prepare("SELECT status FROM execution_runs WHERE script_id = ? AND status IN ('passed','failed') ORDER BY created_at DESC LIMIT 1")
    .get(scriptId) as { status: string } | undefined;
  return lastRun?.status === "failed";
}

// FR-4.8: delete artifacts (evidence files) past their configured retention window. retention_days
// <= 0 means "unlimited" (never auto-deleted), matching the SRS's "7/30 days/unlimited" options.
export function cleanupExpiredArtifacts(now = new Date()): { checked: number; deleted: number } {
  const rows = db
    .prepare("SELECT id, evidence_path, retention_days, created_at FROM execution_runs WHERE evidence_path IS NOT NULL AND evidence_deleted_at IS NULL")
    .all() as Array<{ id: string; evidence_path: string; retention_days: number; created_at: string }>;

  let deleted = 0;
  const clearEvidence = db.prepare("UPDATE execution_runs SET evidence_path = NULL, evidence_deleted_at = ? WHERE id = ?");

  for (const row of rows) {
    if (!row.retention_days || row.retention_days <= 0) continue; // unlimited retention
    const ageMs = now.getTime() - new Date(row.created_at).getTime();
    const retentionMs = row.retention_days * 24 * 60 * 60 * 1000;
    if (ageMs < retentionMs) continue;

    try {
      if (row.evidence_path && fs.existsSync(row.evidence_path)) {
        fs.rmSync(row.evidence_path, { recursive: true, force: true });
      }
    } catch {
      /* best-effort deletion */
    }
    clearEvidence.run(now.toISOString(), row.id);
    deleted += 1;
  }

  return { checked: rows.length, deleted };
}

// FR-4.16: time-based scheduled runs, each invoking a specified Execution Profile. Triggers at
// most once per profile per calendar day. Runs every accepted/edited test case's most recent
// script against the profile's configuration.
export async function runScheduledProfiles(now = new Date()): Promise<Array<{ profileId: string; triggeredRuns: number }>> {
  const today = now.toISOString().slice(0, 10);
  const dayName = getDayOfWeek(now);
  const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

  const profiles = db
    .prepare("SELECT * FROM execution_profiles WHERE schedule_json IS NOT NULL AND (last_scheduled_run_date IS NULL OR last_scheduled_run_date != ?)")
    .all(today) as any[];

  const results: Array<{ profileId: string; triggeredRuns: number }> = [];

  for (const profile of profiles) {
    let schedule: { time?: string; daysOfWeek?: string[] };
    try {
      schedule = JSON.parse(profile.schedule_json);
    } catch {
      continue;
    }
    if (!schedule.time) continue;
    if (schedule.daysOfWeek && schedule.daysOfWeek.length > 0 && !schedule.daysOfWeek.includes(dayName)) continue;
    if (schedule.time !== hhmm) continue;

    const scripts = db.prepare(`
      SELECT automation_scripts.* FROM automation_scripts
      JOIN test_cases ON test_cases.id = automation_scripts.test_case_id
      WHERE test_cases.status IN ('accepted','edited')
      GROUP BY automation_scripts.test_case_id
      HAVING automation_scripts.created_at = MAX(automation_scripts.created_at)
    `).all() as any[];

    let triggeredRuns = 0;
    for (const script of scripts) {
      const targetUrl = `http://localhost:${process.env.PORT || 4100}/demo/login.html`;
      await runExecution(script.id, targetUrl, { profile_id: profile.id, trigger_source: "scheduled" });
      triggeredRuns += 1;
    }

    db.prepare("UPDATE execution_profiles SET last_scheduled_run_date = ? WHERE id = ?").run(today, profile.id);
    results.push({ profileId: profile.id, triggeredRuns });
  }

  return results;
}

function normalizeProfile(input: any): any {
  const browserSet = BROWSER_SETS.has(input?.browser_set) ? input.browser_set : "chromium";
  const artifactCaptureMode = ARTIFACT_MODES.has(input?.artifact_capture_mode) ? input.artifact_capture_mode : "logs-only";
  const selectionMode = SELECTION_MODES.has(input?.selection_mode) ? input.selection_mode : "full-suite";
  const retryStrategy = RETRY_STRATEGIES.has(input?.retry_strategy) ? input.retry_strategy : "no-retry";
  return {
    name: input?.name || "Unnamed profile",
    description: input?.description || "",
    browser_set: browserSet,
    concurrency: Number(input?.concurrency || 1),
    artifact_capture_mode: artifactCaptureMode,
    retention_days: Number(input?.retention_days || 30),
    selection_mode: selectionMode,
    retry_strategy: retryStrategy,
    provider: input?.provider || "local",
    runner_pool_name: input?.runner_pool_name || null,
    reserved_runner_count: Number(input?.reserved_runner_count || 0),
    headless_mode: input?.headless_mode ? 1 : 0,
    reuse_browser_instances: input?.reuse_browser_instances ? 1 : 0,
    is_default_for_team: input?.is_default_for_team ? 1 : 0,
    is_default_for_suite: input?.is_default_for_suite ? 1 : 0,
    rules_json: input?.rules_json ? JSON.stringify(input.rules_json) : null,
    schedule_json: input?.schedule_json ? JSON.stringify(input.schedule_json) : null,
  };
}

export function listExecutionProfiles() {
  return db.prepare("SELECT * FROM execution_profiles ORDER BY created_at DESC").all();
}

export function createExecutionProfile(input: any) {
  const profile = normalizeProfile(input);
  const id = nanoid(10);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO execution_profiles (
      id, name, description, browser_set, concurrency, artifact_capture_mode,
      retention_days, selection_mode, retry_strategy, provider, runner_pool_name,
      reserved_runner_count, headless_mode, reuse_browser_instances,
      is_default_for_team, is_default_for_suite, rules_json, schedule_json,
      created_at, updated_at
    ) VALUES (
      @id, @name, @description, @browser_set, @concurrency, @artifact_capture_mode,
      @retention_days, @selection_mode, @retry_strategy, @provider, @runner_pool_name,
      @reserved_runner_count, @headless_mode, @reuse_browser_instances,
      @is_default_for_team, @is_default_for_suite, @rules_json, @schedule_json,
      @created_at, @updated_at
    )
  `).run({ id, ...profile, created_at: now, updated_at: now });
  return { id, ...profile, created_at: now, updated_at: now };
}

export function updateExecutionProfile(id: string, input: any) {
  const existing = db.prepare("SELECT * FROM execution_profiles WHERE id = ?").get(id) as any;
  if (!existing) throw new Error("Profile not found");
  const profile = normalizeProfile({ ...existing, ...input });
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE execution_profiles SET
      name = @name, description = @description, browser_set = @browser_set,
      concurrency = @concurrency, artifact_capture_mode = @artifact_capture_mode,
      retention_days = @retention_days, selection_mode = @selection_mode,
      retry_strategy = @retry_strategy, provider = @provider, runner_pool_name = @runner_pool_name,
      reserved_runner_count = @reserved_runner_count, headless_mode = @headless_mode,
      reuse_browser_instances = @reuse_browser_instances, is_default_for_team = @is_default_for_team,
      is_default_for_suite = @is_default_for_suite, rules_json = @rules_json,
      schedule_json = @schedule_json, updated_at = @updated_at
    WHERE id = @id
  `).run({ id, ...profile, updated_at: now });
  return { id, ...profile, created_at: existing.created_at, updated_at: now };
}

export function deleteExecutionProfile(id: string) {
  db.prepare("DELETE FROM execution_profiles WHERE id = ?").run(id);
}

export function suggestExecutionProfile(context: Record<string, string> = {}) {
  const profiles = listExecutionProfiles() as any[];
  if (profiles.length === 0) return { suggestedProfileId: null, profile: null };
  const defaultProfile = profiles.find((profile: any) => profile.is_default_for_team || profile.is_default_for_suite) || profiles[0];
  const byContext = profiles.find((profile: any) => {
    const contextKey = context?.trigger_source || context?.execution_context || "";
    if (contextKey.includes("ci")) return profile.provider === "ci" || profile.provider === "cloud";
    return false;
  });
  return { suggestedProfileId: (byContext || defaultProfile)?.id || null, profile: byContext || defaultProfile || null };
}

export function listExecutionQueues() {
  return db.prepare("SELECT * FROM execution_runs WHERE status = 'queued' ORDER BY created_at ASC").all();
}

export async function queueExecution(scriptId: string, targetUrl: string, input: any = {}): Promise<any> {
  const profile = input.profile_id ? (db.prepare("SELECT * FROM execution_profiles WHERE id = ?").get(input.profile_id) as any) : null;
  const config = profile ? { ...profile } : normalizeProfile(input);
  const id = nanoid(10);
  const now = new Date().toISOString();
  const queuePosition = (db.prepare("SELECT COUNT(*) as count FROM execution_runs WHERE status = 'queued' ").get() as any).count + 1;
  db.prepare(`
    INSERT INTO execution_runs (
      id, script_id, profile_id, status, duration_ms, stdout, stderr, evidence_path,
      browser_set, concurrency, artifact_capture_mode, retention_days, selection_mode,
      retry_strategy, queue_position, provider, execution_context, trigger_source,
      reserved_runner_count, headless_mode, reuse_browser_instances, created_at
    ) VALUES (
      @id, @script_id, @profile_id, 'queued', 0, '', '', '',
      @browser_set, @concurrency, @artifact_capture_mode, @retention_days,
      @selection_mode, @retry_strategy, @queue_position, @provider, @execution_context,
      @trigger_source, @reserved_runner_count, @headless_mode, @reuse_browser_instances, @created_at
    )
  `).run({
    id,
    script_id: scriptId,
    profile_id: input.profile_id || null,
    browser_set: config.browser_set,
    concurrency: config.concurrency,
    artifact_capture_mode: config.artifact_capture_mode,
    retention_days: config.retention_days,
    selection_mode: config.selection_mode,
    retry_strategy: config.retry_strategy,
    queue_position: queuePosition,
    provider: config.provider,
    execution_context: input.execution_context || null,
    trigger_source: input.trigger_source || null,
    reserved_runner_count: config.reserved_runner_count,
    headless_mode: config.headless_mode,
    reuse_browser_instances: config.reuse_browser_instances,
    created_at: now,
  });
  return { id, status: "queued", queuePosition };
}

export function runExecution(scriptId: string, targetUrl: string, input: any = {}): Promise<any> {
  return new Promise((resolve) => {
    const script = db.prepare("SELECT * FROM automation_scripts WHERE id = ?").get(scriptId) as any;
    if (!script) {
      resolve({ error: "Script not found" });
      return;
    }

    if (script.security_scan_status === "flagged") {
      const id = nanoid(10);
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO execution_runs (id, script_id, status, duration_ms, stdout, stderr, created_at)
        VALUES (@id, @script_id, 'blocked', 0, '', @stderr, @created_at)
      `).run({
        id,
        script_id: scriptId,
        stderr: `Execution blocked: security scan flagged this script (${script.security_scan_notes})`,
        created_at: now,
      });
      resolve({ id, status: "blocked", notes: script.security_scan_notes });
      return;
    }

    const relFile = path.relative(SERVER_ROOT, script.file_path).replace(/\\/g, "/");
    const startedAt = Date.now();
    const profile = input.profile_id ? (db.prepare("SELECT * FROM execution_profiles WHERE id = ?").get(input.profile_id) as any) : null;
    const config = profile ? { ...profile } : normalizeProfile(input);

    // FR-4.15: apply the profile's custom execution rules (test-attribute/schedule/prior-outcome
    // conditioned overrides) on top of its base configuration before building the run
    const testCase = db.prepare("SELECT title FROM test_cases WHERE id = ?").get(script.test_case_id) as { title: string } | undefined;
    const ruleOverrides = evaluateCustomExecutionRules(profile?.rules_json, {
      testCaseTitle: testCase?.title,
      dayOfWeek: getDayOfWeek(),
      previousRunFailed: getPreviousRunFailed(scriptId),
    });
    Object.assign(config, ruleOverrides);

    const browserSet = config.browser_set || "chromium";
    const artifactMode = config.artifact_capture_mode || "logs-only";
    const retryStrategy = config.retry_strategy || "no-retry";
    const selectionMode = config.selection_mode || "full-suite";
    const reuseBrowser = Number(config.reuse_browser_instances || 0) === 1;
    const headless = Number(config.headless_mode || 0) === 1;

    const args = ["playwright", "test", relFile, "--reporter=json"];
    if (browserSet === "chromium+firefox") args.push("--project=chromium", "--project=firefox");
    if (browserSet === "all") args.push("--project=chromium", "--project=firefox", "--project=webkit");
    if (headless) args.push("--headed=false");
    if (reuseBrowser) args.push("--retries=1");
    if (retryStrategy === "retry-all") args.push("--retries=2");
    if (retryStrategy === "retry-flaky") args.push("--retries=1");
    if (selectionMode === "flaky-tests-only") args.push("--grep=flaky");

    const runId = nanoid(10);
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO execution_runs (
        id, script_id, profile_id, status, duration_ms, stdout, stderr, evidence_path,
        browser_set, concurrency, artifact_capture_mode, retention_days, selection_mode,
        retry_strategy, queue_position, provider, execution_context, trigger_source,
        reserved_runner_count, headless_mode, reuse_browser_instances, created_at
      ) VALUES (
        @id, @script_id, @profile_id, 'running', 0, '', '', '',
        @browser_set, @concurrency, @artifact_capture_mode, @retention_days,
        @selection_mode, @retry_strategy, 0, @provider, @execution_context,
        @trigger_source, @reserved_runner_count, @headless_mode, @reuse_browser_instances, @created_at
      )
    `).run({
      id: runId,
      script_id: scriptId,
      profile_id: input.profile_id || null,
      browser_set: browserSet,
      concurrency: config.concurrency,
      artifact_capture_mode: artifactMode,
      retention_days: config.retention_days,
      selection_mode: selectionMode,
      retry_strategy: retryStrategy,
      provider: config.provider,
      execution_context: input.execution_context || null,
      trigger_source: input.trigger_source || null,
      reserved_runner_count: config.reserved_runner_count,
      headless_mode: headless ? 1 : 0,
      reuse_browser_instances: reuseBrowser ? 1 : 0,
      created_at: now,
    });

    execFile(
      getNpxCommand(),
      args,
      {
        cwd: SERVER_ROOT,
        env: { ...process.env, TARGET_URL: targetUrl, PLAYWRIGHT_BROWSER_SET: browserSet, ARTIFACT_CAPTURE_MODE: artifactMode, RETRY_STRATEGY: retryStrategy, SELECTION_MODE: selectionMode },
        maxBuffer: 20 * 1024 * 1024,
        shell: process.platform === "win32",
      },
      (error, stdout, stderr) => {
        const durationMs = Date.now() - startedAt;
        let status: "passed" | "failed" | "error" = error ? "failed" : "passed";
        let evidencePath: string | null = null;

        try {
          const resultsDir = path.join(SERVER_ROOT, "test-results", "artifacts");
          if (fs.existsSync(resultsDir)) {
            const entries = fs.readdirSync(resultsDir);
            if (entries.length > 0) {
              evidencePath = path.join(resultsDir, entries[entries.length - 1]);
            }
          }
        } catch {
          /* best-effort evidence lookup */
        }

        db.prepare(`
          UPDATE execution_runs
          SET status = @status, duration_ms = @duration_ms, stdout = @stdout, stderr = @stderr, evidence_path = @evidence_path
          WHERE id = @id
        `).run({
          id: runId,
          status,
          duration_ms: durationMs,
          stdout: stdout?.slice(0, 8000) ?? "",
          stderr: stderr?.slice(0, 8000) ?? "",
          evidence_path: evidencePath,
        });

        db.prepare("UPDATE automation_scripts SET last_run_status = ? WHERE id = ?").run(status, scriptId);

        // FR-6.2 / FR-6.7: refresh the flaky flag and record actual-vs-estimated time now that the run is final
        const isFlaky = updateFlakyFlagForScript(scriptId);
        const timeBreakdown = recordTimeBreakdownForRun(runId, selectionMode, durationMs);

        // FR-7.3: notify Slack/Teams -- best-effort, never blocks the response on a broken webhook
        notifyAllOnRunComplete(`Run ${runId} for script ${scriptId}: ${status.toUpperCase()} (${durationMs}ms)`).catch(() => undefined);

        resolve({ id: runId, status, durationMs, stdout, stderr, evidencePath, browserSet, artifactMode, retryStrategy, selectionMode, isFlaky, timeBreakdown });
      }
    );
  });
}
