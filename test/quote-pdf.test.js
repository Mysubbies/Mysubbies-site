const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const admin = fs.readFileSync(path.join(__dirname, '..', 'mysubbies-admin-portal.html'), 'utf8');
const customer = fs.readFileSync(path.join(__dirname, '..', 'mysubbies-quote.html'), 'utf8');

test('proposal PDFs use wide description-led columns and measured description details', () => {
  for (const source of [admin, customer]) {
    assert.match(source, /cellWidth:108/);
    assert.match(source, /cellWidth:18/);
    assert.match(source, /cellWidth:25/);
    assert.match(source, /cellWidth:29/);
    assert.match(source, /Measurements:/);
    assert.match(source, /didDrawCell/);
  }
});

test('proposal PDFs show prepared-for contact details and Valid Until in the header', () => {
  assert.match(customer, /VALID UNTIL/);
  assert.match(customer, /property\.address/);
  assert.match(customer, /property\.postcode/);
  assert.match(customer, /customer\.email/);
  assert.match(customer, /customer\.phone \|\| customer\.mobile/);
  assert.match(admin, /validUntil: v\.expiresAt/);
});

test('proposal details begin on a new page and include acceptance and page numbering', () => {
  assert.match(customer, /doc\.addPage\(\); let sectionY = 24/);
  for (const source of [admin, customer]) {
    assert.match(source, /Scope of Works/);
    assert.match(source, /Terms \/ Important Information/);
    assert.match(source, /Quote Acceptance/);
    assert.match(source, /Page \$\{i\} of \$\{pageCount\}/);
    assert.match(source, /TOTAL INC GST/);
  }
});

test('Quote 13 premium comparison PDF is present', () => {
  const sample = fs.readFileSync(path.join(__dirname, '..', 'artifacts', 'quote-13-premium-sample.pdf'));
  assert.equal(sample.subarray(0, 8).toString(), '%PDF-1.4');
  assert.ok(sample.length > 3000);
});
