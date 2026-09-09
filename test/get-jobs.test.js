const test = require('node:test');
const assert = require('node:assert/strict');

const clients = require('../api/_lib/clients');
const { signAdminToken } = require('../api/_lib/adminAuth');

function query(result, calls) {
  const q = {
    select(value) { calls.push(['select', value]); return q; },
    eq(column, value) { calls.push(['eq', column, value]); return q; },
    not(column, op, value) { calls.push(['not', column, op, value]); return q; },
    is(column, value) { calls.push(['is', column, value]); return q; },
    in(column, value) { calls.push(['in', column, value]); return q; },
    limit(value) { calls.push(['limit', value]); return Promise.resolve(result); },
    maybeSingle() { return Promise.resolve(result); },
  };
  return q;
}

function supabaseFor({ user, customer, contractor, assigned = [], offers = [], customerJobs = [], adminJobs = [] }) {
  const calls = [];
  return {
    calls,
    auth: { getUser: async () => user ? { data: { user }, error: null } : { data: null, error: new Error('invalid') } },
    from(table) {
      if (table === 'customers') return query({ data: customer || null, error: null }, calls);
      if (table === 'contractors') return query({ data: contractor || null, error: null }, calls);
      if (table === 'jobs') {
        const q = query({ data: [], error: null }, calls);
        q.limit = value => {
          calls.push(['limit', value]);
          const lastEq = [...calls].reverse().find(c => c[0] === 'eq');
          const isUnassigned = calls.some(c => c[0] === 'is' && c[1] === 'contractor_email');
          if (isUnassigned) return Promise.resolve({ data: offers, error: null });
          if (lastEq && lastEq[1] === 'contractor_email') return Promise.resolve({ data: assigned, error: null });
          if (lastEq && lastEq[1] === 'customer_email') return Promise.resolve({ data: customerJobs, error: null });
          return Promise.resolve({ data: adminJobs, error: null });
        };
        return q;
      }
      throw new Error(`Unexpected table ${table}`);
    },
  };
}

function loadHandler(supabase) {
  clients.getSupabase = () => supabase;
  delete require.cache[require.resolve('../api/get-jobs')];
  return require('../api/get-jobs');
}

function invoke(handler, queryParams, token) {
  return new Promise(resolve => {
    const req = { method: 'GET', query: queryParams, headers: token ? { authorization: `Bearer ${token}` } : {} };
    const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { resolve({ status: this.code, body }); } };
    handler(req, res);
  });
}

test('customer and contractor reads reject unauthenticated requests', async () => {
  const handler = loadHandler(supabaseFor({}));
  assert.equal((await invoke(handler, { customerEmail: 'spoof@example.com' })).status, 401);
  assert.equal((await invoke(handler, { contractorEmail: 'spoof@example.com' })).status, 401);
});

test('spoofed customer email is ignored and only authenticated customer jobs are queried', async () => {
  const db = supabaseFor({ user: { id: 'auth-c' }, customer: { id: 'c', auth_user_id: 'auth-c', email: 'owner@example.com' },
    customerJobs: [{ full_record: { id: 'own' }, job_number: 1 }] });
  const response = await invoke(loadHandler(db), { customerEmail: 'victim@example.com' }, 'valid');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.jobs, [{ id: 'own', jobNumber: 1 }]);
  assert(db.calls.some(c => c[0] === 'eq' && c[1] === 'customer_email' && c[2] === 'owner@example.com'));
  assert(!db.calls.some(c => c.includes('victim@example.com')));
});

test('customer cannot use contractor branch or read contractor jobs', async () => {
  const db = supabaseFor({ user: { id: 'auth-c' }, customer: { email: 'owner@example.com' } });
  assert.equal((await invoke(loadHandler(db), { contractorEmail: 'target@example.com' }, 'valid')).status, 403);
});

test('spoofed contractor email is ignored and assigned jobs use authenticated account', async () => {
  const db = supabaseFor({ user: { id: 'auth-k' }, contractor: { id: 'k', auth_user_id: 'auth-k', email: 'real@example.com', categories: [] },
    assigned: [{ full_record: { id: 'assigned' }, job_number: 2 }] });
  const response = await invoke(loadHandler(db), { contractorEmail: 'other@example.com' }, 'valid');
  assert.equal(response.status, 200);
  assert(response.body.jobs.some(job => job.id === 'assigned'));
  assert(db.calls.some(c => c[0] === 'eq' && c[1] === 'contractor_email' && c[2] === 'real@example.com'));
  assert(!db.calls.some(c => c.includes('other@example.com')));
});

test('unassigned offers expose only the explicit safe projection', async () => {
  const privateRecord = { id: 'offer', category: 'Plumbing', icon: 'x', suburb: 'Richmond', urgency: 'Soon', basePrice: 300,
    items: [{ taskName: 'Tap', qty: 1, unit: 'Each', notes: 'Address: 1 Secret St' }], status: 'feed', createdAt: 'now',
    address: '1 Secret St', customerName: 'Person', customerEmail: 'person@example.com', customerPhone: '0400',
    messages: ['private'], internalMessages: ['private'], photoDataUrl: 'private', paidStages: { deposit: true }, accessToken: 'private' };
  const db = supabaseFor({ user: { id: 'auth-k' }, contractor: { email: 'real@example.com', categories: [] },
    offers: [{ full_record: privateRecord, job_number: 3 }] });
  const response = await invoke(loadHandler(db), { contractorEmail: 'anything' }, 'valid');
  const offer = response.body.jobs[0];
  assert.deepEqual(Object.keys(offer).sort(), ['basePrice', 'category', 'createdAt', 'icon', 'id', 'items', 'jobNumber', 'status', 'suburb', 'urgency'].sort());
  assert.deepEqual(Object.keys(offer.items[0]).sort(), ['qty', 'taskName', 'unit'].sort());
});

test('valid admin read retains existing requireAdmin protection', async () => {
  process.env.ADMIN_SESSION_SECRET = 'test-secret';
  const db = supabaseFor({ adminJobs: [{ full_record: { id: 'admin-visible' }, job_number: 4 }] });
  const handler = loadHandler(db);
  assert.equal((await invoke(handler, { all: '1' })).status, 401);
  const response = await invoke(handler, { all: '1' }, signAdminToken());
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.jobs, [{ id: 'admin-visible', jobNumber: 4 }]);
  delete process.env.ADMIN_SESSION_SECRET;
});

test('authenticated customer with zero bookings receives an empty jobs array', async () => {
  const db = supabaseFor({ user: { id: 'auth-new' }, customer: { id: 'new', auth_user_id: 'auth-new', email: 'new@example.com' }, customerJobs: [] });
  const response = await invoke(loadHandler(db), { customerEmail: '1' }, 'valid');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { jobs: [] });
});

test('expired customer session is rejected without querying private jobs', async () => {
  const db = supabaseFor({ customerJobs: [{ full_record: { id: 'private' }, job_number: 8 }] });
  const response = await invoke(loadHandler(db), { customerEmail: '1' }, 'expired');
  assert.equal(response.status, 401);
  assert.equal(db.calls.some(call => call[0] === 'eq' && call[1] === 'customer_email'), false);
});
