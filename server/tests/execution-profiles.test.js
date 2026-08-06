import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.ts';
import { createExecutionProfile, listExecutionProfiles, queueExecution, suggestExecutionProfile } from '../src/services/executionService.ts';

function resetData() {
  db.prepare('DELETE FROM auto_heal_actions').run();
  db.prepare('DELETE FROM change_detections').run();
  db.prepare('DELETE FROM execution_evidence').run(); // FK to execution_runs, must go first
  db.prepare('DELETE FROM bug_findings').run(); // FK to execution_runs, must go first
  db.prepare('DELETE FROM execution_runs').run();
  db.prepare('DELETE FROM execution_profiles').run();
  db.prepare('DELETE FROM review_audit_entries').run();
  db.prepare('DELETE FROM sync_records').run();
  db.prepare('DELETE FROM automation_scripts').run();
  db.prepare('DELETE FROM test_cases').run();
  db.prepare('DELETE FROM inputs').run();
}

test('execution profiles and queueing are persisted and suggested', async () => {
  resetData();

  db.prepare('INSERT INTO inputs (id, type, content, created_at) VALUES (?, ?, ?, ?)').run('input-exec', 'manual', 'Exec fixture', new Date().toISOString());
  db.prepare(`
    INSERT INTO test_cases (id, input_id, title, category, steps, expected_result, confidence_score, source_rationale, status, authorship_type, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('tc-exec', 'input-exec', 'Exec case', 'Smoke', JSON.stringify(['Open page']), 'Page opens', 0.9, 'Fixture', 'accepted', 'ai', 1, new Date().toISOString(), new Date().toISOString());
  db.prepare(`
    INSERT INTO automation_scripts (id, test_case_id, language, framework, code, file_path, security_scan_status, security_scan_notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('script-1', 'tc-exec', 'typescript', 'playwright', 'test("x", () => {})', 'generated/script.spec.ts', 'passed', 'ok', new Date().toISOString());

  const profile = createExecutionProfile({
    name: 'CI smoke profile',
    browser_set: 'chromium+firefox',
    concurrency: 2,
    artifact_capture_mode: 'full-debug',
    retention_days: 7,
    selection_mode: 'smart-selection',
    retry_strategy: 'retry-flaky',
    provider: 'ci',
    headless_mode: 1,
    reuse_browser_instances: 1,
    is_default_for_team: 1
  });

  assert.ok(profile.id);
  assert.equal(listExecutionProfiles().length, 1);

  const suggestion = suggestExecutionProfile({ trigger_source: 'github-actions' });
  assert.equal(suggestion.suggestedProfileId, profile.id);

  const queued = await queueExecution('script-1', 'http://localhost:4100/demo/login.html', { profile_id: profile.id, trigger_source: 'github-actions' });
  assert.equal(queued.status, 'queued');
  assert.equal(queued.queuePosition, 1);

  const queuedRows = db.prepare('SELECT * FROM execution_runs WHERE status = ?').all('queued');
  assert.equal(queuedRows.length, 1);
});
