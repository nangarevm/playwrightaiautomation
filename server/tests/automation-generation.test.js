import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { db } from '../src/db.ts';
import { generateAutomationScript } from '../src/services/codegenService.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const generatedDir = path.join(__dirname, '..', 'generated');

function resetData() {
  db.prepare('DELETE FROM auto_heal_actions').run();
  db.prepare('DELETE FROM change_detections').run();
  db.prepare('DELETE FROM execution_runs').run();
  db.prepare('DELETE FROM automation_scripts').run();
  db.prepare('DELETE FROM review_audit_entries').run();
  db.prepare('DELETE FROM sync_records').run();
  db.prepare('DELETE FROM test_cases').run();
  db.prepare('DELETE FROM inputs').run();
}

test('generateAutomationScript persists multiple automation artifacts and scans them', async () => {
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
  assert.ok(result.artifacts.length >= 2);

  const rows = db.prepare('SELECT * FROM automation_scripts WHERE test_case_id = ? ORDER BY language').all(testCaseId);
  assert.equal(rows.length, result.artifacts.length);
  assert.ok(rows.every((row) => row.security_scan_status === 'passed'));
  assert.ok(rows.some((row) => row.language === 'typescript'));
  assert.ok(rows.some((row) => row.language === 'python'));

  const files = fs.readdirSync(generatedDir);
  assert.ok(files.some((file) => file.endsWith('.spec.ts')));
  assert.ok(files.some((file) => file.endsWith('.py')));
});
