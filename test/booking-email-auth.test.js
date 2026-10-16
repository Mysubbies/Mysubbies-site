const test=require('node:test');const assert=require('node:assert/strict');const fs=require('fs');const vm=require('node:vm');const crypto=require('node:crypto');
function setup({count=0,delivery=true,generationError=false}={}){
 const messages=[],generated=[],ids=new Set();
 const db = {
   from(table) {
     assert.equal(table, 'contractor_signup_attempts');
     return {
       select() { return this; }, eq() { return this; },
       gte: async () => ({ count, error:null }),
       insert: async row => {
         if (ids.has(row.id)) return { error:{code:'23505'} };
         ids.add(row.id); return { error:null };
       },
     };
   },
   auth: { admin: { generateLink: async args => {
     generated.push(args);
     return generationError ? {error:new Error('private internal error')} : {data:{properties:{email_otp:'123456',hashed_token:'server-only'}}};
   } } },
 };
 const c={module:{exports:{}},process:{env:{RESEND_API_KEY:'configured'}},Date,require(name){if(name==='crypto')return crypto;if(name==='./signupSecurity')return{clientFingerprint:()=> 'client-ip'};if(name==='./email')return{sendEmailWithResult:async m=>{messages.push(m);return{ok:delivery}},wrapEmail:s=>s,escapeHtml:s=>s};throw Error(name)}};
 vm.createContext(c);vm.runInContext(fs.readFileSync('api/_lib/bookingEmailAuth.js','utf8'),c);
 async function send(email='customer@example.com') {const res={headers:{},setHeader(k,v){this.headers[k]=v},status(code){this.code=code;return this},json(body){this.body=body}};await c.module.exports.requestBookingCode(db,{body:{email},headers:{}},res);return res}
 return {send,messages,generated,db,c};
}
test('booking email code is delivered only by email and no code/session is returned publicly',async()=>{
 const s=setup(),res=await s.send();assert.equal(res.code,200);assert.equal(res.body.sent,true);
 assert.equal(s.messages.length,1);assert.match(s.messages[0].html,/123456/);assert.equal(s.messages[0].to,'customer@example.com');
 assert.doesNotMatch(JSON.stringify(res.body),/123456|server-only|session|access_token/);assert.equal(s.generated[0].type,'magiclink');
});
test('invalid email and unavailable delivery never report a sent verification code',async()=>{
 const invalid=setup();assert.equal((await invalid.send('bad-address')).code,400);assert.equal(invalid.generated.length,0);
 const failed=setup({delivery:false});assert.equal((await failed.send()).code,503);
 const generation=setup({generationError:true});assert.equal((await generation.send()).code,503);assert.equal(generation.messages.length,0);
});
test('hourly limits and atomic per-minute locks prevent repeated code emails',async()=>{
 const limited=setup({count:10});assert.equal((await limited.send()).code,429);assert.equal(limited.generated.length,0);
 const concurrent=setup();const results=await Promise.all([concurrent.send(),concurrent.send()]);assert.deepEqual(results.map(r=>r.code).sort(),[200,429]);assert.equal(concurrent.messages.length,1);
});
test('missing mail configuration does not generate credentials',async()=>{
 const s=setup();delete s.c.process.env.RESEND_API_KEY;assert.equal((await s.send()).code,503);assert.equal(s.generated.length,0);
});
