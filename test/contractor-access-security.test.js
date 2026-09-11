const test = require('node:test');
const assert = require('node:assert/strict');
const { requireAccount, requireApprovedContractor } = require('../api/_lib/userAuth');

function db({ user = { id: 'auth-1' }, customer, contractor }) {
  return { auth: { getUser: async () => ({ data: { user }, error: null }) }, from(table) {
    const data = table === 'customers' ? customer : contractor;
    return { select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: data || null, error: null }) };
  } };
}
const req = { headers: { authorization: 'Bearer valid' } };

test('customer identity cannot escalate into the contractor role', async () => {
  const result = await requireAccount(db({ customer: { auth_user_id: 'auth-1', email: 'customer@example.test' } }), req, 'contractor');
  assert.equal(result.ok, false); assert.equal(result.status, 403);
});

test('unapproved, rejected, suspended and expired contractors are denied approved-only access', async () => {
  for (const status of ['manual_review', 'rejected', 'suspended', 'expired_documents']) {
    const result = await requireApprovedContractor(db({ contractor: { auth_user_id: 'auth-1', email: 'c@example.test', status } }), req);
    assert.equal(result.ok, false, status);
  }
  const expired = await requireApprovedContractor(db({ contractor: { auth_user_id: 'auth-1', email: 'c@example.test', status: 'approved', insurance_expiry: '2020-01-01' } }), req);
  assert.equal(expired.ok, false);
});

test('approved current contractor is allowed and remains bound to own row', async () => {
  const result = await requireApprovedContractor(db({ contractor: { id: 'own', auth_user_id: 'auth-1', email: 'own@example.test', status: 'approved' } }), req);
  assert.equal(result.ok, true); assert.equal(result.account.id, 'own');
});
