import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.ts';
import { errBody, ERROR_CODE_BY_STATUS } from '../src/errorCodes.ts';
import { idempotencyMiddleware, cleanupExpiredIdempotencyKeys } from '../src/services/idempotencyService.ts';
import { rateLimitMiddleware, resetRateLimitBuckets } from '../src/services/rateLimitService.ts';
import { exportProject, importProject, EXPORT_SCHEMA_VERSION, ImportSchemaVersionError } from '../src/services/adminService.ts';
import { applyTestCaseReview, deriveCommonAncestor, applyBulkAction } from '../src/services/testCaseFeatures.ts';
import { sendRunNotification, createIntegration, listFailedDeliveries } from '../src/services/integrationsService.ts';

function resetData() {
  db.prepare('DELETE FROM idempotency_keys').run();
  db.prepare('DELETE FROM failed_deliveries').run();
  db.prepare('DELETE FROM auto_heal_actions').run();
  db.prepare('DELETE FROM change_detections').run();
  db.prepare('DELETE FROM execution_evidence').run();
  db.prepare('DELETE FROM bug_findings').run(); // FK to execution_runs, must go first
  db.prepare('DELETE FROM execution_runs').run();
  db.prepare('DELETE FROM test_case_data_rows').run();
  db.prepare('DELETE FROM test_case_duplicate_flags').run();
  db.prepare('DELETE FROM sync_records').run();
  db.prepare('DELETE FROM review_audit_entries').run();
  db.prepare('DELETE FROM automation_scripts').run();
  db.prepare('DELETE FROM test_cases').run();
  db.prepare('DELETE FROM inputs').run();
  db.prepare('DELETE FROM integrations').run();
  db.prepare('DELETE FROM audit_log').run();
}

test.beforeEach(() => {
  resetData();
  resetRateLimitBuckets();
});

// -- Fake express req/res helpers for middleware unit tests -----------------
function fakeReq(overrides = {}) {
  return {
    method: 'POST',
    baseUrl: '/api/test-cases',
    path: '/',
    headers: {},
    header(name) {
      return this.headers[name.toLowerCase()];
    },
    user: { id: 'user-qa-lead' },
    ip: '127.0.0.1',
    ...overrides,
  };
}

function fakeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  return res;
}

// SR-FR-0.4 -------------------------------------------------------------
test('idempotencyMiddleware replays the original response for a repeated Idempotency-Key', () => {
  const req1 = fakeReq({ headers: { 'idempotency-key': 'key-1' } });
  const res1 = fakeRes();
  let nextCalled = false;
  idempotencyMiddleware(req1, res1, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true, 'first request with a new key should pass through to the route handler');
  res1.status(201).json({ id: 'tc-123', created: true });

  // A second request with the SAME key should short-circuit before next() and
  // replay the stored response, without the route handler running again.
  const req2 = fakeReq({ headers: { 'idempotency-key': 'key-1' } });
  const res2 = fakeRes();
  let secondNextCalled = false;
  idempotencyMiddleware(req2, res2, () => {
    secondNextCalled = true;
  });
  assert.equal(secondNextCalled, false, 'a replayed request must not re-execute the mutation');
  assert.equal(res2.statusCode, 201);
  assert.deepEqual(res2.body, { id: 'tc-123', created: true });
  assert.equal(res2.headers['Idempotency-Replayed'], 'true');
});

test('idempotencyMiddleware treats different keys/paths as independent and skips GET requests', () => {
  const reqA = fakeReq({ headers: { 'idempotency-key': 'key-a' } });
  const resA = fakeRes();
  idempotencyMiddleware(reqA, resA, () => {});
  resA.status(200).json({ value: 'a' });

  const reqB = fakeReq({ headers: { 'idempotency-key': 'key-b' } });
  const resB = fakeRes();
  let nextCalled = false;
  idempotencyMiddleware(reqB, resB, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true, 'a different key must not replay another key\'s response');

  const getReq = fakeReq({ method: 'GET', headers: { 'idempotency-key': 'key-a' } });
  const getRes = fakeRes();
  let getNextCalled = false;
  idempotencyMiddleware(getReq, getRes, () => {
    getNextCalled = true;
  });
  assert.equal(getNextCalled, true, 'GET requests must never be intercepted by idempotency replay');
});

test('cleanupExpiredIdempotencyKeys is safe to call and does not remove fresh keys', () => {
  const req = fakeReq({ headers: { 'idempotency-key': 'key-fresh' } });
  const res = fakeRes();
  idempotencyMiddleware(req, res, () => {});
  res.status(200).json({ ok: true });

  cleanupExpiredIdempotencyKeys();
  const row = db.prepare('SELECT * FROM idempotency_keys WHERE idem_key = ?').get('key-fresh');
  assert.ok(row, 'a key created moments ago must survive a cleanup sweep');
});

// Dev TDD §6.5 error code catalog -----------------------------------------
test('errBody attaches the stable error_code for every cataloged status', () => {
  assert.equal(errBody(400, 'bad input').error_code, 'INVALID_SCHEMA');
  assert.equal(errBody(401, 'no identity').error_code, 'AUTH_REQUIRED');
  assert.equal(errBody(403, 'denied').error_code, 'FORBIDDEN_ROLE');
  assert.equal(errBody(409, 'conflict').error_code, 'CONCURRENT_EDIT_CONFLICT');
  assert.equal(errBody(422, 'scan failed').error_code, 'SECURITY_SCAN_FAILED');
  assert.equal(errBody(429, 'slow down').error_code, 'RATE_LIMITED');
  assert.equal(errBody(501, 'not configured').error_code, 'SERVICE_NOT_CONFIGURED');
  assert.equal(errBody(503, 'degraded').error_code, 'LLM_PROVIDER_DEGRADED');
  // A status with no cataloged code (e.g. 404) must not fabricate one.
  assert.equal(errBody(404, 'not found').error_code, undefined);
  assert.deepEqual(Object.keys(ERROR_CODE_BY_STATUS).sort(), ['400', '401', '403', '409', '422', '429', '501', '503'].sort());
});

test('errBody preserves the message and merges extra fields', () => {
  const body = errBody(409, 'conflict happened', { conflict: true, currentVersion: 3 });
  assert.equal(body.error, 'conflict happened');
  assert.equal(body.conflict, true);
  assert.equal(body.currentVersion, 3);
  assert.equal(body.error_code, 'CONCURRENT_EDIT_CONFLICT');
});

// 429 rate limiting ---------------------------------------------------------
test('rateLimitMiddleware allows normal traffic and blocks a burst past the window limit', () => {
  const req = fakeReq({ user: { id: 'burst-user' } });
  let allowed = 0;
  for (let i = 0; i < 200; i++) {
    const res = fakeRes();
    let calledNext = false;
    rateLimitMiddleware(req, res, () => {
      calledNext = true;
    });
    if (calledNext) allowed++;
  }
  assert.equal(allowed, 200, 'the first 200 requests within the window should all pass through');

  const res = fakeRes();
  let blockedNextCalled = false;
  rateLimitMiddleware(req, res, () => {
    blockedNextCalled = true;
  });
  assert.equal(blockedNextCalled, false, 'the 201st request within the window must be rejected');
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.error_code, 'RATE_LIMITED');
  assert.ok(res.headers['Retry-After']);
});

test('rateLimitMiddleware tracks separate identities independently', () => {
  const reqA = fakeReq({ user: { id: 'identity-a' } });
  const reqB = fakeReq({ user: { id: 'identity-b' } });
  for (let i = 0; i < 200; i++) {
    rateLimitMiddleware(reqA, fakeRes(), () => {});
  }
  const res = fakeRes();
  let nextCalled = false;
  rateLimitMiddleware(reqB, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true, 'a different identity must have its own independent bucket');
});

// SR-FR-9.1 common_ancestor --------------------------------------------------
test('deriveCommonAncestor reconstructs the version-1 snapshot from the audit trail after one edit', () => {
  const inputId = 'input-ancestor';
  const now = new Date().toISOString();
  db.prepare('INSERT INTO inputs (id, type, content, created_at) VALUES (?, ?, ?, ?)').run(inputId, 'manual', 'x', now);
  const tcId = 'tc-ancestor';
  db.prepare(`
    INSERT INTO test_cases (id, input_id, title, category, steps, expected_result, confidence_score, source_rationale, status, authorship_type, version, priority, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(tcId, inputId, 'Original title', 'Smoke', JSON.stringify(['step 1']), 'result', 0.9, 'r', 'draft', 'ai', 1, 'Medium', now, now);

  // Apply a real edit through the review state machine (bumps version 1 -> 2)
  // and log it to audit_log the same way routes/testcases.ts does.
  const { diff } = applyTestCaseReview(tcId, 'edit', {
    edited_fields: { title: 'Edited title' },
    reviewer_user_id: 'user-qa-lead',
  });
  db.prepare(`
    INSERT INTO audit_log (id, actor_user_id, actor_role, action, entity_type, entity_id, details, retain_until, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('audit-1', 'user-qa-lead', 'QA Lead', 'test_case_edit', 'test_case', tcId, JSON.stringify({ diff }), now, now);

  const ancestor = deriveCommonAncestor(tcId, 1);
  assert.ok(ancestor, 'version 1 should be reconstructable from the single edit entry');
  assert.equal(ancestor.title, 'Original title');

  // A base_version that predates any recorded edit is honestly reported as unavailable.
  assert.equal(deriveCommonAncestor(tcId, 5), null);
  assert.equal(deriveCommonAncestor(tcId, undefined), null);
});

// SR-FR-2.7 bulk partial-failure reporting ----------------------------------
test('applyBulkAction reports per-item success/failure rather than an all-or-nothing result', () => {
  const inputId = 'input-bulk';
  const now = new Date().toISOString();
  db.prepare('INSERT INTO inputs (id, type, content, created_at) VALUES (?, ?, ?, ?)').run(inputId, 'manual', 'x', now);
  const okId = 'tc-bulk-ok';
  db.prepare(`
    INSERT INTO test_cases (id, input_id, title, category, steps, expected_result, confidence_score, source_rationale, status, authorship_type, version, priority, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(okId, inputId, 't', 'Smoke', JSON.stringify(['s']), 'r', 0.9, 'r', 'draft', 'ai', 1, 'Medium', now, now);

  const results = applyBulkAction([okId, 'tc-does-not-exist'], 'accept');
  const succeeded = results.filter((r) => r.ok).map((r) => r.id);
  const failed = results.filter((r) => !r.ok).map((r) => ({ id: r.id, reason: r.error }));
  assert.deepEqual(succeeded, [okId]);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].id, 'tc-does-not-exist');
  assert.ok(failed[0].reason);
});

// SR-FR-8.5 export/import schema versioning ---------------------------------
test('exportProject stamps a schema_version and importProject rejects an unrecognized one', () => {
  const payload = exportProject();
  assert.equal(payload.schema_version, EXPORT_SCHEMA_VERSION);

  assert.throws(() => importProject({ schema_version: 999 }), ImportSchemaVersionError);
  assert.throws(() => importProject({}), ImportSchemaVersionError);

  // A matching version is accepted (no rows to import here, just proving the gate passes).
  const result = importProject({ schema_version: EXPORT_SCHEMA_VERSION, test_cases: [] });
  assert.ok(result.imported);
});

// SR-FR-7.2 retry + failed_deliveries ---------------------------------------
test('sendRunNotification retries on transient failure and succeeds without logging a failed delivery', async () => {
  const integration = createIntegration({ type: 'slack', webhook_url: 'https://hooks.slack.com/services/x', notify_on_run: true });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls < 2) return { ok: false, status: 500 };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  try {
    const result = await sendRunNotification(integration.id, 'test message');
    assert.equal(result.ok, true);
    assert.equal(calls, 2, 'should have retried once before succeeding');
    assert.equal(listFailedDeliveries('slack_teams_notification').length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sendRunNotification logs a failed_deliveries row after exhausting all retries', async () => {
  const integration = createIntegration({ type: 'slack', webhook_url: 'https://hooks.slack.com/services/y', notify_on_run: true });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { ok: false, status: 500 };
  };
  try {
    await assert.rejects(() => sendRunNotification(integration.id, 'test message'));
    assert.equal(calls, 3, 'should attempt exactly MAX_DELIVERY_ATTEMPTS times');
    const failed = listFailedDeliveries('slack_teams_notification');
    assert.equal(failed.length, 1);
    assert.equal(failed[0].attempts, 3);
    assert.equal(failed[0].target_ref, integration.id);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
