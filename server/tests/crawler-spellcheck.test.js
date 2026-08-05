import test from 'node:test';
import assert from 'node:assert/strict';
import { checkText, collectPageSpellingIssues } from '../src/crawler/spellcheck.ts';

test('checkText flags a real misspelling with a suggestion', () => {
  const issues = checkText('Plase enter your email', 'page title');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].word, 'Plase');
  assert.ok(issues[0].suggestions.length > 0);
});

test('checkText does not flag correctly spelled prose', () => {
  const issues = checkText('Successful login redirects to the dashboard', 'page title');
  assert.equal(issues.length, 0);
});

test('checkText skips identifiers (camelCase, ALLCAPS, tokens with digits)', () => {
  const issues = checkText('userId OTP field2 XyzAbc', 'input label');
  assert.equal(issues.length, 0);
});

test('checkText allows common UI/product terms not in a general dictionary', () => {
  const issues = checkText('Add to wishlist and proceed to checkout', 'button label');
  assert.equal(issues.length, 0);
});

test('checkText deduplicates repeated misspellings within the same text', () => {
  const issues = checkText('Recieve confirmation, then recieve a receipt', 'page title');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].word.toLowerCase(), 'recieve');
});

test('collectPageSpellingIssues aggregates the title and every element label', () => {
  const issues = collectPageSpellingIssues('Checkuot', [
    { type: 'button', label: 'Submitt', locators: [], component: 'Form' },
    { type: 'link', label: 'Continue shopping', locators: [], component: 'Nav' },
  ]);
  const words = issues.map((i) => i.word);
  assert.ok(words.includes('Checkuot'));
  assert.ok(words.includes('Submitt'));
  assert.equal(issues.length, 2);
});
