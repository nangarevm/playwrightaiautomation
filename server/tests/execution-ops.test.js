import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { db } from '../src/db.ts';
import { cleanupExpiredArtifacts, evaluateCustomExecutionRules } from '../src/services/executionService.ts';
import { generateAutomationScript } from '../src/services/codegenService.ts';
import { generateTestCasesForInput, regenerateTestCase } from '../src/services/generationService.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const generatedDir = path.join(__dirname, '..', 'generated');

function resetData() {
  db.prepare('DELETE FROM auto_heal_actions').run();
  db.prepare('DELETE FROM change_detections').run();
  db.prepare('DELETE FROM execution_runs').run();
  db.prepare('DELETE FROM review_audit_entries').run();
  db.prepare('DELETE FROM sync_records').run();
  db.prepare('DELETE FROM automation_scripts').run();
  db.prepare('DELETE FROM test_cases').run();
  db.prepare('DELETE FROM inputs').run();
}

test.beforeEach(() => {
  resetData();
});

test('evaluateCustomExecutionRules applies module-keyword rules (FR-4.15)', () => {
  const rulesJson = JSON.stringify([
    { if: { testModuleContains: 'payments' }, then: { browser_set: 'all', artifact_capture_mode: 'video-failures', retry_strategy: 'retry-all' } },
  ]);
  const overrides = evaluateCustomExecutionRules(rulesJson, { testCaseTitle: 'Payments checkout smoke test' });
  assert.equal(overrides.browser_set, 'all');
  assert.equal(overrides.retry_strategy, 'retry-all');
});

test('evaluateCustomExecutionRules applies day-of-week rules and ignores non-matching ones', () => {
  const rulesJson = JSON.stringify([
    { if: { dayOfWeek: 'Friday' }, then: { selection_mode: 'full-suite' } },
  ]);
  assert.deepEqual(evaluateCustomExecutionRules(rulesJson, { dayOfWeek: 'Friday' }), { selection_mode: 'full-suite' });
  assert.deepEqual(evaluateCustomExecutionRules(rulesJson, { dayOfWeek: 'Monday' }), {});
});

test('evaluateCustomExecutionRules applies previous-run-failed rules', () => {
  const rulesJson = JSON.stringify([
    { if: { previousRunFailed: true }, then: { retry_strategy: 'retry-flaky' } },
  ]);
  assert.deepEqual(evaluateCustomExecutionRules(rulesJson, { previousRunFailed: true }), { retry_strategy: 'retry-flaky' });
  assert.deepEqual(evaluateCustomExecutionRules(rulesJson, { previousRunFailed: false }), {});
});

test('evaluateCustomExecutionRules returns {} for missing/invalid rules_json', () => {
  assert.deepEqual(evaluateCustomExecutionRules(null, {}), {});
  assert.deepEqual(evaluateCustomExecutionRules('not json', {}), {});
});

test('cleanupExpiredArtifacts deletes only video artifacts past retention_days, leaves non-video/unlimited rows alone, and audits each deletion (FR-4.8)', () => {
  const now = new Date();
  const oldDate = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days ago

  // run-expired: video-capturing mode, retention passed -- its .webm should be deleted,
  // its non-video screenshot must survive since deletion is scoped to video only.
  const videoDir = path.join(__dirname, '..', 'test-results', 'artifacts-test-video');
  fs.mkdirSync(videoDir, { recursive: true });
  const videoFile = path.join(videoDir, 'video.webm');
  fs.writeFileSync(videoFile, 'video bytes');
  const screenshotFile = path.join(videoDir, 'screenshot.png');
  fs.writeFileSync(screenshotFile, 'screenshot bytes');

  // run-non-video: retention passed, but artifact_capture_mode has no video -- must be
  // left completely untouched by this video-specific routine.
  const nonVideoDir = path.join(__dirname, '..', 'test-results', 'artifacts-test-nonvideo');
  fs.mkdirSync(nonVideoDir, { recursive: true });
  const nonVideoFile = path.join(nonVideoDir, 'evidence.txt');
  fs.writeFileSync(nonVideoFile, 'log bytes');

  // run-unlimited: video mode but unlimited retention -- must be left alone.
  const unlimitedDir = path.join(__dirname, '..', 'test-results', 'artifacts-test-unlimited');
  fs.mkdirSync(unlimitedDir, { recursive: true });
  const unlimitedVideoFile = path.join(unlimitedDir, 'video.webm');
  fs.writeFileSync(unlimitedVideoFile, 'video bytes 2');

  db.prepare('INSERT INTO inputs (id, type, content, created_at) VALUES (?, ?, ?, ?)').run('input-cleanup', 'manual', 'fixture', now.toISOString());
  db.prepare(`
    INSERT INTO test_cases (id, input_id, title, category, steps, expected_result, confidence_score, source_rationale, status, authorship_type, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('tc-cleanup', 'input-cleanup', 'Cleanup fixture', 'Smoke', JSON.stringify(['step']), 'result', 0.9, 'fixture', 'accepted', 'ai', 1, now.toISOString(), now.toISOString());
  db.prepare(`
    INSERT INTO automation_scripts (id, test_case_id, language, framework, code, file_path, security_scan_status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('script-x', 'tc-cleanup', 'typescript', 'playwright', 'test("x", () => {})', 'generated/script-x.spec.ts', 'passed', now.toISOString());

  db.prepare(`
    INSERT INTO execution_runs (id, script_id, status, duration_ms, stdout, stderr, evidence_path, retention_days, artifact_capture_mode, created_at)
    VALUES (?, ?, 'failed', 1000, '', '', ?, 7, 'video-failures', ?)
  `).run('run-expired', 'script-x', videoDir, oldDate);

  db.prepare(`
    INSERT INTO execution_runs (id, script_id, status, duration_ms, stdout, stderr, evidence_path, retention_days, artifact_capture_mode, created_at)
    VALUES (?, ?, 'failed', 1000, '', '', ?, 7, 'all-screenshots', ?)
  `).run('run-non-video', 'script-x', nonVideoDir, oldDate);

  db.prepare(`
    INSERT INTO execution_runs (id, script_id, status, duration_ms, stdout, stderr, evidence_path, retention_days, artifact_capture_mode, created_at)
    VALUES (?, ?, 'failed', 1000, '', '', ?, 0, 'video-all', ?)
  `).run('run-unlimited', 'script-x', unlimitedDir, oldDate);

  const auditCountBefore = db.prepare("SELECT COUNT(*) as c FROM audit_log WHERE action = 'artifact_auto_deleted'").get().c;

  const result = cleanupExpiredArtifacts(now);
  assert.equal(result.deleted, 1);
  assert.equal(fs.existsSync(videoFile), false); // video deleted
  assert.equal(fs.existsSync(screenshotFile), true); // non-video evidence in same dir survives
  assert.equal(fs.existsSync(nonVideoFile), true); // non-video-mode run untouched
  assert.equal(fs.existsSync(unlimitedVideoFile), true); // unlimited retention untouched

  const expiredRow = db.prepare('SELECT evidence_path, evidence_deleted_at FROM execution_runs WHERE id = ?').get('run-expired');
  assert.equal(expiredRow.evidence_path, videoDir); // evidence_path itself is preserved (only the video file was removed)
  assert.ok(expiredRow.evidence_deleted_at);

  const nonVideoRow = db.prepare('SELECT evidence_deleted_at FROM execution_runs WHERE id = ?').get('run-non-video');
  assert.equal(nonVideoRow.evidence_deleted_at, null);

  const auditCountAfter = db.prepare("SELECT COUNT(*) as c FROM audit_log WHERE action = 'artifact_auto_deleted'").get().c;
  assert.equal(auditCountAfter, auditCountBefore + 1);

  fs.rmSync(videoDir, { recursive: true, force: true });
  fs.rmSync(nonVideoDir, { recursive: true, force: true });
  fs.rmSync(unlimitedDir, { recursive: true, force: true });
  db.prepare('DELETE FROM execution_runs WHERE id IN (?, ?, ?)').run('run-expired', 'run-non-video', 'run-unlimited');
  db.prepare('DELETE FROM automation_scripts WHERE id = ?').run('script-x');
  db.prepare('DELETE FROM test_cases WHERE id = ?').run('tc-cleanup');
  db.prepare('DELETE FROM inputs WHERE id = ?').run('input-cleanup');
});

test('regenerateTestCase versions the test case and returns a diff (FR-2.6)', async () => {
  const input = await db.prepare('INSERT INTO inputs (id, type, content, created_at) VALUES (?, ?, ?, ?)').run(
    'input-regen', 'free_text', 'The application has a login page with Username and Password fields.', new Date().toISOString()
  );
  const cases = await generateTestCasesForInput('input-regen', 'The application has a login page with Username and Password fields.');
  const original = cases[0];
  assert.equal(original.version, undefined); // raw insert row shape; version defaults to 1 in DB

  const before = db.prepare('SELECT version FROM test_cases WHERE id = ?').get(original.id);
  assert.equal(before.version, 1);

  const result = await regenerateTestCase(original.id);
  assert.equal(result.version, 2);
  assert.ok(result.diff);
  assert.equal(result.status, 'draft');
});

test('generateAutomationScript honors an explicit framework request (FR-3.2)', async () => {
  const now = new Date().toISOString();
  db.prepare('INSERT INTO inputs (id, type, content, created_at) VALUES (?, ?, ?, ?)').run('input-fw', 'manual', 'Login workflow', now);
  db.prepare(`
    INSERT INTO test_cases (
      id, input_id, title, category, steps, expected_result, confidence_score,
      source_rationale, status, authorship_type, version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'tc-fw', 'input-fw', 'Login succeeds with valid credentials', 'Smoke',
    JSON.stringify(['Open login page', 'Enter credentials', 'Submit form']), 'Welcome screen appears',
    0.95, 'Mock provider', 'accepted', 'ai', 1, now, now
  );

  const result = await generateAutomationScript('tc-fw', { framework: 'cypress' });
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].framework, 'cypress');
  assert.ok(result.artifacts[0].fileName.endsWith('.cy.js'));

  const files = fs.readdirSync(generatedDir);
  assert.ok(files.some((f) => f.endsWith('.cy.js')));
});
