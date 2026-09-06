import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '../src/db.ts';
import { recordBugFinding, getBugFinding, listBugFindings, BUG_SCAN_CONFIG } from '../src/services/bugDetectionService.ts';
import {
  inferShape,
  mergeShape,
  diffShape,
  looksLikeErrorBody,
  detectUnexpectedEmpty,
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
  getMaxDuplicateRequests,
  setMaxDuplicateRequests,
} from '../src/services/adminService.ts';
import { compareScreenshotToBaseline, getVisualIgnoreSelectors, setVisualIgnoreSelectors, VISUAL_DIFF_CONFIG } from '../src/services/screensService.ts';
import { getDomCheckIgnoreSelectors, setDomCheckIgnoreSelectors, DOM_CHECKS_CONFIG } from '../src/services/domChecksService.ts';
import { isResponsiveScanEnabled, setResponsiveScanEnabled, RESPONSIVE_VIEWPORTS, getResponsiveViewports, setResponsiveViewports } from '../src/services/responsiveService.ts';

function resetData() {
  db.prepare('DELETE FROM bug_findings').run();
  db.prepare('DELETE FROM api_schemas').run();
  db.prepare('DELETE FROM ui_api_consistency_rules').run();
  db.prepare('DELETE FROM screens').run();
}

function insertScreen(id) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO screens (id, name, module_name, source_input_id, url_or_path, last_captured_state_hash, change_status, last_compared_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'new', ?, ?, ?)
  `).run(id, id, 'fixture', 'input-x', null, 'x', now, now, now);
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

// False-positive fix: a paginated/virtualized list legitimately renders
// fewer elements than the API returned -- 'at-most' mode must not flag that,
// while still catching the UI somehow rendering MORE than the API returned.
test("checkUiApiConsistency 'at-most' mode tolerates the UI rendering fewer items (pagination) but still flags rendering more", async () => {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO screens (id, name, module_name, source_input_id, url_or_path, last_captured_state_hash, change_status, last_compared_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'new', ?, ?, ?)
  `).run('screen-paginated', 'Paginated list', 'fixture', 'input-x', null, 'x', now, now, now);

  const rule = createConsistencyRule({ screenId: 'screen-paginated', name: 'Page 1 rows', domSelector: '.row', apiEndpointKey: 'GET /api/items', comparisonMode: 'at-most' });
  assert.equal(rule.comparison_mode, 'at-most');

  const bodies = new Map([['GET /api/items', { items: [1, 2, 3, 4, 5] }]]); // API has 5 total

  const pageOfThree = { locator: () => ({ count: async () => 3 }) }; // UI shows page 1 of 3 -- legitimate
  const noFalsePositive = await checkUiApiConsistency(pageOfThree, 'screen-paginated', 'Paginated list', bodies);
  assert.equal(noFalsePositive.length, 0);

  const rendersTooMany = { locator: () => ({ count: async () => 7 }) }; // UI somehow renders more than the API has -- a real bug
  const stillCatchesRealBug = await checkUiApiConsistency(rendersTooMany, 'screen-paginated', 'Paginated list', bodies);
  assert.equal(stillCatchesRealBug.length, 1);

  const rules = db.prepare('SELECT id FROM ui_api_consistency_rules WHERE screen_id = ?').all('screen-paginated');
  for (const r of rules) deleteConsistencyRule(r.id);
  db.prepare('DELETE FROM bug_findings WHERE screen_id = ?').run('screen-paginated'); // FK to screens, must go first
  db.prepare('DELETE FROM screens WHERE id = ?').run('screen-paginated');
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

// ---- Phase 5: responsive viewport list is genuinely configurable (not a
// fixed in-code array), with validation. The actual per-viewport scanning
// (correctly tagging findings with viewport, catching a mobile-only bug)
// runs through the real browser -- verified live against
// server/src/demo-app/responsive-fixture.html, not repeated here. ----

test('responsive viewport list defaults to mobile+tablet and is QA-Lead editable, with validation', () => {
  const original = getResponsiveViewports();
  try {
    assert.deepEqual(original, RESPONSIVE_VIEWPORTS);

    setResponsiveViewports([{ name: 'small-mobile', width: 320, height: 568 }]);
    assert.deepEqual(getResponsiveViewports(), [{ name: 'small-mobile', width: 320, height: 568 }]);

    assert.throws(() => setResponsiveViewports([]));
    assert.throws(() => setResponsiveViewports([{ name: 'bad' }]));
    assert.throws(() => setResponsiveViewports('not-an-array'));
  } finally {
    setResponsiveViewports(original);
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

// ---- Phase 1 hardening: malformed-JSON, empty-response, duplicate-requests, unhandled-rejection config ----

test('checkAndRecordApiResponse flags malformed JSON only when the response claims application/json', () => {
  const claimsJson = checkAndRecordApiResponse({
    method: 'GET',
    path: '/api/malformed',
    status: 200,
    body: undefined,
    contentType: 'application/json; charset=utf-8',
    jsonParseFailed: true,
  });
  assert.equal(claimsJson.length, 1);
  assert.equal(claimsJson[0].category, 'api-status');
  assert.match(claimsJson[0].title, /malformed JSON/);

  const notJson = checkAndRecordApiResponse({
    method: 'GET',
    path: '/api/not-json',
    status: 200,
    body: undefined,
    contentType: 'text/plain',
    jsonParseFailed: true,
  });
  assert.equal(notJson.length, 0, 'a non-JSON content-type failing to parse as JSON is expected, not a bug');
});

test('detectUnexpectedEmpty flags an empty array/object only when the baseline has previously seen real data', () => {
  const arrayBaseline = inferShape([{ sku: 'a' }, { sku: 'b' }]);
  assert.equal(detectUnexpectedEmpty(arrayBaseline, []), 'array');
  assert.equal(detectUnexpectedEmpty(arrayBaseline, [{ sku: 'c' }]), null, 'non-empty is fine');

  const emptyArrayBaseline = inferShape([]);
  assert.equal(detectUnexpectedEmpty(emptyArrayBaseline, []), null, 'baseline itself never saw data -- nothing to compare against');

  const objectBaseline = inferShape({ id: 1, total: 42 });
  assert.equal(detectUnexpectedEmpty(objectBaseline, {}), 'object');

  const allOptionalBaseline = { kind: 'object', fields: { promo: { kind: 'primitive', types: ['string'], nullable: false } }, optionalFields: ['promo'] };
  assert.equal(detectUnexpectedEmpty(allOptionalBaseline, {}), null, 'every field is already known-optional -- an empty object is not anomalous');
});

test('checkAndRecordApiResponse flags an empty array against a populated baseline, regardless of schema mode', () => {
  checkAndRecordApiResponse({ method: 'GET', path: '/api/inventory', status: 200, body: [{ sku: 'a' }, { sku: 'b' }] });
  const findings = checkAndRecordApiResponse({ method: 'GET', path: '/api/inventory', status: 200, body: [] });
  const emptyFinding = findings.find((f) => /empty array where data was expected/.test(f.title));
  assert.ok(emptyFinding, 'expected an empty-response-where-data-expected finding');
  assert.equal(emptyFinding.severity, 'medium');
});

test('max_duplicate_requests defaults to 5 and is QA-Lead editable, with validation', () => {
  assert.equal(getMaxDuplicateRequests(), 5);
  setMaxDuplicateRequests(3, undefined);
  assert.equal(getMaxDuplicateRequests(), 3);
  assert.throws(() => setMaxDuplicateRequests(0, undefined));
  assert.throws(() => setMaxDuplicateRequests(1.5, undefined));
  setMaxDuplicateRequests(5, undefined); // restore default for other tests
});

test('BUG_SCAN_CONFIG carries a duplicate-request fallback used only if the live org_settings lookup throws', () => {
  assert.equal(BUG_SCAN_CONFIG.maxDuplicateRequestsFallback, 5);
});

// ---- Phase 1B: fingerprint / correlation / confidence skeleton ----

import { computeFingerprint } from '../src/services/bugFingerprintService.ts';
import { correlateFindings } from '../src/services/bugCorrelationService.ts';
import { scoreConfidence, derivePriority, CONFIDENCE_CONFIG } from '../src/services/bugConfidenceService.ts';

test('computeFingerprint is stable across volatile numbers/urls but differs across screens/categories/messages', () => {
  const a = computeFingerprint({ screenId: 's1', category: 'api-status', title: 't', detail: 'HTTP 500 on https://x.test/api/orders/123' });
  const b = computeFingerprint({ screenId: 's1', category: 'api-status', title: 't', detail: 'HTTP 500 on https://x.test/api/orders/456' });
  assert.equal(a, b, 'only the volatile id differs -- same fingerprint expected');

  const differentScreen = computeFingerprint({ screenId: 's2', category: 'api-status', title: 't', detail: 'HTTP 500 on https://x.test/api/orders/123' });
  assert.notEqual(a, differentScreen);

  const differentCategory = computeFingerprint({ screenId: 's1', category: 'console-error', title: 't', detail: 'HTTP 500 on https://x.test/api/orders/123' });
  assert.notEqual(a, differentCategory);

  const differentMessage = computeFingerprint({ screenId: 's1', category: 'api-status', title: 't', detail: 'a totally different failure entirely' });
  assert.notEqual(a, differentMessage);
});

test('recordBugFinding dedupes a recurring finding across scans by bumping reproducibility instead of inserting a new row', () => {
  insertScreen('screen-dedup');
  const first = recordBugFinding({ source: 'ui_exploratory', category: 'api-status', severity: 'high', title: 'Broken link on X', detail: 'HTTP 500 on https://x.test/a', screenId: 'screen-dedup' });
  assert.equal(first.reproducibility_attempts, 1);
  assert.equal(first.reproducibility_successes, 1);

  const second = recordBugFinding({ source: 'ui_exploratory', category: 'api-status', severity: 'high', title: 'Broken link on X', detail: 'HTTP 500 on https://x.test/a', screenId: 'screen-dedup' });
  assert.equal(second.id, first.id, 'same underlying defect must reuse the same row, not insert a duplicate');
  assert.equal(second.reproducibility_attempts, 2);
  assert.equal(second.reproducibility_successes, 2);

  const rows = listBugFindings({ screenId: 'screen-dedup' });
  assert.equal(rows.length, 1);
});

test('recordBugFinding reopens a resolved finding that recurs, but leaves an ignored finding ignored', () => {
  insertScreen('screen-status');
  insertScreen('screen-status-2');
  const resolved = recordBugFinding({ source: 'ui_exploratory', category: 'ui-dom', severity: 'medium', title: 'Broken image', detail: 'broken.png', screenId: 'screen-status' });
  db.prepare("UPDATE bug_findings SET status = 'resolved' WHERE id = ?").run(resolved.id);
  const recurred = recordBugFinding({ source: 'ui_exploratory', category: 'ui-dom', severity: 'medium', title: 'Broken image', detail: 'broken.png', screenId: 'screen-status' });
  assert.equal(recurred.status, 'open', 'a resolved bug that recurs should reopen');

  const ignored = recordBugFinding({ source: 'ui_exploratory', category: 'ui-dom', severity: 'low', title: 'Spelling issue', detail: 'teh -> the', screenId: 'screen-status-2' });
  db.prepare("UPDATE bug_findings SET status = 'ignored' WHERE id = ?").run(ignored.id);
  const stillIgnored = recordBugFinding({ source: 'ui_exploratory', category: 'ui-dom', severity: 'low', title: 'Spelling issue', detail: 'teh -> the', screenId: 'screen-status-2' });
  assert.equal(stillIgnored.status, 'ignored', 'an explicitly-ignored finding must not resurface as open on a repeat scan');
  assert.equal(stillIgnored.reproducibility_attempts, 2, 'reproducibility still advances even while ignored');
});

test('correlateFindings groups an anchor (api-status) with supporting findings (ui-dom, console-error) when there is exactly one anchor', () => {
  insertScreen('screen-corr-1');
  const anchor = recordBugFinding({ source: 'ui_exploratory', category: 'api-status', severity: 'critical', title: 'Server error', detail: 'HTTP 500 on POST /api/order', screenId: 'screen-corr-1' });
  const spinner = recordBugFinding({ source: 'ui_exploratory', category: 'ui-dom', severity: 'medium', title: 'Stuck spinner', detail: 'spinner stuck', screenId: 'screen-corr-1' });
  const jsError = recordBugFinding({ source: 'ui_exploratory', category: 'console-error', severity: 'high', title: 'JS error', detail: 'TypeError: x is undefined', screenId: 'screen-corr-1' });
  const unrelated = recordBugFinding({ source: 'ui_exploratory', category: 'ui-visual', severity: 'low', title: 'Visual diff', detail: '2% pixels differ', screenId: 'screen-corr-1' });

  correlateFindings([anchor, spinner, jsError, unrelated]);

  const reloadedAnchor = getBugFinding(anchor.id);
  const reloadedSpinner = getBugFinding(spinner.id);
  const reloadedJsError = getBugFinding(jsError.id);
  const reloadedUnrelated = getBugFinding(unrelated.id);

  assert.ok(reloadedAnchor.correlation_group_id, 'anchor should be grouped');
  assert.equal(reloadedSpinner.correlation_group_id, reloadedAnchor.correlation_group_id);
  assert.equal(reloadedJsError.correlation_group_id, reloadedAnchor.correlation_group_id);
  assert.equal(reloadedUnrelated.correlation_group_id, null, 'ui-visual is not a supporting category and must stay ungrouped here');
});

test('correlateFindings stays silent (no grouping) when there are two or more competing anchors, per its documented false-positive guard', () => {
  insertScreen('screen-corr-2');
  const anchor1 = recordBugFinding({ source: 'ui_exploratory', category: 'api-status', severity: 'high', title: 'Server error A', detail: 'HTTP 500 on POST /api/a', screenId: 'screen-corr-2' });
  const anchor2 = recordBugFinding({ source: 'ui_exploratory', category: 'api-status', severity: 'high', title: 'Server error B', detail: 'HTTP 500 on POST /api/b', screenId: 'screen-corr-2' });
  const spinner = recordBugFinding({ source: 'ui_exploratory', category: 'ui-dom', severity: 'medium', title: 'Stuck spinner', detail: 'spinner stuck', screenId: 'screen-corr-2' });

  correlateFindings([anchor1, anchor2, spinner]);

  assert.equal(getBugFinding(anchor1.id).correlation_group_id, null);
  assert.equal(getBugFinding(anchor2.id).correlation_group_id, null);
  assert.equal(getBugFinding(spinner.id).correlation_group_id, null, 'ambiguous which anchor this belongs to -- must not guess');
});

test('correlateFindings groups two findings that independently name the same endpoint key, regardless of anchor count', () => {
  insertScreen('screen-corr-3');
  const schemaFinding = recordBugFinding({ source: 'api_fuzz', category: 'api-schema', severity: 'high', title: 'Schema drift', detail: 'field changed', screenId: 'screen-corr-3', evidence: { endpointKey: 'GET /api/orders' } });
  const mismatchFinding = recordBugFinding({ source: 'ui_exploratory', category: 'ui-api-mismatch', severity: 'medium', title: 'Count mismatch', detail: 'count differs', screenId: 'screen-corr-3', evidence: { rule: { endpointKey: 'GET /api/orders' } } });

  correlateFindings([schemaFinding, mismatchFinding]);

  const a = getBugFinding(schemaFinding.id);
  const b = getBugFinding(mismatchFinding.id);
  assert.ok(a.correlation_group_id);
  assert.equal(a.correlation_group_id, b.correlation_group_id);
});

test('scoreConfidence weights category/reproducibility/correlation deterministically and stays within [min, max]', () => {
  const base = scoreConfidence({ category: 'ui-dom', severity: 'medium', evidence: '{}', reproducibility_attempts: 1, reproducibility_successes: 1 });
  const reproduced = scoreConfidence({ category: 'ui-dom', severity: 'medium', evidence: '{}', reproducibility_attempts: 3, reproducibility_successes: 3 });
  assert.ok(reproduced > base, 'reproducing the same finding again must raise confidence');

  const correlated = scoreConfidence({ category: 'ui-dom', severity: 'medium', evidence: '{}', reproducibility_attempts: 1, reproducibility_successes: 1 }, { isCorrelated: true });
  assert.ok(correlated > base, 'corroboration by another signal in the same scan must raise confidence');

  const schemaScore = scoreConfidence({ category: 'api-schema', severity: 'high', evidence: '{}', reproducibility_attempts: 1, reproducibility_successes: 1 });
  const visualScore = scoreConfidence({ category: 'ui-visual', severity: 'high', evidence: '{}', reproducibility_attempts: 1, reproducibility_successes: 1 });
  assert.ok(schemaScore > visualScore, 'a structural schema diff is a stronger signal than a bare pixel-diff');

  const smallVisualDiff = scoreConfidence({ category: 'ui-visual', severity: 'medium', evidence: JSON.stringify({ diffPercentage: 1.5, thresholdPercent: 1.0 }), reproducibility_attempts: 1, reproducibility_successes: 1 });
  const bigVisualDiff = scoreConfidence({ category: 'ui-visual', severity: 'medium', evidence: JSON.stringify({ diffPercentage: 40, thresholdPercent: 1.0 }), reproducibility_attempts: 1, reproducibility_successes: 1 });
  assert.ok(bigVisualDiff > smallVisualDiff, 'a diff far above threshold is less likely to be animation/timestamp noise than one barely over it');

  for (const score of [base, reproduced, correlated, schemaScore, visualScore, smallVisualDiff, bigVisualDiff]) {
    assert.ok(score >= CONFIDENCE_CONFIG.min && score <= CONFIDENCE_CONFIG.max);
  }
});

test('derivePriority never assigns P0/P1/P2 to a low-severity finding regardless of confidence, and requires high confidence for P0', () => {
  assert.equal(derivePriority('low', 0.95), 'P3');
  assert.equal(derivePriority('critical', 0.95), 'P0');
  assert.equal(derivePriority('critical', 0.3), 'P1');
  assert.equal(derivePriority('high', 0.95), 'P1');
  assert.equal(derivePriority('medium', 0.95), 'P2');
});

// ---- Phase 2: accessibility config/CRUD (the actual axe-core call needs a
// real browser -- verified live against server/src/demo-app/accessibility-fixture.html,
// not repeated here, same pattern as the Phase 4 DOM-checks note above) ----

import { getAccessibilityIgnoreRules, setAccessibilityIgnoreRules, ACCESSIBILITY_CONFIG } from '../src/services/accessibilityService.ts';
import { getAccessibilityEnabled, setAccessibilityEnabled, getAccessibilityWcagLevel, setAccessibilityWcagLevel } from '../src/services/adminService.ts';

test('accessibility_enabled defaults to true (unlike other ignore-lists) and is QA-Lead editable', () => {
  assert.equal(getAccessibilityEnabled(), true);
  setAccessibilityEnabled(false, undefined);
  assert.equal(getAccessibilityEnabled(), false);
  setAccessibilityEnabled(true, undefined); // restore default for other tests
});

test('accessibility_wcag_level defaults to AA and validates its allowed values', () => {
  assert.equal(getAccessibilityWcagLevel(), 'AA');
  setAccessibilityWcagLevel('AAA', undefined);
  assert.equal(getAccessibilityWcagLevel(), 'AAA');
  assert.throws(() => setAccessibilityWcagLevel('Z', undefined));
  setAccessibilityWcagLevel('AA', undefined); // restore default for other tests
});

test('ACCESSIBILITY_CONFIG maps every axe impact level to a platform severity and caps findings per scan', () => {
  assert.deepEqual(ACCESSIBILITY_CONFIG.impactSeverity, { critical: 'critical', serious: 'high', moderate: 'medium', minor: 'low' });
  assert.ok(ACCESSIBILITY_CONFIG.maxIssuesPerScan > 0);
  assert.deepEqual(ACCESSIBILITY_CONFIG.wcagTags.AA, ['wcag2a', 'wcag21a', 'wcag2aa', 'wcag21aa']);
});

test('per-screen accessibility ignore-rules round-trip, with validation', () => {
  insertScreen('screen-a11y-ignore');
  assert.deepEqual(getAccessibilityIgnoreRules('screen-a11y-ignore'), []);
  setAccessibilityIgnoreRules('screen-a11y-ignore', ['color-contrast']);
  assert.deepEqual(getAccessibilityIgnoreRules('screen-a11y-ignore'), ['color-contrast']);
  assert.throws(() => setAccessibilityIgnoreRules('screen-a11y-ignore', 'not-an-array'));
});

// ---- Phase 3a: field-type-aware mutation (fieldTypeInferenceService) ----

import { classifyFieldMutationStrategy, generateMutationValues, representativeInvalidValue, generateFieldCombinationMatrix, FIELD_COMBINATION_CONFIG } from '../src/services/fieldTypeInferenceService.ts';

test('classifyFieldMutationStrategy maps known input types and treats checkboxes/dropdowns/file as unmutable', () => {
  assert.equal(classifyFieldMutationStrategy({ type: 'input', inputType: 'email' }), 'email');
  assert.equal(classifyFieldMutationStrategy({ type: 'input', inputType: 'number' }), 'number');
  assert.equal(classifyFieldMutationStrategy({ type: 'input', inputType: 'tel' }), 'tel');
  assert.equal(classifyFieldMutationStrategy({ type: 'input', inputType: 'url' }), 'url');
  assert.equal(classifyFieldMutationStrategy({ type: 'input', inputType: 'date' }), 'date');
  assert.equal(classifyFieldMutationStrategy({ type: 'input', inputType: 'password' }), 'password');
  assert.equal(classifyFieldMutationStrategy({ type: 'textarea' }), 'text');
  assert.equal(classifyFieldMutationStrategy({ type: 'checkbox' }), 'unmutable');
  assert.equal(classifyFieldMutationStrategy({ type: 'dropdown' }), 'unmutable');
  assert.equal(classifyFieldMutationStrategy({ type: 'input', inputType: 'file' }), 'unmutable');
});

test('generateMutationValues returns a concrete, non-empty deterministic value set per mutable strategy, and none for unmutable fields', () => {
  const emailValues = generateMutationValues({ type: 'input', inputType: 'email' });
  assert.ok(emailValues.length > 0);
  assert.ok(emailValues.every((v) => typeof v.value === 'string' && typeof v.label === 'string'));
  assert.ok(emailValues.some((v) => v.label === 'invalid format'));

  assert.deepEqual(generateMutationValues({ type: 'checkbox' }), []);
});

test('representativeInvalidValue returns a concrete literal value, not a description', () => {
  const value = representativeInvalidValue({ type: 'input', inputType: 'email' });
  assert.equal(value, 'not-an-email');
  assert.ok(!/isn't a valid|invalid value that/i.test(value));
});

test('generateFieldCombinationMatrix requires at least 2 mutable fields and is capped', () => {
  const single = generateFieldCombinationMatrix([{ type: 'input', label: 'Email', inputType: 'email', locators: [], component: 'x' }]);
  assert.deepEqual(single, []);

  const manyFields = Array.from({ length: 6 }, (_, i) => ({ type: 'input', label: `Field ${i}`, inputType: 'text', locators: [], component: 'x' }));
  const combos = generateFieldCombinationMatrix(manyFields);
  assert.ok(combos.length <= FIELD_COMBINATION_CONFIG.maxCombinations);
  assert.ok(combos.length > 0);
  for (const c of combos) {
    assert.equal(c.states.length, 2);
    assert.ok(c.states.some((s) => s.state === 'invalid'));
    assert.ok(c.states.some((s) => s.state === 'empty'));
  }
});

// ---- Phase 3b: state-transition testing config/CRUD (runFlow's actual
// execution needs a real browser -- verified live against
// server/src/demo-app/state-transition-fixture.html, not repeated here,
// same pattern as the Phase 2/4 browser-dependent checks above) ----

import { defineFlow, getFlow, listFlows, deleteFlow, buildCreateEditDeleteRefreshTemplate, buildDuplicateSubmitTemplate, buildRapidClickTemplate, buildBackForwardAfterMutationTemplate, buildSessionExpiryMidFlowTemplate } from '../src/services/stateTransitionService.ts';

test('defineFlow validates step/invariant shape and persists, getFlow/listFlows/deleteFlow round-trip', () => {
  insertScreen('screen-flow-1');
  assert.throws(() => defineFlow({ name: 'no steps', steps: [], invariants: [] }));
  assert.throws(() =>
    defineFlow({ name: 'no invariants', steps: [{ action: 'navigate', url: 'http://x' }], invariants: [] })
  );
  assert.throws(() =>
    defineFlow({
      name: 'bad afterStep',
      steps: [{ action: 'navigate', url: 'http://x' }],
      invariants: [{ afterStep: 5, type: 'visible', selector: '.x', message: 'm' }],
    })
  );

  const flow = defineFlow({
    name: 'Delete then verify gone',
    screenId: 'screen-flow-1',
    steps: [
      { action: 'navigate', url: 'http://localhost/x' },
      { action: 'click', selector: '#delete' },
      { action: 'refresh' },
    ],
    invariants: [{ afterStep: 2, type: 'not_visible', selector: '.record', message: 'still visible' }],
  });
  assert.ok(flow.id);

  const reloaded = getFlow(flow.id);
  assert.equal(reloaded.name, 'Delete then verify gone');
  assert.equal(JSON.parse(reloaded.steps_json).length, 3);

  const listed = listFlows('screen-flow-1');
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, flow.id);

  deleteFlow(flow.id);
  assert.equal(getFlow(flow.id), undefined);
});

test('named template builders produce a valid {steps, invariants} pair matching each master-prompt worked pattern', () => {
  const t1 = buildCreateEditDeleteRefreshTemplate({
    url: 'http://x', createSelector: '#new', fillSelector: '#name', value: 'Test', saveSelector: '#save',
    recordSelector: 'text=Test', deleteSelector: '#delete',
  });
  assert.ok(t1.steps.some((s) => s.action === 'refresh'));
  assert.equal(t1.invariants[0].type, 'not_visible');

  const t2 = buildDuplicateSubmitTemplate({ url: 'http://x', fillSelector: '#name', value: 'Test', saveSelector: '#save', recordSelector: '.record' });
  assert.equal(t2.steps.filter((s) => s.action === 'click').length, 2, 'duplicate-submit clicks save twice');
  assert.equal(t2.invariants[0].type, 'count_equals');
  assert.equal(t2.invariants[0].count, 1);

  const t3 = buildRapidClickTemplate({ url: 'http://x', clickSelector: '#like', counterSelector: '.count', expectedText: '1', clicks: 5 });
  assert.equal(t3.steps.filter((s) => s.action === 'click').length, 5);
  assert.equal(t3.invariants[0].type, 'text_equals');

  const t4 = buildBackForwardAfterMutationTemplate({ url: 'http://x', deleteSelector: '#delete', recordSelector: '.record' });
  assert.deepEqual(t4.steps.map((s) => s.action), ['navigate', 'click', 'back', 'forward']);
  assert.equal(t4.invariants[0].type, 'not_visible');

  const t5 = buildSessionExpiryMidFlowTemplate({ url: 'http://x', triggerSelector: '#action', loginIndicatorSelector: '#login-form' });
  assert.ok(t5.steps.some((s) => s.action === 'clear_cookies'));
  assert.equal(t5.invariants[0].type, 'visible');
});

// ---- Phase 4b: performance thresholds config ----

import { getSlowApiThresholdMs, setSlowApiThresholdMs, getSlowPageThresholdMs, setSlowPageThresholdMs, getMaxRequestsPerPage, setMaxRequestsPerPage } from '../src/services/adminService.ts';

test('performance thresholds default sensibly and are QA-Lead editable, with validation', () => {
  assert.equal(getSlowApiThresholdMs(), 3000);
  assert.equal(getSlowPageThresholdMs(), 5000);
  assert.equal(getMaxRequestsPerPage(), 100);

  setSlowApiThresholdMs(1500, undefined);
  assert.equal(getSlowApiThresholdMs(), 1500);
  setSlowPageThresholdMs(9000, undefined);
  assert.equal(getSlowPageThresholdMs(), 9000);
  setMaxRequestsPerPage(50, undefined);
  assert.equal(getMaxRequestsPerPage(), 50);

  assert.throws(() => setSlowApiThresholdMs(0, undefined));
  assert.throws(() => setSlowApiThresholdMs(-1, undefined));
  assert.throws(() => setMaxRequestsPerPage(1.5, undefined));

  // restore defaults for other tests
  setSlowApiThresholdMs(3000, undefined);
  setSlowPageThresholdMs(5000, undefined);
  setMaxRequestsPerPage(100, undefined);
});

// ---- Phase 4a: authz testing enforcement (the actual probe needs a real
// browser-adjacent fetch against a real target -- verified live via a
// scratch script against a demo fixture; the enforcement gate itself is
// pure logic and is fully covered here) ----

import { getAuthzTestingEnabled, setAuthzTestingEnabled } from '../src/services/adminService.ts';
import { createEnvironment, setSecondaryCredentials, hasSecondaryCredentials, deleteEnvironment } from '../src/services/environmentsService.ts';
import { runIdorProbe, runVerticalEscalationProbe, isAuthzTestingConfigured, AuthzTestingNotAuthorizedError } from '../src/services/authzTestingService.ts';

test('authz_testing_enabled defaults to false (opt-in only)', () => {
  assert.equal(getAuthzTestingEnabled(), false);
});

test('authz probes refuse to run unless BOTH the org toggle and the environment secondary identity are configured', async () => {
  const env = createEnvironment({ name: 'Authz Test Env', target_url: 'http://localhost:1' });
  try {
    assert.equal(hasSecondaryCredentials(env.id), false);
    assert.deepEqual(isAuthzTestingConfigured(env.id), { orgEnabled: false, environmentConfigured: false, allowed: false });

    await assert.rejects(() => runIdorProbe(env.id, ['http://localhost:1/x']), AuthzTestingNotAuthorizedError);
    await assert.rejects(() => runVerticalEscalationProbe(env.id, ['http://localhost:1/x']), AuthzTestingNotAuthorizedError);

    setAuthzTestingEnabled(true, undefined);
    await assert.rejects(() => runIdorProbe(env.id, ['http://localhost:1/x']), AuthzTestingNotAuthorizedError, 'org on but environment not configured must still refuse');

    setAuthzTestingEnabled(false, undefined);
    setSecondaryCredentials(env.id, 'secondary', 'pass');
    await assert.rejects(() => runIdorProbe(env.id, ['http://localhost:1/x']), AuthzTestingNotAuthorizedError, 'environment configured but org off must still refuse');

    setAuthzTestingEnabled(true, undefined);
    assert.deepEqual(isAuthzTestingConfigured(env.id), { orgEnabled: true, environmentConfigured: true, allowed: true });
  } finally {
    setAuthzTestingEnabled(false, undefined);
    deleteEnvironment(env.id);
  }
});

test('authz probes never issue anything but a GET (no code path accepts a mutating method)', () => {
  const source = readFileSync(join(process.cwd(), 'src/services/authzTestingService.ts'), 'utf8');
  const fetchCalls = source.match(/fetch\([^)]*\)/gs) || [];
  assert.ok(fetchCalls.length > 0);
  for (const call of fetchCalls) {
    assert.match(call, /method:\s*"GET"/, `every fetch call in authzTestingService.ts must hardcode GET: ${call}`);
  }
});

// ---- Phase 4c: exploratory agent config (the actual session run needs a
// real browser -- verified live against a 3-page demo-app fixture, not
// repeated here) ----

import { getExplorationDefaultMaxActions, setExplorationDefaultMaxActions, getExplorationDefaultMaxDepth, setExplorationDefaultMaxDepth } from '../src/services/adminService.ts';
import { listExplorationSessions, getExplorationSession, stopExplorationSession, EXPLORATION_CONFIG } from '../src/services/exploratoryAgentService.ts';

test('exploration defaults are conservative (20 actions, depth 3) and QA-Lead editable', () => {
  assert.equal(getExplorationDefaultMaxActions(), 20);
  assert.equal(getExplorationDefaultMaxDepth(), 3);
  setExplorationDefaultMaxActions(5, undefined);
  assert.equal(getExplorationDefaultMaxActions(), 5);
  setExplorationDefaultMaxDepth(2, undefined);
  assert.equal(getExplorationDefaultMaxDepth(), 2);
  assert.throws(() => setExplorationDefaultMaxActions(0, undefined));
  setExplorationDefaultMaxActions(20, undefined); // restore defaults
  setExplorationDefaultMaxDepth(3, undefined);
});

test('getExplorationSession/listExplorationSessions/stopExplorationSession handle a missing session without throwing', () => {
  assert.equal(getExplorationSession('does-not-exist'), undefined);
  assert.equal(stopExplorationSession('does-not-exist'), undefined);
  assert.ok(Array.isArray(listExplorationSessions()));
  assert.ok(EXPLORATION_CONFIG.maxCandidateActionsPerStep > 0);
});

// ---- Phase 5: bug reporting service (formatBugReport/dashboard are pure
// logic over already-recorded findings; reverifyHighConfidenceFinding's
// actual rescan needs a real browser -- verified live above, not repeated here) ----

import { formatBugReport, getBugDashboard, getBugGroup, inferAndPersistRootCause, BUG_REPORTING_CONFIG } from '../src/services/bugReportingService.ts';
import { recordReproductionAttempt } from '../src/services/bugDetectionService.ts';

test('formatBugReport produces every required master-prompt #24 section, and labels an inferred root cause explicitly', () => {
  insertScreen('screen-report-1');
  const anchor = recordBugFinding({ source: 'ui_exploratory', category: 'api-status', severity: 'critical', title: 'Server error', detail: 'HTTP 500 on POST /api/order', screenId: 'screen-report-1', evidence: { url: 'http://x/checkout' }, stepsToReproduce: ['Navigate to checkout', 'Submit order', 'Observe: HTTP 500'] });
  const spinner = recordBugFinding({ source: 'ui_exploratory', category: 'ui-dom', severity: 'medium', title: 'Stuck spinner', detail: 'spinner stuck', screenId: 'screen-report-1' });
  correlateFindings([anchor, spinner]);

  const report = formatBugReport(anchor.id);
  for (const section of ['# Bug Report:', '**Severity:**', '**Priority:**', '**Confidence:**', '**Category:**', '**URL:**', '**Status:**', '## Steps to Reproduce', '## Expected Result', '## Actual Result', '## Evidence', '## Probable Root Cause']) {
    assert.ok(report.includes(section), `report missing section: ${section}`);
  }
  assert.ok(report.includes('http://x/checkout'));
  assert.ok(report.includes('AI Inference'), 'a correlated group\'s root cause must be explicitly labeled as inferred, never presented as fact');

  assert.throws(() => formatBugReport('does-not-exist'));
});

test('formatBugReport on a standalone (uncorrelated) finding reports "not yet analyzed" rather than fabricating a root cause', () => {
  insertScreen('screen-report-2');
  const standalone = recordBugFinding({ source: 'ui_exploratory', category: 'ui-visual', severity: 'low', title: 'Minor visual diff', detail: '0.6% pixels differ', screenId: 'screen-report-2' });
  const report = formatBugReport(standalone.id);
  assert.ok(report.includes('Not yet analyzed'));
  assert.ok(!report.includes('AI Inference'));
});

test('inferAndPersistRootCause ranks a stronger-signal category as the root cause and persists the narrative to every finding in the group', () => {
  insertScreen('screen-report-3');
  const schemaFinding = recordBugFinding({ source: 'api_fuzz', category: 'api-schema', severity: 'high', title: 'Schema drift', detail: 'field type changed', screenId: 'screen-report-3' });
  const consoleFinding = recordBugFinding({ source: 'ui_exploratory', category: 'console-error', severity: 'high', title: 'JS error', detail: 'TypeError', screenId: 'screen-report-3' });
  correlateFindings([schemaFinding, consoleFinding]);
  const groupId = getBugFinding(schemaFinding.id).correlation_group_id;

  const narrative = inferAndPersistRootCause(groupId);
  assert.match(narrative, /"Schema drift".*most likely root cause/);
  assert.equal(getBugFinding(schemaFinding.id).root_cause_is_inferred, 1);
  assert.equal(getBugFinding(consoleFinding.id).root_cause_narrative, narrative);

  assert.equal(inferAndPersistRootCause('no-such-group'), null);
});

test('getBugDashboard rolls up category/priority/severity counts, new-vs-recurring, and correlation stats correctly', () => {
  insertScreen('screen-dash-1');
  const f1 = recordBugFinding({ source: 'ui_exploratory', category: 'ui-dom', severity: 'medium', title: 'Bug A', detail: 'detail A', screenId: 'screen-dash-1' });
  recordBugFinding({ source: 'ui_exploratory', category: 'console-error', severity: 'high', title: 'Bug B', detail: 'detail B', screenId: 'screen-dash-1' });
  recordReproductionAttempt(f1.id, true); // simulate a recurring (reproduced-again) finding

  const dashboard = getBugDashboard();
  assert.equal(dashboard.totalFindings, 2);
  assert.equal(dashboard.byCategory['ui-dom'], 1);
  assert.equal(dashboard.byCategory['console-error'], 1);
  assert.equal(dashboard.newCount, 1, 'Bug B was never reproduced again -- still "new"');
  assert.equal(dashboard.recurringCount, 1, 'Bug A was reproduced a second time -- "recurring"');
  assert.ok(dashboard.topFailingPages.some((p) => p.screenId === 'screen-dash-1' && p.count === 2));
  assert.ok(typeof dashboard.averageConfidence === 'number');
});

test('getBugGroup throws for an unknown correlation group id', () => {
  assert.throws(() => getBugGroup('does-not-exist'));
});

test('recordReproductionAttempt bumps attempts always, but successes only when reproduced=true, and never double-inserts a row', () => {
  insertScreen('screen-repro-1');
  const f = recordBugFinding({ source: 'ui_exploratory', category: 'ui-dom', severity: 'medium', title: 'Flaky-looking bug', detail: 'detail', screenId: 'screen-repro-1' });
  assert.equal(f.reproducibility_attempts, 1);
  assert.equal(f.reproducibility_successes, 1);

  const notReproduced = recordReproductionAttempt(f.id, false);
  assert.equal(notReproduced.id, f.id);
  assert.equal(notReproduced.reproducibility_attempts, 2);
  assert.equal(notReproduced.reproducibility_successes, 1, 'a failed reproduction attempt must not bump successes');

  const reproduced = recordReproductionAttempt(f.id, true);
  assert.equal(reproduced.reproducibility_attempts, 3);
  assert.equal(reproduced.reproducibility_successes, 2);

  assert.throws(() => recordReproductionAttempt('does-not-exist', true));
});

test('BUG_REPORTING_CONFIG has a sensible re-verification confidence bar', () => {
  assert.ok(BUG_REPORTING_CONFIG.reverifyConfidenceThreshold > 0 && BUG_REPORTING_CONFIG.reverifyConfidenceThreshold < 1);
});

// ---- Master-prompt §5: OpenAPI/Swagger contract intelligence (parsing/
// matching/caching are pure logic; live discovery+diff against a real
// endpoint is verified live above against openapi-contract-fixture.html,
// not repeated here) ----

import { parseOpenApiContractSchemas, checkAgainstOpenApiContract, getOpenApiSpecForOrigin, deleteOpenApiSpec, OPENAPI_CONTRACT_CONFIG } from '../src/services/openApiContractService.ts';

function resetOpenApiSpecs() {
  db.prepare('DELETE FROM openapi_specs').run();
}

test.beforeEach(() => {
  resetOpenApiSpecs();
});

test('parseOpenApiContractSchemas converts an OpenAPI 3.x object/array/primitive schema, honoring required vs optional fields', () => {
  const spec = JSON.stringify({
    openapi: '3.0.0',
    info: { title: 'Test API', version: '2.0' },
    paths: {
      '/users/{id}': {
        get: {
          responses: {
            '200': {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      id: { type: 'number' },
                      name: { type: 'string' },
                      tags: { type: 'array', items: { type: 'string' } },
                      nickname: { type: 'string', nullable: true },
                    },
                    required: ['id', 'name'],
                  },
                },
              },
            },
          },
        },
      },
    },
  });
  const { title, version, schemas } = parseOpenApiContractSchemas(spec);
  assert.equal(title, 'Test API');
  assert.equal(version, '2.0');
  const shape = schemas['GET /users/{id}'];
  assert.ok(shape);
  assert.equal(shape.kind, 'object');
  assert.deepEqual(new Set(shape.optionalFields), new Set(['tags', 'nickname']));
  assert.equal(shape.fields.tags.kind, 'array');
  assert.equal(shape.fields.tags.item.kind, 'primitive');
  assert.equal(shape.fields.nickname.nullable, true);
});

test('parseOpenApiContractSchemas resolves a $ref to components.schemas and a Swagger 2.0 top-level response.schema', () => {
  const oas3 = JSON.stringify({
    openapi: '3.0.0',
    info: { title: 'Ref API', version: '1.0' },
    components: { schemas: { Order: { type: 'object', properties: { total: { type: 'number' } }, required: ['total'] } } },
    paths: { '/orders': { get: { responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } } } } } } },
  });
  const { schemas: oas3Schemas } = parseOpenApiContractSchemas(oas3);
  assert.equal(oas3Schemas['GET /orders'].fields.total.kind, 'primitive');

  const swagger2 = JSON.stringify({
    swagger: '2.0',
    info: { title: 'Swagger API', version: '1.0' },
    definitions: { Order: { type: 'object', properties: { total: { type: 'number' } }, required: ['total'] } },
    paths: { '/orders': { get: { responses: { '200': { schema: { $ref: '#/definitions/Order' } } } } } },
  });
  const { schemas: swagger2Schemas } = parseOpenApiContractSchemas(swagger2);
  assert.equal(swagger2Schemas['GET /orders'].fields.total.kind, 'primitive');
});

test('parseOpenApiContractSchemas throws on a document with no paths, and skips operations with an unmodelable schema rather than guessing', () => {
  assert.throws(() => parseOpenApiContractSchemas(JSON.stringify({ info: {} })));

  const oneOfSpec = JSON.stringify({
    openapi: '3.0.0',
    info: { title: 'x', version: '1' },
    paths: { '/x': { get: { responses: { '200': { content: { 'application/json': { schema: { oneOf: [{ type: 'object' }, { type: 'array' }] } } } } } } } },
  });
  const { schemas } = parseOpenApiContractSchemas(oneOfSpec);
  assert.equal(schemas['GET /x'], undefined, 'oneOf is not modeled -- must be skipped, not guessed at');
});

test('checkAgainstOpenApiContract matches a path TEMPLATE against a concrete request path and flags a real violation, tagged contractSource: openapi', () => {
  db.prepare(
    "INSERT INTO openapi_specs (id, base_url, found, spec_url, title, version, schemas_json, discovered_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)"
  ).run(
    'spec-1',
    'http://localhost:9999',
    'http://localhost:9999/openapi.json',
    'Test',
    '1.0',
    JSON.stringify({ 'GET /orders/{id}': { kind: 'object', fields: { id: { kind: 'primitive', types: ['number'], nullable: false }, total: { kind: 'primitive', types: ['number'], nullable: false } }, optionalFields: [] } }),
    new Date().toISOString(),
    new Date().toISOString()
  );

  const findings = checkAgainstOpenApiContract({ baseUrl: 'http://localhost:9999', method: 'GET', path: '/orders/42', body: { id: 42 } });
  assert.equal(findings.length, 1, 'missing "total" must be flagged');
  const evidence = JSON.parse(findings[0].evidence);
  assert.equal(evidence.contractSource, 'openapi');
  assert.equal(findings[0].category, 'api-schema');

  // No spec cached for this origin at all -- must return no findings, not throw.
  assert.deepEqual(checkAgainstOpenApiContract({ baseUrl: 'http://unknown-origin.test', method: 'GET', path: '/x', body: {} }), []);

  // A path with no matching template in the spec -- no findings.
  assert.deepEqual(checkAgainstOpenApiContract({ baseUrl: 'http://localhost:9999', method: 'GET', path: '/nonexistent', body: {} }), []);
});

test('getOpenApiSpecForOrigin/deleteOpenApiSpec round-trip by origin, ignoring path/query differences in the probed baseUrl', () => {
  db.prepare(
    "INSERT INTO openapi_specs (id, base_url, found, spec_url, title, version, schemas_json, discovered_at, updated_at) VALUES (?, ?, 0, NULL, NULL, NULL, '{}', ?, ?)"
  ).run('spec-2', 'http://example.test', new Date().toISOString(), new Date().toISOString());

  const found = getOpenApiSpecForOrigin('http://example.test/some/deep/page?x=1');
  assert.ok(found, 'lookup must normalize to origin, ignoring path/query');
  assert.equal(found.base_url, 'http://example.test');

  deleteOpenApiSpec('http://example.test/another/page');
  assert.equal(getOpenApiSpecForOrigin('http://example.test'), undefined);
});

test('OPENAPI_CONTRACT_CONFIG has a non-empty well-known path list and sane bounds', () => {
  assert.ok(OPENAPI_CONTRACT_CONFIG.wellKnownSpecPaths.length > 0);
  assert.ok(OPENAPI_CONTRACT_CONFIG.maxDiffIssuesPerResponse > 0);
  assert.ok(OPENAPI_CONTRACT_CONFIG.maxRefDepth > 0);
});

// ---- Master-prompt §7: optional AI visual-diff reasoning (the real
// anthropic vision call is not exercised here -- verified live above with
// the mock provider's deterministic stand-in against a real visual
// regression; this covers config/gating/confidence-scoring, which is pure logic) ----

import { getVisualAiReasoningEnabled, setVisualAiReasoningEnabled } from '../src/services/adminService.ts';
import { llm } from '../src/llm/index.ts';

test('visual_ai_reasoning_enabled defaults to false (opt-in, costs a real LLM call per visual finding)', () => {
  assert.equal(getVisualAiReasoningEnabled(), false);
  setVisualAiReasoningEnabled(true, undefined);
  assert.equal(getVisualAiReasoningEnabled(), true);
  setVisualAiReasoningEnabled(false, undefined); // restore default
});

test('mock provider analyzeVisualDiff is a deterministic stand-in over diffPercentage/threshold ratio, not real vision', async () => {
  const farAbove = await llm.analyzeVisualDiff({ beforeImageBase64: 'x', afterImageBase64: 'y', diffPercentage: 30, thresholdPercent: 1 });
  assert.equal(farAbove.isLikelyRealRegression, true);

  const nearThreshold = await llm.analyzeVisualDiff({ beforeImageBase64: 'x', afterImageBase64: 'y', diffPercentage: 1.2, thresholdPercent: 1 });
  assert.equal(nearThreshold.isLikelyRealRegression, false);

  assert.ok(typeof farAbove.reasoning === 'string' && farAbove.reasoning.length > 0);
});

test('scoreConfidence shifts for a ui-visual finding based on the optional AI annotation, on top of (not instead of) the existing diff-margin penalty', () => {
  const base = { category: 'ui-visual', severity: 'medium', reproducibility_attempts: 1, reproducibility_successes: 1 };
  const noAnnotation = scoreConfidence({ ...base, evidence: JSON.stringify({ diffPercentage: 1.5, thresholdPercent: 1.0 }) });
  const aiConfirmed = scoreConfidence({ ...base, evidence: JSON.stringify({ diffPercentage: 1.5, thresholdPercent: 1.0, aiVisualReasoning: { isLikelyRealRegression: true } }) });
  const aiNoise = scoreConfidence({ ...base, evidence: JSON.stringify({ diffPercentage: 1.5, thresholdPercent: 1.0, aiVisualReasoning: { isLikelyRealRegression: false } }) });

  assert.ok(aiConfirmed > noAnnotation, 'an AI-confirmed regression must raise confidence above the un-annotated baseline');
  assert.ok(aiNoise < noAnnotation, 'an AI-flagged-as-noise diff must lower confidence below the un-annotated baseline');
  for (const score of [noAnnotation, aiConfirmed, aiNoise]) {
    assert.ok(score >= CONFIDENCE_CONFIG.min && score <= CONFIDENCE_CONFIG.max);
  }
});

test('withLlmGateway never cache-hits for visual_diff_reasoning, even on an identical prompt -- a text-only cache key could otherwise return a real-image classification for a different pair of screenshots', async () => {
  const { withLlmGateway } = await import('../src/services/llmGatewayService.ts');
  let runCalls = 0;
  const run = async () => {
    runCalls++;
    return { result: { isLikelyRealRegression: true, reasoning: 'x' }, outputText: 'x' };
  };
  await withLlmGateway('visual_diff_reasoning', { provider: 'mock', prompt: 'diffPercentage=5 thresholdPercent=1' }, run);
  await withLlmGateway('visual_diff_reasoning', { provider: 'mock', prompt: 'diffPercentage=5 thresholdPercent=1' }, run);
  assert.equal(runCalls, 2, 'the second identical call must NOT be served from cache');
});

// ---- Playbook §L: Network / Failure Injection (config + named-template
// builders -- pure logic; runNetworkFailureScenario() itself launches a real
// browser and page.route() interception, and was live-verified separately
// against server/src/demo-app/network-failure-fixture.html: an infinite-
// spinner button under a "timeout" injection produced a high-severity
// infinite-spinner finding, a false-success button under "http_error"
// produced a critical false-success finding, a silent-failure button under
// both "http_error" and "malformed_json" produced medium silent-failure
// findings, and a well-behaved button produced ZERO findings under
// "http_error" and "offline" -- confirming no false positive on correct
// error handling.) ----

import { NETWORK_FAILURE_CONFIG, buildOfflineDuringSubmitScenario, buildTimeoutDuringSubmitScenario, buildHttpErrorDuringSubmitScenario } from '../src/services/networkFailureInjectionService.ts';

test('NETWORK_FAILURE_CONFIG has sane defaults for the grace period and indicator selector lists', () => {
  assert.ok(NETWORK_FAILURE_CONFIG.gracePeriodMs > 0);
  assert.ok(NETWORK_FAILURE_CONFIG.errorIndicatorSelectors.length > 0);
  assert.ok(NETWORK_FAILURE_CONFIG.successIndicatorSelectors.length > 0);
  assert.ok(NETWORK_FAILURE_CONFIG.spinnerSelectors.length > 0);
  assert.ok(NETWORK_FAILURE_CONFIG.highLatencyDelayMs > NETWORK_FAILURE_CONFIG.gracePeriodMs, 'high-latency delay must exceed the grace period, or every high_latency scenario would look like a plain timeout');
  assert.ok(NETWORK_FAILURE_CONFIG.navTimeoutMs > 0);
});

test('buildOfflineDuringSubmitScenario/buildTimeoutDuringSubmitScenario build a ready scenario with the given mode, url, urlPattern, and triggerSelector', () => {
  const offline = buildOfflineDuringSubmitScenario({ name: 'Checkout offline', url: 'http://x/checkout', apiPattern: '**/api/checkout', submitSelector: '#pay-btn' });
  assert.equal(offline.mode, 'offline');
  assert.equal(offline.name, 'Checkout offline');
  assert.equal(offline.url, 'http://x/checkout');
  assert.equal(offline.urlPattern, '**/api/checkout');
  assert.equal(offline.triggerSelector, '#pay-btn');
  assert.equal(offline.httpStatus, undefined);

  const timeout = buildTimeoutDuringSubmitScenario({ name: 'Checkout timeout', url: 'http://x/checkout', apiPattern: '**/api/checkout', submitSelector: '#pay-btn' });
  assert.equal(timeout.mode, 'timeout');
});

test('buildHttpErrorDuringSubmitScenario carries the given httpStatus through to the scenario', () => {
  const scenario = buildHttpErrorDuringSubmitScenario({ name: 'Checkout 503', url: 'http://x/checkout', apiPattern: '**/api/checkout', submitSelector: '#pay-btn', httpStatus: 503 });
  assert.equal(scenario.mode, 'http_error');
  assert.equal(scenario.httpStatus, 503);
});

// ---- Playbook §N: Multi-Tab / Multi-Context Testing (config validation +
// named-template builders -- pure logic; runMultiTabScenario() itself
// launches a real browser with two Pages sharing one BrowserContext, and
// was live-verified separately against
// server/src/demo-app/multi-tab-fixture.html: a sessionStorage-backed
// logout (buggy -- sessionStorage is per-tab) produced exactly 1
// cross-tab-session finding while the same flow against a localStorage-
// backed logout (correct -- localStorage is shared across tabs) produced
// ZERO; a genuine concurrent-edit lost-update (tab B's save silently
// clobbering tab A's) produced exactly 1 finding while a single-tab
// control edit with no real conflict produced ZERO; and a session that
// expired in tab A (context.clearCookies()) followed by an authenticated
// action in tab B whose handler never re-checks the cookie produced
// exactly 1 finding.) ----

import { runMultiTabScenario, buildLogoutInOneTabTemplate, buildConcurrentEditLostUpdateTemplate, buildSessionExpiryOtherTabTemplate } from '../src/services/multiTabTestingService.ts';

test('runMultiTabScenario rejects a scenario with no steps or no invariants', async () => {
  await assert.rejects(() => runMultiTabScenario({ name: 'x', steps: [], invariants: [{ afterStep: 0, tab: 'a', type: 'visible', selector: '#x', message: 'm' }] }), /at least one step/);
  await assert.rejects(() => runMultiTabScenario({ name: 'x', steps: [{ tab: 'a', action: 'wait', ms: 1 }], invariants: [] }), /at least one invariant/);
});

test('runMultiTabScenario rejects an invariant whose afterStep is out of range', async () => {
  await assert.rejects(
    () => runMultiTabScenario({ name: 'x', steps: [{ tab: 'a', action: 'wait', ms: 1 }], invariants: [{ afterStep: 5, tab: 'a', type: 'visible', selector: '#x', message: 'm' }] }),
    /must be a valid index/
  );
});

test('buildLogoutInOneTabTemplate builds a 4-step flow (navigate both tabs, logout in A, refresh B) with a not_visible invariant on tab B', () => {
  const { steps, invariants } = buildLogoutInOneTabTemplate({ url: 'http://x/app', logoutSelector: '#logout', authenticatedOnlySelector: '#authed' });
  assert.equal(steps.length, 4);
  assert.deepEqual(steps.map((s) => s.tab), ['a', 'b', 'a', 'b']);
  assert.equal(invariants.length, 1);
  assert.equal(invariants[0].tab, 'b');
  assert.equal(invariants[0].type, 'not_visible');
  assert.equal(invariants[0].afterStep, 3);
});

test('buildConcurrentEditLostUpdateTemplate builds a 7-step flow where tab B saves after tab A, then tab A refreshes and must not see tab B\'s value', () => {
  const { steps, invariants } = buildConcurrentEditLostUpdateTemplate({
    url: 'http://x/record',
    fillSelector: '#notes',
    valueA: 'A value',
    valueB: 'B value',
    saveSelector: '#save',
    savedValueSelector: '#saved',
  });
  assert.equal(steps.length, 7);
  assert.equal(steps[steps.length - 1].action, 'refresh');
  assert.equal(steps[steps.length - 1].tab, 'a');
  assert.equal(invariants.length, 1);
  assert.equal(invariants[0].type, 'text_not_contains');
  assert.equal(invariants[0].text, 'B value');
});

test('buildSessionExpiryOtherTabTemplate builds a flow that clears cookies in tab A then expects a visible login prompt in tab B', () => {
  const { steps, invariants } = buildSessionExpiryOtherTabTemplate({ url: 'http://x/app', authenticatedActionSelector: '#do-action', loginPromptSelector: '#login-prompt' });
  assert.ok(steps.some((s) => s.action === 'clear_cookies' && s.tab === 'a'));
  assert.equal(invariants.length, 1);
  assert.equal(invariants[0].tab, 'b');
  assert.equal(invariants[0].type, 'visible');
  assert.equal(invariants[0].selector, '#login-prompt');
});

// ---- Playbook §Q: Cross-Browser Testing (pure classifyCrossBrowserFindings
// logic -- no browser launch. scanScreenForUiBugs()'s new `browserName`
// option and scanScreenAcrossBrowsers() itself were live-verified separately
// against server/src/demo-app/buggy-fixture.html: the default (implicit
// chromium) scan still detected the same findings as before with no
// browserName stamp in evidence, and a single-engine cross-browser run
// classified every one of those findings as "common" (with nothing to
// differ against). Firefox/WebKit engines are NOT installed in this sandbox
// (see the file-level doc comment in crossBrowserScanService.ts), so the
// 3-engine common-vs-browser-specific split itself is proven here with
// synthetic fixture data instead of a live run.) ----

import { classifyCrossBrowserFindings } from '../src/services/crossBrowserScanService.ts';

function fakeFinding(id, fingerprint) {
  return { id, fingerprint, title: `finding ${id}`, category: 'console-error', severity: 'medium' };
}

test('classifyCrossBrowserFindings splits a fingerprint seen on every engine into common, and single-engine fingerprints into browser-specific', () => {
  const byBrowser = {
    chromium: [fakeFinding('c1', 'fp-common'), fakeFinding('c2', 'fp-chromium-only')],
    firefox: [fakeFinding('f1', 'fp-common'), fakeFinding('f2', 'fp-firefox-only')],
    webkit: [fakeFinding('w1', 'fp-common')],
  };
  const result = classifyCrossBrowserFindings(byBrowser, ['chromium', 'firefox', 'webkit']);
  assert.deepEqual(result.common, ['fp-common']);
  assert.equal(result.browserSpecific.length, 2);
  const chromiumOnly = result.browserSpecific.find((b) => b.fingerprint === 'fp-chromium-only');
  const firefoxOnly = result.browserSpecific.find((b) => b.fingerprint === 'fp-firefox-only');
  assert.deepEqual(chromiumOnly.browsers, ['chromium']);
  assert.deepEqual(firefoxOnly.browsers, ['firefox']);
});

test('classifyCrossBrowserFindings with a single browser classifies every finding as common (nothing to differ against)', () => {
  const result = classifyCrossBrowserFindings({ chromium: [fakeFinding('c1', 'fp-a'), fakeFinding('c2', 'fp-b')] }, ['chromium']);
  assert.equal(result.common.length, 2);
  assert.equal(result.browserSpecific.length, 0);
});

test('classifyCrossBrowserFindings ignores a finding with no fingerprint rather than misclassifying it', () => {
  const result = classifyCrossBrowserFindings({ chromium: [{ id: 'x', fingerprint: null }] }, ['chromium']);
  assert.equal(result.common.length, 0);
  assert.equal(result.browserSpecific.length, 0);
});
