const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');

const admin = readFileSync('mysubbies-admin-portal.html', 'utf8');
const adminApi = readFileSync('api/admin-account.js', 'utf8');
const listApi = readFileSync('api/get-admin-list.js', 'utf8');
const migration = readFileSync('supabase/schema_v25_admin_customer_profile.sql', 'utf8');
const customerAddressMigration = readFileSync('supabase/schema_v27_customer_address_locations.sql', 'utf8');

test('successful admin login reveals the sidebar without a refresh', () => {
  const login = admin.slice(admin.indexOf('async function adminLogin()'), admin.indexOf('function adminLogout()'));
  assert.match(login, /classList\.remove\('logged-out'\)/);
  assert.match(login, /hydrateDisputesFromServer\(\)/);
  assert.match(login, /hydrateInquiriesFromServer\(\)/);
});

test('logged-out admin header hides authenticated controls', () => {
  assert.match(admin, /body\.logged-out \.navlinks \{ display:none; \}/);
  assert.match(admin, /<div class="navlinks">[\s\S]*adminLogout\(\)/);
});

test('customer View writes the returned detail page into the app', () => {
  assert.match(admin, /if \(selectedCustomerId \|\| selectedCustomerEmail\) \{\s*app\.innerHTML = renderCustomerDetail\(\)/);
  assert.match(admin, /function openCustomerDetail\(customerId\)/);
  assert.match(admin, /onclick="openCustomerDetail\('\$\{c\.id\}'\)"/);
});

test('customer profile editing is authorised and database-backed', () => {
  assert.match(admin, /action: 'updateProfile'/);
  assert.match(adminApi, /if \(role === 'customer' && action === 'updateProfile'\)/);
  assert.match(adminApi, /requireAdmin\(req, res\)/);
  assert.match(adminApi, /admin_update_customer_profile/);
  assert.match(migration, /update jobs/);
  assert.match(migration, /update customer_credits/);
  assert.match(migration, /Issued quote snapshots are deliberately immutable/);
});

test('admin can select and save a verified customer address', () => {
  assert.match(admin, /id="customerEditAddress"/);
  assert.match(admin, /MySubbiesAddress\.attach\('customerEditAddress'/);
  assert.match(admin, /MySubbiesAddress\.getSelection\('customerEditAddress'\)/);
  assert.match(adminApi, /admin_update_customer_profile_v2/);
  assert.match(adminApi, /p_address_latitude/);
  assert.match(listApi, /address_formatted/);
  assert.match(customerAddressMigration, /alter table customers add column if not exists address_verified/);
  assert.match(customerAddressMigration, /Issued quote and[\s\S]*snapshots remain unchanged/);
  const detailRender = admin.slice(admin.indexOf('if (selectedCustomerId || selectedCustomerEmail)'), admin.indexOf('const jobs = getJobs()'));
  assert.match(detailRender, /app\.innerHTML = renderCustomerDetail\(\);\s*initialiseCustomerAddressEditor\(\);/);
});

test('contractor coverage map receives structured verified locations', () => {
  for (const field of ['address_latitude', 'address_longitude', 'address_verified', 'address_suburb']) {
    assert.match(listApi, new RegExp(field));
  }
  assert.match(admin, /data-tab="coverage"/);
  assert.match(admin, /function initialiseContractorCoverageMap\(\)/);
  assert.match(admin, /contractorHasMapLocation/);
  assert.match(admin, /Google Maps is not configured/);
});

test('admin can edit a contractor and verify the map address', () => {
  assert.match(admin, /function openContractorEditor\(contractorId\)/);
  assert.match(admin, /MySubbiesAddress\.attach\('contractorEditAddress'/);
  assert.match(admin, /MySubbiesAddress\.getSelection\('contractorEditAddress'\)/);
  assert.match(admin, /Edit &amp; verify/);
  assert.match(adminApi, /role === 'contractor' && action === 'updateProfile'/);
  assert.match(adminApi, /address_verified: true/);
  assert.match(adminApi, /address_latitude: latitude/);
  assert.match(adminApi, /full_application: mergedApplication/);
});
