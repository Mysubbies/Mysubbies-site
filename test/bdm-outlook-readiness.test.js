'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { outlookIntegrationReadiness, SHARED_MAILBOX } = require('../lib/ai-workforce/outlook-shared-mailbox-config');
test('shared mailbox is fixed and sending remains disabled by default', () => {
  const result = outlookIntegrationReadiness({});
  assert.equal(result.mailbox, SHARED_MAILBOX);
  assert.equal(result.mailbox, 'accounts@mysubbies.com.au');
  assert.equal(result.credentialsConfigured, false);
  assert.equal(result.sendEnabled, false);
});
test('readiness never exposes credentials or enables sending even with flag', () => {
  const result = outlookIntegrationReadiness({ MS365_TENANT_ID: 'tenant', MS365_CLIENT_ID: 'client', MS365_CLIENT_SECRET: 'super-secret', BDM_OUTLOOK_SEND_ENABLED: 'true' });
  assert.equal(result.credentialsConfigured, true);
  assert.equal(result.requestedSendEnabled, true);
  assert.equal(result.sendEnabled, false);
  assert.equal(JSON.stringify(result).includes('super-secret'), false);
});
test('incomplete credentials are not marked ready', () => {
  assert.equal(outlookIntegrationReadiness({MS365_TENANT_ID:'tenant', MS365_CLIENT_ID:'client'}).credentialsConfigured, false);
});
