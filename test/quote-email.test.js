const test = require('node:test');
const assert = require('node:assert/strict');

const { renderQuoteEmail, serviceUrl } = require('../api/_lib/quoteEmail');

function email(overrides = {}) {
  return renderQuoteEmail({
    quote: { quote_number: 2042 },
    version: {
      customer_snapshot: { name: 'Ava Nguyen' },
      property_snapshot: { suburb: 'Richmond' },
      line_items: [{ description: 'Garden clean-up', qty: 2, unit: 'hours', unitPriceCents: 61725, lineTotalCents: 123450 }],
      scope_text: 'Prepare garden beds\nRemove green waste',
      inclusions_text: 'Labour\nMaterials',
      subtotal_ex_gst_cents: 112227,
      gst_cents: 11223,
      total_inc_gst_cents: 123450,
      expires_at: '2026-10-10T00:00:00.000Z',
    },
    secureQuoteUrl: 'https://preview.example/mysubbies-quote.html?token=secure-token',
    sourceCategory: 'Gardening & Lawn Mowing',
    recommendations: [
      { category: 'Fencing', displayName: 'Fencing & gates', image: 'images/categories/fencing.jpg', startingPriceDollars: 360, destination: { page: 'mysubbies-website.html#categories', category: 'Fencing' } },
      { category: 'Property Maintenance', displayName: 'Property Maintenance', image: 'images/categories/property-maintenance.jpg', startingPriceDollars: null, destination: { page: 'mysubbies-website.html#categories', category: 'Property Maintenance' } },
    ],
    ...overrides,
  });
}

test('premium quote email includes customer, quote summary, total and secure CTA', () => {
  const html = email();
  assert.match(html, /Hi Ava,/);
  assert.match(html, /Quote #2042/);
  assert.match(html, /\$1,234\.50/);
  assert.match(html, /https:\/\/preview\.example\/mysubbies-quote\.html\?token=secure-token/);
  assert.match(html, />View your quote →<\/a>/);
  assert.doesNotMatch(html, /View &amp; accept your quote/);
  assert.match(html, /\.primary-button:hover,\.primary-button:active\{background:#E6BF00!important\}/);
  assert.match(html, /class="primary-button"[^>]*background:#FFD400;color:#111111/);
  assert.match(html, /Richmond/);
  assert.match(html, /Prepared for Ava Nguyen/);
  assert.match(html, /Itemised quote/);
  assert.match(html, /Garden clean-up/);
  assert.match(html, /2 hours/);
  assert.match(html, /Subtotal \(ex\. GST\)/);
  assert.match(html, /\$1,122\.27/);
  assert.match(html, /GST \(10%\)/);
  assert.match(html, /\$112\.23/);
  assert.match(html, /Prepare garden beds<br>Remove green waste/);
  assert.match(html, /Labour<br>Materials/);
  assert.match(html, /A PDF copy is attached/);
});

test('itemised pricing uses accessible table headings and email document metadata', () => {
  const html = email();
  assert.match(html, /<html lang="en" dir="ltr">/);
  assert.match(html, /<title>Your MySubbies quote is ready \(Quote #2042\)<\/title>/);
  assert.match(html, /<th scope="col"[^>]*>Description<\/th>/);
  assert.match(html, /<th scope="col"[^>]*>Qty<\/th>/);
  assert.match(html, /<th scope="col"[^>]*>Price<\/th>/);
});

test('email recommendations show authoritative rates and estimate fallback', () => {
  const html = email();
  assert.match(html, /Something else planned for your property/);
  assert.match(html, /Fencing &amp; gates/);
  assert.match(html, /From \$360/);
  assert.match(html, /Get an estimate/);
  assert.match(html, /https:\/\/preview\.example\/mysubbies-website\.html\?service=Fencing#categories/);
});

test('email recommendation URLs contain no quote token or customer identity', () => {
  const url = serviceUrl({ category: 'Painting', destination: { page: 'mysubbies-website.html#categories' } }, 'https://preview.example/mysubbies-quote.html?token=secret');
  assert.equal(url, 'https://preview.example/mysubbies-website.html?service=Painting#categories');
  assert.doesNotMatch(url, /token|Ava|2042/);
});

test('recommendations do not change the displayed quote total', () => {
  const withoutRecommendations = email({ recommendations: [] });
  const withRecommendations = email();
  assert.match(withoutRecommendations, /\$1,234\.50/);
  assert.match(withRecommendations, /\$1,234\.50/);
});

test('multiline quote descriptions retain their formatting in email', () => {
  const html = email({
    version: {
      customer_snapshot: { name: 'Ava Nguyen' },
      property_snapshot: {},
      line_items: [{ description: '• Supply fencing\n\n• Posts concreted into ground' }],
      total_inc_gst_cents: 10000,
    },
    sourceCategory: null,
    recommendations: [],
  });
  assert.ok(html.includes('• Supply fencing<br><br>• Posts concreted into ground'));
});

test('customer, service and recommendation content is HTML escaped', () => {
  const html = email({
    sourceCategory: '<img src=x onerror=alert(1)>',
    version: {
      customer_snapshot: { name: '<script>alert(1)</script>' },
      property_snapshot: { suburb: 'Richmond & Co' },
      line_items: [{ description: '<b>Unsafe</b>' }],
      total_inc_gst_cents: 10000,
    },
    recommendations: [{ category: 'Paint & Repair', displayName: '<svg onload=alert(1)>', image: 'images/categories/painting.jpg', startingPriceDollars: null, destination: { page: 'mysubbies-website.html#categories' } }],
  });
  assert.doesNotMatch(html, /<script>|<svg onload|<img src=x/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;svg onload=alert\(1\)&gt;/);
  assert.match(html, /Richmond &amp; Co/);
});
