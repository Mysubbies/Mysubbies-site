const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const flow = fs.readFileSync('js/booking-flow.js', 'utf8');
function requestContext(response) {
 const nodes = Object.fromEntries(['complexJobForm','cqDescription','cqName','cqPhone','cqEmail','cqSuburb','cqError','cqSubmit','cqBack','complexJobRequest'].map(id => [id, {value:'',hidden:false,disabled:false,textContent:'',appendChild(node){ this.result=node; }}]));
 Object.assign(nodes.complexJobForm,{reportValidity:()=>true});
 for (const [id,value] of Object.entries({cqDescription:'Build a custom structure',cqName:'Test Customer',cqPhone:'0400000000',cqEmail:'test@example.com',cqSuburb:'Craigieburn'})) nodes[id].value=value;
 const calls=[];
 const c={Blob,cart:[],uploadedPhotos:['data:image/jpeg;base64,YQ=='],document:{getElementById:id=>nodes[id],createElement:()=>({setAttribute(){},append(){},textContent:''})},fetch:async(url,init)=>{calls.push({url,payload:JSON.parse(init.body)});return response;}};
 vm.createContext(c);
 vm.runInContext(flow.slice(flow.indexOf('let complexJobSending'),flow.indexOf('function renderComplexJobOffer')),c);
 vm.runInContext(flow.slice(flow.indexOf('async function submitComplexJobRequest'),flow.indexOf('(function initBookingFlow')),c);
 return {c,nodes,calls};
}
test('unlisted work saves a quote enquiry, without a fabricated price or contractor dispatch',async()=>{
 const {c,nodes,calls}=requestContext({ok:true,json:async()=>({id:'request-1'})});
 await c.submitComplexJobRequest({preventDefault(){}});
 assert.equal(calls.length,1);assert.equal(calls[0].url,'/api/support');
 assert.equal(calls[0].payload.purpose,'quote_request');assert.equal(calls[0].payload.attachments.length,1);
 assert.equal(calls[0].payload.basePrice,undefined);assert.equal(nodes.complexJobForm.hidden,true);
 await c.submitComplexJobRequest({preventDefault(){}});assert.equal(calls.length,1);
});
test('a failed quote save keeps details/photos and permits retry',async()=>{
 const {c,nodes,calls}=requestContext({ok:false,json:async()=>({error:'Please try again'})});
 await c.submitComplexJobRequest({preventDefault(){}});
 assert.equal(nodes.complexJobForm.hidden,false);assert.equal(nodes.cqDescription.value,'Build a custom structure');
 assert.equal(nodes.cqSubmit.disabled,false);assert.equal(c.uploadedPhotos.length,1);assert.match(nodes.cqError.textContent,/try again/);
 await c.submitComplexJobRequest({preventDefault(){}});assert.equal(calls.length,2);
});
test('complex listed work and risky answers require review before quoting',()=>{
 const source=flow.slice(0,flow.indexOf('// Presentation'));
 const c={cart:[{needsSiteVisit:true}],TARGETED_QUESTIONS:{},selectedCat:null,riskAnswers:{}};vm.createContext(c);vm.runInContext(source,c);
 assert.equal(c.estimatorRequiresReview(),true);c.cart=[{needsSiteVisit:false}];assert.equal(c.estimatorRequiresReview(),false);
 c.selectedCat={label:'Fencing'};c.TARGETED_QUESTIONS={Fencing:[{id:'slope',risky:['Steep']}]};c.riskAnswers={slope:'Steep'};assert.equal(c.estimatorRequiresReview(),true);
});
test('checkout reprices quantity from the current catalogue and respects minimum charges',async()=>{
 const nodes={bookingCart:{},confirmFreeBooking:{}};
 const c={quote:{items:[{catLabel:'Cleaning',taskName:'Clean',base:100,qty:1,unit:'job'}]},bookingSubmitting:false,
 localStorage:{setItem(){}},document:{getElementById:id=>nodes[id],querySelector:()=>null},
 fetch:async()=>({ok:true,json:async()=>({categories:[{label:'Cleaning',tasks:[{name:'Clean',unit:'job',rate:25,minJobPrice:100}]}]})})};
 vm.createContext(c);vm.runInContext(fs.readFileSync('js/booking-cart.js','utf8'),c);
 await c.updateBookingCartQuantity(0,2);assert.equal(c.quote.items[0].base,100);
 await c.updateBookingCartQuantity(0,8);assert.equal(c.quote.items[0].base,200);
 await c.updateBookingCartQuantity(0,-1);assert.equal(c.quote.items[0].qty,8);
});
test('the server stores quote requests in the admin enquiry inbox and rejects invalid attachments',async()=>{
 const writes=[],notifications=[];
 const context={module:{exports:{}},console,Buffer,require(name){
  if(name==='./_lib/clients')return{getSupabase:()=>({from(table){assert.equal(table,'inquiries');return{insert(row){writes.push(row);return{select(){return{single:async()=>({data:{id:'saved-request'}})}}}}}}})};
  if(name==='./_lib/adminAuth')return{requireAdmin:()=>false};
  if(name==='./_lib/email')return{escapeHtml:s=>s};
  if(name==='./_lib/adminNotify')return{notifyAdmin:async n=>notifications.push(n)};
  throw Error(name);
 }};
 vm.createContext(context);vm.runInContext(fs.readFileSync('api/support.js','utf8'),context);
 const call=async attachments=>{const res={status(code){this.code=code;return this;},json(body){this.body=body;}};await context.module.exports({method:'POST',body:{entity:'inquiries',action:'create',purpose:'quote_request',role:'customer',name:'Test',email:'test@example.com',text:'Custom job details',attachments}},res);return res;};
 const valid=await call([{name:'photo.jpg',dataUrl:'data:image/jpeg;base64,YQ=='}]);
 assert.equal(valid.code,200);assert.equal(valid.body.id,'saved-request');assert.equal(writes.length,1);assert.match(notifications[0].title,/quote request/);
 const invalid=await call([{dataUrl:'data:text/html;base64,YQ=='}]);assert.equal(invalid.code,400);assert.equal(writes.length,1);
});
