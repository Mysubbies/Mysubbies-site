const test = require('node:test');
const assert = require('node:assert/strict');

const clients = require('../api/_lib/clients');
const { signAdminToken } = require('../api/_lib/adminAuth');
const { deterministicJobId, convertAcceptedQuoteToJob, QuoteConversionError } = require('../api/_lib/quoteToJob');

function query(result) {
  const q = { select() { return q; }, eq() { return q; }, is() { return q; }, order() { return q; }, in() { return q; },
    update() { return q; }, insert() { return q; }, limit() { return q; },
    maybeSingle: async () => result, single: async () => result,
    then(resolve) { return Promise.resolve(result).then(resolve); } };
  return q;
}

test('quote conversion is deterministic and duplicate conversion is idempotent', async () => {
  const quote = { id: 'quote-1', current_status: 'accepted', current_version_id: 'version-1', job_id: 'quote_quote-1' };
  const job = { id: 'quote_quote-1' };
  const db = { from(table) { return query({ data: table === 'quotes' ? quote : job, error: null }); } };
  const result = await convertAcceptedQuoteToJob(db, quote.id);
  assert.equal(deterministicJobId(quote.id), 'quote_quote-1');
  assert.equal(result.alreadyConverted, true);
  assert.equal(result.job.id, job.id);
});

test('invalid quote state cannot be converted', async () => {
  const db = { from() { return query({ data: { id: 'quote-2', current_status: 'sent', job_id: null }, error: null }); } };
  await assert.rejects(() => convertAcceptedQuoteToJob(db, 'quote-2'), error =>
    error instanceof QuoteConversionError && error.statusCode === 409);
});

test('accepted conversion builds job identity and price from immutable version', async () => {
  const quote = { id: 'q3', quote_number: 103, customer_id: 'customer-1', current_status: 'accepted', current_version_id: 'v3', job_id: null };
  const version = { id: 'v3', quote_id: 'q3', version_number: 2, status: 'accepted', total_inc_gst_cents: 123400,
    customer_snapshot: { name: 'Real Customer', email: 'real@example.com', phone: '0400' },
    property_snapshot: { address: '1 Main St', suburb: 'Richmond' },
    line_items: [{ description: 'Accepted scope', qty: 1, lineTotalCents: 123400 }] };
  let insertedJob;
  const db = {
    from(table) {
      if (table === 'quotes') {
        const q = query({ data: quote, error: null });
        q.update = () => query({ data: quote, error: null });
        return q;
      }
      if (table === 'quote_versions') return query({ data: version, error: null });
      if (table === 'payment_schedule_config') return query({ data: { high_value_threshold_cents: 2000000, deposit_cap_low_pct: 10, deposit_cap_high_pct: 5 }, error: null });
      if (table === 'category_payment_rules') return query({ data: null, error: null });
      if (table === 'jobs') {
        const q = query({ data: null, error: null });
        q.insert = value => { insertedJob = value; return query({ data: value, error: null }); };
        return q;
      }
      throw new Error(`Unexpected table ${table}`);
    },
  };
  const result = await convertAcceptedQuoteToJob(db, quote.id);
  assert.equal(result.alreadyConverted, false);
  assert.equal(insertedJob.id, 'quote_q3');
  assert.equal(insertedJob.customer_id, 'customer-1');
  assert.equal(insertedJob.customer_email, 'real@example.com');
  assert.equal(insertedJob.base_price_cents, 123400);
  assert.equal(insertedJob.full_record.items[0].description, 'Accepted scope');
  assert.equal(insertedJob.deposit_pct, 10);
});

test('push_to_portal API is admin-only; customer/public callers cannot cross the boundary', async () => {
  clients.getSupabase = () => ({ from() { return query({ data: { id: 'q', current_status: 'sent', job_id: null }, error: null }); } });
  delete require.cache[require.resolve('../api/quotes')];
  const handler = require('../api/quotes');
  const invoke = token => new Promise(resolve => {
    const req = { method: 'POST', body: { action: 'push_to_portal', quoteId: 'q' }, headers: token ? { authorization: `Bearer ${token}` } : {} };
    const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { resolve({ status: this.code, body }); } };
    handler(req, res);
  });
  assert.equal((await invoke()).status, 401);
  process.env.ADMIN_SESSION_SECRET = 'quote-test-secret';
  assert.equal((await invoke(signAdminToken())).status, 409);
  delete process.env.ADMIN_SESSION_SECRET;
});

test('legacy convert action cannot publish a quote', async () => {
  clients.getSupabase = () => ({ from() { return query({ data: null, error: null }); } });
  delete require.cache[require.resolve('../api/quotes')];
  const handler = require('../api/quotes');
  process.env.ADMIN_SESSION_SECRET = 'quote-test-secret';
  const response = await new Promise(resolve => {
    const req = { method: 'POST', body: { action: 'convert_to_job', quoteId: 'q' }, headers: { authorization: `Bearer ${signAdminToken()}` } };
    const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { resolve({ status: this.code, body }); } };
    handler(req, res);
  });
  assert.equal(response.status, 400);
  assert.equal(response.body.error, 'Unknown action.');
  delete process.env.ADMIN_SESSION_SECRET;
});
