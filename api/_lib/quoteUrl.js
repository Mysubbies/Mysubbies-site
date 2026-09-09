const PRODUCTION_QUOTE_URL = 'https://app.mysubbies.com.au/mysubbies-quote.html';

function withHttps(value) {
  if (!value) return null;
  return /^https:\/\//i.test(value) ? value : `https://${value}`;
}

function quoteBaseUrl(env = process.env) {
  if (env.QUOTE_BASE_URL) return String(env.QUOTE_BASE_URL).replace(/\/$/, '');
  // Vercel supplies these system variables per deployment. Prefer the stable
  // branch URL, then the deployment URL, so Preview emails remain on Preview
  // without trusting a request Host header or requiring a production change.
  const previewOrigin = withHttps(env.VERCEL_BRANCH_URL || env.VERCEL_URL);
  return previewOrigin ? `${previewOrigin.replace(/\/$/, '')}/mysubbies-quote.html` : PRODUCTION_QUOTE_URL;
}

module.exports = { PRODUCTION_QUOTE_URL, quoteBaseUrl };
