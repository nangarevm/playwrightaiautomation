import test from 'node:test';
import assert from 'node:assert/strict';
import { structureFingerprint, structureMatches } from '../src/crawler/diff.ts';
import { dedupeKey, fetchSitemapUrls } from '../src/crawler/urlUtils.ts';
import { dedupeScenarios, dedupeScenariosFuzzy, scenarioFingerprint } from '../src/crawler/scenarioDedup.ts';

test('dedupeKey collapses tracking params and trailing slashes', () => {
  const a = dedupeKey('https://example.com/forum?utm_source=nav');
  const b = dedupeKey('https://example.com/forum/');
  assert.equal(a, b);
});

test('scenarioFingerprint treats identical scenarios as duplicates', () => {
  const a = {
    title: 'Verify login submits successfully',
    flowGroup: 'Login Form',
    type: 'positive',
    steps: ['Given the user is on "Login"', 'When the user fills credentials', 'Then success'],
  };
  const b = { ...a };
  assert.equal(scenarioFingerprint(a), scenarioFingerprint(b));
});

test('dedupeScenarios removes exact duplicate scenarios', () => {
  const base = {
    id: '1',
    title: 'Verify X loads successfully',
    type: 'positive',
    tier: 'smoke',
    flowGroup: 'Home',
    steps: ['Given navigate', 'Then loads'],
    locators: [],
  };
  const dup = { ...base, id: '2' };
  const unique = dedupeScenarios([base, dup]);
  assert.equal(unique.length, 1);
});

test('dedupeScenariosFuzzy keeps page-load scenarios for different pages', () => {
  const a = {
    id: '1',
    title: 'Verify Dashboard loads successfully',
    type: 'positive',
    tier: 'smoke',
    flowGroup: 'Dashboard',
    steps: ['Given the user navigates to "Dashboard"', 'Then the page loads and its key elements render'],
    locators: [],
  };
  const b = {
    id: '2',
    title: 'Verify Reports loads successfully',
    type: 'positive',
    tier: 'smoke',
    flowGroup: 'Reports',
    steps: ['Given the user navigates to "Reports"', 'Then the page loads and its key elements render'],
    locators: [],
  };
  const unique = dedupeScenariosFuzzy([a, b]);
  assert.equal(unique.length, 2);
});

test('dedupeScenariosFuzzy collapses near-duplicates on the same page/tier', () => {
  const a = {
    id: '1',
    title: 'Verify Dashboard loads successfully',
    type: 'positive',
    tier: 'smoke',
    flowGroup: 'Dashboard',
    steps: ['Given the user navigates to "Dashboard"', 'Then the page loads and its key elements render'],
    locators: [],
  };
  const b = {
    id: '2',
    title: 'Verify Dashboard loads successfully now',
    type: 'positive',
    tier: 'smoke',
    flowGroup: 'Dashboard',
    steps: ['Given the user navigates to "Dashboard"', 'Then the page loads and its key elements render'],
    locators: [],
  };
  const unique = dedupeScenariosFuzzy([a, b]);
  assert.equal(unique.length, 1);
});

test('fetchSitemapUrls returns empty array when sitemap is unreachable', async () => {
  const urls = await fetchSitemapUrls('https://this-domain-definitely-does-not-exist-12345.example');
  assert.equal(Array.isArray(urls), true);
  assert.equal(urls.length, 0);
});

test('structureMatches ignores locator differences for incremental re-crawl probes', () => {
  const a = [
    { type: 'input', label: 'Email', locators: ["getByLabel('Email')"], component: 'Login' },
    { type: 'button', label: 'Submit', locators: ["getByRole('button', { name: 'Submit' })"], component: 'Login' },
  ];
  const b = [
    { type: 'button', label: 'Submit', locators: ['#submit-btn'], component: 'Login' },
    { type: 'input', label: 'Email', locators: ['#email'], component: 'Login' },
  ];
  assert.equal(structureMatches(a, b), true);
  assert.equal(structureFingerprint(a), structureFingerprint(b));

  const changed = [
    { type: 'input', label: 'Username', locators: ['#user'], component: 'Login' },
    { type: 'button', label: 'Submit', locators: ['#submit'], component: 'Login' },
  ];
  assert.equal(structureMatches(a, changed), false);
});
