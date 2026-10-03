const test=require('node:test');
const assert=require('node:assert/strict');
const {createPilot}=require('./support/property-pilot.cjs');
const crypto=require('node:crypto');
const fs=require('node:fs');
const vm=require('node:vm');
const png='data:image/png;base64,'+Buffer.from([137,80,78,71,13,10,26,10,0]).toString('base64');
const pdf='data:application/pdf;base64,'+Buffer.from('%PDF-1.4\nPilot invoice').toString('base64');
async function setup(approvalRequired=true){
  const p=createPilot();
  const org=await p.invoke('admin-create-organisation',{name:'Isolated Pilot Agency',adminEmail:'pm@example.invalid',approvalRequired});
  assert.equal(org.status,201);assert.equal(org.body.inviteEmailSent,true);
  assert.match(p.emails[0].html,/\/property/);
  assert.equal((await p.invoke('activate-invite',{},'pm')).status,200);
  const prop=await p.invoke('create-property',{name:'Pilot site',address:'Test property A',workOrderId:crypto.randomUUID()},'pm');
  assert.equal(prop.status,201);
  return {...p,orgId:org.body.organisation.id,propertyId:prop.body.property.id};
}
test('isolated API pilot: invite → property → quote → approve → preferred offer → accept → progress → evidence → invoice → PM activity',async()=>{
  const p=await setup();
  const member=await p.invoke('admin-add-member',{organisationId:p.orgId,email:'requester@example.invalid',role:'requester'});assert.equal(member.status,201);
  assert.equal((await p.invoke('activate-invite',{},'requester')).status,200);
  assert.equal((await p.invoke('admin-add-property',{organisationId:p.orgId,address:'Test property B'})).status,201);
  assert.equal((await p.invoke('admin-set-preferred-contractor',{propertyId:p.propertyId,contractorId:'contractor-one'})).status,200);
  const workOrderId=crypto.randomUUID();
  const created=await p.invoke('create-work-order',{workOrderId,propertyId:p.propertyId,serviceMode:'project_quote',category:'Handyman',taskSummary:'Repair door',attachments:[{name:'Request.png',dataUrl:png}]},'requester');
  assert.equal(created.status,201);assert.equal(created.body.workOrder.id,workOrderId);assert.equal(created.body.workOrder.status,'quote_required');
  const duplicate=await p.invoke('create-work-order',{workOrderId,propertyId:p.propertyId,serviceMode:'project_quote'},'requester');
  assert.equal(duplicate.status,200);assert.equal(duplicate.body.duplicatePrevented,true);assert.equal(p.tables.pm_work_orders.length,1);
  assert.equal((await p.invoke('approve-work-order',{workOrderId},'pm')).status,409);
  assert.equal((await p.invoke('admin-release-work-order',{workOrderId})).status,409);
  assert.equal((await p.invoke('admin-set-quote',{workOrderId,quotedPriceCents:25000,quoteReference:'PILOT-Q-1'})).status,200);
  assert.equal((await p.invoke('approve-work-order',{workOrderId},'requester')).status,403);
  assert.equal((await p.invoke('approve-work-order',{workOrderId},'pm')).status,200);
  const released=await p.invoke('admin-release-work-order',{workOrderId});assert.equal(released.status,200);assert.equal(released.body.contractor.id,'contractor-one');assert.equal(p.tables.job_offers.length,1);
  assert.equal((await p.invoke('admin-set-quote',{workOrderId,quotedPriceCents:30000})).status,409);
  const feed=await p.invoke('',{contractorEmail:'1'},'contractor','GET','get-jobs');assert.equal(feed.status,200);assert.equal(feed.body.jobs.length,1);
  assert.equal(feed.body.jobs[0].source,'property_management');assert.equal(feed.body.jobs[0].propertyManagement.workOrderId,workOrderId);
  assert.equal(feed.body.jobs[0].address,undefined);assert.equal(feed.body.jobs[0].propertyManagement.organisationName,undefined);
  const other=await p.invoke('',{contractorEmail:'1'},'other','GET','get-jobs');assert.equal(other.status,200);assert.equal(other.body.jobs.length,0);
  const jobId=released.body.jobId;
  const accepted=await p.invoke('',{role:'contractor',jobs:[{id:jobId,status:'assigned',contractorEmail:'contractor@example.invalid'}]},'contractor','POST','sync-jobs');assert.equal(accepted.status,200);
  for(const operationalStage of ['scheduled','on_the_way','started'])assert.equal((await p.invoke('',{role:'contractor',jobs:[{id:jobId,operationalStage}]},'contractor','POST','sync-jobs')).status,200);
  assert.equal((await p.invoke('contractor-completion',{workOrderId,attachments:[{name:'After.png',dataUrl:png}]},'other')).status,403);
  assert.equal((await p.invoke('contractor-completion',{workOrderId,completionNotes:'Door repaired and checked.',attachments:[{name:'Before.png',dataUrl:png},{name:'After.png',dataUrl:png}]},'contractor')).status,200);
  assert.equal(p.tables.jobs[0].stage,'completed');
  assert.equal((await p.invoke('admin-upload-invoice',{workOrderId,invoiceReference:'PILOT-I-1',invoiceAmountCents:25000,attachments:[{name:'Pilot.pdf',dataUrl:pdf}]})).status,200);
  const boot=await p.invoke('bootstrap',{},'pm','GET');assert.equal(boot.status,200);
  const wo=boot.body.workOrders[0];assert.equal(wo.status,'completed');assert.equal(wo.completionNotes,'Door repaired and checked.');assert.equal(wo.invoiceReference,'PILOT-I-1');
  assert.equal(wo.files.filter(f=>f.kind==='completion_photo').length,2);assert.equal(wo.files.find(f=>f.kind==='invoice').expiresIn,300);
  for(const eventType of ['work_order_created','quote_set','approval_approved','allocated_to_site_contractor','completion_evidence_added','invoice_uploaded'])assert(wo.events.some(e=>e.eventType===eventType),eventType);
  assert(p.notifications.some(n=>n.eventType==='new-property-job-allocated'));
});
test('instant price, explicit allocation, unapproved contractor and cancelled-order release guards',async()=>{
  const p=await setup(false);
  const created=await p.invoke('create-work-order',{propertyId:p.propertyId,category:'Handyman',taskName:'Minor repair',qty:2},'pm');
  assert.equal(created.status,201);assert.equal(created.body.workOrder.quotedPriceCents,30000);assert.equal(created.body.workOrder.approvalStatus,'not_required');
  const workOrderId=created.body.workOrder.id;
  p.tables.contractors[1].status='pending';
  assert.equal((await p.invoke('admin-release-work-order',{workOrderId,contractorId:'contractor-two'})).status,409);assert.equal(p.tables.jobs.length,0);
  assert.equal((await p.invoke('cancel-work-order',{workOrderId},'pm')).status,200);
  assert.equal((await p.invoke('admin-release-work-order',{workOrderId,contractorId:'contractor-one'})).status,409);assert.equal(p.tables.jobs.length,0);
  const next=await p.invoke('create-work-order',{propertyId:p.propertyId,category:'Handyman',taskName:'Minor repair',qty:1},'pm');
  assert.equal((await p.invoke('admin-release-work-order',{workOrderId:next.body.workOrder.id,contractorId:'contractor-one'})).status,200);
});
test('high-value legal review, organisation isolation and viewer permissions',async()=>{
  const p=await setup();
  const created=await p.invoke('create-work-order',{propertyId:p.propertyId,serviceMode:'project_quote'},'pm');const workOrderId=created.body.workOrder.id;
  await p.invoke('admin-set-quote',{workOrderId,quotedPriceCents:1000000});await p.invoke('approve-work-order',{workOrderId},'pm');
  assert.equal((await p.invoke('admin-release-work-order',{workOrderId,contractorId:'contractor-one'})).status,409);
  await p.invoke('admin-update-work-order',{workOrderId,legalReviewStatus:'cleared'});
  assert.equal((await p.invoke('admin-release-work-order',{workOrderId,contractorId:'contractor-one'})).status,200);
  p.tables.pm_members[0].role='viewer';
  assert.equal((await p.invoke('create-work-order',{propertyId:p.propertyId},'pm')).status,403);
  assert.equal((await p.invoke('admin-summary',{},'pm','GET')).status,401);
  p.tables.pm_members[0].organisation_id='different-org';
  p.tables.pm_members[0].role='requester';
  p.tables.pm_organisations.push({id:'different-org',name:'Other agency',status:'active'});
  assert.equal((await p.invoke('create-work-order',{propertyId:p.propertyId},'pm')).status,404);
});
test('contractor completion button submits property evidence and notes, while ordinary jobs keep their progress endpoint',async()=>{
  const html=fs.readFileSync(require('node:path').join(__dirname,'../mysubbies-contractor-portal.html'),'utf8');
  const source=html.slice(html.indexOf('  async function updateJobProgress('),html.indexOf('  // Mirrors requestCancelJob()',html.indexOf('  async function updateJobProgress(')));
  for(const property of [true,false]){
    const job={id:'pilot-job',source:property?'property_management':'browse',propertyManagement:{workOrderId:'pilot-order'},beforePhotos:[png],afterPhotos:[png]};
    const requests=[];
    const context=vm.createContext({getJobs:()=>[job],getContractorAccessToken:async()=>'isolated-token',fetch:async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return {ok:true,json:async()=>({})}},document:{getElementById:()=>({value:'Door repaired.'})},localStorage:{setItem(){}},showToast(){},render(){},Date,JSON});
    vm.runInContext(source,context);await context.updateJobProgress('pilot-job','completed');
    assert.equal(requests.length,1);assert.equal(requests[0].url,property?'/api/property-management':'/api/sync-jobs');
    if(property){assert.equal(requests[0].body.workOrderId,'pilot-order');assert.equal(requests[0].body.completionNotes,'Door repaired.');assert.equal(requests[0].body.attachments.length,2);}
  }
});
test('invalid attachment batches upload no partial completion evidence',async()=>{
  const p=createPilot();
  await assert.rejects(()=>require('../api/_lib/propertyWorkOrderFiles').storeAttachments(p.db,'org','order',null,[{name:'Valid.png',dataUrl:png},{name:'Invalid.png',dataUrl:'data:image/png;base64,YmFk'}],'completion_photo'),/content does not match/);
  assert.equal(p.objects.size,0);assert.equal(p.tables.pm_work_order_files.length,0);
});
