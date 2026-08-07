import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBaselineCoverageScenarios, buildIntraPageFlowScenario, buildNegativeAndEdgeBaselines, buildScenariosForPage } from '../src/crawler/scenarios.ts';
import { dedupeScenariosFuzzy } from '../src/crawler/scenarioDedup.ts';

const sampleElements = [
  { type: 'input', label: 'Email', locators: ["page.getByLabel('Email')"], component: 'Contact Form', required: true, inputType: 'email' },
  { type: 'button', label: 'Submit', locators: ["page.getByRole('button', { name: 'Submit' })"], component: 'Contact Form', required: false, inputType: null },
  { type: 'link', label: 'Home', locators: ["page.getByRole('link', { name: 'Home' })"], component: 'Nav', required: false, inputType: null },
];

test('every page always gets smoke page-load and regression baselines', () => {
  const baselines = buildBaselineCoverageScenarios('Contact Us', sampleElements);
  assert.equal(baselines.length, 2);
  assert.ok(baselines.some((s) => s.tier === 'smoke' && /loads successfully/i.test(s.title)));
  assert.ok(baselines.some((s) => s.tier === 'regression'));
});

test('every page always gets negative and edge baselines', () => {
  const baselines = buildNegativeAndEdgeBaselines('Contact Us', sampleElements);
  assert.ok(baselines.some((s) => s.type === 'negative'), 'missing negative');
  assert.ok(baselines.some((s) => s.type === 'edge'), 'missing edge');
});

test('form pages still include smoke + regression + negative + edge (no empty slots)', () => {
  const scenarios = buildScenariosForPage('Contact Us', sampleElements, 1);
  const unique = dedupeScenariosFuzzy(scenarios);
  assert.ok(unique.some((s) => s.tier === 'smoke'), 'missing smoke');
  assert.ok(unique.some((s) => s.tier === 'regression'), 'missing regression');
  assert.ok(unique.some((s) => s.type === 'negative'), 'missing negative');
  assert.ok(unique.some((s) => s.type === 'edge'), 'missing edge');
  assert.ok(unique.some((s) => /submits successfully/i.test(s.title)), 'missing form happy path');
  assert.ok(unique.some((s) => /submitted empty|validation error/i.test(s.title)), 'missing form empty negative');
});

test('link-only pages include smoke + regression + negative + edge + click coverage', () => {
  const linksOnly = [
    { type: 'link', label: 'About', locators: ["page.getByRole('link', { name: 'About' })"], component: 'Nav', required: false, inputType: null },
    { type: 'link', label: 'Blog', locators: ["page.getByRole('link', { name: 'Blog' })"], component: 'Nav', required: false, inputType: null },
  ];
  const scenarios = buildScenariosForPage('Home', linksOnly, 0);
  assert.ok(scenarios.some((s) => s.tier === 'smoke'));
  assert.ok(scenarios.some((s) => s.tier === 'regression'));
  assert.ok(scenarios.some((s) => s.type === 'negative'));
  assert.ok(scenarios.some((s) => s.type === 'edge'));
  assert.ok(scenarios.some((s) => /clicking/i.test(s.title)));
});

test('intra-page flow fills the flow slot when multi-page journeys are unavailable', () => {
  const flow = buildIntraPageFlowScenario('Dashboard', sampleElements);
  assert.ok(flow);
  assert.equal(flow.type, 'flow');
  assert.equal(flow.tier, 'regression');
});
