import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.ts';
import { applySelfHealingForTestCase, detectChangesForTestCase, rollbackAutoHealAction } from '../src/services/selfHealingService.ts';

function resetTables() {
  db.prepare('DELETE FROM auto_heal_actions').run();
  db.prepare('DELETE FROM change_detections').run();
  db.prepare('DELETE FROM execution_evidence').run(); // FK to execution_runs, must go first
  db.prepare('DELETE FROM bug_findings').run(); // FK to execution_runs, must go first
  db.prepare('DELETE FROM execution_runs').run();
  db.prepare('DELETE FROM review_audit_entries').run();
  db.prepare('DELETE FROM sync_records').run();
  db.prepare('DELETE FROM automation_scripts').run();
  db.prepare('DELETE FROM test_cases').run();
  db.prepare('DELETE FROM inputs').run();
}

function seedTestCase() {
  const inputId = 'input-self-heal';
  db.prepare('INSERT INTO inputs (id, type, content, created_at) VALUES (?, ?, ?, ?)').run(inputId, 'text', 'Login flow', new Date().toISOString());

  const testCaseId = 'tc-self-heal';
  db.prepare(`
    INSERT INTO test_cases (
      id, input_id, title, category, steps, expected_result, confidence_score, source_rationale,
      status, authorship_type, version, priority, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    testCaseId,
    inputId,
    'Successful login with valid credentials',
    'Smoke',
    JSON.stringify(['Open login page', 'Enter username', 'Enter password', 'Submit']),
    'User sees dashboard',
    0.93,
    'Derived from login flow',
    'accepted',
    'ai',
    1,
    'High',
    new Date().toISOString(),
    new Date().toISOString(),
  );

  db.prepare(`
    INSERT INTO automation_scripts (
      id, test_case_id, language, framework, code, file_path, security_scan_status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'script-self-heal',
    testCaseId,
    'typescript',
    'playwright',
    "await page.getByLabel('Username').fill(username);",
    '/tmp/login.spec.ts',
    'passed',
    new Date().toISOString(),
  );

  return { testCaseId };
}

test.beforeEach(() => {
  resetTables();
});

test('detectChangesForTestCase records ui and api deltas with a numeric confidence score', () => {
  const { testCaseId } = seedTestCase();
  const detection = detectChangesForTestCase({
    testCaseId,
    uiBeforeHtml: '<input id="username" />',
    uiAfterHtml: '<input id="user-name" />',
    apiBeforeSpec: '{"swagger":"2.0","paths":{"/login":{"post":{}}}}',
    apiAfterSpec: '{"swagger":"2.0","paths":{"/login":{"post":{}},"/health":{"get":{}}}}',
  });

  assert.equal(detection.detected, true);
  assert.equal(detection.changeTypes.includes('ui'), true);
  assert.equal(detection.changeTypes.includes('api'), true);
  assert.equal(detection.confidenceScore >= 0.7, true);
});

test('applySelfHealingForTestCase updates the test case and script together when confidence is high', () => {
  const { testCaseId } = seedTestCase();
  const detection = detectChangesForTestCase({
    testCaseId,
    uiBeforeHtml: '<input id="username" />',
    uiAfterHtml: '<input id="user-name" />',
    apiBeforeSpec: '{}',
    apiAfterSpec: '{}',
  });

  const result = applySelfHealingForTestCase({
    testCaseId,
    detectionId: detection.id,
    beforeLocator: "getByLabel('Username')",
    afterLocator: "getByTestId('username-input')",
    confidence: 0.91,
    reason: 'selector changed',
  });

  const testCase = db.prepare('SELECT * FROM test_cases WHERE id = ?').get(testCaseId);
  const script = db.prepare('SELECT * FROM automation_scripts WHERE test_case_id = ?').get(testCaseId);

  assert.equal(result.applied, true);
  assert.equal(testCase.needs_regeneration, 0);
  assert.equal(script.needs_regeneration, 0);
  assert.match(script.code, /getByTestId/);
  assert.equal(script.sync_state.includes('username-input'), true);
});

test('applySelfHealingForTestCase flags regeneration when confidence is below threshold', () => {
  const { testCaseId } = seedTestCase();
  const detection = detectChangesForTestCase({
    testCaseId,
    uiBeforeHtml: '<input id="username" />',
    uiAfterHtml: '<input id="user-name" />',
    apiBeforeSpec: '{}',
    apiAfterSpec: '{}',
  });

  const result = applySelfHealingForTestCase({
    testCaseId,
    detectionId: detection.id,
    beforeLocator: "getByLabel('Username')",
    afterLocator: "getByTestId('username-input')",
    confidence: 0.6,
    reason: 'weak match',
  });

  const testCase = db.prepare('SELECT * FROM test_cases WHERE id = ?').get(testCaseId);
  const script = db.prepare('SELECT * FROM automation_scripts WHERE test_case_id = ?').get(testCaseId);

  assert.equal(result.applied, false);
  assert.equal(result.regenerationRequired, true);
  assert.equal(testCase.needs_regeneration, 1);
  assert.equal(script.needs_regeneration, 1);
});

test('rollbackAutoHealAction restores an earlier test case and script state', () => {
  const { testCaseId } = seedTestCase();
  const detection = detectChangesForTestCase({
    testCaseId,
    uiBeforeHtml: '<input id="username" />',
    uiAfterHtml: '<input id="user-name" />',
    apiBeforeSpec: '{}',
    apiAfterSpec: '{}',
  });

  const result = applySelfHealingForTestCase({
    testCaseId,
    detectionId: detection.id,
    beforeLocator: "getByLabel('Username')",
    afterLocator: "getByTestId('username-input')",
    confidence: 0.91,
    reason: 'selector changed',
  });

  const rolledBack = rollbackAutoHealAction(result.healActionId);
  const testCase = db.prepare('SELECT * FROM test_cases WHERE id = ?').get(testCaseId);
  const script = db.prepare('SELECT * FROM automation_scripts WHERE test_case_id = ?').get(testCaseId);

  assert.equal(rolledBack.rolledBack, true);
  assert.equal(testCase.automation_sync_state.includes('original-state'), true);
  assert.match(script.code, /getByLabel/);
});
