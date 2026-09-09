const test = require('node:test');
const assert = require('node:assert/strict');

const { renderQuoteEmail, serviceUrl } = require('../api/_lib/quoteEmail');

function email(overrides = {}) {
  return renderQuoteEmail({
    quote: { quote_number: 2042 },
    version: {
      customer_snapshot: { name: 'Ava Nguyen' },
      property_snapshot: { suburb: 'Richmond' },
      line_items: [{ description: 'Garden clean-up' }],
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
  assert.match(html, /View &amp; accept your quote/);
  assert.match(html, /\.primary-button:hover,\.primary-button:active\{background:#E6BF00!important\}/);
  assert.match(html, /class="primary-button"[^>]*background:#FFD400;color:#111111/);
  assert.match(html, /Richmond/);
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
