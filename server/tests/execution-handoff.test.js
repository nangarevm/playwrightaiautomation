import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { db } from '../src/db.ts';
import { triggerUltrafastRun } from '../src/services/ultrafastService.ts';
import { runExecution, summarizeRunForClient } from '../src/services/executionService.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const generatedDir = path.join(__dirname, '..', 'generated');

function resetData() {
  db.prepare('DELETE FROM auto_heal_actions').run();
  db.prepare('DELETE FROM change_detections').run();
  db.prepare('DELETE FROM execution_evidence').run();
  db.prepare('DELETE FROM bug_findings').run();
  db.prepare('DELETE FROM execution_runs').run();
  db.prepare('DELETE FROM review_audit_entries').run();
  db.prepare('DELETE FROM sync_records').run();
  db.prepare('DELETE FROM automation_scripts').run();
  db.prepare('DELETE FROM test_cases').run();
  db.prepare('DELETE FROM inputs').run();
}

test('runExecution resolves (never rejects) when the script file is missing on disk', async () => {
  resetData();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO inputs (id, type, content, created_at) VALUES (?, ?, ?, ?)').run('in-missing', 'manual', 'x', now);
  db.prepare(`
    INSERT INTO test_cases (id, input_id, title, category, steps, expected_result, confidence_score, source_rationale, status, authorship_type, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('tc-missing-file', 'in-missing', 'Missing file', 'Smoke', '[]', 'ok', 0.9, 'x', 'accepted', 'ai', 1, now, now);
  db.prepare(`
    INSERT INTO automation_scripts (id, test_case_id, language, framework, code, file_path, security_scan_status, security_scan_notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('script-missing-file', 'tc-missing-file', 'typescript', 'playwright', 'test("x", () => {})', path.join(generatedDir, 'does-not-exist-missing.spec.ts'), 'passed', 'ok', now);

  const result = await runExecution('script-missing-file', 'http://localhost:4100/demo/login.html', { speed_mode: 'ultrafast' });
  assert.equal(result.status, 'error');
  assert.match(result.error, /Script file not found on disk/);
  const row = db.prepare('SELECT status FROM execution_runs WHERE id = ?').get(result.id);
  assert.equal(row.status, 'error');
});

test('triggerUltrafastRun returns a slim run payload without multi-megabyte stdout', async () => {
  resetData();
  const now = new Date().toISOString();
  const fileName = 'tc-slim-run.spec.ts';
  const filePath = path.join(generatedDir, fileName);
  fs.writeFileSync(filePath, `import { test, expect } from '@playwright/test';
test('slim run', async ({ page }) => {
  await page.goto(process.env.TARGET_URL || 'http://localhost:4100/demo/login.html');
  await expect(page).toHaveTitle(/Login/i);
});
`, 'utf-8');

  db.prepare('INSERT INTO inputs (id, type, content, created_at) VALUES (?, ?, ?, ?)').run('in-slim', 'manual', 'x', now);
  db.prepare(`
    INSERT INTO test_cases (id, input_id, title, category, steps, expected_result, confidence_score, source_rationale, status, authorship_type, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('tc-slim-run', 'in-slim', 'slim run', 'Smoke', '[]', 'ok', 0.95, 'x', 'accepted', 'ai', 1, now, now);
  db.prepare(`
    INSERT INTO automation_scripts (id, test_case_id, language, framework, code, file_path, security_scan_status, security_scan_notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('script-slim-run', 'tc-slim-run', 'typescript', 'playwright', 'x', filePath, 'passed', 'ok', now);

  const result = await triggerUltrafastRun({ script_id: 'script-slim-run', target_url: 'http://localhost:4100/demo/login.html' });
  assert.ok(result.run?.id);
  assert.ok(['passed', 'failed', 'error'].includes(result.run.status));
  assert.equal(result.run.stdout, undefined);
  assert.equal(typeof result.run.stdoutBytes, 'number');
  assert.equal(summarizeRunForClient({ id: 'x', status: 'passed', stdout: 'hello' }).stdout, undefined);
});
