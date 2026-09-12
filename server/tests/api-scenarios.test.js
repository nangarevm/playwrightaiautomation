import test from 'node:test';
import assert from 'node:assert/strict';
import { isLikelyApiResponse } from '../src/crawler/network.ts';
import { buildApiScenariosForSite } from '../src/crawler/apiScenarios.ts';
import { mockProvider } from '../src/llm/mockProvider.ts';

test('isLikelyApiResponse rejects HTML document routes masquerading as xhr/fetch', () => {
  assert.equal(isLikelyApiResponse('text/html; charset=utf-8', 'https://example.com/contact'), false);
  assert.equal(isLikelyApiResponse('', 'https://example.com/pricing'), false);
  assert.equal(isLikelyApiResponse('application/json', 'https://example.com/api/v1/users'), true);
});

test('buildApiScenariosForSite skips page routes and keeps real API endpoints', () => {
  const pages = [
    {
      url: 'https://example.com/home',
      apis: [
        { trigger: 'page load', method: 'GET', endpoint: '/contact', schema: {}, host: 'example.com' },
        {
          trigger: 'page load',
          method: 'GET',
          endpoint: '/api/v1/status',
          schema: { type: 'object', fields: { status: 'string' } },
          responseSchema: { type: 'object', fields: { status: 'string' } },
          status: 200,
          responseTimeMs: 125,
          host: 'example.com',
        },
      ],
    },
  ];
  const byPage = buildApiScenariosForSite('example.com', pages);
  const scenarios = byPage.get('https://example.com/home') ?? [];
  assert.equal(scenarios.length, 1);
  assert.match(scenarios[0].title, /GET \/api\/v1\/status/);
  assert.match(scenarios[0].steps.join('\n'), /observed HTTP 200/);
  assert.match(scenarios[0].steps.join('\n'), /"status":"string"/);
  assert.match(scenarios[0].steps.join('\n'), /observed 125ms/);
});

test('API code generation validates observed status, schema, and performance', async () => {
  const script = await mockProvider.generatePlaywrightScript(
    {
      title: 'Verify GET /api/v1/status returns a successful response',
      category: 'API',
      steps: [
        'When a GET request is sent to "/api/v1/status"',
        'Then the response status matches the observed HTTP 200',
        'And the response matches the observed response schema: {"type":"object","fields":{"status":"string"}}',
        'And the response remains within a reasonable threshold from the observed 125ms',
      ],
      expected_result: 'The response is correct',
      confidence_score: 0.9,
      source_rationale: 'fixture',
    },
    { framework: 'playwright', language: 'typescript', apiSpecHint: 'API endpoint GET /api/v1/status' }
  );

  assert.match(script, /toBe\(200\)/);
  assert.match(script, /toHaveProperty\("status"\)/);
  assert.match(script, /response changed|Missing response field/);
  assert.match(script, /durationMs/);
});
