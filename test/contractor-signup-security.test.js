const test = require('node:test');
const assert = require('node:assert/strict');
const { clientFingerprint, looksLikeBot, enforceSignupRateLimit, MAX_ATTEMPTS_PER_HOUR } = require('../api/_lib/signupSecurity');

test('signup honeypot and implausibly fast submissions are rejected without revealing why', () => {
  assert.equal(looksLikeBot({ website: 'spam', formStartedAt: Date.now() - 5000 }), true);
  assert.equal(looksLikeBot({ website: '', formStartedAt: Date.now() }), true);
  assert.equal(looksLikeBot({ website: '', formStartedAt: Date.now() - 5000 }), false);
});

test('rate-limit fingerprint is hashed and stable, never storing the raw IP', () => {
  const req = { headers: { 'x-forwarded-for': '203.0.113.8, 10.0.0.1' } };
  const hash = clientFingerprint(req);
  assert.equal(hash.length, 64); assert.doesNotMatch(hash, /203\.0\.113\.8/); assert.equal(hash, clientFingerprint(req));
});

test('persistent signup limiter blocks the sixth hourly attempt', async () => {
  let inserted = false;
  const query = { select() { return this; }, eq() { return this; }, gte() { return Promise.resolve({ count: MAX_ATTEMPTS_PER_HOUR, error: null }); },
    insert() { inserted = true; return Promise.resolve({ error: null }); } };
  const result = await enforceSignupRateLimit({ from: () => query }, { headers: {}, socket: { remoteAddress: '127.0.0.1' } });
  assert.equal(result.ok, false); assert.equal(inserted, false);
});
