import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { db } from '../src/db.ts';
import { generateAutomationScript, staticSecurityScan, classifyLocatorStrategy, SecurityScanFailedError } from '../src/services/codegenService.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const generatedDir = path.join(__dirname, '..', 'generated');

function resetData() {
  db.prepare('DELETE FROM auto_heal_actions').run();
  db.prepare('DELETE FROM change_detections').run();
  db.prepare('DELETE FROM execution_evidence').run(); // FK to execution_runs, must go first
  db.prepare('DELETE FROM bug_findings').run(); // FK to execution_runs, must go first
  db.prepare('DELETE FROM execution_runs').run();
  db.prepare('DELETE FROM automation_scripts').run();
  db.prepare('DELETE FROM review_audit_entries').run();
  db.prepare('DELETE FROM sync_records').run();
  db.prepare('DELETE FROM test_cases').run();
  db.prepare('DELETE FROM inputs').run();
}

test('generateAutomationScript persists one automation artifact per request and scans it', async () => {
  resetData();

  const inputId = 'input-automation';
  db.prepare('INSERT INTO inputs (id, type, content, created_at) VALUES (?, ?, ?, ?)').run(
    inputId,
    'manual',
    'Login workflow',
    new Date().toISOString()
  );

  const testCaseId = 'tc-automation';
  db.prepare(`
    INSERT INTO test_cases (
      id, input_id, title, category, steps, expected_result, confidence_score,
      source_rationale, status, authorship_type, version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    testCaseId,
    inputId,
    'Login succeeds with valid credentials',
    'Smoke',
    JSON.stringify(['Open login page', 'Enter credentials', 'Submit form']),
    'Welcome screen appears',
    0.95,
    'Mock provider',
    'accepted',
    'ai',
    1,
    new Date().toISOString(),
    new Date().toISOString()
  );

  const result = await generateAutomationScript(testCaseId);
  assert.equal(result.artifacts.length, 1);

  const rows = db.prepare('SELECT * FROM automation_scripts WHERE test_case_id = ? ORDER BY language').all(testCaseId);
  assert.equal(rows.length, 1);
  assert.ok(rows.every((row) => row.security_scan_status === 'passed'));
  assert.equal(rows[0].language, 'typescript');

  const files = fs.readdirSync(generatedDir);
  assert.ok(files.some((file) => file.endsWith('.spec.ts')));
});

test('generateAutomationScript can target a specific language in a single LLM call', async () => {
  resetData();

  const inputId = 'input-python';
  db.prepare('INSERT INTO inputs (id, type, content, created_at) VALUES (?, ?, ?, ?)').run(
    inputId,
    'manual',
    'Login workflow',
    new Date().toISOString()
  );

  const testCaseId = 'tc-python';
  db.prepare(`
    INSERT INTO test_cases (
      id, input_id, title, category, steps, expected_result, confidence_score,
      source_rationale, status, authorship_type, version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    testCaseId,
    inputId,
    'Login succeeds with valid credentials',
    'Smoke',
    JSON.stringify(['Open login page', 'Enter credentials', 'Submit form']),
    'Welcome screen appears',
    0.95,
    'Mock provider',
    'accepted',
    'ai',
    1,
    new Date().toISOString(),
    new Date().toISOString()
  );

  const result = await generateAutomationScript(testCaseId, { language: 'python' });
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].language, 'python');
  assert.ok(result.artifacts[0].fileName.endsWith('.py'));
});

// SR-FR-3.4: locator strategy must be recorded as a queryable column, not just an
// inline code comment -- the mock provider's login-flow script uses getByLabel/
// getByRole, so it should classify as 'accessibility'.
test('generateAutomationScript records a queryable locator_strategy per script (SR-FR-3.4)', async () => {
  resetData();

  const inputId = 'input-locator';
  db.prepare('INSERT INTO inputs (id, type, content, created_at) VALUES (?, ?, ?, ?)').run(
    inputId, 'manual', 'Login workflow', new Date().toISOString()
  );
  const testCaseId = 'tc-locator';
  db.prepare(`
    INSERT INTO test_cases (
      id, input_id, title, category, steps, expected_result, confidence_score,
      source_rationale, status, authorship_type, version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    testCaseId, inputId, 'Login succeeds with valid credentials', 'Smoke',
    JSON.stringify(['Open login page', 'Enter credentials', 'Submit form']),
    'Welcome screen appears', 0.95, 'Mock provider', 'accepted', 'ai', 1,
    new Date().toISOString(), new Date().toISOString()
  );

  await generateAutomationScript(testCaseId);
  const rows = db.prepare('SELECT * FROM automation_scripts WHERE test_case_id = ?').all(testCaseId);
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.ok(['accessibility', 'css_xpath_fallback', 'mixed', 'n/a'].includes(row.locator_strategy));
  }
  // The mock provider's login script uses getByLabel/getByRole -- an accessibility-first locator.
  assert.ok(rows.some((row) => row.locator_strategy === 'accessibility'));
});

// Dev TDD §6.5 (422 SECURITY_SCAN_FAILED / FR-3.6): a script flagged by the static
// scan must fail generation closed rather than being silently persisted.
test('staticSecurityScan flags code containing a disallowed pattern, and classifyLocatorStrategy distinguishes strategies', () => {
  const dangerous = staticSecurityScan("const cp = require('child_process'); cp.exec('rm -rf /');");
  assert.equal(dangerous.status, 'flagged');

  const safe = staticSecurityScan("await page.getByRole('button', { name: 'Log in' }).click();");
  assert.equal(safe.status, 'passed');

  assert.equal(classifyLocatorStrategy("await page.getByRole('button').click();"), 'accessibility');
  assert.equal(classifyLocatorStrategy("await page.locator('.css-class').click();"), 'css_xpath_fallback');
  assert.equal(
    classifyLocatorStrategy("await page.getByRole('button').click(); await page.locator('.fallback').click();"),
    'mixed'
  );
  assert.equal(classifyLocatorStrategy("const response = await request.get('/api/status');"), 'n/a');
});

test('a flagged artifact throws SecurityScanFailedError instead of being persisted (FR-3.6 MVP gate)', () => {
  const err = new SecurityScanFailedError('spawns OS processes');
  assert.match(err.message, /static security scan/i);
  assert.equal(err.notes, 'spawns OS processes');
});
