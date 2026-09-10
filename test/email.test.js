const test = require('node:test');
const assert = require('node:assert/strict');

function loadEmail(fromEmail) {
  if (fromEmail === undefined) delete process.env.RESEND_FROM_EMAIL;
  else process.env.RESEND_FROM_EMAIL = fromEmail;
  delete require.cache[require.resolve('../api/_lib/email')];
  return require('../api/_lib/email');
}

test('quote email reports missing Preview configuration without exposing a secret', async () => {
  delete process.env.RESEND_API_KEY;
  const { sendEmailWithResult } = loadEmail();
  const result = await sendEmailWithResult({ to: 'customer@example.com', subject: 'Quote', html: '<p>Quote</p>' });
  assert.equal(result.ok, false);
  assert.match(result.error, /RESEND_API_KEY/);
});

test('Resend rejection is converted to a safe configuration error', async () => {
  process.env.RESEND_API_KEY = 're_test_secret_that_must_not_escape';
  const originalFetch = global.fetch;
  const originalError = console.error;
  let logged;
  console.error = (...args) => { logged = args; };
  global.fetch = async () => ({
    ok: false,
    status: 403,
    text: async () => JSON.stringify({ name: 'validation_error', message: 'Domain not verified for customer@example.com' }),
  });
  try {
    const { sendEmailWithResult } = loadEmail('MySubbies <quotes@example.test>');
    const result = await sendEmailWithResult({ to: 'customer@example.com', subject: 'Quote', html: '<p>Quote</p>' });
    assert.equal(result.code, 'email_configuration_error');
    assert.match(result.error, /sending domain/);
    assert.doesNotMatch(JSON.stringify(result), /re_test_secret|customer@example\.com/);
    assert.doesNotMatch(JSON.stringify(logged), /re_test_secret|customer@example\.com|Domain not verified/);
  } finally {
    global.fetch = originalFetch;
    console.error = originalError;
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM_EMAIL;
  }
});

test('configured quote email sends the selected verified from address', async () => {
  process.env.RESEND_API_KEY = 're_test';
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => { request = { url, options }; return { ok: true }; };
  try {
    const { sendEmailWithResult } = loadEmail('MySubbies Quotes <quotes@example.test>');
    const result = await sendEmailWithResult({ to: 'customer@example.com', bcc: 'accounts@mysubbies.com.au', subject: 'Quote', html: '<p>Quote</p>' });
    assert.equal(result.ok, true);
    assert.equal(request.url, 'https://api.resend.com/emails');
    const payload = JSON.parse(request.options.body);
    assert.equal(payload.from, 'MySubbies Quotes <quotes@example.test>');
    assert.equal(payload.to, 'customer@example.com');
    assert.equal(payload.bcc, 'accounts@mysubbies.com.au');
    assert.doesNotMatch(payload.html, /accounts@mysubbies\.com\.au/);
  } finally {
    global.fetch = originalFetch;
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM_EMAIL;
  }
});
