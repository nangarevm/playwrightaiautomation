import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.ts';
import { recordBugFinding, getBugFinding, listBugFindings, BUG_SCAN_CONFIG } from '../src/services/bugDetectionService.ts';
import {
  inferShape,
  mergeShape,
  diffShape,
  looksLikeErrorBody,
  checkAndRecordApiResponse,
  listApiSchemas,
  getApiSchemaByKey,
  updateApiSchemaMode,
  resetApiSchemaBaseline,
  deleteApiSchema,
} from '../src/services/apiSchemaService.ts';
import { createConsistencyRule, checkUiApiConsistency, deleteConsistencyRule } from '../src/services/uiApiConsistencyService.ts';
import {
  getVisualDiffThresholdPercent,
  setVisualDiffThresholdPercent,
  getApiSchemaDefaultMode,
  setApiSchemaDefaultMode,
} from '../src/services/adminService.ts';
import { compareScreenshotToBaseline, getVisualIgnoreSelectors, setVisualIgnoreSelectors, VISUAL_DIFF_CONFIG } from '../src/services/screensService.ts';
import { getDomCheckIgnoreSelectors, setDomCheckIgnoreSelectors, DOM_CHECKS_CONFIG } from '../src/services/domChecksService.ts';
import { isResponsiveScanEnabled, setResponsiveScanEnabled, RESPONSIVE_VIEWPORTS } from '../src/services/responsiveService.ts';

function resetData() {
  db.prepare('DELETE FROM bug_findings').run();
  db.prepare('DELETE FROM api_schemas').run();
  db.prepare('DELETE FROM ui_api_consistency_rules').run();
  db.prepare('DELETE FROM screens').run();
}

test.beforeEach(() => {
  resetData();
});

// ---- Phase 1 config contract (regression guard against the two live-tested fixes) ----

test('BUG_SCAN_CONFIG suppresses Chromium\'s own auto-echoed network-failure console noise by default, and known third-party URL noise', () => {
  const consoleMsg = 'Failed to load resource: the server responded with a status of 404 (Not Found)';
  assert.ok(BUG_SCAN_CONFIG.ignoredConsolePatterns.some((p) => p.test(consoleMsg)), 'default ignoredConsolePatterns must suppress the Chromium auto-echo, or the 404 double-reports as both api-status and console-error');
  assert.ok(BUG_SCAN_CONFIG.ignoredUrlPatterns.some((p) => p.test('https://www.google-analytics.com/collect')));
  assert.ok(BUG_SCAN_CONFIG.ignoredUrlPatterns.some((p) => p.test('https://example.com/favicon.ico')));
  // App-specific console noise is intentionally NOT pre-guessed -- only the
  // one universal Chromium behavior above is a default.
  assert.equal(BUG_SCAN_CONFIG.ignoredConsolePatterns.length, 1);
});

// ---- bug_findings category/viewport (additive columns) ----

test('recordBugFinding persists and round-trips the new category/viewport columns', () => {
  const finding = recordBugFinding({
    source: 'ui_exploratory',
    category: 'ui-dom',
    severity: 'medium',
    title: 'Zero-size element with content',
    detail: 'test',
    viewport: 'mobile',
    stepsToReproduce: ['step 1'],
  });
  assert.equal(finding.category, 'ui-dom');
  assert.equal(finding.viewport, 'mobile');

  const reloaded = getBugFinding(finding.id);
  assert.equal(reloaded.category, 'ui-dom');
  assert.equal(reloaded.viewport, 'mobile');

  const filtered = listBugFindings({ category: 'ui-dom' });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].id, finding.id);

  const filteredOther = listBugFindings({ category: 'api-schema' });
  assert.equal(filteredOther.length, 0);
});

// ---- apiSchemaService: shape inference + diff ----

test('inferShape builds a recursive shape for nested objects/arrays from a single sample', () => {
  const shape = inferShape({ id: 1, name: 'a', tags: ['x', 'y'], address: { city: 'Pune', zip: null } });
  assert.equal(shape.kind, 'object');
  assert.equal(shape.fields.id.kind, 'primitive');
  assert.deepEqual(shape.fields.id.types, ['number']);
  assert.equal(shape.fields.tags.kind, 'array');
  assert.deepEqual(shape.fields.tags.item.types, ['string']);
  assert.equal(shape.fields.address.kind, 'object');
  assert.equal(shape.fields.address.fields.zip.kind, 'null');
  assert.deepEqual(shape.optionalFields, []); // a single sample has no known-optional fields yet
});

test('mergeShape widens a type union and marks inconsistently-present fields optional', () => {
  let acc = inferShape({ id: 1, total: 42.5, items: ['a'] });
  acc = mergeShape(acc, inferShape({ id: 2, total: '42.5', items: ['a', 'b'] })); // total varies number/string
  acc = mergeShape(acc, inferShape({ id: 3, items: [] })); // total absent this time

  assert.deepEqual(new Set(acc.fields.total.types), new Set(['number', 'string']));
  assert.ok(acc.optionalFields.includes('total'), 'total was absent in at least one sample, so it must be tracked as optional');
  assert.ok(!acc.optionalFields.includes('id'), 'id was present in every sample, so it must NOT be optional');
});

test('diffShape flags missing fields, type mismatches, and unexpected nulls/fields -- but not variation already seen during baseline merging', () => {
  const baseline = inferShape({ id: 1, name: 'Alice', price: 9.99 });

  const actualMissing = inferShape({ id: 1, price: 9.99 });
  const missingIssues = diffShape(baseline, actualMissing);
  assert.ok(missingIssues.some((i) => i.kind === 'missing_field' && i.path === '$.name'));

  const actualTypeMismatch = inferShape({ id: 1, name: 'Alice', price: '9.99' });
  const typeIssues = diffShape(baseline, actualTypeMismatch);
  assert.ok(typeIssues.some((i) => i.kind === 'type_mismatch' && i.path === '$.price'));

  const actualNull = inferShape({ id: 1, name: null, price: 9.99 });
  const nullIssues = diffShape(baseline, actualNull);
  assert.ok(nullIssues.some((i) => i.kind === 'unexpected_null' && i.path === '$.name'));

  const actualExtra = inferShape({ id: 1, name: 'Alice', price: 9.99, discount: 0.1 });
  const extraIssues = diffShape(baseline, actualExtra);
  assert.ok(extraIssues.some((i) => i.kind === 'unexpected_field' && i.path === '$.discount'));

  // A baseline field that was already nullable tolerates null without complaint.
  const nullableBaseline = inferShape({ id: 1, name: null });
  const stillNull = inferShape({ id: 1, name: null });
  assert.equal(diffShape(nullableBaseline, stillNull).length, 0);

  // False-positive fix: a type merged in during baseline (e.g. price seen as
  // both a number and a string across baseline samples) must NOT be flagged
  // once strict, and a field baseline ever saw absent must NOT be flagged
  // missing when it's absent again.
  let widenedBaseline = inferShape({ id: 1, name: 'Alice', price: 9.99 });
  widenedBaseline = mergeShape(widenedBaseline, inferShape({ id: 2, name: 'Bob', price: '9.99' }));
  widenedBaseline = mergeShape(widenedBaseline, inferShape({ id: 3, price: 9.99 })); // name absent this time
  assert.equal(diffShape(widenedBaseline, inferShape({ id: 4, name: 'Carol', price: '9.99' })).length, 0);
  assert.equal(diffShape(widenedBaseline, inferShape({ id: 5, price: 9.99 })).length, 0); // name absent again -- known-optional
});

test('looksLikeErrorBody recognizes common error-shaped payloads', () => {
  assert.equal(looksLikeErrorBody({ success: false, message: 'oops' }), true);
  assert.equal(looksLikeErrorBody({ error: 'bad request' }), true);
  assert.equal(looksLikeErrorBody({ errors: ['a', 'b'] }), true);
  assert.equal(looksLikeErrorBody({ status: 'error' }), true);
  assert.equal(looksLikeErrorBody({ id: 1, name: 'ok' }), false);
  assert.equal(looksLikeErrorBody([1, 2, 3]), false);
  assert.equal(looksLikeErrorBody(null), false);
});

// ---- apiSchemaService: end-to-end baseline capture + drift detection ----

test('checkAndRecordApiResponse establishes a baseline on first sighting, widens it across baseline sightings, then flags genuinely new drift once strict', () => {
  const endpoint = { method: 'GET', path: '/api/orders/123' };
  const first = checkAndRecordApiResponse({ ...endpoint, status: 200, body: { id: 1, total: 42.5, items: ['a'] } });
  assert.equal(first.length, 0); // nothing to compare against yet

  const stored = getApiSchemaByKey('GET /api/orders/123');
  assert.ok(stored);
  assert.equal(stored.mode, 'baseline'); // org default

  // baseline mode: a type variance (total as a string) is silently accepted
  // AND absorbed into the stored shape -- not just silently ignored.
  const stillBaseline = checkAndRecordApiResponse({ ...endpoint, status: 200, body: { id: 1, total: '42.5', items: ['a'] } });
  assert.equal(stillBaseline.length, 0);
  const widened = JSON.parse(getApiSchemaByKey('GET /api/orders/123').schema_json);
  assert.deepEqual(new Set(widened.fields.total.types), new Set(['number', 'string']));

  updateApiSchemaMode(stored.id, 'strict');

  // Re-sending a variant already observed during baseline must NOT flag --
  // baseline mode already accepted this shape as correct.
  const alreadySeen = checkAndRecordApiResponse({ ...endpoint, status: 200, body: { id: 1, total: '42.5', items: ['a'] } });
  assert.equal(alreadySeen.length, 0);

  // A genuinely new type (never observed during baseline) DOES flag.
  const drifted = checkAndRecordApiResponse({ ...endpoint, status: 200, body: { id: 1, total: true, items: ['a'] } });
  assert.ok(drifted.some((f) => f.category === 'api-schema'));
  assert.equal(drifted[0].source, 'api_fuzz');

  // total was present in EVERY baseline sample -- now genuinely missing.
  const missingField = checkAndRecordApiResponse({ ...endpoint, status: 200, body: { id: 1, items: ['a'] } });
  assert.ok(missingField.some((f) => f.detail.includes('total')));
});

test('checkAndRecordApiResponse flags a 2xx response with an error-shaped body regardless of schema mode', () => {
  const findings = checkAndRecordApiResponse({ method: 'GET', path: '/api/weird', status: 200, body: { success: false, error: 'nope' } });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, 'api-status');
  assert.match(findings[0].title, /HTTP 200/);
});

test('api schema CRUD: list/reset/delete', () => {
  checkAndRecordApiResponse({ method: 'POST', path: '/api/items', status: 201, body: { id: 1, name: 'a' } });
  const schemas = listApiSchemas();
  assert.equal(schemas.length, 1);

  updateApiSchemaMode(schemas[0].id, 'strict');
  checkAndRecordApiResponse({ method: 'POST', path: '/api/items', status: 201, body: { id: 1, name: 'a', extra: true } });

  const reset = resetApiSchemaBaseline(schemas[0].id);
  const reShape = JSON.parse(reset.schema_json);
  assert.ok('extra' in (reShape.fields || {}) === false); // re-baselined from the ORIGINAL sample, not the drifted one

  deleteApiSchema(schemas[0].id);
  assert.equal(listApiSchemas().length, 0);
});

// ---- uiApiConsistencyService ----

test('checkUiApiConsistency flags a mismatch and stays silent on a match', async () => {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO screens (id, name, module_name, source_input_id, url_or_path, last_captured_state_hash, change_status, last_compared_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'new', ?, ?, ?)
  `).run('screen-consistency', 'Orders list', 'fixture', 'input-x', null, 'x', now, now, now);

  createConsistencyRule({ screenId: 'screen-consistency', name: 'Order rows', domSelector: 'tr.order-row', apiEndpointKey: 'GET /api/orders' });

  const fakePageMismatch = { locator: () => ({ count: async () => 3 }) };
  const bodies = new Map([['GET /api/orders', { items: [1, 2] }]]); // API says 2, UI renders 3
  const mismatchFindings = await checkUiApiConsistency(fakePageMismatch, 'screen-consistency', 'Orders list', bodies);
  assert.equal(mismatchFindings.length, 1);
  assert.equal(mismatchFindings[0].category, 'ui-api-mismatch');

  db.prepare('DELETE FROM bug_findings').run();
  const fakePageMatch = { locator: () => ({ count: async () => 2 }) };
  const matchFindings = await checkUiApiConsistency(fakePageMatch, 'screen-consistency', 'Orders list', bodies);
  assert.equal(matchFindings.length, 0);

  const rules = db.prepare('SELECT id FROM ui_api_consistency_rules WHERE screen_id = ?').all('screen-consistency');
  for (const r of rules) deleteConsistencyRule(r.id);
  db.prepare('DELETE FROM screens WHERE id = ?').run('screen-consistency');
});

// ---- adminService: new configurable thresholds ----

test('visual diff threshold and API schema default mode are QA-Lead editable with validation', () => {
  const originalThreshold = getVisualDiffThresholdPercent();
  const originalMode = getApiSchemaDefaultMode();
  try {
    assert.equal(originalThreshold, 1.0);
    assert.equal(originalMode, 'baseline');

    setVisualDiffThresholdPercent(5, undefined);
    assert.equal(getVisualDiffThresholdPercent(), 5);
    assert.throws(() => setVisualDiffThresholdPercent(-1, undefined));
    assert.throws(() => setVisualDiffThresholdPercent(101, undefined));

    setApiSchemaDefaultMode('strict', undefined);
    assert.equal(getApiSchemaDefaultMode(), 'strict');
    assert.throws(() => setApiSchemaDefaultMode('nonsense', undefined));
  } finally {
    setVisualDiffThresholdPercent(originalThreshold, undefined);
    setApiSchemaDefaultMode(originalMode, undefined);
  }
});

test('responsive scan toggle defaults on and is settable', () => {
  const original = isResponsiveScanEnabled();
  try {
    assert.equal(original, true);
    setResponsiveScanEnabled(false);
    assert.equal(isResponsiveScanEnabled(), false);
    assert.equal(RESPONSIVE_VIEWPORTS.length, 2);
    assert.ok(RESPONSIVE_VIEWPORTS.some((v) => v.name === 'mobile'));
    assert.ok(RESPONSIVE_VIEWPORTS.some((v) => v.name === 'tablet'));
  } finally {
    setResponsiveScanEnabled(original);
  }
});

// ---- screensService: buffer-based compare, no baseline case (no browser needed) ----

test('compareScreenshotToBaseline reports no baseline when none has been saved', () => {
  const result = compareScreenshotToBaseline('screen-with-no-baseline', Buffer.from([]));
  assert.equal(result.hasBaseline, false);
  assert.equal(result.visualChangeDetected, false);
});

// ---- Phase 3: visual-diff noise handling config ----

test('visual-diff noise handling defaults: animations disabled by default, no app-specific ignore-selectors guessed', () => {
  assert.equal(VISUAL_DIFF_CONFIG.disableAnimations, true);
  assert.deepEqual(VISUAL_DIFF_CONFIG.defaultIgnoreSelectors, []);
});

test('per-screen visual ignore-selectors are stored and round-trip, with validation', () => {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO screens (id, name, module_name, source_input_id, url_or_path, last_captured_state_hash, change_status, last_compared_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'new', ?, ?, ?)
  `).run('screen-visual-ignore', 'Visual ignore fixture', 'fixture', 'input-x', null, 'x', now, now, now);

  assert.deepEqual(getVisualIgnoreSelectors('screen-visual-ignore'), []);
  setVisualIgnoreSelectors('screen-visual-ignore', ['.timestamp', '.ad-slot']);
  assert.deepEqual(getVisualIgnoreSelectors('screen-visual-ignore'), ['.timestamp', '.ad-slot']);
  assert.throws(() => setVisualIgnoreSelectors('screen-visual-ignore', 'not-an-array'));

  db.prepare('DELETE FROM screens WHERE id = ?').run('screen-visual-ignore');
});

// ---- Phase 4: DOM check config/CRUD (the actual detection logic runs inside
// a page.evaluate() callback and needs a real browser -- verified live
// against server/src/demo-app/dom-fixture.html, not repeated here) ----

test('DOM_CHECKS_CONFIG has no app-specific selector guesses by default, and per-screen ignore-selectors round-trip', () => {
  assert.deepEqual(DOM_CHECKS_CONFIG.defaultIgnoreSelectors, []);

  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO screens (id, name, module_name, source_input_id, url_or_path, last_captured_state_hash, change_status, last_compared_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'new', ?, ?, ?)
  `).run('screen-dom-ignore', 'DOM ignore fixture', 'fixture', 'input-x', null, 'x', now, now, now);

  assert.deepEqual(getDomCheckIgnoreSelectors('screen-dom-ignore'), []);
  setDomCheckIgnoreSelectors('screen-dom-ignore', ['.badge-wrap']);
  assert.deepEqual(getDomCheckIgnoreSelectors('screen-dom-ignore'), ['.badge-wrap']);
  assert.throws(() => setDomCheckIgnoreSelectors('screen-dom-ignore', 'not-an-array'));

  db.prepare('DELETE FROM screens WHERE id = ?').run('screen-dom-ignore');
});
