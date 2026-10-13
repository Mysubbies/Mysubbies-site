'use strict';

// Configuration readiness only. This module never requests tokens, creates drafts,
// or sends mail. No secrets or tokens may be exposed to the browser.
const SHARED_MAILBOX = 'accounts@mysubbies.com.au';
function outlookIntegrationReadiness(env = process.env) {
  const tenantId = String(env.MS365_TENANT_ID || '').trim();
  const clientId = String(env.MS365_CLIENT_ID || '').trim();
  const clientSecret = String(env.MS365_CLIENT_SECRET || '').trim();
  const enabled = env.BDM_OUTLOOK_SEND_ENABLED === 'true';
  return {
    mailbox: SHARED_MAILBOX,
    provider: 'microsoft-365-shared-mailbox',
    credentialsConfigured: Boolean(tenantId && clientId && clientSecret),
    sendEnabled: false, // Hard-disabled until separately reviewed implementation.
    requestedSendEnabled: enabled,
    nextStep: 'Review Graph permissions and delegated/shared-mailbox access before implementing draft or send actions.'
  };
}
module.exports = { SHARED_MAILBOX, outlookIntegrationReadiness };
