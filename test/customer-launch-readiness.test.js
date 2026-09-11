const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const homepage = fs.readFileSync('mysubbies-website.html', 'utf8');
const booking = fs.readFileSync('mysubbies-booking.html', 'utf8');
const depositApi = fs.readFileSync('api/create-deposit-intent.js', 'utf8');
const webhook = fs.readFileSync('api/stripe-webhook.js', 'utf8');
const leadSchema = fs.readFileSync('supabase/schema_v21_customer_leads.sql', 'utf8');
const admin = fs.readFileSync('mysubbies-admin-portal.html', 'utf8');

test('campaign attribution preserves every supported UTM field', () => {
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) {
    assert.match(homepage, new RegExp(`['"]${key}['"]`));
    assert.match(depositApi, new RegExp(`${key}: bounded\\(campaign\\.${key}\\)`));
  }
  assert.match(booking, /attribution: getAttribution\(\)/);
});

test('admin CRM exposes required lead fields and launch filters', () => {
  for (const label of ['Customer','Contact','Service','Suburb','Source / campaign','Stage','Quote','Booking','Created']) assert.match(admin, new RegExp(label));
  for (const stage of ['NEW','QUOTE_REQUESTED','BOOKING_STARTED','BOOKED','LOST']) assert.match(admin, new RegExp(stage));
});

test('lead capture is authenticated, data-minimal and converts on paid deposit', () => {
  assert.ok(depositApi.indexOf("requireAccount(supabase, req, 'customer')") < depositApi.indexOf("from('customer_leads')"));
  assert.doesNotMatch(leadSchema, /password|card|payment_method/i);
  assert.match(depositApi, /'BOOKED' : 'BOOKING_STARTED'/);
  assert.match(webhook, /stage: 'BOOKED', booking_status: 'deposit_paid'/);
  assert.match(leadSchema, /enable row level security/);
});

test('booking success accurately explains next steps and provides both portal actions', () => {
  assert.match(booking, /Booking received/);
  assert.match(booking, /arranging the appropriate local professional/);
  assert.match(booking, /additional job information/);
  assert.match(booking, /once they are genuinely confirmed/);
  assert.match(booking, /View my booking/);
  assert.match(booking, /Go to my account/);
});
