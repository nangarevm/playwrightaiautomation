import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.ts';
import { triggerUltrafastRun, resolveDefaultProfileAndEnvironment } from '../src/services/ultrafastService.ts';
import { queueExecution } from '../src/services/executionService.ts';
import { getUltrafastConfidenceThreshold, setUltrafastConfidenceThreshold } from '../src/services/adminService.ts';

function resetData() {
  db.prepare('DELETE FROM auto_heal_actions').run();
  db.prepare('DELETE FROM change_detections').run();
  db.prepare('DELETE FROM execution_evidence').run(); // FK to execution_runs, must go first
  db.prepare('DELETE FROM bug_findings').run(); // FK to execution_runs, must go first
  db.prepare('DELETE FROM execution_runs').run();
  db.prepare('DELETE FROM execution_profiles').run();
  db.prepare('DELETE FROM environments').run();
  db.prepare('DELETE FROM review_audit_entries').run();
  db.prepare('DELETE FROM sync_records').run();
  db.prepare('DELETE FROM automation_scripts').run();
  db.prepare('DELETE FROM test_cases').run();
  db.prepare('DELETE FROM inputs').run();
  db.prepare("DELETE FROM audit_log WHERE action LIKE 'ultrafast_%' OR action = 'org_ultrafast_threshold_changed'").run();
}

function seedInputAndTestCase(tcId, confidence, extra = {}) {
  const now = new Date().toISOString();
  db.prepare('INSERT INTO inputs (id, type, content, created_at) VALUES (?, ?, ?, ?)').run(`input-${tcId}`, 'manual', 'Ultrafast fixture', now);
  db.prepare(`
    INSERT INTO test_cases (id, input_id, title, category, steps, expected_result, confidence_score, source_rationale, status, authorship_type, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(tcId, `input-${tcId}`, 'Ultrafast case', 'Smoke', JSON.stringify(['Open page']), 'Page opens', confidence, 'Fixture', extra.status ?? 'draft', 'ai', 1, now, now);
  if (extra.critical) {
    db.prepare('UPDATE test_cases SET critical_path = 1, second_reviewer_required = 1, second_reviewer_status = \'pending\' WHERE id = ?').run(tcId);
  }
  const scriptId = `script-${tcId}`;
  db.prepare(`
    INSERT INTO automation_scripts (id, test_case_id, language, framework, code, file_path, security_scan_status, security_scan_notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(scriptId, tcId, 'typescript', 'playwright', 'test("x", () => {})', 'generated/does-not-exist-ultrafast.spec.ts', 'passed', 'ok', now);
  return scriptId;
}

test.beforeEach(() => {
  resetData();
});

// FR-4.25/FR-4.26/FR-4.30
test('triggerUltrafastRun auto-selects profile/environment, auto-accepts a high-confidence test case via the real accept path, tags the run speed_mode, and audits every auto-decision', async () => {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO environments (id, name, target_url, default_profile_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('env-1', 'Staging', 'http://localhost:4100/demo/login.html', null, now, now);

  const profile = db.prepare(`
    INSERT INTO execution_profiles (id, name, default_environment_id, is_default_for_team, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  profile.run('profile-1', 'Default profile', 'env-1', 1, now, now);

  const scriptId = seedInputAndTestCase('tc-uf-1', 0.95);

  const result = await triggerUltrafastRun({ script_id: scriptId });

  // FR-4.25: profile/environment auto-resolved with no user input
  assert.equal(result.resolvedProfile.id, 'profile-1');
  assert.equal(result.resolvedEnvironment.id, 'env-1');

  // Run is tagged speed_mode: 'ultrafast' (FR-4.24) and recorded on the run row
  assert.equal(result.run.speedMode, 'ultrafast');
  const runRow = db.prepare('SELECT * FROM execution_runs WHERE id = ?').get(result.run.id);
  assert.equal(runRow.speed_mode, 'ultrafast');
  assert.equal(runRow.profile_id, 'profile-1');
  assert.equal(runRow.environment_id, 'env-1');

  // FR-4.26/FR-2.4: high-confidence case auto-accepted through the real accept state machine
  assert.equal(result.reviewOutcome.outcome, 'auto_accepted');
  const tcRow = db.prepare('SELECT * FROM test_cases WHERE id = ?').get('tc-uf-1');
  assert.equal(tcRow.status, 'accepted');
  assert.equal(tcRow.needs_review_later, 0);
  // A real accept leaves the same review_audit_entries trail a manual accept would
  const reviewEntries = db.prepare("SELECT * FROM review_audit_entries WHERE test_case_id = ? AND action = 'accept'").all('tc-uf-1');
  assert.equal(reviewEntries.length, 1);

  // FR-4.27: report link handed back directly, scoped to this run, no export click needed
  assert.equal(result.reportUrl, `/api/reporting/export.html?runId=${result.run.id}`);

  // FR-4.30: every auto-decision logged, structurally identical to a manual audit_log row,
  // differing only in actor identification (system vs. a named user)
  const profilePick = db.prepare("SELECT * FROM audit_log WHERE action = 'ultrafast_profile_auto_selected' AND entity_id = ?").get('profile-1');
  assert.ok(profilePick);
  assert.equal(profilePick.actor_user_id, 'system');
  assert.equal(profilePick.actor_role, 'system');

  const envPick = db.prepare("SELECT * FROM audit_log WHERE action = 'ultrafast_environment_auto_selected' AND entity_id = ?").get('env-1');
  assert.ok(envPick);

  const autoAccept = db.prepare("SELECT * FROM audit_log WHERE action = 'ultrafast_auto_accept' AND entity_id = ?").get('tc-uf-1');
  assert.ok(autoAccept);
  const details = JSON.parse(autoAccept.details);
  assert.equal(details.threshold_used, 0.85);
  assert.equal(details.confidence_score, 0.95);
});

// FR-4.26: below-threshold case does not block/pause the run
test('triggerUltrafastRun routes a below-threshold test case to needs-review-later without blocking the run', async () => {
  const scriptId = seedInputAndTestCase('tc-uf-2', 0.4);

  const result = await triggerUltrafastRun({ script_id: scriptId });

  // FR-4.26/FR-2.4: no script can be generated for a still-draft case (the FR-2.4/FR-4.29
  // codegen gate is unweakened), so this trigger call completes successfully with no run
  // for this case yet (non-blocking) rather than throwing/failing.
  assert.equal(result.reviewOutcome.outcome, 'needs_review_later');
  assert.equal(result.run, null);

  const tcRow = db.prepare('SELECT * FROM test_cases WHERE id = ?').get('tc-uf-2');
  assert.equal(tcRow.status, 'draft'); // untouched -- not auto-accepted
  assert.equal(tcRow.needs_review_later, 1);

  const auditRow = db.prepare("SELECT * FROM audit_log WHERE action = 'ultrafast_needs_review_later' AND entity_id = ?").get('tc-uf-2');
  assert.ok(auditRow);
  const details = JSON.parse(auditRow.details);
  assert.equal(details.threshold_used, 0.85);
  assert.equal(details.confidence_score, 0.4);
});

// FR-8.6 interaction (explicitly not built/weakened per the SRS's out-of-scope callout):
// a critical-path case still requiring second-reviewer sign-off cannot be auto-accepted by
// Ultrafast Mode either -- it is routed to needs-review-later instead of silently bypassing
// the FR-8.6 gate or failing the run.
test('triggerUltrafastRun does not bypass the FR-8.6 second-reviewer gate for a critical-path case', async () => {
  const scriptId = seedInputAndTestCase('tc-uf-3', 0.99, { critical: true });

  const result = await triggerUltrafastRun({ script_id: scriptId });

  assert.equal(result.reviewOutcome.outcome, 'skipped_second_reviewer_required');
  const tcRow = db.prepare('SELECT * FROM test_cases WHERE id = ?').get('tc-uf-3');
  assert.equal(tcRow.status, 'draft');
  assert.equal(tcRow.needs_review_later, 1);
});

// FR-4.25/FR-4.26: triggering from just a test_case_id (no script yet -- e.g. this test case
// was never manually reviewed) still works end to end: auto-accept, then auto-generate the
// automation script (the same codegenService path a human accept would unlock), then run.
test('triggerUltrafastRun accepts a bare test_case_id reference and generates the script itself when none exists yet', async () => {
  const now = new Date().toISOString();
  db.prepare('INSERT INTO inputs (id, type, content, created_at) VALUES (?, ?, ?, ?)').run('input-tc-uf-4', 'manual', 'Ultrafast fixture', now);
  db.prepare(`
    INSERT INTO test_cases (id, input_id, title, category, steps, expected_result, confidence_score, source_rationale, status, authorship_type, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('tc-uf-4', 'input-tc-uf-4', 'Ultrafast bare test case', 'Smoke', JSON.stringify(['Open page']), 'Page opens', 0.95, 'Fixture', 'draft', 'ai', 1, now, now);

  const before = db.prepare('SELECT COUNT(*) as c FROM automation_scripts WHERE test_case_id = ?').get('tc-uf-4').c;
  assert.equal(before, 0);

  const result = await triggerUltrafastRun({ test_case_id: 'tc-uf-4' });

  assert.equal(result.reviewOutcome.outcome, 'auto_accepted');
  assert.ok(result.run);
  assert.equal(result.run.speedMode, 'ultrafast');

  const after = db.prepare('SELECT COUNT(*) as c FROM automation_scripts WHERE test_case_id = ?').get('tc-uf-4').c;
  assert.ok(after >= 1); // generateAutomationScript may write more than one artifact (e.g. multiple frameworks)
});

// FR-4.25: profile/environment resolution -- last-used for the script wins over the default
test('resolveDefaultProfileAndEnvironment prefers a script\'s last-used profile/environment over the platform default', () => {
  const now = new Date().toISOString();
  db.prepare('INSERT INTO execution_profiles (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run('profile-default', 'Default', now, now);
  db.prepare('INSERT INTO execution_profiles (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run('profile-last-used', 'Last used', now, now);
  db.prepare('INSERT INTO environments (id, name, target_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('env-last-used', 'Last env', 'http://x', now, now);

  const scriptId = seedInputAndTestCase('tc-resolve', 0.9);
  db.prepare(`
    INSERT INTO execution_runs (id, script_id, profile_id, environment_id, status, duration_ms, stdout, stderr, created_at)
    VALUES (?, ?, ?, ?, 'passed', 100, '', '', ?)
  `).run('prior-run', scriptId, 'profile-last-used', 'env-last-used', now);

  const resolved = resolveDefaultProfileAndEnvironment(scriptId);
  assert.equal(resolved.profileId, 'profile-last-used');
  assert.equal(resolved.environmentId, 'env-last-used');
});

// FR-4.24/FR-4.28: Fast Mode (the pre-existing default flow) is unchanged -- runs not
// explicitly marked ultrafast are tagged speed_mode: 'fast'
test('queueExecution defaults speed_mode to fast for the existing (non-Ultrafast) flow', async () => {
  const scriptId = seedInputAndTestCase('tc-fast', 0.9, { status: 'accepted' });
  const queued = await queueExecution(scriptId, 'http://localhost:4100/demo/login.html', {});
  assert.equal(queued.status, 'queued');
  // speed_mode isn't set by queueExecution itself (it's set when runExecution actually
  // starts the run) -- but the run this queues through must resolve to 'fast' by default,
  // never silently 'ultrafast', once it starts.
  const row = db.prepare('SELECT speed_mode FROM execution_runs WHERE id = ?').get(queued.id);
  assert.equal(row.speed_mode, 'fast');
});

// FR-4.26: QA-Lead-editable Ultrafast confidence threshold (org_settings pattern)
test('ultrafast confidence threshold defaults to 0.85 and is QA-Lead editable, with validation', () => {
  assert.equal(getUltrafastConfidenceThreshold(), 0.85);

  const updated = setUltrafastConfidenceThreshold(0.7, { id: 'user-qa-lead', name: 'Priya', role: 'QA Lead' });
  assert.equal(updated.ultrafast_confidence_threshold, 0.7);
  assert.equal(getUltrafastConfidenceThreshold(), 0.7);

  assert.throws(() => setUltrafastConfidenceThreshold(1.5, undefined));

  // reset to the default for other tests in this file/suite
  setUltrafastConfidenceThreshold(0.85, undefined);
});

test('triggerUltrafastRun requires a script or test case reference', async () => {
  await assert.rejects(() => triggerUltrafastRun({}), /script_id or test_case_id/);
});
