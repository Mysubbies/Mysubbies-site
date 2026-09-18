const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const catalog = require(join(root, 'api/_lib/serviceCatalog'));
const propertyApi = readFileSync(join(root, 'api/property-management.js'), 'utf8');
const bookingApi = readFileSync(join(root, 'api/booking-api.js'), 'utf8');
const migration = readFileSync(join(root, 'supabase/schema_v31_property_management.sql'), 'utf8');
const portal = readFileSync(join(root, 'mysubbies-property-portal.html'), 'utf8');
const feedSecurity = require(join(root, 'api/_lib/jobReadSecurity'));

const categories = [{
  label: 'Handyman',
  icon: 'H',
  tasks: [
    { name: 'TV wall mounting', itemId: 'handy-tv', unit: 'unit', rate: 149, minJobPrice: 149 },
    { name: 'Custom carpentry', unit: 'job', rate: null, unavailable: true },
    { name: 'Hidden service', unit: 'job', rate: 50, disabled: true },
  ],
}];

test('AI-safe catalogue separates instant-price and project-quote services', () => {
  const result = catalog.publicCatalog(categories);
  assert.equal(result.length, 1);
  assert.equal(result[0].tasks.length, 2);
  assert.equal(result[0].tasks[0].serviceMode, 'instant_price');
  assert.equal(result[0].tasks[0].rate, 149);
  assert.equal(result[0].tasks[1].serviceMode, 'project_quote');
  assert.equal(result[0].tasks[1].rate, null);
});

test('server estimate uses live rate and minimum price, never an unavailable task', () => {
  assert.equal(catalog.estimateLine(categories, { category: 'Handyman', taskName: 'TV wall mounting', qty: 1 }).totalCents, 14900);
  assert.equal(catalog.estimateLine(categories, { category: 'Handyman', taskName: 'Custom carpentry', qty: 1 }).serviceMode, 'project_quote');
});

test('property management tables are server mediated with RLS and revoked direct access', () => {
  for (const table of ['pm_organisations','pm_members','pm_properties','pm_work_orders','pm_work_order_files','pm_work_order_events']) {
    assert.match(migration, new RegExp('alter table public\\.' + table + ' enable row level security'));
    assert.match(migration, new RegExp('revoke all privileges on table public\\.' + table + ' from anon, authenticated'));
  }
  assert.match(migration, /property-work-orders'.*false/s);
});

test('commercial workflow enforces identity-bound member and MFA-backed admin paths', () => {
  assert.match(propertyApi, /requirePropertyMember\(supabase, req\)/);
  assert.match(propertyApi, /verifyAdminAuth\(req\)/);
  assert.match(propertyApi, /Only the assigned contractor can add completion evidence/);
  assert.match(propertyApi, /Required client approval has not been recorded/);
});

test('pre-assignment contractor feed still hides exact property and customer data', () => {
  const safe = feedSecurity.toSafeUnassignedOffer({
    id: 'pm_test', category: 'Handyman', suburb: 'Craigieburn',
    address: '1 Private Street', customerName: 'Private Org', customerEmail: 'private@example.com',
    access: 'Key under mat', basePrice: 200, items: [{ taskName: 'Repair', qty: 1, unit: 'job', notes: 'private' }],
  }, 55);
  assert.equal(safe.address, undefined);
  assert.equal(safe.customerName, undefined);
  assert.equal(safe.customerEmail, undefined);
  assert.equal(safe.access, undefined);
  assert.equal(safe.items[0].notes, undefined);
});

test('AI job-status endpoint is authenticated and does not expose contractor identity', () => {
  assert.match(bookingApi, /requireAccount\(supabase, req, 'customer'\)/);
  assert.doesNotMatch(bookingApi, /contractorEmail:/);
  assert.match(bookingApi, /pricingModel:/);
});

test('property portal contains requested commercial proposition and approval workflow', () => {
  assert.match(portal, /One maintenance partner\. One portal\. Complete job visibility\./);
  assert.match(portal, /approve-work-order/);
  assert.match(portal, /Request a project quote/);
  assert.match(portal, /recurring maintenance/);
});
