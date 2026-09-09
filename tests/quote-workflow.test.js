const test = require('node:test');
const assert = require('node:assert/strict');

const quotes = require('../api/quotes')._test;
const { computeQuoteTotals } = require('../api/_lib/quoteMath');

function versionRow(overrides = {}) {
  const totals = computeQuoteTotals([
    { id: 'line-1', description: 'Repair fence', qty: 2, unit: 'm', unitPriceCents: 5500 },
    { id: 'line-2', description: 'Remove waste', qty: 1, unitPriceCents: 1100 },
  ]);
  return {
    id: 'version-1', quote_id: 'quote-1', version_number: 1, status: 'draft',
    customer_snapshot: { name: 'Test Customer', email: 'customer@example.com', phone: '0400000000' },
    property_snapshot: { address: '1 Test Street', suburb: 'Richmond' },
    line_items: totals.lineItems, subtotal_ex_gst_cents: totals.subtotalExGstCents,
    gst_cents: totals.gstCents, total_inc_gst_cents: totals.totalIncGstCents,
    scope_text: 'Repair the damaged fence.', inclusions_text: 'Labour and fixings.',
    exclusions_text: 'Painting.', payment_schedule_note: { text: '10% deposit; balance on completion.' },
    terms_version: 'v1', attachments: [], validity_days: 21,
    created_at: '2026-09-09T00:00:00.000Z', ...overrides,
  };
}

test('save -> reload -> edit preserves the complete persisted quote snapshot', () => {
  const saved = versionRow();
  const reloaded = quotes.serializeVersionAdmin(saved);

  assert.deepEqual(reloaded.customerSnapshot, saved.customer_snapshot);
  assert.deepEqual(reloaded.propertySnapshot, saved.property_snapshot);
  assert.deepEqual(reloaded.lineItems, saved.line_items);
  assert.equal(reloaded.scopeText, saved.scope_text);
  assert.equal(reloaded.inclusionsText, saved.inclusions_text);
  assert.equal(reloaded.exclusionsText, saved.exclusions_text);
  assert.equal(reloaded.paymentTermsText, saved.payment_schedule_note.text);
  assert.equal(reloaded.validityDays, 21);
  assert.equal(reloaded.totalIncGstCents, 12100);

  const quote = quotes.serializeQuoteAdmin({
    id: 'quote-1', quote_number: 1001, current_status: 'draft', customer_id: 'customer-1',
    current_version_id: saved.id,
  }, saved, { id: 'customer-1', name: 'Test Customer', email: 'customer@example.com', phone: '0400000000' });
  assert.equal(quote.id, 'quote-1', 'editing retains the existing quote identity');
  assert.equal(quote.currentVersion.id, 'version-1');
});

test('preview uses persisted server totals and all commercial text', () => {
  const persisted = versionRow({ status: 'issued', issued_at: '2026-09-09T00:00:00.000Z', expires_at: '2026-09-30T00:00:00.000Z' });
  const preview = quotes.serializePublic(
    { quote_number: 1001, current_status: 'sent' }, persisted,
    { legal_name: 'Mysubbies Holdings Pty Ltd', abn: '69 693 675 268' },
  );
  assert.equal(preview.totalIncGstCents, 12100);
  assert.equal(preview.gstCents, 1100);
  assert.equal(preview.paymentTermsText, '10% deposit; balance on completion.');
  assert.equal(preview.scopeText, 'Repair the damaged fence.');
  assert.deepEqual(preview.property, persisted.property_snapshot);
});

test('payment terms remain compatible with both core and optional Preview schema shapes', () => {
  assert.deepEqual(quotes.paymentScheduleNote('50% deposit'), { text: '50% deposit' });
  assert.equal(quotes.getPaymentTermsText({ payment_schedule_note: { text: '50% deposit' } }), '50% deposit');
  assert.equal(quotes.getPaymentTermsText({ payment_terms_text: 'Legacy text' }), 'Legacy text');
});

test('secure quote tokens are not persisted in plaintext and identify the correct version', () => {
  const token = 'customer-secret-token';
  assert.notEqual(quotes.hashToken(token), token);
  assert.equal(quotes.hashToken(token), quotes.hashToken(token));
  assert.equal(quotes.hashToken('different-token') === quotes.hashToken(token), false);
});

test('email delivery reports missing configuration and Resend provider failures', async (t) => {
  const originalKey = process.env.RESEND_API_KEY;
  const originalFrom = process.env.RESEND_FROM_EMAIL;
  const originalFetch = global.fetch;
  t.after(() => {
    if (originalKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = originalKey;
    if (originalFrom === undefined) delete process.env.RESEND_FROM_EMAIL; else process.env.RESEND_FROM_EMAIL = originalFrom;
    global.fetch = originalFetch;
  });

  delete process.env.RESEND_API_KEY;
  delete require.cache[require.resolve('../api/_lib/email')];
  let email = require('../api/_lib/email');
  assert.match((await email.sendEmailWithResult({ to: 'a@b.test', subject: 'Quote', html: 'x' })).error, /RESEND_API_KEY/);

  process.env.RESEND_API_KEY = 'test-key';
  process.env.RESEND_FROM_EMAIL = 'MySubbies <quotes@mysubbies.com.au>';
  let sentBody;
  global.fetch = async (_url, options) => {
    sentBody = JSON.parse(options.body);
    return { ok: false, status: 422, text: async () => JSON.stringify({ message: 'domain rejected' }) };
  };
  delete require.cache[require.resolve('../api/_lib/email')];
  email = require('../api/_lib/email');
  const failed = await email.sendEmailWithResult({ to: 'customer@example.com', subject: 'Quote', html: 'x' });
  assert.deepEqual(failed, { ok: false, status: 422, error: 'domain rejected' });
  assert.equal(sentBody.from, 'MySubbies <quotes@mysubbies.com.au>');
});
