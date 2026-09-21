const test = require('node:test');
const assert = require('node:assert/strict');
const { PDFDocument } = require('pdf-lib');
const { generateQuotePdf } = require('../api/_lib/quotePdf');

test('issued quote PDF is a valid multi-section PDF suitable for email attachment', async () => {
  const bytes = await generateQuotePdf({
    quote: { quote_number: 2042 },
    version: {
      version_number: 2,
      issued_at: '2026-09-21T00:00:00.000Z',
      expires_at: '2026-10-21T00:00:00.000Z',
      customer_snapshot: { name: 'Ava Nguyen', email: 'ava@example.com', phone: '0400000000' },
      property_snapshot: { address: '1 Test Street', suburb: 'Richmond', postcode: '3121' },
      line_items: [{ description: 'Decking\n- Supply composite boards\n- Install framing', qty: 20, unit: 'm2', unitPriceCents: 25000 }],
      subtotal_ex_gst_cents: 454545,
      gst_cents: 45455,
      total_inc_gst_cents: 500000,
      scope_text: 'Supply and install decking.',
      inclusions_text: 'Labour and materials.',
      exclusions_text: 'Permit fees.',
      payment_terms_text: '10% deposit, balance on completion.',
      terms_text: 'Standard MySubbies platform terms apply.',
    },
  });
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  assert.ok(bytes.length > 2500);
  const parsed = await PDFDocument.load(bytes);
  assert.ok(parsed.getPageCount() >= 1);
});
