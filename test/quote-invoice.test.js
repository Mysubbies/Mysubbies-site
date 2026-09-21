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

test('invoice payments are recorded atomically and cannot exceed the balance', () => {
  const api = fs.readFileSync(path.join(__dirname, '..', 'api', 'quotes.js'), 'utf8');
  const schema = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'schema_v31_invoice_payments.sql'), 'utf8');
  assert.match(schema, /create table if not exists invoice_payments/);
  assert.match(schema, /for update/);
  assert.match(schema, /Payment exceeds invoice balance/);
  assert.match(schema, /status = case when v_new_total = total_inc_gst_cents then 'paid' else 'part_paid' end/);
  assert.match(api, /action === 'record_invoice_payment'/);
  assert.match(api, /supabase\.rpc\('record_invoice_payment'/);
});

test('admin and customer invoice surfaces show balances, payment history and receipts', () => {
  const admin = fs.readFileSync(path.join(__dirname, '..', 'mysubbies-admin-portal.html'), 'utf8');
  const customer = fs.readFileSync(path.join(__dirname, '..', 'mysubbies-invoice.html'), 'utf8');
  assert.match(admin, /Record payment received/);
  assert.match(admin, /Payment history/);
  assert.match(admin, /downloadInvoicePaymentReceipt/);
  assert.match(customer, /Balance remaining/);
  assert.match(customer, /downloadReceipt/);
  assert.match(apiSource(), /payments: publicView\s*\? serializedPayments\.map/);
});

test('admin has a dedicated invoice register with balances and quote drill-through', () => {
  const admin = fs.readFileSync(path.join(__dirname, '..', 'mysubbies-admin-portal.html'), 'utf8');
  const api = apiSource();
  assert.match(admin, />Invoices<\/button>/);
  assert.match(admin, /function renderInvoicesTab/);
  assert.match(admin, /Outstanding balance/);
  assert.match(admin, /openInvoiceQuote/);
  assert.match(api, /action === 'list_invoices'/);
  assert.match(api, /quoteNumber: quoteNumberById/);
});

function apiSource() {
  return fs.readFileSync(path.join(__dirname, '..', 'api', 'quotes.js'), 'utf8');
}
