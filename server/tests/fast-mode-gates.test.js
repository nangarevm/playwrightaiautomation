// FR-4.28/FR-4.29 (SRS v4.6 Section 14.4): the Fast Mode run trigger route and the test-case
// review route are exercised here at the Express route-handler level (not just the underlying
// service functions), since these two gaps live specifically in the route handlers -- an
// independent AC audit found both enforced nowhere. There's no supertest/HTTP-harness
// convention in this test suite yet, so handlers are invoked directly off the router's
// internal stack with minimal req/res doubles, matching this repo's existing preference for
// exercising real code paths over mocking framework internals.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { db } from '../src/db.ts';
import { executionRouter } from '../src/routes/execution.ts';
import { testCasesRouter } from '../src/routes/testcases.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const generatedDir = path.join(__dirname, '..', 'generated');

function resetData() {
  db.prepare('DELETE FROM execution_evidence').run(); // FK to execution_runs, must go first
  db.prepare('DELETE FROM bug_findings').run(); // FK to execution_runs, must go first
  db.prepare('DELETE FROM execution_runs').run();
  db.prepare('DELETE FROM review_audit_entries').run();
  db.prepare('DELETE FROM automation_scripts').run();
  db.prepare('DELETE FROM test_cases').run();
  db.prepare('DELETE FROM inputs').run();
  db.prepare('DELETE FROM execution_profiles').run();
  db.prepare('DELETE FROM environments').run();
}

function findHandler(router, method, routePath) {
  const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error(`route ${method.toUpperCase()} ${routePath} not found`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function mockRes() {
  const res = { statusCode: 200, body: undefined };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

function seedScriptFixture() {
  const now = new Date().toISOString();
  db.prepare('INSERT INTO inputs (id, type, content, created_at) VALUES (?, ?, ?, ?)').run('input-fm', 'manual', 'Fast mode fixture', now);
  db.prepare(`
    INSERT INTO test_cases (id, input_id, title, category, steps, expected_result, confidence_score, source_rationale, status, authorship_type, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('tc-fm', 'input-fm', 'Fast mode case', 'Smoke', JSON.stringify(['Open page']), 'Page opens', 0.9, 'Fixture', 'accepted', 'ai', 1, now, now);
  const filePath = path.join(generatedDir, 'script-fm.spec.ts');
  fs.mkdirSync(generatedDir, { recursive: true });
  fs.writeFileSync(filePath, `import { test, expect } from '@playwright/test';
test('Fast mode case', async ({ page }) => {
  await page.goto(process.env.TARGET_URL || 'http://localhost:4100/demo/login.html');
  await expect(page).toHaveTitle(/Login/i);
});
`, 'utf-8');
  db.prepare(`
    INSERT INTO automation_scripts (id, test_case_id, language, framework, code, file_path, security_scan_status, security_scan_notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('script-fm', 'tc-fm', 'typescript', 'playwright', 'test("x", () => {})', filePath, 'passed', 'ok', now);
  db.prepare(`
    INSERT INTO execution_profiles (id, name, browser_set, concurrency, artifact_capture_mode, retention_days, selection_mode, retry_strategy, provider, reserved_runner_count, headless_mode, reuse_browser_instances, is_default_for_team, is_default_for_suite, created_at, updated_at)
    VALUES ('profile-fm', 'Fast mode profile', 'chromium', 1, 'logs-only', 30, 'full-suite', 'no-retry', 'local', 0, 1, 0, 0, 0, ?, ?)
  `).run(now, now);
  db.prepare(`
    INSERT INTO environments (id, name, target_url, created_at, updated_at)
    VALUES ('env-fm', 'Staging', 'http://localhost:4100/demo/login.html', ?, ?)
  `).run(now, now);
}

test.beforeEach(() => {
  resetData();
});

// FR-4.28
test('POST /execution-runs/:scriptId/run rejects a Fast Mode trigger missing profile_id/environment_id', async () => {
  const handler = findHandler(executionRouter, 'post', '/:scriptId/run');
  const req = { params: { scriptId: 'script-fm' }, body: {} };
  const res = mockRes();
  await handler(req, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /FR-4.28/);
  assert.equal(db.prepare('SELECT COUNT(*) as c FROM execution_runs').get().c, 0, 'no run should have been started');
});

// FR-4.28
test('POST /execution-runs/:scriptId/run proceeds once both profile_id and environment_id are given', async () => {
  seedScriptFixture();
  const handler = findHandler(executionRouter, 'post', '/:scriptId/run');
  const req = { params: { scriptId: 'script-fm' }, body: { profile_id: 'profile-fm', environment_id: 'env-fm', trigger_source: 'ui' } };
  const res = mockRes();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.doesNotMatch(JSON.stringify(res.body), /FR-4.28/);
  const run = db.prepare('SELECT * FROM execution_runs WHERE script_id = ?').get('script-fm');
  assert.ok(run, 'a run row should exist');
  assert.equal(run.profile_id, 'profile-fm');
  assert.equal(run.environment_id, 'env-fm');
  assert.equal(run.speed_mode, 'fast');
});

// FR-4.28: Ultrafast is exempt by design (FR-4.25) -- it never carries profile_id/environment_id
// on this route (it goes through the separate /ultrafast trigger), so speed_mode: 'ultrafast'
// must bypass the confirmation gate here rather than being blocked by it.
test('POST /execution-runs/:scriptId/run does not apply the FR-4.28 gate when speed_mode is ultrafast', async () => {
  const handler = findHandler(executionRouter, 'post', '/:scriptId/run');
  const req = { params: { scriptId: 'script-does-not-exist' }, body: { speed_mode: 'ultrafast' } };
  const res = mockRes();
  await handler(req, res);
  // runExecution() resolves (rather than throws) with an "error" body for an unknown script,
  // so the route still responds 200 here -- the point of this test is only that the response
  // is NOT the FR-4.28 rejection, proving the gate was skipped for speed_mode: 'ultrafast'.
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.error, 'Script not found');
  assert.doesNotMatch(res.body.error, /FR-4.28/);
});

// FR-4.29
test('PATCH /test-cases/:id/review rejects an accept with no authenticated reviewer identity (anonymous default)', async () => {
  seedScriptFixture();
  const handler = findHandler(testCasesRouter, 'patch', '/:id/review');
  const req = { params: { id: 'tc-fm' }, body: { action: 'accept' }, user: { id: 'anonymous', name: 'Unauthenticated', role: 'Tester' } };
  const res = mockRes();
  await handler(req, res);
  assert.equal(res.statusCode, 401);
  assert.match(res.body.error, /FR-4.29/);
  const entries = db.prepare('SELECT * FROM review_audit_entries WHERE test_case_id = ?').all('tc-fm');
  assert.equal(entries.length, 0, 'no audit entry should be recorded for a rejected anonymous review');
});

// FR-4.29
test('PATCH /test-cases/:id/review succeeds for a named reviewer and records reviewer_user_id on the audit entry', async () => {
  seedScriptFixture();
  db.prepare("UPDATE test_cases SET status = 'draft' WHERE id = ?").run('tc-fm');
  const handler = findHandler(testCasesRouter, 'patch', '/:id/review');
  const req = { params: { id: 'tc-fm' }, body: { action: 'accept', reviewer_notes: 'looks good' }, user: { id: 'user-qa-lead', name: 'Priya (QA Lead)', role: 'QA Lead' } };
  const res = mockRes();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'accepted');
  const entry = db.prepare('SELECT * FROM review_audit_entries WHERE test_case_id = ? ORDER BY created_at DESC LIMIT 1').get('tc-fm');
  assert.ok(entry, 'an audit entry should be recorded');
  assert.equal(entry.reviewer_user_id, 'user-qa-lead');
  assert.equal(entry.action, 'accept');
});
