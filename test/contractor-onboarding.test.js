const test = require('node:test');
const assert = require('node:assert/strict');
const { AGREEMENT_VERSION, validAbn, validateApplication, applicationToken, tokenHash, receivedEmail, approvedEmail, rejectedEmail } = require('../api/_lib/contractorOnboarding');

function valid(overrides = {}) {
  return { business: 'Synthetic Plumbing Pty Ltd', address: '1 Test St, Coburg VIC 3058', contact: 'Test Person',
    phone: '0412345678', email: 'contractor@example.test', abn: '51824753556', trades: ['Plumbing'],
    regions: ['Northern Melbourne'], availability: ['Weekdays'], licenceHeld: 'yes', insuranceHeld: true,
    agreementAccepted: true, agreementVersion: AGREEMENT_VERSION, agreementAcceptedAt: '2026-09-10T00:00:00.000Z', ...overrides };
}

test('successful synthetic contractor application validates with explicit current agreement consent', () => {
  assert.equal(validAbn('51 824 753 556'), true);
  assert.equal(validateApplication(valid()), null);
});

test('missing fields, invalid email/phone/ABN and missing terms are rejected', () => {
  assert.match(validateApplication(valid({ business: '' })), /business/);
  assert.match(validateApplication(valid({ email: 'bad' })), /email/);
  assert.match(validateApplication(valid({ phone: '123' })), /mobile/);
  assert.match(validateApplication(valid({ abn: '11111111111' })), /ABN/);
  assert.match(validateApplication(valid({ agreementAccepted: false })), /Terms/);
});

test('document update tokens are high entropy and only their hashes need storage', () => {
  const first = applicationToken(); const second = applicationToken();
  assert.notEqual(first, second); assert.equal(tokenHash(first).length, 64); assert.notEqual(tokenHash(first), tokenHash(second));
});

test('onboarding email templates contain required operational guidance', () => {
  const received = receivedEmail(valid());
  assert.equal(received.subject, 'Thanks for joining the MySubbies Contractor Network');
  assert.match(received.html, /does not guarantee/i); assert.match(received.html, /independent contractor/i);
  const approved = approvedEmail({ categories: ['Plumbing'], full_application: valid() });
  assert.match(approved.subject, /approved/); assert.match(approved.html, /Activate your account/);
  for (const phrase of ['accept or decline', 'on the way', 'before and after photos', 'Payment follows', 'licence and insurance']) assert.match(approved.html, new RegExp(phrase, 'i'));
  assert.match(rejectedEmail('Upload insurance', true).html, /Upload insurance/);
  assert.match(rejectedEmail('Upload insurance', true).html, /reviewed again/);
});
