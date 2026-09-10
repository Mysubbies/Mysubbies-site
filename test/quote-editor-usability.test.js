const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const admin = fs.readFileSync(path.join(__dirname, '..', 'mysubbies-admin-portal.html'), 'utf8');
const customerQuote = fs.readFileSync(path.join(__dirname, '..', 'mysubbies-quote.html'), 'utf8');
const quoteApi = fs.readFileSync(path.join(__dirname, '..', 'api', 'quotes.js'), 'utf8');
const { calculateAreaQuantity, computeQuoteTotals } = require('../api/_lib/quoteMath');

test('quote editor uses large multiline description and scope fields', () => {
  assert.match(admin, /Description \/ Materials &amp; Inclusions<\/label><textarea[^>]+quote-description-input[^>]+rows="6"/);
  assert.match(admin, /Scope of Works \/ Notes \/ Inclusions<\/label><textarea[^>]+quote-scope-input[^>]+rows="8"/);
  assert.match(admin, /\.quote-description-input \{ min-height:142px/);
  assert.match(admin, /\.quote-scope-input \{ min-height:190px/);
});

test('normal quote typing updates state and totals without replacing the editor DOM', () => {
  const builder = admin.slice(admin.indexOf('function renderQuoteBuilder()'), admin.indexOf('function renderQuoteBuilderPreview()'));
  assert.match(builder, /oninput="onQuoteLineItemField\('[^']+','qty',this\.value\); updateQuoteBuilderTotals\(\);"/);
  assert.doesNotMatch(builder, /oninput="[^"]*render\(\)[^"]*"/);
  assert.match(admin, /if \(!quoteBuilderOpen\) render\(\);/);
});

test('line breaks are preserved in admin previews and the customer quote', () => {
  assert.match(admin, /quote-preserve-lines/);
  assert.match(customerQuote, /\.item-description \{ white-space:pre-wrap/);
  assert.match(customerQuote, /<td class="item-description">\$\{escapeHtml\(it\.description\)\}<\/td>/);
});

test('square-metre measurements calculate quantity and existing quote totals', () => {
  assert.equal(calculateAreaQuantity(7.5, 4), 30);
  assert.equal(calculateAreaQuantity(7.5, 4.2), 31.5);
  assert.equal(calculateAreaQuantity(-2, 4), null);
  assert.equal(calculateAreaQuantity('invalid', 4), null);

  const totals = computeQuoteTotals([{ unit: 'm²', qty: 1, lengthM: 7.5, widthM: 4, unitPriceCents: 1000 }]);
  assert.equal(totals.lineItems[0].qty, 30);
  assert.equal(totals.lineItems[0].calculatedAreaM2, 30);
  assert.equal(totals.lineItems[0].lengthM, 7.5);
  assert.equal(totals.lineItems[0].widthM, 4);
  assert.equal(totals.totalIncGstCents, 30000);
});

test('area measurements are ignored for non-square-metre services', () => {
  const totals = computeQuoteTotals([{ unit: 'lm', qty: 7.5, lengthM: 7.5, widthM: 4, unitPriceCents: 1000 }]);
  assert.equal(totals.lineItems[0].qty, 7.5);
  assert.equal(Object.hasOwn(totals.lineItems[0], 'widthM'), false);
  assert.equal(totals.totalIncGstCents, 7500);
});

test('live area input updates quantity and totals without rendering the editor', () => {
  const handler = admin.slice(admin.indexOf('function onQuoteAreaMeasurement'), admin.indexOf('function autoGrowQuoteTextarea'));
  assert.match(handler, /Math\.round\(li\.lengthM \* li\.widthM \* 10000\) \/ 10000/);
  assert.match(handler, /updateQuoteBuilderTotals\(\)/);
  assert.doesNotMatch(handler, /render\(/);
  assert.match(admin, /Calculated Area \(m²\)/);
  assert.match(admin, /lengthM: li\.lengthM, widthM: li\.widthM, calculatedAreaM2: li\.calculatedAreaM2/);
});

test('actual quote sends BCC Accounts while retaining the customer recipient', () => {
  const sendHandler = quoteApi.slice(quoteApi.indexOf('async function handleSendQuoteEmail'), quoteApi.indexOf('// AI-assisted drafting'));
  assert.match(sendHandler, /to: customerEmail,\s*\/\/[\s\S]*bcc: 'accounts@mysubbies\.com\.au'/);
  assert.equal((sendHandler.match(/sendEmailWithResult\(/g) || []).length, 1);
  assert.doesNotMatch(sendHandler, /to: 'accounts@mysubbies\.com\.au'/);
});
