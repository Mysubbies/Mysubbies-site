const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const clients = require('../api/_lib/clients');
const { signAdminToken } = require('../api/_lib/adminAuth');
const { validatePayoutDetails, maskBsb, maskAccountNumber, maskedPayoutDetails } = require('../api/_lib/payoutDetails');

test('Australian payout details validate and mask correctly', () => {
  const result = validatePayoutDetails({ accountName:'Test Trade Pty Ltd', bsb:'123-456', accountNumber:'12345678', bankName:'Test Bank', confirmed:true });
  assert.deepEqual(result.value, { accountName:'Test Trade Pty Ltd', bsb:'123456', accountNumber:'12345678', bankName:'Test Bank' });
  assert.equal(maskBsb('123456'), '***-456');
  assert.equal(maskAccountNumber('12345678'), '******5678');
  assert.deepEqual(maskedPayoutDetails({ payout_account_name:'Test Trade Pty Ltd', payout_bsb:'123456', payout_account_number:'12345678', payout_bank_name:'Test Bank', payout_details_confirmed:true, payout_details_updated_at:'2026-09-12' }), {
    complete:true, accountName:'Test Trade Pty Ltd', bankName:'Test Bank', maskedBsb:'***-456', maskedAccountNumber:'******5678', confirmed:true, updatedAt:'2026-09-12'
  });
});

test('invalid BSB, account number, account name and missing confirmation are rejected', () => {
  const base = { accountName:'Test Trade', bsb:'123456', accountNumber:'12345678', confirmed:true };
  assert.match(validatePayoutDetails({ ...base, bsb:'12345' }).error, /exactly 6/);
  assert.match(validatePayoutDetails({ ...base, accountNumber:'12345' }).error, /6 to 10/);
  assert.match(validatePayoutDetails({ ...base, accountName:'x' }).error, /2 and 100/);
  assert.match(validatePayoutDetails({ ...base, confirmed:false }).error, /Confirm/);
});

function db({ authUserId='auth-own', contractorUserId='auth-own' } = {}) {
  const updates = [];
  const contractor = { id:'ctr-1', auth_user_id:contractorUserId, email:'own@example.test', business_name:'Own Trade', categories:[],
    full_application:{}, payout_account_name:'Own Trade', payout_bsb:'123456', payout_account_number:'12345678', payout_bank_name:'Bank', payout_details_confirmed:true, payout_details_updated_at:'2026-09-12' };
  return { updates, auth:{ getUser:async () => ({ data:{ user:{ id:authUserId, email:'own@example.test' } }, error:null }), admin:{} }, from(table) {
    assert.equal(table, 'contractors');
    const q = { select(){ return q; }, eq(){ return q; }, maybeSingle:async () => ({ data:contractor, error:null }),
      update(value){ updates.push(value); return q; }, then(resolve,reject){ return Promise.resolve({ error:null }).then(resolve,reject); } };
    return q;
  } };
}
function handlerFor(database) { clients.getSupabase = () => database; delete require.cache[require.resolve('../api/contractor-profile')]; return require('../api/contractor-profile'); }
function invoke(handler, { method='POST', body={}, token }={}) { return new Promise(resolve => {
  const req = { method, body, query:{}, headers:token ? { authorization:`Bearer ${token}` } : {} };
  const res = { code:200, status(code){this.code=code;return this;}, json(value){resolve({status:this.code,body:value});} }; handler(req,res);
}); }

test('contractor securely saves and updates own payout details and receives only masked data', async () => {
  const database = db(); const handler = handlerFor(database);
  const response = await invoke(handler, { body:{ action:'savePayoutDetails', email:'own@example.test', accessToken:'valid', accountName:'Own Trade', bsb:'654-321', accountNumber:'87654321', confirmed:true } });
  assert.equal(response.status, 200); assert.equal(response.body.payoutDetails.maskedBsb, '***-321');
  assert.equal(response.body.payoutDetails.maskedAccountNumber, '******4321');
  assert.equal('accountNumber' in response.body.payoutDetails, false);
  assert.equal(database.updates[0].payout_account_number, '87654321');
});

test('general contractor profile returns masked payout details and never full BSB/account number', async () => {
  const response = await invoke(handlerFor(db()), { method:'GET', token:'valid' });
  assert.equal(response.status, 200);
  assert.equal(response.body.payoutDetails.maskedBsb, '***-456');
  assert.equal(response.body.payoutDetails.maskedAccountNumber, '******5678');
  assert.equal('bsb' in response.body.payoutDetails, false);
  assert.equal('accountNumber' in response.body.payoutDetails, false);
  assert.doesNotMatch(JSON.stringify(response.body), /12345678/);
});

test('another contractor or customer identity cannot update payout details', async () => {
  const response = await invoke(handlerFor(db({ authUserId:'other-auth', contractorUserId:'owner-auth' })), { body:{ action:'savePayoutDetails', email:'own@example.test', accessToken:'valid', accountName:'Other', bsb:'123456', accountNumber:'12345678', confirmed:true } });
  assert.equal(response.status, 401);
});

test('full payout details require Admin authorization', async () => {
  process.env.ADMIN_SESSION_SECRET='payout-admin-test';
  try {
    const handler = handlerFor(db());
    assert.equal((await invoke(handler,{body:{action:'adminPayoutDetails',contractorEmail:'own@example.test'}})).status,401);
    const response = await invoke(handler,{body:{action:'adminPayoutDetails',contractorEmail:'own@example.test'},token:signAdminToken()});
    assert.equal(response.status,200); assert.equal(response.body.payoutDetails.accountNumber,'12345678');
  } finally { delete process.env.ADMIN_SESSION_SECRET; }
});

test('general/job/email surfaces do not include payout secrets and contractor Connect UX is retired', () => {
  const files = ['api/get-jobs.js','api/notify.js','api/_lib/contractorOnboarding.js'];
  for (const file of files) assert.doesNotMatch(fs.readFileSync(file,'utf8'), /payout_account_number|payout_bsb/);
  const portal = fs.readFileSync('mysubbies-contractor-portal.html','utf8');
  assert.doesNotMatch(portal, /create-connect-onboarding-link|Stripe Connect|connectOnboarding/);
  assert.match(portal, /savePayoutDetails/);
});

test('customer Stripe deposit collection remains present while contractor automatic payout is disabled', () => {
  assert.match(fs.readFileSync('api/create-deposit-intent.js','utf8'), /paymentIntents\.create/);
  assert.match(fs.readFileSync('api/stripe-webhook.js','utf8'), /payment_intent\.succeeded/);
  assert.match(fs.readFileSync('api/weekly-payout.js','utf8'), /Automatic Stripe Connect contractor payouts are disabled/);
});
