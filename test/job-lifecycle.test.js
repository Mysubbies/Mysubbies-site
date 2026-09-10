const test = require('node:test');
const assert = require('node:assert/strict');
const { isEligible, MATCH_BATCH_SIZE, MATCH_RETRY_MINUTES, MAX_MATCH_ROUNDS } = require('../api/_lib/jobLifecycle');

test('matching requires an approved contractor in the job category and area', () => {
  const job = { category: 'Plumbing', suburb: 'Coburg' };
  const eligible = { status: 'approved', categories: ['Plumbing'], suburb_ids: ['Coburg'] };
  assert.equal(isEligible(job, eligible), true);
  assert.equal(isEligible(job, { ...eligible, status: 'suspended' }), false);
  assert.equal(isEligible(job, { ...eligible, categories: ['Electrical'] }), false);
  assert.equal(isEligible(job, { ...eligible, suburb_ids: ['Frankston'] }), false);
});

test('legacy application fields remain eligible inputs', () => {
  const contractor = { status: 'preferred', full_application: { trades: ['Fencing'], regions: ['Western Melbourne'] } };
  assert.equal(isEligible({ category: 'Fencing', suburb: 'Footscray' }, contractor), true);
});

test('Melbourne region labels do not match contractors across zones', () => {
  const northern = { status: 'approved', categories: ['Plumbing'], suburb_ids: ['Northern Melbourne'] };
  assert.equal(isEligible({ category: 'Plumbing', suburb: 'Coburg' }, northern), true);
  assert.equal(isEligible({ category: 'Plumbing', suburb: 'Frankston' }, northern), false);
});

test('matching automation has bounded fanout and retries', () => {
  assert.equal(MATCH_BATCH_SIZE, 3);
  assert.equal(MATCH_RETRY_MINUTES, 15);
  assert.equal(MAX_MATCH_ROUNDS, 3);
});
