const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

function source(file) { return fs.readFileSync(file, 'utf8'); }

test('application, resubmission, approval, rejection, activation and profile lifecycle events are wired', () => {
  const combined = [source('api/sync-applications.js'), source('api/update-contractor-status.js'), source('api/activate-contractor.js'), source('api/contractor-profile.js')].join('\n');
  for (const event of ['contractor-application-received','contractor-application-resubmitted','contractor-resubmission-received',
    'contractor-application-approved','contractor-application-rejected','contractor-more-information-required',
    'contractor-account-activated','contractor-profile-updated','contractor-payout-details-updated','contractor-compliance-documents-']) {
    assert.match(combined, new RegExp(event));
  }
});

test('job offer, acceptance, decline, expiry, reassignment, material update and milestone events are wired', () => {
  const combined = source('api/sync-jobs.js') + source('api/notify.js');
  for (const event of ['new-job-available','contractor-job-accepted','contractor-job-offer-declined','contractor-job-offer-expired',
    'contractor-job-reassigned','contractor-job-assigned','contractor-job-materially-updated','contractor-job-cancelled',
    'contractor-job-completed']) assert.match(combined, new RegExp(event));
  for (const stage of ['scheduled','on_the_way','started','completed']) assert.match(combined, new RegExp(stage));
});

test('compliance, payout and account-state critical events are wired without changing customer Stripe collection', () => {
  const combined = source('api/contractor-compliance-reminders.js') + source('api/contractor-profile.js') + source('api/admin-account.js');
  for (const marker of ['contractor-${kind}-expired','contractor-${kind}-expiring','contractor-payout-${status}',
    'contractor-account-suspended','contractor-account-reactivated']) assert.match(combined, new RegExp(marker.replace(/[${}]/g, '\\$&')));
  assert.match(source('api/create-deposit-intent.js'), /paymentIntents\.create/);
});
