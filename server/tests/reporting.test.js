import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.ts';
import {
  detectFlakyScripts,
  getDashboardSummary,
  getHoursSavedEstimate,
  getRequirementCoverage,
  recordTimeBreakdownForRun,
} from '../src/services/reportingService.ts';

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

function seed() {
  const now = new Date().toISOString();
  db.prepare('INSERT INTO inputs (id, type, content, created_at) VALUES (?, ?, ?, ?)').run(
    'input-report', 'text', 'Ticket RPT-1 covers /api/report', now
  );
  db.prepare(`
    INSERT INTO test_cases (
      id, input_id, title, category, steps, expected_result, confidence_score, source_rationale,
      status, authorship_type, version, priority, traceability_context, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'tc-report', 'input-report', 'Reporting flow', 'Smoke',
    JSON.stringify(['Open report page']), 'Report renders', 0.9, 'fixture',
    'accepted', 'ai', 1, 'High',
    JSON.stringify({ ticketIds: ['RPT-1'], screenshots: [], endpoints: [], businessRules: '' }),
    now, now
  );
  db.prepare(`
    INSERT INTO automation_scripts (id, test_case_id, language, framework, code, file_path, security_scan_status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('script-report', 'tc-report', 'typescript', 'playwright', 'test("x", () => {})', 'generated/script.spec.ts', 'passed', now);

  return { testCaseId: 'tc-report', scriptId: 'script-report' };
}

function insertRun(id, scriptId, status, durationMs) {
  db.prepare(`
    INSERT INTO execution_runs (id, script_id, status, duration_ms, stdout, stderr, evidence_path, created_at)
    VALUES (?, ?, ?, ?, '', '', '', ?)
  `).run(id, scriptId, status, durationMs, new Date().toISOString());
}

test.beforeEach(() => {
  resetData();
});

test('getDashboardSummary aggregates pass/fail totals and an execution-time trend', () => {
  const { scriptId } = seed();
  insertRun('run-1', scriptId, 'passed', 1000);
  insertRun('run-2', scriptId, 'failed', 2000);

  const summary = getDashboardSummary();
  assert.equal(summary.totalRuns, 2);
  assert.equal(summary.totals.passed, 1);
  assert.equal(summary.totals.failed, 1);
  assert.equal(summary.passRate, 50);
  assert.equal(summary.executionTimeTrend.length, 1);
});

test('detectFlakyScripts flags a script with mixed pass/fail outcomes', () => {
  const { scriptId } = seed();
  insertRun('run-1', scriptId, 'passed', 1000);
  insertRun('run-2', scriptId, 'failed', 1000);
  insertRun('run-3', scriptId, 'passed', 1000);

  const results = detectFlakyScripts();
  assert.equal(results.length, 1);
  assert.equal(results[0].isFlaky, true);

  const script = db.prepare('SELECT is_flaky FROM automation_scripts WHERE id = ?').get(scriptId);
  assert.equal(script.is_flaky, 1);
});

test('getRequirementCoverage maps ticket IDs to approved test cases', () => {
  seed();
  const coverage = getRequirementCoverage();
  assert.equal(coverage.totalTicketsReferenced, 1);
  assert.equal(coverage.coveredByApprovedTestCase, 1);
  assert.equal(coverage.coveragePercent, 100);
});

test('getHoursSavedEstimate compares manual-effort estimate against actual automated time', () => {
  const { scriptId } = seed();
  insertRun('run-1', scriptId, 'passed', 5000);

  const result = getHoursSavedEstimate();
  assert.equal(result.testCaseCount, 1);
  assert.equal(result.estimatedManualHours, 0.25); // 15 minutes
  assert.ok(result.hoursSaved > 0);
});

test('recordTimeBreakdownForRun stores estimated duration and time saved for known selection modes', () => {
  const { scriptId } = seed();
  insertRun('run-1', scriptId, 'passed', 1000);

  const breakdown = recordTimeBreakdownForRun('run-1', 'smart-selection', 1000);
  assert.equal(breakdown.estimatedDurationMs, 3.5 * 60_000);
  assert.equal(breakdown.timeSavedMs, 3.5 * 60_000 - 1000);

  const row = db.prepare('SELECT estimated_duration_ms, time_saved_ms FROM execution_runs WHERE id = ?').get('run-1');
  assert.equal(row.estimated_duration_ms, 3.5 * 60_000);
});
