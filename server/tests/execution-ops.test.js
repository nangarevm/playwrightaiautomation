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

test('cleanupExpiredArtifacts deletes evidence past retention_days and leaves unlimited-retention rows alone (FR-4.8)', () => {
  const now = new Date();
  const oldDate = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days ago
  const evidenceDir = path.join(__dirname, '..', 'test-results', 'artifacts-test');
  fs.mkdirSync(evidenceDir, { recursive: true });
  const evidenceFile = path.join(evidenceDir, 'evidence.txt');
  fs.writeFileSync(evidenceFile, 'screenshot bytes');

  const evidenceFile2 = path.join(evidenceDir, 'evidence-unlimited.txt');
  fs.writeFileSync(evidenceFile2, 'screenshot bytes 2');

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
    INSERT INTO execution_runs (id, script_id, status, duration_ms, stdout, stderr, evidence_path, retention_days, created_at)
    VALUES (?, ?, 'failed', 1000, '', '', ?, 7, ?)
  `).run('run-expired', 'script-x', evidenceFile, oldDate);

  db.prepare(`
    INSERT INTO execution_runs (id, script_id, status, duration_ms, stdout, stderr, evidence_path, retention_days, created_at)
    VALUES (?, ?, 'failed', 1000, '', '', ?, 0, ?)
  `).run('run-unlimited', 'script-x', evidenceFile2, oldDate);

  const result = cleanupExpiredArtifacts(now);
  assert.equal(result.deleted, 1);
  assert.equal(fs.existsSync(evidenceFile), false);
  assert.equal(fs.existsSync(evidenceFile2), true);

  const expiredRow = db.prepare('SELECT evidence_path, evidence_deleted_at FROM execution_runs WHERE id = ?').get('run-expired');
  assert.equal(expiredRow.evidence_path, null);
  assert.ok(expiredRow.evidence_deleted_at);

  const unlimitedRow = db.prepare('SELECT evidence_path FROM execution_runs WHERE id = ?').get('run-unlimited');
  assert.equal(unlimitedRow.evidence_path, evidenceFile2);

  fs.rmSync(evidenceDir, { recursive: true, force: true });
  db.prepare('DELETE FROM execution_runs WHERE id IN (?, ?)').run('run-expired', 'run-unlimited');
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
