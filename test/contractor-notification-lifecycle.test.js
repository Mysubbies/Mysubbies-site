const test = require('node:test');
const assert = require('node:assert/strict');
const { notifyAdmin, notifyContractor } = require('../api/_lib/contractorNotifications');

function db(rows) { return { from(table) { assert.equal(table, 'notifications'); return { insert: async row => { rows.push(row); return { error:null }; } }; } }; }

test('critical contractor notification persists in-app and successful email audit status without sensitive metadata', async () => {
  process.env.RESEND_API_KEY='re_test'; const originalFetch=global.fetch;
  global.fetch=async () => ({ok:true});
  try {
    const rows=[]; const result=await notifyContractor(db(rows), { email:'synthetic@example.test', eventType:'contractor-application-approved',
      title:'Application approved', body:'Use your secure activation email.', subject:'Approved', applicationRef:'app-1', metadata:{status:'approved'} });
    assert.equal(result.ok,true); assert.deepEqual(rows[0].delivery_channels,['in_app','email']);
    assert.deepEqual(rows[0].delivery_status,{in_app:'created',email:'sent'}); assert.equal(rows[0].application_ref,'app-1');
    assert.doesNotMatch(JSON.stringify(rows[0]), /bsb|accountNumber|secret/i);
  } finally { global.fetch=originalFetch; delete process.env.RESEND_API_KEY; }
});

test('critical email failure is visible to Admin while contractor in-app notification remains', async () => {
  process.env.RESEND_API_KEY='re_test'; const originalFetch=global.fetch; const originalError=console.error;
  global.fetch=async () => ({ok:false,status:500,text:async()=> '{}'}); console.error=()=>{};
  try {
    const rows=[]; const result=await notifyContractor(db(rows), { email:'synthetic@example.test', eventType:'contractor-payout-issue', title:'Payout needs attention', body:'Contact support.', subject:'Payout issue', jobId:'job-1' });
    assert.equal(result.ok,false); assert.equal(rows[0].delivery_status.email,'failed');
    assert.equal(rows[1].recipient_role,'admin'); assert.equal(rows[1].event_type,'contractor-critical-email-failed');
    assert.equal(rows[1].metadata.failedEventType,'contractor-payout-issue');
  } finally { global.fetch=originalFetch; console.error=originalError; delete process.env.RESEND_API_KEY; }
});

test('minor lifecycle updates use in-app only and Admin audit rows have structured status', async () => {
  const rows=[];
  await notifyContractor(db(rows), { email:'synthetic@example.test', eventType:'contractor-profile-updated', title:'Profile updated', body:'Your contact phone was updated.' });
  await notifyAdmin(db(rows), { eventType:'contractor-job-accepted', title:'Job accepted', body:'Synthetic contractor accepted.', jobId:'job-1' });
  assert.deepEqual(rows[0].delivery_channels,['in_app']); assert.deepEqual(rows[0].delivery_status,{in_app:'created'});
  assert.equal(rows[1].recipient_role,'admin'); assert.equal(rows[1].link_job_id,'job-1');
});
