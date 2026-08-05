import { nanoid } from "nanoid";
import { execFile, ChildProcess } from "child_process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { db } from "../db.js";
import { recordTimeBreakdownForRun, updateFlakyFlagForScript } from "./reportingService.js";
import { autoFileBugOnRegression, notifyAllOnRunComplete } from "./integrationsService.js";
import { runBugScanForScreen } from "./bugDetectionService.js";
import { decryptSecret } from "./secretsService.js";
import { getEnvironment, preflightHealthCheck } from "./environmentsService.js";
import { logAudit } from "./adminService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.join(__dirname, "..", "..");

// Stop execution: run id -> the live child process, so a stop request has something
// to actually kill (previously there was no handle to a run in flight at all --
// once queued/started, the only way to end it was to let Playwright finish on its
// own). `stoppedRunIds` distinguishes "we killed this on purpose" from "it crashed"
// in the execFile callback below, since a killed process also reports as `error`.
const runningProcesses = new Map<string, ChildProcess>();
const stoppedRunIds = new Set<string>();

// execFile's immediate child is `cmd.exe /c npx ...` on Windows (shell: true), so
// child.kill() alone only kills the shell wrapper, not the actual Playwright/node
// process it spawned -- taskkill /T walks the whole process tree instead. Elsewhere
// (Linux/Mac, shell: false) the child *is* the real process, so a plain signal works.
function killProcessTree(child: ChildProcess) {
  if (process.platform === "win32" && child.pid) {
    execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
  } else {
    child.kill("SIGTERM");
  }
}

// Stops one run: kills its live process if it's actually running, or simply marks
// it stopped if it's still sitting in the queue (nothing to kill -- the queue
// processor only ever dequeues rows still in status 'queued', so flipping the
// status here is enough to keep it from ever starting).
export function stopExecution(runId: string): { ok: boolean; reason?: string } {
  const row = db.prepare("SELECT * FROM execution_runs WHERE id = ?").get(runId) as any;
  if (!row) return { ok: false, reason: "not found" };

  if (row.status === "queued") {
    db.prepare("UPDATE execution_runs SET status = 'stopped' WHERE id = ?").run(runId);
    logAudit(undefined, "execution_run_stopped", "execution_run", runId, { wasQueued: true });
    return { ok: true };
  }

  const child = runningProcesses.get(runId);
  if (row.status === "running" && child) {
    stoppedRunIds.add(runId);
    killProcessTree(child);
    logAudit(undefined, "execution_run_stopped", "execution_run", runId, { wasQueued: false });
    return { ok: true };
  }

  return { ok: false, reason: "not currently running or queued" };
}

// Bulk version for "stop everything in flight" -- e.g. a large batch queued via
// "Run all" that the user wants to abandon partway through, rather than stopping
// hundreds of individual rows one at a time.
export function stopAllExecutions(): { stoppedRunning: number; stoppedQueued: number } {
  const queued = db.prepare("SELECT id FROM execution_runs WHERE status = 'queued'").all() as Array<{ id: string }>;
  if (queued.length > 0) {
    db.prepare("UPDATE execution_runs SET status = 'stopped' WHERE status = 'queued'").run();
  }

  let stoppedRunning = 0;
  for (const [runId, child] of runningProcesses.entries()) {
    stoppedRunIds.add(runId);
    killProcessTree(child);
    stoppedRunning++;
  }

  if (queued.length > 0 || stoppedRunning > 0) {
    logAudit(undefined, "execution_stop_all", "execution_run", null, { stoppedRunning, stoppedQueued: queued.length });
  }
  return { stoppedRunning, stoppedQueued: queued.length };
}

const BROWSER_SETS = new Set(["chromium", "chromium+firefox", "all", "headless"]);
const ARTIFACT_MODES = new Set(["logs-only", "failures-only", "all-screenshots", "video-failures", "video-all", "full-debug"]);
const SELECTION_MODES = new Set(["smart-selection", "full-suite", "custom-selection", "flaky-tests-only", "scheduled-regression"]);
const RETRY_STRATEGIES = new Set(["no-retry", "retry-flaky", "retry-all", "smart-retry"]);

export function getNpxCommand(): string {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

// Escapes a test title for safe use as a literal match inside Playwright's --grep regex.
function escapeGrepRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

// FR-4.10: resolve which scripts a suite-level run (currently the scheduler --
// runScheduledProfiles below) should actually execute for a given selection mode,
// instead of every mode other than flaky-tests-only silently running the full set.
//
//   - full-suite            : every accepted/edited test case's latest script (unfiltered).
//   - scheduled-regression  : same as full-suite; the SRS distinguishes it only by being
//                              fireable exclusively via the scheduler, which is exactly the
//                              one caller of this function -- there's nothing further to filter.
//   - flaky-tests-only      : only scripts flagged is_flaky (FR-6.2's flaky-detection).
//   - smart-selection       : smoke/regression-category scripts, plus any script whose linked
//                              Screen is flagged Changed (change_status !== 'unchanged') --
//                              a real "smoke + changed modules" selection using the existing
//                              Screen change-tracking data (FR-5.7/5.8), not a stub.
//   - custom-selection      : scripts whose test case title/category contains one of the
//                              profile's user-picked tags/modules (custom_selection_query,
//                              comma-separated), previously stored but never applied to actual
//                              file selection.
export function resolveScriptsForSelectionMode(selectionMode: string, customSelectionQuery?: string | null): any[] {
  const allLatestScripts = db.prepare(`
    SELECT automation_scripts.*, test_cases.category as tc_category, test_cases.title as tc_title, test_cases.screen_id as tc_screen_id
    FROM automation_scripts
    JOIN test_cases ON test_cases.id = automation_scripts.test_case_id
    WHERE test_cases.status IN ('accepted','edited')
    GROUP BY automation_scripts.test_case_id
    HAVING automation_scripts.created_at = MAX(automation_scripts.created_at)
  `).all() as any[];

  if (selectionMode === "flaky-tests-only") {
    return allLatestScripts.filter((s) => Number(s.is_flaky) === 1);
  }

  if (selectionMode === "smart-selection") {
    const changedScreenIds = new Set(
      (db.prepare("SELECT id FROM screens WHERE change_status != 'unchanged'").all() as Array<{ id: string }>).map((r) => r.id)
    );
    return allLatestScripts.filter((s) => {
      const category = (s.tc_category || "").toLowerCase();
      const isSmokeOrRegression = category.includes("smoke") || category.includes("regression");
      const screenChanged = s.tc_screen_id && changedScreenIds.has(s.tc_screen_id);
      return isSmokeOrRegression || screenChanged;
    });
  }

  if (selectionMode === "custom-selection") {
    const keywords = (customSelectionQuery || "")
      .split(",")
      .map((k) => k.trim().toLowerCase())
      .filter(Boolean);
    if (keywords.length === 0) return allLatestScripts; // no tags configured yet -- fall back to full set
    return allLatestScripts.filter((s) => {
      const haystack = `${s.tc_title || ""} ${s.tc_category || ""}`.toLowerCase();
      return keywords.some((k) => haystack.includes(k));
    });
  }

  // full-suite / scheduled-regression / unrecognized modes: run everything
  return allLatestScripts;
}

// FR-4.8: delete VIDEO artifacts past their configured retention window. retention_days
// <= 0 means "unlimited" (never auto-deleted), matching the SRS's "7/30 days/unlimited" options.
// Scoped specifically to video evidence (only .webm files within the run's evidence directory)
// rather than wiping every evidence type indiscriminately -- screenshots/logs/traces captured
// by other modes are left alone by this routine. Each deletion gets its own audit-log entry
// (not just a timestamp column) so who/what/when is queryable via the audit trail, not just
// inferred from a null field.
//
// No longer gated by artifact_capture_mode: playwright.config.ts always retains a video for a
// FAILED run regardless of mode, so even a "logs-only" run can have a .webm that needs cleaning
// up. Whether a row actually gets marked/audited is decided below by whether a video file was
// actually found, not by which mode the run was configured with.

function findVideoFiles(dir: string): string[] {
  const found: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...findVideoFiles(full));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".webm")) {
      found.push(full);
    }
  }
  return found;
}

export function cleanupExpiredArtifacts(now = new Date()): { checked: number; deleted: number } {
  const rows = db
    .prepare(
      "SELECT id, evidence_path, retention_days, created_at, artifact_capture_mode FROM execution_runs WHERE evidence_path IS NOT NULL AND evidence_deleted_at IS NULL"
    )
    .all() as Array<{ id: string; evidence_path: string; retention_days: number; created_at: string; artifact_capture_mode: string }>;

  let deleted = 0;
  const markVideoDeleted = db.prepare("UPDATE execution_runs SET evidence_deleted_at = ? WHERE id = ?");

  for (const row of rows) {
    if (!row.retention_days || row.retention_days <= 0) continue; // unlimited retention
    const ageMs = now.getTime() - new Date(row.created_at).getTime();
    const retentionMs = row.retention_days * 24 * 60 * 60 * 1000;
    if (ageMs < retentionMs) continue;

    let videoFiles: string[] = [];
    try {
      if (row.evidence_path && fs.existsSync(row.evidence_path)) {
        videoFiles = findVideoFiles(row.evidence_path);
        for (const file of videoFiles) fs.rmSync(file, { force: true });
      }
    } catch {
      /* best-effort deletion */
    }

    if (videoFiles.length === 0) continue; // nothing video-related to record for this row

    markVideoDeleted.run(now.toISOString(), row.id);
    logAudit(undefined, "artifact_auto_deleted", "execution_run", row.id, {
      evidence_path: row.evidence_path,
      artifact_capture_mode: row.artifact_capture_mode,
      retention_days: row.retention_days,
      video_files_deleted: videoFiles.length,
      files: videoFiles,
    });
    deleted += 1;
  }

  return { checked: rows.length, deleted };
}

// FR-4.20: run the pre-flight health check for the Environment a scheduled/webhook-triggered
// run is about to target (when one is configured) and hold the run rather than executing
// against an unreachable environment or one where auth fails. Mirrors the run-blocking pattern
// already used for a flagged security scan in runExecution() -- log an audit event and report
// a clear "held" status instead of silently skipping or throwing.
export async function preflightGuardEnvironment(
  environmentId: string | null | undefined,
  context: { triggerSource: "scheduled" | "webhook"; profileId?: string | null; scriptId?: string | null }
): Promise<{ held: boolean; healthCheck?: { reachable: boolean; auth_ok: boolean; status?: number; error?: string } }> {
  if (!environmentId) return { held: false };

  const environment = getEnvironment(environmentId) as any;
  if (!environment) return { held: false };

  const healthCheck = await preflightHealthCheck(environmentId);
  if (healthCheck.reachable && healthCheck.auth_ok) {
    return { held: false, healthCheck };
  }

  logAudit(undefined, "run_held_preflight_failed", "environment", environmentId, {
    trigger_source: context.triggerSource,
    profile_id: context.profileId ?? null,
    script_id: context.scriptId ?? null,
    environment_name: environment.name,
    target_url: environment.target_url,
    health_check: healthCheck,
  });

  return { held: true, healthCheck };
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

  const results: Array<{ profileId: string; triggeredRuns: number; held?: boolean; healthCheck?: any }> = [];

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

    // FR-4.20: pre-flight health check the profile's configured Environment (if any)
    // before running the full suite -- an unreachable target or a failed auth check
    // holds/alerts on this profile instead of executing against it.
    const guard = await preflightGuardEnvironment(profile.default_environment_id, {
      triggerSource: "scheduled",
      profileId: profile.id,
    });
    if (guard.held) {
      db.prepare("UPDATE execution_profiles SET last_scheduled_run_date = ? WHERE id = ?").run(today, profile.id);
      results.push({ profileId: profile.id, triggeredRuns: 0, held: true, healthCheck: guard.healthCheck });
      continue;
    }

    const environment = profile.default_environment_id ? (getEnvironment(profile.default_environment_id) as any) : null;

    // FR-4.10: which scripts actually run is now driven by the profile's selection_mode
    // instead of unconditionally running every accepted/edited script.
    const scripts = resolveScriptsForSelectionMode(profile.selection_mode, profile.custom_selection_query);

    let triggeredRuns = 0;
    for (const script of scripts) {
      const targetUrl = environment?.target_url || `http://localhost:${process.env.PORT || 4100}/demo/login.html`;
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
    // FR-4.10: comma-separated tags/module keywords for "custom-selection" mode
    custom_selection_query: input?.custom_selection_query ?? null,
    // FR-4.19/FR-4.20: optional linked Environment -- when set, scheduled/webhook
    // runs of this profile pre-flight health-check it (see preflightGuardEnvironment)
    // and use its target_url instead of the hardcoded demo URL.
    default_environment_id: input?.default_environment_id ?? null,
    // FR-4.24: this profile's default speed mode -- when set to "ultrafast", the client's
    // "quick trigger" flow (see client Execution.tsx) skips the Execution Settings Panel
    // entirely for runs against this profile.
    default_speed_mode: input?.default_speed_mode === "ultrafast" ? "ultrafast" : "fast",
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
      default_environment_id, custom_selection_query, default_speed_mode, created_at, updated_at
    ) VALUES (
      @id, @name, @description, @browser_set, @concurrency, @artifact_capture_mode,
      @retention_days, @selection_mode, @retry_strategy, @provider, @runner_pool_name,
      @reserved_runner_count, @headless_mode, @reuse_browser_instances,
      @is_default_for_team, @is_default_for_suite, @rules_json, @schedule_json,
      @default_environment_id, @custom_selection_query, @default_speed_mode, @created_at, @updated_at
    )
  `).run({ id, ...profile, created_at: now, updated_at: now });
  return { id, ...profile, created_at: now, updated_at: now };
}

// FR-4.23: version every edit to a saved Execution Profile, with a diff and the
// editor's identity, mirroring FR-2.6 test case versioning.
export function updateExecutionProfile(id: string, input: any, editedBy?: string) {
  const existing = db.prepare("SELECT * FROM execution_profiles WHERE id = ?").get(id) as any;
  if (!existing) throw new Error("Profile not found");
  const profile = normalizeProfile({ ...existing, ...input });
  const now = new Date().toISOString();
  const newVersion = (existing.version ?? 1) + 1;

  db.prepare(`
    UPDATE execution_profiles SET
      name = @name, description = @description, browser_set = @browser_set,
      concurrency = @concurrency, artifact_capture_mode = @artifact_capture_mode,
      retention_days = @retention_days, selection_mode = @selection_mode,
      retry_strategy = @retry_strategy, provider = @provider, runner_pool_name = @runner_pool_name,
      reserved_runner_count = @reserved_runner_count, headless_mode = @headless_mode,
      reuse_browser_instances = @reuse_browser_instances, is_default_for_team = @is_default_for_team,
      is_default_for_suite = @is_default_for_suite, rules_json = @rules_json,
      schedule_json = @schedule_json, gate_on_failure = @gate_on_failure,
      default_environment_id = @default_environment_id, custom_selection_query = @custom_selection_query,
      default_speed_mode = @default_speed_mode,
      version = @version, last_edited_by = @last_edited_by, updated_at = @updated_at
    WHERE id = @id
  `).run({ id, ...profile, gate_on_failure: input.gate_on_failure ? 1 : existing.gate_on_failure ? 1 : 0, version: newVersion, last_edited_by: editedBy ?? null, updated_at: now });

  db.prepare(`
    INSERT INTO execution_profile_versions (id, profile_id, version, snapshot_json, edited_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(nanoid(10), id, newVersion, JSON.stringify({ before: existing, after: profile }), editedBy ?? null, now);

  return { id, ...profile, version: newVersion, created_at: existing.created_at, updated_at: now };
}

export function listExecutionProfileVersions(profileId: string) {
  return (db.prepare("SELECT * FROM execution_profile_versions WHERE profile_id = ? ORDER BY version DESC").all(profileId) as any[]).map((v) => ({
    ...v,
    snapshot: JSON.parse(v.snapshot_json),
  }));
}

export function deleteExecutionProfile(id: string) {
  db.prepare("DELETE FROM execution_profiles WHERE id = ?").run(id);
}

// FR-4.14: also returns a human-readable `reason` the suggestion was made, so the client
// can show "Suggested: <profile name> (based on <reason>)" instead of silently applying it.
export function suggestExecutionProfile(context: Record<string, string> = {}) {
  const profiles = listExecutionProfiles() as any[];
  if (profiles.length === 0) return { suggestedProfileId: null, profile: null, reason: null };
  const defaultProfile = profiles.find((profile: any) => profile.is_default_for_team || profile.is_default_for_suite) || profiles[0];
  const byContext = profiles.find((profile: any) => {
    const contextKey = context?.trigger_source || context?.execution_context || "";
    if (contextKey.includes("ci")) return profile.provider === "ci" || profile.provider === "cloud";
    return false;
  });
  const chosen = byContext || defaultProfile || null;
  let reason: string | null = null;
  if (chosen) {
    if (byContext) reason = `trigger context "${context?.trigger_source || context?.execution_context}" matches a CI/cloud provider profile`;
    else if (chosen.is_default_for_team) reason = "marked as the team's default profile";
    else if (chosen.is_default_for_suite) reason = "marked as the default profile for this suite";
    else reason = "no default is set -- falling back to the first configured profile";
  }
  return { suggestedProfileId: chosen?.id || null, profile: chosen, reason };
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
  // FR-4.5: kick the queue processor immediately rather than waiting for the
  // next interval tick -- if capacity is free this run starts right away.
  processExecutionQueueLazy();
  return { id, status: "queued", queuePosition };
}

// Lazy import to avoid a circular dependency (runnerPoolService imports runExecution
// from this file); resolved dynamically only when actually invoked.
function processExecutionQueueLazy() {
  import("./runnerPoolService.js").then((m) => m.processExecutionQueue()).catch(() => undefined);
}

// `existingRunId`: when the runner pool (runnerPoolService.ts) dequeues an
// already-`queued` row, it passes that row's id here so this function updates
// the existing row in place (queued -> running -> passed/failed) instead of
// creating a second row -- the queued run actually gets executed rather than
// sitting in the DB forever (see FR-4.5).
export function runExecution(scriptId: string, targetUrl: string, input: any = {}, existingRunId?: string): Promise<any> {
  return new Promise((resolve) => {
    const script = db.prepare("SELECT * FROM automation_scripts WHERE id = ?").get(scriptId) as any;
    if (!script) {
      resolve({ error: "Script not found" });
      return;
    }

    // FR-7.6: remember the status this script's last run had, before this run
    // overwrites it -- an auto-filed bug requires "previously passing, now failing"
    const previousStatus = script.last_run_status ?? null;

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
    const testCase = db.prepare("SELECT title, category, screen_id FROM test_cases WHERE id = ?").get(script.test_case_id) as { title: string; category: string; screen_id?: string | null } | undefined;
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

    // FR-4.1/FR-4.9: always pass an explicit --project set matching the selected
    // browser set. Previously "chromium" (the default) passed no --project flag at
    // all, and since playwright.config.ts now declares all three projects, an
    // unqualified run would execute against all of them instead of just Chromium.
    // Playwright's --reporter CLI flag REPLACES the config file's `reporter`
    // array rather than merging with it -- passing just "json" here (needed
    // below to parse pass/fail from stdout) was silently disabling
    // playwright.config.ts's allure-playwright reporter for every single run
    // through this engine (Execution tab, Ultrafast, crawler-originated, all
    // of them), so allure-results/ never got written no matter how many tests
    // ran. Comma-separating both keeps stdout parsing working AND lets Allure
    // actually see the run.
    const args = ["playwright", "test", relFile, "--reporter=json,allure-playwright"];
    if (browserSet === "chromium+firefox") args.push("--project=chromium", "--project=firefox");
    else if (browserSet === "all") args.push("--project=chromium", "--project=firefox", "--project=webkit");
    else args.push("--project=chromium"); // "chromium" and "headless" both run Chromium only
    if (retryStrategy === "retry-all") args.push("--retries=2");
    if (retryStrategy === "retry-flaky") args.push("--retries=1");
    // FR-4.11: smart-retry is a distinct strategy from retry-flaky -- it only retries a test
    // that FR-6.2's flaky-detection has already flagged historically flaky (automation_scripts.is_flaky),
    // instead of retrying on every run regardless of history. When the script isn't flagged flaky,
    // smart-retry behaves like no-retry (no --retries flag at all).
    if (retryStrategy === "smart-retry" && Number(script.is_flaky) === 1) {
      args.push("--retries=1");
      if (testCase?.title) args.push(`--grep=${escapeGrepRegex(testCase.title)}`);
    }
    if (selectionMode === "flaky-tests-only") args.push("--grep=flaky");

    // FR-4.21: decrypt and inject only the secrets this specific script
    // references, into the child process env only -- never into script source,
    // stdout/stderr logs, or the file committed to Git.
    const secretsEnv: Record<string, string> = {};
    if (script.secrets_ref) {
      const names = String(script.secrets_ref).split(",").map((n: string) => n.trim()).filter(Boolean);
      for (const name of names) {
        const row = db.prepare("SELECT * FROM platform_secrets WHERE name = ?").get(name) as any;
        if (row) {
          try {
            secretsEnv[name] = decryptSecret({ encrypted: row.value_encrypted, iv: row.value_iv, tag: row.value_tag });
          } catch {
            // corrupt/rotated-out secret -- script runs without it rather than crashing the run
          }
        }
      }
    }

    const runId = existingRunId || nanoid(10);
    const now = new Date().toISOString();

    // FR-4.4: which CI/CD tool triggered this run, when invoked via the webhook route.
    const ciSource: string | null = input.ci_source ?? null;

    // FR-4.24/FR-4.28: speed_mode defaults to 'fast' (existing checkpointed behavior) unless
    // the caller (Ultrafast trigger route) explicitly passes 'ultrafast', or the resolved
    // profile has a saved default_speed_mode.
    const speedMode: string = input.speed_mode === "ultrafast" ? "ultrafast" : (profile?.default_speed_mode === "ultrafast" && input.speed_mode !== "fast") ? "ultrafast" : "fast";
    const environmentId: string | null = input.environment_id ?? null;

    // FR-4.6: the actual worker count Playwright will use for this run -- mirrors the
    // same reuseBrowser-wins-when-requested computation playwright.config.ts applies,
    // computed here too so it's recorded on the run record itself (not just inferable
    // from config), giving "reused across tests" a number to point to from run output.
    const actualWorkerCount = reuseBrowser ? 1 : Math.max(1, Number(config.concurrency) || 1);

    if (existingRunId) {
      // Was 'queued' -- transition to running now that the pool has dequeued it
      db.prepare("UPDATE execution_runs SET status = 'running', queue_position = 0, ci_source = ?, actual_worker_count = ?, speed_mode = ?, environment_id = ? WHERE id = ?").run(
        ciSource,
        actualWorkerCount,
        speedMode,
        environmentId,
        existingRunId
      );
    } else {
      db.prepare(`
        INSERT INTO execution_runs (
          id, script_id, profile_id, status, duration_ms, stdout, stderr, evidence_path,
          browser_set, concurrency, artifact_capture_mode, retention_days, selection_mode,
          retry_strategy, queue_position, provider, execution_context, trigger_source,
          reserved_runner_count, headless_mode, reuse_browser_instances, ci_source,
          actual_worker_count, speed_mode, environment_id, created_at
        ) VALUES (
          @id, @script_id, @profile_id, 'running', 0, '', '', '',
          @browser_set, @concurrency, @artifact_capture_mode, @retention_days,
          @selection_mode, @retry_strategy, 0, @provider, @execution_context,
          @trigger_source, @reserved_runner_count, @headless_mode, @reuse_browser_instances, @ci_source,
          @actual_worker_count, @speed_mode, @environment_id, @created_at
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
        ci_source: ciSource,
        actual_worker_count: actualWorkerCount,
        speed_mode: speedMode,
        environment_id: environmentId,
        created_at: now,
      });
    }

    // FR-4.4: log which CI tool triggered this run, so results are attributable per-tool
    // in the audit trail as well as on the run record. Honest caveat (also in the route
    // comment): this is generic-webhook-based CI attribution via a `source` field/header,
    // not native GitHub Actions/Jenkins/Azure Pipelines/GitLab CI marketplace plugins.
    if (ciSource) {
      logAudit(undefined, "ci_triggered_run", "execution_run", runId, {
        ci_source: ciSource,
        script_id: scriptId,
        profile_id: input.profile_id || null,
      });
    }

    const child = execFile(
      getNpxCommand(),
      args,
      {
        cwd: SERVER_ROOT,
        env: {
          ...process.env,
          ...secretsEnv,
          TARGET_URL: targetUrl,
          PLAYWRIGHT_BROWSER_SET: browserSet,
          ARTIFACT_CAPTURE_MODE: artifactMode,
          RETRY_STRATEGY: retryStrategy,
          SELECTION_MODE: selectionMode,
          // FR-4.2/FR-4.6/FR-4.9: playwright.config.ts reads these to set real
          // workers/headless -- previously stored but never actually reached Playwright.
          EXECUTION_CONCURRENCY: String(config.concurrency || 1),
          REUSE_BROWSER_INSTANCES: reuseBrowser ? "1" : "0",
          HEADLESS_MODE: headless ? "1" : "0",
        },
        maxBuffer: 20 * 1024 * 1024,
        shell: process.platform === "win32",
      },
      (error, stdout, stderr) => {
        runningProcesses.delete(runId);
        const wasStopped = stoppedRunIds.delete(runId);
        const durationMs = Date.now() - startedAt;
        let status: "passed" | "failed" | "error" | "stopped" = wasStopped ? "stopped" : error ? "failed" : "passed";
        let evidencePath: string | null = null;
        let resultsDirEntries: string[] = [];
        const resultsDir = path.join(SERVER_ROOT, "test-results", "artifacts");

        try {
          if (fs.existsSync(resultsDir)) {
            resultsDirEntries = fs.readdirSync(resultsDir);
            if (resultsDirEntries.length > 0) {
              evidencePath = path.join(resultsDir, resultsDirEntries[resultsDirEntries.length - 1]);
            }
          }
        } catch {
          /* best-effort evidence lookup */
        }

        // FR-6.5: per-failed-test evidence entries, parsed from Playwright's own JSON reporter
        // output (--reporter=json on stdout) instead of one evidence_path for the whole run.
        // This is test-level granularity (one row per failed test), not step/action-level --
        // the JSON reporter doesn't expose a stable per-step breakdown to parse, so a genuine
        // per-step implementation isn't attempted here; this is the honest partial improvement.
        try {
          const parsed = JSON.parse(stdout);
          const failedTests: Array<{ title: string; file: string; status: string }> = [];
          const walkSuites = (suites: any[], filePrefix = "") => {
            for (const suite of suites ?? []) {
              const file = suite.file || filePrefix;
              for (const spec of suite.specs ?? []) {
                if (!spec.ok) {
                  for (const t of spec.tests ?? []) {
                    failedTests.push({ title: spec.title, file, status: t.status || "failed" });
                  }
                }
              }
              if (suite.suites) walkSuites(suite.suites, file);
            }
          };
          walkSuites(parsed.suites ?? []);

          if (failedTests.length > 0) {
            const insertEvidence = db.prepare(`
              INSERT INTO execution_evidence (id, run_id, test_title, test_file, status, evidence_path, created_at)
              VALUES (@id, @run_id, @test_title, @test_file, @status, @evidence_path, @created_at)
            `);
            const evNow = new Date().toISOString();
            for (const ft of failedTests) {
              // Best-effort per-test evidence dir match: Playwright names each test's own
              // artifact output folder using a sanitized version of its title.
              const sanitizedTitle = ft.title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
              const matchedDir = resultsDirEntries.find((e) => e.toLowerCase().includes(sanitizedTitle.slice(0, 20)));
              insertEvidence.run({
                id: nanoid(10),
                run_id: runId,
                test_title: ft.title,
                test_file: ft.file,
                status: ft.status,
                evidence_path: matchedDir ? path.join(resultsDir, matchedDir) : evidencePath,
                created_at: evNow,
              });
            }
          }
        } catch {
          /* best-effort JSON reporter parse -- stdout may not be valid JSON on a hard crash */
        }

        // FR-4.22: a CI/CD-triggered run configured to gate on failure reports a
        // block result on failure, so the calling pipeline/PR check can fail
        // and block merge until resolved (or the gate is explicitly overridden
        // by the caller not honoring gate_result -- the platform can't force a
        // third-party CI system's behavior, only surface the signal correctly).
        const gateOnFailure = Boolean(profile?.gate_on_failure) || Boolean(input.gate_on_failure);
        const gateResult = gateOnFailure ? (status === "passed" ? "pass" : "block") : null;

        // FR-4.6: browser-launch count isn't directly exposed by Playwright's JSON reporter/stdout
        // in this version, so this is a documented proxy, not a literal launch counter: with browser
        // reuse (--workers=1) all tests in the run share a single browser instance, so launch count
        // is 1; without reuse, Playwright launches one browser per worker, so launch count == worker
        // count. This is still verifiable from the run record (actual_worker_count) rather than only
        // inferable from the REUSE_BROWSER_INSTANCES config flag.
        const browserLaunchCount = actualWorkerCount;

        db.prepare(`
          UPDATE execution_runs
          SET status = @status, duration_ms = @duration_ms, stdout = @stdout, stderr = @stderr, evidence_path = @evidence_path, gate_result = @gate_result, browser_launch_count = @browser_launch_count
          WHERE id = @id
        `).run({
          id: runId,
          status,
          duration_ms: durationMs,
          stdout: stdout?.slice(0, 8000) ?? "",
          stderr: stderr?.slice(0, 8000) ?? "",
          evidence_path: evidencePath,
          gate_result: gateResult,
          browser_launch_count: browserLaunchCount,
        });

        db.prepare("UPDATE automation_scripts SET last_run_status = ? WHERE id = ?").run(status, scriptId);

        // FR-6.2 / FR-6.7: refresh the flaky flag and record actual-vs-estimated time now that the run is final
        const isFlaky = updateFlakyFlagForScript(scriptId);
        const timeBreakdown = recordTimeBreakdownForRun(runId, selectionMode, durationMs);

        // FR-7.3: notify Slack/Teams -- best-effort, never blocks the response on a broken webhook
        notifyAllOnRunComplete(`Run ${runId} for script ${scriptId}: ${status.toUpperCase()} (${durationMs}ms)`).catch(() => undefined);

        // FR-7.6: auto-file a bug when a previously-passing test regresses -- best-effort
        if (testCase) {
          autoFileBugOnRegression(
            { id: script.test_case_id, title: testCase.title, category: (testCase as any).category ?? "" },
            { id: runId, status, evidence_path: evidencePath },
            previousStatus
          ).catch(() => undefined);
        }

        // Bug Detection Engine: run an exploratory UI scan of the screen this
        // script's test case is tagged to, right after every run -- catches
        // defects a pass/fail assertion alone wouldn't (broken images, JS/server
        // errors, stuck spinners), not just regressions on the one thing the
        // test itself asserts. Best-effort, never blocks the run response.
        if (testCase?.screen_id) {
          runBugScanForScreen(testCase.screen_id, runId).catch(() => undefined);
        }

        resolve({
          id: runId,
          status,
          durationMs,
          stdout,
          stderr,
          evidencePath,
          browserSet,
          artifactMode,
          retryStrategy,
          selectionMode,
          isFlaky,
          timeBreakdown,
          gateResult,
          blocksPipeline: gateResult === "block",
          speedMode,
          environmentId,
          ciSource,
          actualWorkerCount,
          browserLaunchCount,
        });
      }
    );
    runningProcesses.set(runId, child);
  });
}

// FR-4.2: run several scripts together in one Playwright invocation so
// `--workers=N` has more than one test to actually parallelize, and record a
// real sequential-baseline duration (workers=1) alongside the concurrent one --
// giving the AC's "verifiable by comparing run duration to a sequential
// baseline" a real number to compare rather than a single opaque duration.
export async function runExecutionBatch(scriptIds: string[], targetUrl: string, input: any = {}): Promise<any> {
  if (scriptIds.length === 0) throw new Error("scriptIds must be a non-empty array");

  const scripts = scriptIds.map((id) => db.prepare("SELECT * FROM automation_scripts WHERE id = ?").get(id) as any).filter(Boolean);
  if (scripts.length === 0) throw new Error("No matching scripts found");

  const relFiles = scripts.map((s) => path.relative(SERVER_ROOT, s.file_path).replace(/\\/g, "/"));
  const profile = input.profile_id ? (db.prepare("SELECT * FROM execution_profiles WHERE id = ?").get(input.profile_id) as any) : null;
  const config = profile ? { ...profile } : normalizeProfile(input);
  const requestedConcurrency = Math.max(1, Number(config.concurrency || 1));

  const runOnce = (workers: number): Promise<{ durationMs: number; passed: number; failed: number }> => {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      execFile(
        getNpxCommand(),
        ["playwright", "test", ...relFiles, "--reporter=json,allure-playwright"],
        {
          cwd: SERVER_ROOT,
          env: { ...process.env, TARGET_URL: targetUrl, EXECUTION_CONCURRENCY: String(workers), REUSE_BROWSER_INSTANCES: "0", HEADLESS_MODE: "1" },
          maxBuffer: 20 * 1024 * 1024,
          shell: process.platform === "win32",
        },
        (_error, stdout) => {
          const durationMs = Date.now() - startedAt;
          let passed = 0, failed = 0;
          try {
            const parsed = JSON.parse(stdout);
            for (const suite of parsed.suites ?? []) {
              for (const spec of suite.specs ?? []) {
                if (spec.ok) passed++; else failed++;
              }
            }
          } catch {
            /* best-effort parse */
          }
          resolve({ durationMs, passed, failed });
        }
      );
    });
  };

  // Concurrent run first (what the user actually asked for), then a true
  // sequential (--workers=1) baseline run of the same scripts for comparison.
  const concurrentResult = await runOnce(requestedConcurrency);
  const sequentialBaseline = requestedConcurrency > 1 ? await runOnce(1) : null;

  const runId = nanoid(10);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO execution_runs (
      id, script_id, profile_id, status, duration_ms, stdout, stderr, evidence_path,
      browser_set, concurrency, artifact_capture_mode, retention_days, selection_mode,
      retry_strategy, queue_position, provider, execution_context, trigger_source,
      reserved_runner_count, headless_mode, reuse_browser_instances, created_at
    ) VALUES (
      @id, @script_id, NULL, @status, @duration_ms, @stdout, '', '',
      @browser_set, @concurrency, @artifact_capture_mode, @retention_days,
      @selection_mode, @retry_strategy, 0, @provider, @execution_context,
      'batch', @reserved_runner_count, @headless_mode, @reuse_browser_instances, @created_at
    )
  `).run({
    id: runId,
    script_id: scripts[0].id, // batch runs summarize under the first script's row; individual script results are in `stdout`
    status: concurrentResult.failed === 0 ? "passed" : "failed",
    duration_ms: concurrentResult.durationMs,
    stdout: JSON.stringify({ scriptIds, passed: concurrentResult.passed, failed: concurrentResult.failed }),
    browser_set: "chromium",
    concurrency: requestedConcurrency,
    artifact_capture_mode: config.artifact_capture_mode || "logs-only",
    retention_days: config.retention_days || 30,
    selection_mode: config.selection_mode || "full-suite",
    retry_strategy: config.retry_strategy || "no-retry",
    provider: config.provider || "local",
    execution_context: input.execution_context || null,
    reserved_runner_count: config.reserved_runner_count || 0,
    headless_mode: 1,
    reuse_browser_instances: 0,
    created_at: now,
  });

  return {
    id: runId,
    scriptCount: scripts.length,
    concurrency: requestedConcurrency,
    concurrentDurationMs: concurrentResult.durationMs,
    sequentialBaselineDurationMs: sequentialBaseline?.durationMs ?? null,
    speedup: sequentialBaseline ? Number((sequentialBaseline.durationMs / concurrentResult.durationMs).toFixed(2)) : null,
    passed: concurrentResult.passed,
    failed: concurrentResult.failed,
  };
}
