import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.ts';
import {
  attachUser,
  createUser,
  getUserActivityDashboard,
  listAuditLog,
  listFlaggedForReReview,
  listUsers,
  logAudit,
  routeTestCaseToOwner,
  sampleTestCasesForReReview,
  setCriticalPath,
  submitSecondReviewerSignOff,
} from '../src/services/adminService.ts';

function resetData() {
  db.prepare('DELETE FROM audit_log').run();
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

function seedTestCase(id, title, statusOverrides = {}) {
  const now = new Date().toISOString();
  db.prepare('INSERT INTO inputs (id, type, content, created_at) VALUES (?, ?, ?, ?)').run(`input-${id}`, 'text', title, now);
  db.prepare(`
    INSERT INTO test_cases (
      id, input_id, title, category, steps, expected_result, confidence_score, source_rationale,
      status, authorship_type, version, priority, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, `input-${id}`, title, 'Smoke', JSON.stringify(['step']), 'result', 0.9, 'fixture',
    statusOverrides.status ?? 'accepted', 'ai', 1, 'High', now, now
  );
}

test.beforeEach(() => {
  resetData();
});

test('seeded users exist for each SRS role', () => {
  const users = listUsers();
  const roles = users.map((u) => u.role);
  assert.ok(roles.includes('QA Lead'));
  assert.ok(roles.includes('Tester'));
  assert.ok(roles.includes('Developer'));
  assert.ok(roles.includes('Manager'));
});

test('createUser persists a new user', () => {
  const user = createUser({ name: 'Test User', role: 'Tester', email: 't@example.com' });
  assert.ok(user.id);
  assert.equal(user.role, 'Tester');
});

test('logAudit and listAuditLog record and retrieve governance events', () => {
  logAudit({ id: 'user-qa-lead', name: 'Priya', role: 'QA Lead' }, 'test_case_accepted', 'test_case', 'tc-1', { note: 'looks good' });
  const entries = listAuditLog({ entityType: 'test_case', entityId: 'tc-1' });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].action, 'test_case_accepted');
  assert.equal(entries[0].actor_role, 'QA Lead');
});

test('routeTestCaseToOwner matches a test case to the user whose owned_modules keyword appears in the title', () => {
  seedTestCase('tc-route', 'Login flow smoke test');
  const result = routeTestCaseToOwner('tc-route');
  assert.equal(result.matched, true);
  assert.equal(result.ownerUserId, 'user-qa-lead'); // seeded with owned_modules including "login"

  const row = db.prepare('SELECT owner_user_id FROM test_cases WHERE id = ?').get('tc-route');
  assert.equal(row.owner_user_id, 'user-qa-lead');
});

test('setCriticalPath flags a test case as requiring second-reviewer sign-off', () => {
  seedTestCase('tc-critical', 'Payments checkout flow');
  const updated = setCriticalPath('tc-critical', true);
  assert.equal(updated.critical_path, 1);
  assert.equal(updated.second_reviewer_required, 1);
  assert.equal(updated.second_reviewer_status, 'pending');
});

test('submitSecondReviewerSignOff records the decision and reviewer', () => {
  seedTestCase('tc-signoff', 'Payments checkout flow');
  setCriticalPath('tc-signoff', true);
  const updated = submitSecondReviewerSignOff('tc-signoff', { id: 'user-qa-lead', name: 'Priya', role: 'QA Lead' }, 'approved');
  assert.equal(updated.second_reviewer_status, 'approved');
  assert.equal(updated.second_reviewer_id, 'user-qa-lead');
});

test('submitSecondReviewerSignOff rejects when the test case does not require sign-off', () => {
  seedTestCase('tc-no-signoff', 'Ordinary flow');
  assert.throws(() => submitSecondReviewerSignOff('tc-no-signoff', { id: 'user-qa-lead', name: 'Priya', role: 'QA Lead' }, 'approved'));
});

test('sampleTestCasesForReReview flags previously approved cases and listFlaggedForReReview returns them', () => {
  seedTestCase('tc-1', 'Case one');
  seedTestCase('tc-2', 'Case two');
  const sampled = sampleTestCasesForReReview(2);
  assert.equal(sampled.length, 2);

  const flagged = listFlaggedForReReview();
  assert.equal(flagged.length, 2);
  assert.ok(flagged.every((row) => row.flagged_for_re_review === 1));
});

// -- User activity dashboard ("who's logged in / what are they doing") -----

function fakeReq(headerId) {
  return {
    headers: { 'x-user-id': headerId },
    header(name) {
      return this.headers[name.toLowerCase()];
    },
  };
}

function fakeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test('attachUser stamps last_seen_at on the resolved user row', () => {
  const before = db.prepare('SELECT last_seen_at FROM users WHERE id = ?').get('user-tester').last_seen_at;
  const req = fakeReq('user-tester');
  const res = fakeRes();
  let calledNext = false;
  attachUser(req, res, () => {
    calledNext = true;
  });
  assert.ok(calledNext, 'attachUser must call next() for a valid, non-disabled user');
  assert.equal(req.user.id, 'user-tester');
  const after = db.prepare('SELECT last_seen_at FROM users WHERE id = ?').get('user-tester').last_seen_at;
  assert.ok(after, 'last_seen_at must be set after attachUser resolves a real user');
  assert.notEqual(after, before);
});

test('getUserActivityDashboard marks a just-stamped user online and a never-seen user offline, sorted online-first', () => {
  attachUser(fakeReq('user-tester'), fakeRes(), () => {});

  const activity = getUserActivityDashboard();
  const tester = activity.find((u) => u.id === 'user-tester');
  const developer = activity.find((u) => u.id === 'user-developer');

  assert.ok(tester.isOnline, 'a user attachUser just stamped must read as online');
  assert.ok(tester.lastSeenAt);
  assert.ok(!developer.isOnline, 'a user with no last_seen_at must read as offline');
  assert.equal(developer.lastSeenAt, null);

  const testerIndex = activity.findIndex((u) => u.id === 'user-tester');
  const developerIndex = activity.findIndex((u) => u.id === 'user-developer');
  assert.ok(testerIndex < developerIndex, 'online users must sort before offline users');
});

test('getUserActivityDashboard rolls up audit_log into totalActionCount and lastAction', () => {
  logAudit({ id: 'user-qa-lead', name: 'Priya', role: 'QA Lead' }, 'test_case_routed', 'test_case', 'tc-1', { note: 'x' });
  logAudit({ id: 'user-qa-lead', name: 'Priya', role: 'QA Lead' }, 'critical_path_flagged', 'test_case', 'tc-1', { critical: true });

  const activity = getUserActivityDashboard();
  const qaLead = activity.find((u) => u.id === 'user-qa-lead');
  assert.equal(qaLead.totalActionCount, 2);
  assert.equal(qaLead.lastAction.action, 'critical_path_flagged');
  assert.equal(qaLead.lastAction.entityType, 'test_case');
});

test('getUserActivityDashboard reports disabled: true once an SSO-disabled user is present', () => {
  db.prepare('UPDATE users SET sso_disabled_at = ? WHERE id = ?').run(new Date().toISOString(), 'user-manager');
  const activity = getUserActivityDashboard();
  const manager = activity.find((u) => u.id === 'user-manager');
  assert.equal(manager.disabled, true);
  db.prepare('UPDATE users SET sso_disabled_at = NULL WHERE id = ?').run('user-manager'); // restore for other tests
});
