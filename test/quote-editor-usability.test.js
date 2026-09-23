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

test('quote textareas stay stable while typing and mobile fields stack cleanly', () => {
  const builder = admin.slice(admin.indexOf('function renderQuoteBuilder()'), admin.indexOf('function renderQuoteBuilderPreview()'));
  assert.doesNotMatch(builder, /autoGrowQuoteTextarea/);
  assert.doesNotMatch(admin, /el\.style\.height = el\.scrollHeight/);
  assert.match(admin, /\.quote-item-grid \{ grid-template-columns:1fr 1fr !important/);
  assert.match(admin, /\.quote-item-description \{ grid-column:1\/-1/);
  assert.match(admin, /\.quote-mobile-actions \{ position:sticky; bottom:0/);
  assert.match(admin, /@media \(max-width:520px\)/);
  assert.match(admin, /if \(quoteBuilderOpen\) return; \/\/ never disturb a quote while the admin is typing/);
  assert.match(admin, /if \(!quoteBuilderOpen\) render\(\);/);
  assert.match(admin, /\.quote-builder-grid \.fieldinput \{ font-size:16px; \}/);
  assert.match(admin, /body\.quote-editor-active \.mobile-tabbar \{ display:none !important; \}/);
});

test('quote list and detail views use mobile card layouts instead of wide tables', () => {
  assert.match(admin, /class="quote-detail-items"/);
  assert.match(admin, /data-label="Unit price"/);
  assert.match(admin, /class="quote-list-table"/);
  assert.match(admin, /data-label="Customer"/);
  assert.match(admin, /\.quote-detail-actions \{ display:grid; grid-template-columns:1fr 1fr; \}/);
});

test('admin can duplicate an existing quote into a separate editable draft', () => {
  assert.match(admin, /onclick="duplicateSelectedQuote\(\)">⧉ Duplicate as new quote<\/button>/);
  const duplicate = admin.slice(admin.indexOf('function duplicateSelectedQuote()'), admin.indexOf('function renderQuoteDetailView()'));
  assert.match(duplicate, /quoteId: null/);
  assert.match(duplicate, /copiedFromQuoteNumber: quote\.quoteNumber/);
  assert.match(duplicate, /customerId: quote\.customerId \|\| null/);
  assert.match(duplicate, /lineItems: .*\.map\(li => \(\{ \.\.\.li, id: 'li_' \+ Math\.random/);
  assert.match(duplicate, /scopeText: v\.scopeText \|\| ''/);
  assert.match(duplicate, /paymentTermsText: v\.paymentTermsText \|\| ''/);
  assert.match(duplicate, /propertyPostcode: .*propertySnapshot\.postcode/);
  assert.match(admin, /Copied from Quote #\$\{d\.copiedFromQuoteNumber\}/);
});

test('admin can safely cancel, archive and restore quotes', () => {
  assert.match(admin, /onclick="cancelSelectedQuote\(\)">Cancel quote<\/button>/);
  assert.match(admin, /\['draft', 'sent'\]\.includes\(quote\.currentStatus\)/);
  assert.match(admin, /onclick="setSelectedQuoteArchived\(/);
  assert.match(admin, /Archived Quotes/);
  assert.match(admin, /action: 'cancel_quote'/);
  assert.match(admin, /action: archived \? 'archive_quote' : 'unarchive_quote'/);
  assert.match(quoteApi, /if \(!\['draft', 'sent'\]\.includes\(quote\.current_status\)\)/);
  assert.match(quoteApi, /eventType: 'cancelled'/);
  assert.match(quoteApi, /eventType: archived \? 'archived' : 'unarchived'/);
  assert.match(quoteApi, /const showArchived = archived === 'true'/);
  assert.match(quoteApi, /document_access_tokens.*update\(\{ revoked_at: nowIso \}\)/s);
});

test('quote resend confirms and allows editing the recipient email', () => {
  const resend = admin.slice(admin.indexOf('async function resendQuoteEmail()'), admin.indexOf('async function reviseSelectedQuote()'));
  assert.match(resend, /prompt\('Check the customer email before resending/);
  assert.match(resend, /const recipientEmail = enteredEmail\.trim\(\)\.toLowerCase\(\)/);
  assert.match(resend, /Resend Quote #\$\{quote\.quoteNumber\} to \$\{recipientEmail\}/);
  assert.match(resend, /quoteId: selectedQuoteId, recipientEmail/);
  assert.match(quoteApi, /const \{ quoteId, recipientEmail \} = req\.body \|\| \{\}/);
  assert.match(quoteApi, /const requestedEmail = String\(recipientEmail \|\| ''\)\.trim\(\)\.toLowerCase\(\)/);
});

test('admin portal paints immediately and hydrates live data in the background', () => {
  const workspace = admin.slice(admin.indexOf('function startAdminWorkspace()'), admin.indexOf('async function checkAdminAuth()'));
  assert.match(workspace, /render\(\);/);
  assert.match(workspace, /Promise\.allSettled\(/);
  assert.ok(workspace.indexOf('render();') < workspace.indexOf('Promise.allSettled('));
  const auth = admin.slice(admin.indexOf('async function checkAdminAuth()'), admin.indexOf('async function adminLogout()'));
  assert.doesNotMatch(auth, /Promise\.all\(\[hydrateJobsFromServer\(\), hydrateApplicationsFromServer\(\)/);
  assert.match(admin, /if \(tab === 'quotes' && !staffListData && !staffListLoading\) loadStaffList\(\)/);
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

test('customer quote presents Ask a question as an app action button', () => {
  assert.match(customerQuote, /<button class="btn btn-outline" onclick="openQuestionModal\(\)">Ask a question<\/button>/);
  assert.doesNotMatch(customerQuote, /btn btn-link" onclick="openQuestionModal/);
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

test('linear-metre length populates quantity without applying width', () => {
  const totals = computeQuoteTotals([{ unit: 'LM', qty: 1, lengthM: 6.5, widthM: 4, unitPriceCents: 12000 }]);
  assert.equal(totals.lineItems[0].qty, 6.5);
  assert.equal(totals.lineItems[0].lengthM, 6.5);
  assert.equal(Object.hasOwn(totals.lineItems[0], 'widthM'), false);
  assert.equal(totals.totalIncGstCents, 78000);
});

test('live area input updates quantity and totals without rendering the editor', () => {
  const handler = admin.slice(admin.indexOf('function onQuoteAreaMeasurement'), admin.indexOf('function onQuoteRateCardPick'));
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

test('custom m² workflow exposes measurements and produces 26.00 quantity', () => {
  assert.match(admin, /<select class="fieldinput" onchange="onQuoteUnitField\('[^']+',this\.value\)">\$\{quoteUnitOptions\(li\.unit\)\}<\/select>/);
  assert.match(admin, /\['m²', 'LM', 'each', 'hour', 'visit', 'gate'/);
  assert.match(admin, /areaFields\.hidden = !isSquareMetreUnit\(value\)/);
  assert.match(admin, /qtyInput\.value = li\.calculatedAreaM2\.toFixed\(2\)/);
  const totals = computeQuoteTotals([{ unit: 'm²', lengthM: 6.5, widthM: 4, qty: 1, unitPriceCents: 15000 }]);
  assert.equal(totals.lineItems[0].qty.toFixed(2), '26.00');
  assert.equal(totals.totalIncGstCents, 390000);
});
