const test = require('node:test');
const assert = require('node:assert/strict');
const clients = require('../api/_lib/clients');

function makeDb({ user, linked = null, emailProfile = null, phoneProfiles = [], savedCustomer = null }) {
  const calls = [];
  return {
    calls,
    auth: { getUser: async () => user ? { data: { user }, error: null } : { data: null, error: new Error('expired') } },
    from(table) {
      assert.equal(table, 'customers');
      const state = { action: 'select', filters: [] };
      const q = {
        select(fields) { calls.push(['select', fields]); return q; },
        update(values) { state.action = 'update'; calls.push(['update', values]); return q; },
        insert(values) { state.action = 'insert'; calls.push(['insert', values]); return q; },
        eq(column, value) { state.filters.push(['eq', column, value]); calls.push(['eq', column, value]); return q; },
        is(column, value) { state.filters.push(['is', column, value]); calls.push(['is', column, value]); return q; },
        limit() { return Promise.resolve({ data: phoneProfiles, error: null }); },
        maybeSingle() {
          const authFilter = state.filters.some(f => f[1] === 'auth_user_id');
          return Promise.resolve({ data: authFilter ? linked : emailProfile, error: null });
        },
        single() { return Promise.resolve({ data: savedCustomer, error: null }); },
      };
      return q;
    },
  };
}

function loadHandler(db) {
  clients.getSupabase = () => db;
  delete require.cache[require.resolve('../api/customer-register')];
  return require('../api/customer-register');
}
function invoke(handler, body = {}, token = 'valid') {
  return new Promise(resolve => {
    const req = { method: 'POST', body, headers: token ? { authorization: `Bearer ${token}` } : {} };
    const res = { code: 200, status(code) { this.code = code; return this; }, json(payload) { resolve({ status: this.code, body: payload }); } };
    handler(req, res);
  });
}
const user = { id: 'auth-1', email: 'NEW@EXAMPLE.COM', user_metadata: {} };
const details = { firstName: 'New', lastName: 'Customer', phone: '0400000000' };

test('completely new authenticated customer gets a linked profile', async () => {
  const customer = { id: 'customer-1', email: 'new@example.com', name: 'New Customer', phone: details.phone };
  const db = makeDb({ user, savedCustomer: customer });
  const response = await invoke(loadHandler(db), details);
  assert.equal(response.status, 201);
  assert.deepEqual(response.body.customer, customer);
  assert(db.calls.some(c => c[0] === 'insert' && c[1].auth_user_id === user.id && c[1].email === 'new@example.com'));
});

test('existing unlinked booking profile with same email is safely linked', async () => {
  const customer = { id: 'customer-old', email: 'new@example.com', name: 'New Customer', phone: details.phone };
  const db = makeDb({ user, emailProfile: { ...customer, auth_user_id: null }, savedCustomer: customer });
  const response = await invoke(loadHandler(db), details);
  assert.equal(response.status, 200);
  assert(db.calls.some(c => c[0] === 'update' && c[1].auth_user_id === user.id));
  assert(db.calls.some(c => c[0] === 'is' && c[1] === 'auth_user_id' && c[2] === null));
});

test('existing profile already linked to this auth user is reused', async () => {
  const customer = { id: 'customer-1', auth_user_id: user.id, email: 'new@example.com' };
  const db = makeDb({ user, linked: customer, savedCustomer: { ...customer, name: 'New Customer', phone: details.phone } });
  const response = await invoke(loadHandler(db), details);
  assert.equal(response.status, 200);
  assert.equal(db.calls.some(c => c[0] === 'insert'), false);
});

test('different auth user cannot take over an email-linked profile', async () => {
  const db = makeDb({ user, emailProfile: { id: 'victim', auth_user_id: 'auth-victim', email: 'new@example.com' } });
  const response = await invoke(loadHandler(db), details);
  assert.equal(response.status, 409);
  assert.equal(db.calls.some(c => c[0] === 'update'), false);
});

test('same mobile on a different email is not used as identity proof', async () => {
  const db = makeDb({ user, phoneProfiles: [{ id: 'other', email: 'other@example.com' }] });
  const response = await invoke(loadHandler(db), details);
  assert.equal(response.status, 409);
  assert.equal(db.calls.some(c => c[0] === 'insert'), false);
});

test('unauthenticated registration cannot create or link a profile', async () => {
  const db = makeDb({});
  const response = await invoke(loadHandler(db), details, null);
  assert.equal(response.status, 401);
  assert.equal(db.calls.length, 0);
});
