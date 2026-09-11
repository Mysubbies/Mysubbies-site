const test = require('node:test');
const assert = require('node:assert/strict');
const { customerLifecycleEmail, PORTAL } = require('../api/_lib/customerLifecycleEmail');

test('all launch lifecycle templates are branded, actionable and escape customer data', () => {
  const events = ['welcome','booking_received','payment_received','information_required','contractor_confirmed','rescheduled','cancelled','completed','quote_ready','account_recovery'];
  for (const event of events) {
    const out = customerLifecycleEmail(event, { customerName: '<script>Ada</script>', service: 'Fencing', address: '1 Test St', amount: '$50' });
    assert.match(out.html, /My<span[^>]*>Subbies/);
    assert.match(out.html, new RegExp(PORTAL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(out.html, /<script>Ada/);
    assert.doesNotMatch(out.html, /job_[a-z0-9]|secret|password=/i);
  }
});

test('booking received does not falsely claim assignment', () => {
  const out = customerLifecycleEmail('booking_received', { customerName: 'Ada', service: 'Fencing' });
  assert.match(out.html, /arranging the appropriate local professional/);
  assert.match(out.html, /only after confirmation/);
  assert.doesNotMatch(out.html, /contractor (is|has been) assigned/i);
});
