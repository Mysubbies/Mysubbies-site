const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeProspect, ingestProspects } = require('../lib/ai-workforce/prospect-ingestion');
const { managerSnapshot } = require('../lib/ai-workforce/manager-snapshot');
test('normalizes valid prospect', () => {
 const p=normalizeProspect({business_name:' Clinic A ',category:'clinic',suburb:'Craigieburn',provider:'directory',source_url:'https://example.org/a',provider_place_id:'abc'});
 assert.equal(p.business_name,'Clinic A'); assert.equal(p.provider_place_id,'abc');
});
test('rejects prospect without HTTPS provenance', () => {
 assert.throws(()=>normalizeProspect({business_name:'A',category:'clinic',suburb:'Craigieburn',provider:'x',source_url:'http://example.org'}));
});
test('holds prospects without provider IDs for review', async () => {
 const r=await ingestProspects({},[{business_name:'A',category:'clinic',suburb:'Craigieburn',provider:'x',source_url:'https://example.org'}]);
 assert.deepEqual(r,{processed:1,submitted:0,needs_review:1});
});
test('enforces ingestion batch limits', async () => {
 await assert.rejects(ingestProspects({},Array.from({length:26},()=>({}))));
});
test('manager snapshot reports counts but does not invent cash', async () => {
 const counts={customer_leads:4,customers:3,contractors:2,ai_prospects:10,ai_outreach_drafts:1,payments:5};
 const db={from(table){return {select(){return {get count(){return counts[table]},error:null,eq(){return {count:counts[table],error:null}}}}}}};
 const result=await managerSnapshot(db);
 assert.equal(result.prospects,10);
 assert.equal(result.cash_received_aud,null);
 assert.equal(result.cash_target_aud_per_month,20000);
});
