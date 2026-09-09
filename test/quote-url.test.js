const test = require('node:test');
const assert = require('node:assert/strict');

const { PRODUCTION_QUOTE_URL, quoteBaseUrl } = require('../api/_lib/quoteUrl');

test('explicit quote URL remains authoritative', () => {
  assert.equal(quoteBaseUrl({ QUOTE_BASE_URL: 'https://staging.example/quote' }), 'https://staging.example/quote');
});

test('Vercel Preview uses its branch URL instead of production', () => {
  assert.equal(
    quoteBaseUrl({ VERCEL_BRANCH_URL: 'feature-branch.example.vercel.app', VERCEL_URL: 'deployment.example.vercel.app' }),
    'https://feature-branch.example.vercel.app/mysubbies-quote.html',
  );
});

test('Vercel deployment URL is the safe Preview fallback', () => {
  assert.equal(quoteBaseUrl({ VERCEL_URL: 'deployment.example.vercel.app' }), 'https://deployment.example.vercel.app/mysubbies-quote.html');
});

test('non-Vercel runtime retains the production quote URL', () => {
  assert.equal(quoteBaseUrl({}), PRODUCTION_QUOTE_URL);
});
