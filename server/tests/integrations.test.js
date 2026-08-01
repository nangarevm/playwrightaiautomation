import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.ts';
import { decryptSecret, encryptSecret, maskSecret } from '../src/services/secretsService.ts';
import {
  createIntegration,
  deleteIntegration,
  getIntegration,
  listIntegrations,
  rotateIntegrationToken,
} from '../src/services/integrationsService.ts';

function resetData() {
  db.prepare('DELETE FROM integrations').run();
}

test.beforeEach(() => {
  resetData();
});

test('encryptSecret/decryptSecret round-trips and never leaks plaintext in the ciphertext', () => {
  const plaintext = 'super-secret-jira-token';
  const encrypted = encryptSecret(plaintext);
  assert.notEqual(encrypted.encrypted, plaintext);
  assert.equal(decryptSecret(encrypted), plaintext);
});

test('maskSecret shows only the last 4 characters', () => {
  assert.equal(maskSecret('abcdefgh1234'), '********1234');
  assert.equal(maskSecret(''), '');
});

test('createIntegration stores the token encrypted and never returns it raw', () => {
  const integration = createIntegration({ type: 'jira', base_url: 'https://example.atlassian.net', token: 'raw-token-value', org_id: 'TEST' });
  assert.ok(integration.id);
  assert.equal(integration.token_masked.endsWith('alue'), true);
  assert.ok(!JSON.stringify(integration).includes('raw-token-value'));

  const raw = db.prepare('SELECT token_encrypted FROM integrations WHERE id = ?').get(integration.id);
  assert.notEqual(raw.token_encrypted, 'raw-token-value');
});

test('listIntegrations filters by type', () => {
  createIntegration({ type: 'jira', base_url: 'https://a.atlassian.net', token: 't1' });
  createIntegration({ type: 'slack', webhook_url: 'https://hooks.slack.com/x', notify_on_run: true });

  assert.equal(listIntegrations().length, 2);
  assert.equal(listIntegrations('jira').length, 1);
  assert.equal(listIntegrations('slack')[0].notify_on_run, true);
});

test('rotateIntegrationToken replaces the stored credential', () => {
  const integration = createIntegration({ type: 'azure', base_url: 'https://dev.azure.com/org', token: 'old-token' });
  const rotated = rotateIntegrationToken(integration.id, 'new-token-value');
  assert.equal(rotated.token_masked.endsWith('alue'), true);
  assert.notEqual(rotated.token_masked, integration.token_masked);
});

test('deleteIntegration removes the record', () => {
  const integration = createIntegration({ type: 'teams', webhook_url: 'https://outlook.office.com/webhook/x' });
  deleteIntegration(integration.id);
  assert.equal(getIntegration(integration.id), null);
});
