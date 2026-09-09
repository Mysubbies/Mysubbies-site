const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const portal = fs.readFileSync(require.resolve('../mysubbies-customer-portal.html'), 'utf8');
const website = fs.readFileSync(require.resolve('../index.html'), 'utf8');
const booking = fs.readFileSync(require.resolve('../mysubbies-booking.html'), 'utf8');

test('customer can register without entering the booking or payment flow', () => {
  assert.match(portal, /Create your MySubbies account/);
  for (const field of ['signupFirstName', 'signupLastName', 'signupEmail', 'signupMobile', 'signupPassword', 'signupConfirmPassword', 'signupTerms']) assert.match(portal, new RegExp(`id="${field}"`));
  assert.match(portal, /sb\.auth\.signUp\(\{ email, password/);
  assert.match(portal, /No booking or payment is required/);
});

test('new customer sees the required zero-booking welcome state rather than an error', () => {
  assert.match(portal, /Welcome to MySubbies/);
  assert.match(portal, /You haven't booked anything yet\./);
  assert.match(portal, /Book your first service/);
  assert.match(portal, /Request a project quote/);
  assert.match(portal, /if \(allJobs\.length === 0\)/);
});

test('missing or expired session is distinct from a network failure', () => {
  assert.match(portal, /if \(!token\) return 'expired'/);
  assert.match(portal, /if \(res\.status === 401\) return 'expired'/);
  assert.match(portal, /if \(!res\.ok\) return 'error'/);
  assert.match(portal, /Your session has expired\. Please log in again\./);
});

test('existing customer login still uses Supabase password authentication', () => {
  assert.match(portal, /sb\.auth\.signInWithPassword\(\{ email, password \}\)/);
  assert.match(portal, /Don't have an account\?/);
});

test('booking-created and manually-created accounts share Supabase customer identity', () => {
  assert.match(booking, /sb\.auth\.signUp\(\{ email, password \}\)/);
  assert.match(booking, /auth_user_id: data\.user\.id, email/);
  assert.match(portal, /fetch\('\/api\/customer-register'/);
  assert.match(booking, /customerId: pending\.customer\.customerDbId/);
});

test('public and portal navigation consistently uses My Bookings', () => {
  assert.match(website, /mysubbies-customer-portal\.html">My Bookings/);
  assert.match(website, /mysubbies-customer-portal\.html\?signup=1/);
  for (const label of ['My Home', 'My Bookings', 'Home Maintenance', 'Payments', 'Help']) assert.match(portal, new RegExp(`>${label}<`));
});
