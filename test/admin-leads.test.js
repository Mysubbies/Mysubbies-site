const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('admin portal exposes and renders the Leads tab', () => {
  const html = read('mysubbies-admin-portal.html');
  assert.match(html, /data-tab="leads"/);
  assert.match(html, /get-admin-list\?type=leads/);
  assert.match(html, /tab === 'leads' \? renderLeadsTab\(\)/);
  assert.match(html, /leadSearchQuery/);
});

test('admin lead list remains behind server-side admin authentication', () => {
  const api = read('api/get-admin-list.js');
  assert.match(api, /requireAdmin\(req, res\)/);
  assert.match(api, /if \(type === 'leads'\)/);
  assert.match(api, /from\('customer_leads'\)/);
});

test('booking lead capture requires customer authentication', () => {
  const api = read('api/customer-lead-start.js');
  const booking = read('mysubbies-booking.html');
  assert.match(api, /requireAccount\(supabase, req, 'customer'\)/);
  assert.match(booking, /Authorization: 'Bearer ' \+ leadToken/);
  assert.match(booking, /fetch\('\/api\/customer-lead-start'/);
});

test('lead schema enables RLS for lead and event records', () => {
  const sql = read('supabase/schema_v26_customer_leads.sql');
  assert.match(sql, /alter table customer_leads enable row level security/i);
  assert.match(sql, /alter table customer_lead_events enable row level security/i);
  assert.match(sql, /BOOKING_STARTED/);
});
