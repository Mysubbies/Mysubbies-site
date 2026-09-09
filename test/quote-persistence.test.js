const test = require('node:test');
const assert = require('node:assert/strict');

const { paymentTermsFromVersion, quoteVersionContent } = require('../api/_lib/quotePersistence');

const totals = {
  lineItems: [{ description: 'Repair fence', qty: 2, unitPriceCents: 5500, lineTotalCents: 11000 }],
  subtotalExGstCents: 10000,
  gstCents: 1000,
  totalIncGstCents: 11000,
};

test('quote creation persists payment schedule in v19 schema without payment_terms_text', () => {
  const fields = quoteVersionContent({
    propertySnapshot: { address: '1 Main St', suburb: 'Richmond' },
    scopeText: 'Repair the damaged section.',
    inclusionsText: 'Labour and materials.',
    exclusionsText: 'Painting.',
    paymentTermsText: '10% deposit, balance on completion.',
    validityDays: 21,
  }, totals);

  assert.equal(Object.hasOwn(fields, 'payment_terms_text'), false);
  assert.deepEqual(fields.payment_schedule_note, { text: '10% deposit, balance on completion.' });
  assert.deepEqual(fields.property_snapshot, { address: '1 Main St', suburb: 'Richmond' });
  assert.deepEqual(fields.line_items, totals.lineItems);
  assert.equal(fields.scope_text, 'Repair the damaged section.');
  assert.equal(fields.inclusions_text, 'Labour and materials.');
  assert.equal(fields.exclusions_text, 'Painting.');
  assert.equal(fields.validity_days, 21);
  assert.equal(fields.gst_cents, 1000);
  assert.equal(fields.total_inc_gst_cents, 11000);
});

test('quote edit and reload retain the v19 payment schedule value', () => {
  const stored = { payment_schedule_note: { text: 'Original schedule' }, validity_days: 30 };
  const updated = quoteVersionContent({ paymentTermsText: 'Updated schedule' }, totals, stored);
  assert.equal(Object.hasOwn(updated, 'payment_terms_text'), false);
  assert.deepEqual(updated.payment_schedule_note, { text: 'Updated schedule' });
  assert.equal(paymentTermsFromVersion(updated), 'Updated schedule');
});

test('read compatibility accepts legacy JSON string and optional v20 rows without writing v20', () => {
  assert.equal(paymentTermsFromVersion({ payment_schedule_note: 'Legacy schedule' }), 'Legacy schedule');
  assert.equal(paymentTermsFromVersion({ payment_terms_text: 'Optional v20 text' }), 'Optional v20 text');
  const fields = quoteVersionContent({}, totals, { payment_terms_text: 'Optional v20 text' });
  assert.deepEqual(fields.payment_schedule_note, { text: 'Optional v20 text' });
  assert.equal(Object.hasOwn(fields, 'payment_terms_text'), false);
});
