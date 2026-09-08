const test = require('node:test');
const assert = require('node:assert/strict');

const clients = require('../api/_lib/clients');
const { mergePermittedMutation, restoreStructuredFields, initialRecord } = require('../api/_lib/jobMutationSecurity');

function chain(result, onUpdate) {
  const q = {
    select() { return q; }, eq() { return q; }, is() { return q; },
    maybeSingle() { return Promise.resolve(result); },
    update(value) { if (onUpdate) onUpdate(value); return q; },
    then(resolve) { return Promise.resolve(result).then(resolve); },
  };
  return q;
}

function fakeSupabase({ user, customer, contractor, job, updates }) {
  return {
    auth: { getUser: async () => user ? { data: { user }, error: null } : { data: null, error: new Error('invalid') } },
    from(table) {
      if (table === 'customers') return chain({ data: customer || null, error: null });
      if (table === 'contractors') return chain({ data: contractor || null, error: null });
      if (table === 'jobs') return chain({ data: job || null, error: null }, value => updates.push(value));
      throw new Error(`Unexpected table ${table}`);
    },
  };
}

function loadHandler(db) {
  clients.getSupabase = () => db;
  delete require.cache[require.resolve('../api/sync-jobs')];
  return require('../api/sync-jobs');
}

function invoke(handler, body, token) {
  return new Promise(resolve => {
    const req = { method: 'POST', body, headers: token ? { authorization: `Bearer ${token}` } : {} };
    const res = { code: 200, status(code) { this.code = code; return this; }, json(value) { resolve({ status: this.code, body: value }); } };
    handler(req, res);
  });
}

const structured = { id: 'job-1', category: 'Plumbing', customer_email: 'owner@example.com', contractor_email: 'trade@example.com',
  base_price_cents: 50000, status: 'deposit_paid', disputed: false,
  full_record: { id: 'job-1', category: 'Plumbing', customerEmail: 'owner@example.com', contractorEmail: 'trade@example.com',
    basePrice: 500, priceLow: 500, priceHigh: 500, status: 'assigned', paidStages: { deposit: true },
    paymentSchedule: [{ key: 'deposit', pct: 5 }], messages: [] } };

test('unauthenticated job mutation is rejected without a write', async () => {
  const updates = [];
  const response = await invoke(loadHandler(fakeSupabase({ updates })), { role: 'customer', jobs: [{ id: 'job-1' }] });
  assert.equal(response.status, 401);
  assert.equal(updates.length, 0);
});

test('customer cannot mutate another customer job', async () => {
  const updates = [];
  const db = fakeSupabase({ user: { id: 'auth-other' }, customer: { email: 'other@example.com' }, job: structured, updates });
  const response = await invoke(loadHandler(db), { role: 'customer', jobs: [{ id: 'job-1', messages: [] }] }, 'valid');
  assert.equal(response.status, 403);
  assert.equal(updates.length, 0);
});

test('contractor cannot mutate another contractor assignment', async () => {
  const updates = [];
  const db = fakeSupabase({ user: { id: 'auth-other' }, contractor: { email: 'other@example.com' }, job: structured, updates });
  const response = await invoke(loadHandler(db), { role: 'contractor', jobs: [{ id: 'job-1' }] }, 'valid');
  assert.equal(response.status, 403);
  assert.equal(updates.length, 0);
});

test('forged assignment, price, payment, completion and evidence are ignored', () => {
  const submitted = { ...structured.full_record, contractorEmail: 'attacker@example.com', contractor: 'Attacker',
    basePrice: 1, priceLow: 1, priceHigh: 1, status: 'completed', paidStages: { deposit: true, completion: true },
    paymentSchedule: [], afterPhotos: ['forged'], completionEvidence: { approved: true } };
  const merged = restoreStructuredFields(mergePermittedMutation(structured.full_record, submitted, 'customer'), structured);
  assert.equal(merged.contractorEmail, 'trade@example.com');
  assert.equal(merged.basePrice, 500);
  assert.equal(merged.status, 'assigned');
  assert.deepEqual(merged.paidStages, { deposit: true });
  assert.deepEqual(merged.paymentSchedule, [{ key: 'deposit', pct: 5 }]);
  assert.equal(merged.afterPhotos, undefined);
  assert.equal(merged.completionEvidence, undefined);
});

test('legitimate customer display update and message append are permitted', () => {
  const submitted = { address: '2 New Street', urgency: 'Next week', messages: [
    { id: 'm1', from: 'customer', authorName: 'You', text: 'Please call first', createdAt: '2026-09-08T00:00:00Z' },
  ] };
  const merged = mergePermittedMutation(structured.full_record, submitted, 'customer');
  assert.equal(merged.address, '2 New Street');
  assert.equal(merged.urgency, 'Next week');
  assert.equal(merged.messages.length, 1);
  assert.equal(merged.messages[0].from, 'customer');
});

test('new display record derives protected state from structured job and account', () => {
  const record = initialRecord({ id: 'forged', category: 'Fake', customerName: 'Fake', customerPhone: 'Fake',
    basePrice: 1, status: 'completed', paidStages: { completion: true }, items: [{ taskName: 'Tap', qty: 1 }] },
  structured, { role: 'customer', account: { name: 'Real Customer', phone: '0400000000' } });
  assert.equal(record.id, 'job-1');
  assert.equal(record.category, 'Plumbing');
  assert.equal(record.customerName, 'Real Customer');
  assert.equal(record.basePrice, 500);
  assert.equal(record.status, 'feed');
  assert.deepEqual(record.paidStages, { deposit: true });
});

test('authenticated contractor acceptance binds assignment to authenticated email', async () => {
  const updates = [];
  const available = { ...structured, contractor_email: null, full_record: { ...structured.full_record, contractorEmail: null, contractor: null, status: 'feed' } };
  const db = fakeSupabase({ user: { id: 'auth-trade' }, contractor: { email: 'realtrade@example.com' }, job: available, updates });
  const response = await invoke(loadHandler(db), { role: 'contractor', jobs: [{ id: 'job-1', status: 'assigned', contractorEmail: 'forged@example.com', contractor: 'Real Trade' }] }, 'valid');
  assert.equal(response.status, 200);
  assert.equal(updates[0].contractor_email, 'realtrade@example.com');
  assert.equal(updates[0].full_record.contractorEmail, 'realtrade@example.com');
});
