const test = require('node:test');
const assert = require('node:assert/strict');
const { signAdminToken } = require('../api/_lib/adminAuth');
const crm = require('../api/ai-bdm-crm');
const discover = require('../api/ai-bdm-discover');

function response() {
  return { statusCode: 200, body: null, headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    setHeader(key, value) { this.headers[key] = value; }
  };
}
test('BDM CRM rejects unauthenticated reads and writes', async () => {
  for (const method of ['GET', 'POST']) {
    const res = response();
    await crm({ method, headers: {}, body: { action: 'review', decision: 'approved', draft_id: 'x' } }, res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.error, 'Unauthorized');
  }
});
test('BDM discovery rejects unauthenticated searches before provider calls', async () => {
  const res = response();
  await discover({ method: 'GET', headers: {}, query: { suburb: 'Craigieburn' } }, res);
  assert.equal(res.statusCode, 401);
});
test('BDM endpoints reject unsupported methods', async () => {
  for (const [handler, method] of [[crm, 'DELETE'], [discover, 'POST']]) {
    const res = response();
    await handler({ method, headers: {} }, res);
    assert.equal(res.statusCode, 405);
  }
});
test('BDM discovery blocks unapproved search area even with admin session', async () => {
  const original = process.env.ADMIN_SESSION_SECRET;
  try {
    process.env.ADMIN_SESSION_SECRET = 'test-only-not-production-secret';
    const token = signAdminToken();
    const res = response();
    await discover({ method: 'GET', headers: { cookie: 'mysubbies_admin_session=' + encodeURIComponent(token) },
      query: { suburb: 'Sydney', category: 'medical clinics' } }, res);
    assert.equal(res.statusCode, 400);
  } finally {
    if (original === undefined) delete process.env.ADMIN_SESSION_SECRET;
    else process.env.ADMIN_SESSION_SECRET = original;
  }
});
