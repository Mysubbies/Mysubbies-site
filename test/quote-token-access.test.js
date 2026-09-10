const test = require('node:test');
const assert = require('node:assert/strict');

const clients = require('../api/_lib/clients');

function createDatabase({ versionStatus = 'issued', quoteStatus = 'sent', expired = false } = {}) {
  const token = {
    id: 'token-1', document_id: 'version-1', revoked_at: null,
    expires_at: new Date(Date.now() + (expired ? -60000 : 3600000)).toISOString(),
  };
  const version = {
    id: 'version-1', quote_id: 'quote-1', status: versionStatus, version_number: 1,
    expires_at: token.expires_at, customer_snapshot: { name: 'Customer', email: 'customer@example.com' },
    line_items: [], total_inc_gst_cents: 10000, subtotal_ex_gst_cents: 9091, gst_cents: 909,
  };
  const quote = { id: 'quote-1', quote_number: 101, current_status: quoteStatus };
  const tokenUpdates = [];
  const db = {
    tokenUpdates,
    from(table) {
      const result = () => {
        if (table === 'document_access_attempts') return { data: null, count: 0, error: null };
        if (table === 'document_access_tokens') return { data: token, error: null };
        if (table === 'quote_versions') return { data: version, error: null };
        if (table === 'quotes') return { data: quote, error: null };
        if (table === 'platform_rate_card' || table === 'issuing_entities') return { data: null, error: null };
        return { data: null, error: null };
      };
      const query = {
        select() { return query; }, eq() { return query; }, gte() { return query; }, is() { return query; },
        insert() { return query; },
        update(values) { if (table === 'document_access_tokens') tokenUpdates.push(values); return query; },
        maybeSingle: async () => result(),
        then(resolve) { return Promise.resolve(result()).then(resolve); },
      };
      return query;
    },
  };
  return db;
}

function loadHandler(db) {
  clients.getSupabase = () => db;
  delete require.cache[require.resolve('../api/quotes')];
  return require('../api/quotes');
}

function openQuote(handler, ip = '203.0.113.10') {
  return new Promise(resolve => {
    const req = { method: 'GET', query: { token: 'same-secure-token' }, headers: { 'x-forwarded-for': ip } };
    const res = {
      code: 200, headers: {},
      setHeader(name, value) { this.headers[name] = value; },
      status(code) { this.code = code; return this; },
      json(body) { resolve({ status: this.code, body, headers: this.headers }); },
    };
    handler(req, res);
  });
}

test('first open, second open, refresh and another browser do not consume a valid quote token', async () => {
  const db = createDatabase();
  const handler = loadHandler(db);
  const responses = [
    await openQuote(handler),
    await openQuote(handler),
    await openQuote(handler), // browser refresh is the same GET again
    await openQuote(handler, '198.51.100.20'),
  ];
  responses.forEach(response => {
    assert.equal(response.status, 200);
    assert.equal(response.body.status, 'sent');
    assert.equal(response.headers['Cache-Control'], 'private, no-store');
  });
  assert.equal(db.tokenUpdates.length, 4);
  assert.ok(db.tokenUpdates.every(update => Object.keys(update).join() === 'last_accessed_at'));
});

test('valid quote opens before expiry and genuinely expired issued quote is rejected', async () => {
  assert.equal((await openQuote(loadHandler(createDatabase()))).status, 200);
  const expired = await openQuote(loadHandler(createDatabase({ expired: true })));
  assert.equal(expired.status, 410);
  assert.equal(expired.body.error, 'This link has expired.');
});

test('accepted and declined quotes reopen with their settled status after review expiry', async () => {
  const accepted = await openQuote(loadHandler(createDatabase({ versionStatus: 'accepted', quoteStatus: 'accepted', expired: true })));
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.status, 'accepted');

  const declined = await openQuote(loadHandler(createDatabase({ versionStatus: 'declined', quoteStatus: 'declined', expired: true })));
  assert.equal(declined.status, 200);
  assert.equal(declined.body.status, 'declined');
});
