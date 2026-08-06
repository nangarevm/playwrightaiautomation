import test from 'node:test';
import assert from 'node:assert/strict';
import { isLikelyApiResponse } from '../src/crawler/network.ts';
import { buildApiScenariosForSite } from '../src/crawler/apiScenarios.ts';

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
        { trigger: 'page load', method: 'GET', endpoint: '/api/v1/status', schema: {}, host: 'example.com' },
      ],
    },
  ];
  const byPage = buildApiScenariosForSite('example.com', pages);
  const scenarios = byPage.get('https://example.com/home') ?? [];
  assert.equal(scenarios.length, 1);
  assert.match(scenarios[0].title, /GET \/api\/v1\/status/);
});
