const test = require('node:test');
const assert = require('node:assert/strict');
const clients = require('../api/_lib/clients');
const { signAdminToken } = require('../api/_lib/adminAuth');

function chain(result, capture) {
  const q = { select() { return q; }, eq() { return q; }, update(value) { capture?.(value); return q; },
    maybeSingle: async () => result, then(resolve, reject) { return Promise.resolve(result).then(resolve, reject); } };
  return q;
}
function invoke(handler, body, token) { return new Promise(resolve => {
  const req = { method: 'POST', body, headers: { authorization: `Bearer ${token}` } };
  const res = { code: 200, status(code) { this.code = code; return this; }, json(value) { resolve({ status: this.code, body: value }); } };
  handler(req, res);
}); }
function load(statusUpdates, notificationRows) {
  const current = { id: 'c1', email: 'trade@example.test', business_name: 'Synthetic Trade', categories: ['Plumbing'],
    full_application: { email: 'trade@example.test', regions: ['Northern Melbourne'] } };
  clients.getSupabase = () => ({ from(table) {
    if (table === 'contractors') {
      let updating = false;
      const q = chain({ data: current, error: null });
      q.update = value => { updating = true; statusUpdates.push(value); return q; };
      q.select = () => updating ? Promise.resolve({ data: [{ ...current, ...statusUpdates.at(-1) }], error: null }) : q;
      return q;
    }
    if (table === 'notifications') return { insert: async rows => { notificationRows.push(...(Array.isArray(rows) ? rows : [rows])); return { error: null }; } };
    throw new Error(table);
  } });
  delete require.cache[require.resolve('../api/update-contractor-status')];
  return require('../api/update-contractor-status');
}

test('approval is Admin-only, persists setup-token state, sends onboarding email and creates audit notification', async () => {
  process.env.ADMIN_SESSION_SECRET = 'status-test'; process.env.RESEND_API_KEY = 're_test';
  const originalFetch = global.fetch; let email;
  global.fetch = async (_url, options) => { email = JSON.parse(options.body); return { ok: true }; };
  try {
    const updates = [], notifications = []; const handler = load(updates, notifications);
    assert.equal((await invoke(handler, { email: 'trade@example.test', status: 'approved' }, 'bad')).status, 401);
    const result = await invoke(handler, { email: 'trade@example.test', status: 'approved' }, signAdminToken());
    assert.equal(result.status, 200); assert.equal(result.body.emailDelivery, 'sent');
    assert.equal(updates[0].status, 'approved'); assert.equal(updates[0].application_update_token_hash.length, 64);
    assert.match(email.subject, /approved/); assert.match(email.html, /How job offers work/); assert.match(email.html, /setup=/);
    assert(notifications.some(n => n.event_type === 'contractor-application-approved'));
  } finally { global.fetch = originalFetch; delete process.env.RESEND_API_KEY; delete process.env.ADMIN_SESSION_SECRET; }
});

test('rejection and more-information require a reason; delivery failure is visible to Admin', async () => {
  process.env.ADMIN_SESSION_SECRET = 'status-test'; process.env.RESEND_API_KEY = 're_test';
  const originalFetch = global.fetch; global.fetch = async () => ({ ok: false, status: 500, text: async () => '{}' });
  try {
    const updates = [], notifications = []; const handler = load(updates, notifications); const token = signAdminToken();
    assert.equal((await invoke(handler, { email: 'trade@example.test', status: 'rejected' }, token)).status, 400);
    const result = await invoke(handler, { email: 'trade@example.test', status: 'manual_review', reason: 'Upload current insurance' }, token);
    assert.equal(result.status, 200); assert.equal(result.body.emailDelivery, 'failed');
    assert.equal(updates[0].full_application.reviewNotes, 'Upload current insurance');
    assert(notifications.some(n => n.event_type === 'contractor-onboarding-email-failed'));
  } finally { global.fetch = originalFetch; delete process.env.RESEND_API_KEY; delete process.env.ADMIN_SESSION_SECRET; }
});
