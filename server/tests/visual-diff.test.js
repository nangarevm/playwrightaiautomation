import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.ts';
import { saveVisualBaseline, diffAgainstVisualBaseline } from '../src/services/screensService.ts';

function resetScreens() {
  db.prepare('DELETE FROM screens').run();
}

test.beforeEach(() => {
  resetScreens();
});

// FR-5.9: real pixel-level visual diffing via Playwright screenshots + pixelmatch,
// exercised against data: URLs so the test doesn't depend on a running dev server.
test('saveVisualBaseline + diffAgainstVisualBaseline detect a real pixel change between two screenshots (FR-5.9)', async (t) => {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO screens (id, name, module_name, source_input_id, url_or_path, last_captured_state_hash, change_status, last_compared_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'new', ?, ?, ?)
  `).run('screen-visual', 'Visual fixture screen', 'fixture', 'input-visual', null, 'x', now, now, now);

  const redPageUrl = 'data:text/html,<body style="margin:0;background:red;width:200px;height:200px"></body>';
  const bluePageUrl = 'data:text/html,<body style="margin:0;background:blue;width:200px;height:200px"></body>';

  const baseline = await saveVisualBaseline('screen-visual', { url: redPageUrl });
  assert.ok(baseline.visual_baseline_ref);
  const parsedRef = JSON.parse(baseline.visual_baseline_ref);
  assert.equal(parsedRef.type, 'screenshot');

  const sameDiff = await diffAgainstVisualBaseline('screen-visual', { url: redPageUrl });
  assert.equal(sameDiff.hasBaseline, true);
  assert.equal(sameDiff.method, 'pixel-diff');
  assert.equal(sameDiff.visualChangeDetected, false);
  assert.equal(sameDiff.diffPercentage, 0);

  const changedDiff = await diffAgainstVisualBaseline('screen-visual', { url: bluePageUrl });
  assert.equal(changedDiff.visualChangeDetected, true);
  assert.ok(changedDiff.diffPercentage > 50); // whole background color changed

  db.prepare('DELETE FROM screens WHERE id = ?').run('screen-visual');
});

// Fallback content-hash path is preserved for callers with no live URL to render.
test('saveVisualBaseline/diffAgainstVisualBaseline fall back to content-hash when no url is given (FR-5.9)', async () => {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO screens (id, name, module_name, source_input_id, url_or_path, last_captured_state_hash, change_status, last_compared_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'new', ?, ?, ?)
  `).run('screen-hash-fallback', 'Hash fallback screen', 'fixture', 'input-visual', null, 'x', now, now, now);

  await saveVisualBaseline('screen-hash-fallback', { content: '<h1>before</h1>' });
  const unchanged = await diffAgainstVisualBaseline('screen-hash-fallback', { content: '<h1>before</h1>' });
  assert.equal(unchanged.method, 'content-hash');
  assert.equal(unchanged.visualChangeDetected, false);

  const changed = await diffAgainstVisualBaseline('screen-hash-fallback', { content: '<h1>after</h1>' });
  assert.equal(changed.visualChangeDetected, true);

  db.prepare('DELETE FROM screens WHERE id = ?').run('screen-hash-fallback');
});
