const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { milestoneOptions, validateInvoiceAmount, gstBreakdown } = require('../api/_lib/quoteInvoice');

test('explicit quote percentages become reviewable milestone options', () => {
  const result = milestoneOptions('10% deposit, 40% at frame stage, 50% on completion', 110000);
  assert.deepEqual(result.map(x => [x.percentage, x.amountCents]), [[10, 11000], [40, 44000], [50, 55000]]);
});

test('invoice totals use Australian GST-inclusive one-eleventh calculation', () => {
  assert.deepEqual(gstBreakdown(110000), { totalIncGstCents: 110000, gstCents: 10000, subtotalExGstCents: 100000 });
});

test('server validation prevents aggregate over-invoicing', () => {
  assert.equal(validateInvoiceAmount({ amountCents: 50001, quoteTotalCents: 100000, previouslyInvoicedCents: 50000 }), 'This invoice would exceed the accepted quote total after earlier invoices.');
  assert.equal(validateInvoiceAmount({ amountCents: 50000, quoteTotalCents: 100000, previouslyInvoicedCents: 50000 }), null);
});

test('invoice workflow is accepted-quote only and bank configuration stays server-side', () => {
  const api = fs.readFileSync(path.join(__dirname, '..', 'api', 'quotes.js'), 'utf8');
  const admin = fs.readFileSync(path.join(__dirname, '..', 'mysubbies-admin-portal.html'), 'utf8');
  const customer = fs.readFileSync(path.join(__dirname, '..', 'mysubbies-invoice.html'), 'utf8');
  assert.match(api, /quote\.current_status !== 'accepted'/);
  assert.match(api, /INVOICE_BANK_ACCOUNT_NAME/);
  assert.match(api, /validateInvoiceAmount/);
  assert.match(admin, /Create milestone tax invoice/);
  assert.match(customer, /TAX INVOICE/);
});
