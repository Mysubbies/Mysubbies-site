const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const payment = require(join(root, 'api/_lib/paymentSchedule'));
const bookingHtml = readFileSync(join(root, 'mysubbies-booking.html'), 'utf8');
const depositApi = readFileSync(join(root, 'api/create-deposit-intent.js'), 'utf8');
const getJobs = readFileSync(join(root, 'api/get-jobs.js'), 'utf8');

function fakeSupabase() {
  return {
    from(table) {
      if (table === 'payment_schedule_config') {
        return {
          select() { return this; },
          eq() { return this; },
          async single() {
            return { data: { high_value_threshold_cents: 2000000, deposit_cap_high_pct: 5, deposit_cap_low_pct: 10 }, error: null };
          },
        };
      }
      if (table === 'category_payment_rules') {
        return {
          select() { return this; },
          eq() { return this; },
          async maybeSingle() {
            return { data: { category: 'Decking', schedule_type: 'standard', default_template_id: null, allow_job_override: true }, error: null };
          },
        };
      }
      throw new Error('Unexpected table: ' + table);
    },
  };
}

test('jobs above $9,900 resolve to zero-deposit contract review', async () => {
  assert.equal(payment.NO_DEPOSIT_BOOKING_THRESHOLD_CENTS, 990000);
  const resolved = await payment.resolveScheduleForJob(fakeSupabase(), 'Decking', 990001);
  assert.equal(resolved.status, 'pending_admin_schedule');
  assert.equal(resolved.schedule_type, 'manual_review');
  assert.equal(resolved.deposit_pct, 0);
  assert.equal(resolved.milestones.length, 1);
  assert.equal(resolved.milestones[0].amount_cents, 0);
});

test('zero-deposit booking bypasses Stripe while keeping the existing DB payment status', () => {
  assert.match(depositApi, /status: 'pending_deposit'/);
  assert.doesNotMatch(depositApi, /status: depositMilestone\.amount_cents === 0 \? 'pending_contract_review'/);
  assert.match(depositApi, /if \(Number\(depositMilestoneRow\.amount_cents\) === 0\)/);
  assert.match(depositApi, /noDepositRequired: true/);
  assert.match(depositApi, /jobStatus: 'pending_contract_review'/);
});

test('customer UI shows $0 due today and does not mount Stripe for zero deposit', () => {
  assert.match(bookingHtml, /Book job — \$0 due today/);
  assert.match(bookingHtml, /if \(!noDepositRequired\) \{/);
  assert.match(bookingHtml, /pendingContractReview: true/);
  assert.match(bookingHtml, /status: \(useRealPayment && paymentInfo\.pendingContractReview\) \? 'pending_contract_review' : 'feed'/);
});

test('contract-review jobs are excluded from contractor feed', () => {
  assert.match(getJobs, /r\.full_record && r\.full_record\.status === 'feed'/);
});
