import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.ts';
import {
  compressPrompt,
  chooseModelTier,
  withLlmGateway,
  logScriptGenerationUsage,
  getLlmUsageSummary,
} from '../src/services/llmGatewayService.ts';

function resetUsage() {
  db.prepare('DELETE FROM llm_usage_log').run();
}

// FR-9.6: prompt compression measurably lowers token count for large inputs
// without discarding unique content.
test('compressPrompt shrinks a large input with duplicate lines but preserves unique content', () => {
  const uniqueLine = 'The checkout page must validate the promo code field before submit.';
  const repeatedBoilerplate = 'Standard Playwright POM coding conventions apply to this project.';
  const bigInput = Array.from({ length: 40 }, () => repeatedBoilerplate).join('\n') + '\n' + uniqueLine;

  const { compressed, wasCompressed } = compressPrompt(bigInput);
  assert.equal(wasCompressed, true);
  assert.ok(compressed.length < bigInput.length, 'compressed output should be smaller');
  assert.ok(compressed.includes(uniqueLine), 'unique content must survive compression');
  assert.equal(compressed.split('\n').filter((l) => l === repeatedBoilerplate).length, 1, 'duplicate lines collapse to one');
});

test('compressPrompt leaves small inputs untouched', () => {
  const small = 'Short ticket description.';
  const { compressed, wasCompressed } = compressPrompt(small);
  assert.equal(wasCompressed, false);
  assert.equal(compressed, small);
});

// FR-9.7: simpler generation tasks route to the lower-cost model tier. The
// length threshold this test asserts against is itself controlled by
// org_settings.cost_saving_mode (Settings' "cost-saving mode" toggle, ON by
// default) -- save/restore it explicitly so this test's outcome depends only
// on its own inputs, not on whatever a previous test or a real user session
// last left that shared, persistent setting as.
test('chooseModelTier routes Negative/Edge Case categories and short prompts to economy', () => {
  const before = db.prepare('SELECT cost_saving_mode, economy_tier_length_threshold FROM org_settings WHERE id = 1').get();
  db.prepare('UPDATE org_settings SET cost_saving_mode = 0 WHERE id = 1').run();
  try {
    assert.equal(chooseModelTier('a short prompt', 'Negative'), 'economy');
    assert.equal(chooseModelTier('a short prompt', 'Edge Case'), 'economy');
    assert.equal(chooseModelTier('x'), 'economy'); // short prompt, no category
    assert.equal(chooseModelTier('x'.repeat(1000), 'Smoke'), 'primary'); // 1000 chars > the 400-char off-mode threshold
  } finally {
    db.prepare('UPDATE org_settings SET cost_saving_mode = ?, economy_tier_length_threshold = ? WHERE id = 1').run(
      before.cost_saving_mode,
      before.economy_tier_length_threshold
    );
  }
});

// FR-9.5: a structurally near-duplicate request is served from cache instead of
// triggering a new call, and the hit is visible in the usage dashboard (FR-6.10)
test('withLlmGateway serves a near-duplicate prompt from the semantic cache', async () => {
  resetUsage();
  let callCount = 0;
  const basePrompt = 'Ticket PROD-42: the product listing page must show price, title, and add-to-cart button for every item card.';
  const nearDuplicatePrompt = 'Ticket PROD-43: the product listing page must show price, title, and add-to-cart button for every item card.';

  const runFn = async () => {
    callCount++;
    return { result: [{ title: 'case', category: 'Smoke' }], outputText: 'case' };
  };

  const first = await withLlmGateway('test_case_generation', { provider: 'mock', prompt: basePrompt }, runFn);
  const second = await withLlmGateway('test_case_generation', { provider: 'mock', prompt: nearDuplicatePrompt }, runFn);

  assert.equal(callCount, 1, 'the second near-duplicate request must not trigger a new LLM call');
  assert.deepEqual(second, first, 'the cached response is returned for the near-duplicate request');

  const summary = getLlmUsageSummary();
  assert.equal(summary.total_calls, 2);
  assert.equal(summary.cache_hits, 1);
  assert.ok(summary.cache_hit_rate_pct > 0);
});

test('withLlmGateway does not cache-hit for genuinely different prompts', async () => {
  resetUsage();
  let callCount = 0;
  const runFn = async () => {
    callCount++;
    return { result: { ok: true }, outputText: 'response ' + callCount };
  };

  await withLlmGateway('test_case_generation', { provider: 'mock', prompt: 'Ticket A: login page must accept email and password.' }, runFn);
  await withLlmGateway('test_case_generation', { provider: 'mock', prompt: 'Ticket B: checkout page must total the cart and apply tax.' }, runFn);

  assert.equal(callCount, 2, 'unrelated prompts should each trigger their own LLM call');
});

// FR-6.10 (amended): dashboard shows usage, cost, and savings attributable to
// caching/routing, and updates as new requests are made.
test('getLlmUsageSummary reports cost savings from cache hits and script-generation routing', async () => {
  resetUsage();
  const runFn = async () => ({ result: 'x', outputText: 'y'.repeat(2000) });

  await withLlmGateway('test_case_generation', { provider: 'mock', prompt: 'a'.repeat(3000) }, runFn);
  logScriptGenerationUsage('input-x', 'economy', 'mock', 'some steps text', 'const code = 1;');

  const summary = getLlmUsageSummary();
  assert.equal(summary.total_calls, 2);
  assert.ok(summary.total_cost_usd >= 0);
  assert.ok(summary.total_cost_without_optimization_usd >= summary.total_cost_usd, 'baseline cost must be >= actual optimized cost');
  assert.equal(summary.calls_by_model_tier.economy >= 1, true);
  assert.equal(summary.recent.length, 2);
});
