const { getSupabase } = require('./_lib/clients');
const { requireAdmin } = require('./_lib/adminAuth');
const { sendEmailWithResult, wrapEmail, escapeHtml, emailButton } = require('./_lib/email');

function clean(v,n){ return String(v||'').trim().slice(0,n||500); }
function email(v){ const x=clean(v,254).toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x)?x:''; }
function type(v){ return v==='property_manager'?'property_manager':'contractor'; }
async function logActivity(supabase,p,eventType,outcome,detail){try{await supabase.from('business_development_activity').insert({prospect_id:p.id,prospect_type:p.prospect_type,event_type:eventType,outcome:outcome||'success',detail:clean(detail,500)||null});}catch(e){console.error('CRM audit log failed',e);}}
function registrationUrl(t){
  return t==='property_manager'
    ? 'https://app.mysubbies.com.au/mysubbies-property-managers.html'
    : 'https://www.mysubbies.com.au/mysubbies-contractor-landing.html';
}
async function list(supabase,req,res){
  const t=type(req.query.type);
  const {data,error}=await supabase.from('business_development_prospects').select('*').eq('prospect_type',t).order('updated_at',{ascending:false}).limit(1000);
  if(error) throw error;
  const prospects=data||[], ids=prospects.map(p=>p.id);
  let activity=[];
  if(ids.length){
    const {data:events,error:eventError}=await supabase.from('business_development_activity').select('id,prospect_id,event_type,outcome,detail,created_at').in('prospect_id',ids).order('created_at',{ascending:false}).limit(500);
    if(eventError) throw eventError; activity=events||[];
  }
  res.status(200).json({prospects,activity});
}
async function save(supabase,body,res){
  const t=type(body.prospectType), e=email(body.email);
  const row={prospect_type:t,business_name:clean(body.businessName,180),contact_name:clean(body.contactName,120)||null,email:e||null,phone:clean(body.phone,60)||null,website:clean(body.website,500)||null,suburb:clean(body.suburb,120)||null,state:clean(body.state,20)||'VIC',trade_or_segment:clean(body.tradeOrSegment,160)||null,source_provider:clean(body.sourceProvider,80),source_url:clean(body.sourceUrl,1000),source_reference:clean(body.sourceReference,500)||null};
  if(!row.business_name||!row.source_provider||!row.source_url){res.status(400).json({error:'Business name and source evidence are required.'});return;}
  if(e){const {data:existing,error:xerr}=await supabase.from('business_development_prospects').select('*').eq('prospect_type',t).ilike('email',e).maybeSingle();if(xerr)throw xerr;if(existing){await logActivity(supabase,existing,'duplicate_prevented','success','Existing prospect returned instead of creating a duplicate.');res.status(200).json({prospect:existing,duplicatePrevented:true});return;}}
  const {data,error}=await supabase.from('business_development_prospects').insert(row).select('*').single();if(error)throw error;await logActivity(supabase,data,'prospect_created','success','Source-backed prospect added to CRM.');res.status(201).json({prospect:data});
}
async function updateProspect(supabase,body,res){
  const id=clean(body.id,80);
  if(!id){res.status(400).json({error:'Prospect id is required.'});return;}
  const patch={updated_at:new Date().toISOString()};
  const fields={businessName:'business_name',contactName:'contact_name',email:'email',phone:'phone',website:'website',suburb:'suburb',state:'state',tradeOrSegment:'trade_or_segment',sourceProvider:'source_provider',sourceUrl:'source_url',sourceReference:'source_reference',notes:'notes'};
  for(const key of Object.keys(fields)){
    if(body[key]!==undefined){
      if(key==='email') patch[fields[key]]=email(body[key])||null;
      else patch[fields[key]]=clean(body[key],key==='sourceUrl'?1000:key==='notes'?2000:500)||null;
    }
  }
  if(body.status!==undefined){
    const allowed=['prospect','invited','opened','interested','registration_started','registered','under_review','approved','active','declined','archived'];
    if(!allowed.includes(body.status)){res.status(400).json({error:'Invalid prospect status.'});return;}
    patch.status=body.status;
  }
  if(!patch.business_name && body.businessName!==undefined){res.status(400).json({error:'Business name cannot be empty.'});return;}
  if(patch.source_provider!==undefined&&!patch.source_provider){res.status(400).json({error:'Source provider is required.'});return;}
  if(patch.source_url!==undefined&&!patch.source_url){res.status(400).json({error:'Source evidence URL is required.'});return;}
  const {data,error}=await supabase.from('business_development_prospects').update(patch).eq('id',id).select('*').single();
  if(error)throw error;
  await logActivity(supabase,data,'prospect_updated','success','Prospect details updated by admin.');
  res.status(200).json({prospect:data});
}
async function deleteProspect(supabase,body,res){
  const id=clean(body.id,80);
  if(!id){res.status(400).json({error:'Prospect id is required.'});return;}
  const {data:p,error:findError}=await supabase.from('business_development_prospects').select('*').eq('id',id).maybeSingle();
  if(findError)throw findError;
  if(!p){res.status(404).json({error:'Prospect not found.'});return;}
  const {error:activityError}=await supabase.from('business_development_activity').delete().eq('prospect_id',id);
  if(activityError)throw activityError;
  const {error:deleteError}=await supabase.from('business_development_prospects').delete().eq('id',id);
  if(deleteError)throw deleteError;
  res.status(200).json({deleted:true});
}
async function removeProspect(supabase,body,res){
  const id=clean(body.id,80);
  if(!id){res.status(400).json({error:'Prospect id is required.'});return;}
  const {data,error}=await supabase.from('business_development_prospects').select('*').eq('id',id).maybeSingle();
  if(error)throw error;
  if(!data){res.status(404).json({error:'Prospect not found.'});return;}
  await logActivity(supabase,data,'prospect_archived','success','Prospect archived by admin.');
  const {error:updateError}=await supabase.from('business_development_prospects').update({status:'archived',updated_at:new Date().toISOString()}).eq('id',id);
  if(updateError)throw updateError;
  res.status(200).json({archived:true});
}
async function searchPublic(body,res){
  const key=String(process.env.GOOGLE_PLACES_SERVER_API_KEY||process.env.GOOGLE_PLACES_API_KEY||process.env.GOOGLE_MAPS_API_KEY||process.env.GOOGLE_MAPS_JS_API_KEY||process.env.GOOGLE_MAPS_BROWSER_API_KEY||process.env.GOOGLE_API_KEY||'').trim();
  if(!key){res.status(503).json({error:'Google Places server key is missing from this Preview deployment.',code:'PLACES_KEY_MISSING'});return;}
  const t=type(body.prospectType);
  const query=clean(body.query,240);
  const location=clean(body.location,160)||'Melbourne VIC';
  if(!query){res.status(400).json({error:'Enter a business type, trade or segment to search.'});return;}
  const searchText=query+' in '+location;
  const response=await fetch('https://places.googleapis.com/v1/places:searchText',{
    method:'POST',
    headers:{
      'Content-Type':'application/json',
      'X-Goog-Api-Key':key,
      'X-Goog-FieldMask':'places.id,places.displayName,places.formattedAddress,places.websiteUri,places.nationalPhoneNumber,places.googleMapsUri'
    },
    body:JSON.stringify({textQuery:searchText,pageSize:20,regionCode:'AU',languageCode:'en'})
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok){const reason=clean(data&&data.error&&data.error.message,500)||('Google Places returned HTTP '+response.status);console.error('Places prospect search failed',response.status,reason);res.status(502).json({error:'Google Places search failed: '+reason,code:'PLACES_API_ERROR'});return;}
  const results=(data.places||[]).map(function(p){
    const address=clean(p.formattedAddress,300);
    const parts=address.split(',').map(function(x){return x.trim();});
    return {
      prospectType:t,
      businessName:clean(p.displayName&&p.displayName.text,180),
      phone:clean(p.nationalPhoneNumber,60),
      website:clean(p.websiteUri,500),
      suburb:parts.length>1?parts[parts.length-2]:'',
      state:'VIC',
      tradeOrSegment:query,
      sourceProvider:'Google Places',
      sourceUrl:clean(p.googleMapsUri,1000)||('https://www.google.com/maps/search/?api=1&query_place_id='+encodeURIComponent(p.id||'')),
      sourceReference:clean(p.id,500)
    };
  }).filter(function(x){return x.businessName&&x.sourceUrl;});

  // Enrich search results automatically from the public business website so
  // email is available at the review stage. Prefer generic business inboxes.
  async function enrichResultEmail(x){
    if(!x.website)return x;
    const root=normaliseWebsite(x.website);
    if(!root)return x;
    const candidates=[root,root.replace(/\/$/,'')+'/contact',root.replace(/\/$/,'')+'/contact-us',root.replace(/\/$/,'')+'/about'];
    let found=[];
    for(const url of candidates){
      try{
        const response=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0 MySubbies public contact checker'},redirect:'follow'});
        if(!response.ok)continue;
        const html=await response.text();
        found=extractEmailsFromHtml(html);
        if(found.length)break;
      }catch(e){}
    }
    if(found.length){
      x.email=found.find(function(e){return /^(info|admin|office|hello|enquiries|enquiry|contact|reception|property|maintenance|support)@/i.test(e);})||found[0];
    }
    return x;
  }
  const enrichedResults=[];
  for(const x of results) enrichedResults.push(await enrichResultEmail(x));
  res.status(200).json({query:searchText,results:enrichedResults,reviewRequired:true});
}
function extractEmailsFromHtml(html) {
  const matches=String(html||'').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)||[];
  return [...new Set(matches.map(x=>x.toLowerCase()).filter(x=>!/^(example|test|noreply|no-reply)@/.test(x)))];
}
function normaliseWebsite(v) {
  const x=clean(v,500);
  if(!x)return '';
  return /^https?:\/\//i.test(x)?x:'https://'+x;
}
async function enrichPublicEmail(supabase,body,res){
  const id=clean(body.id,80);
  if(!id){res.status(400).json({error:'Prospect id is required.'});return;}
  const {data:p,error}=await supabase.from('business_development_prospects').select('*').eq('id',id).maybeSingle();
  if(error)throw error;
  if(!p){res.status(404).json({error:'Prospect not found.'});return;}
  if(p.email){res.status(200).json({prospect:p,found:true,email:p.email});return;}
  const root=normaliseWebsite(p.website);
  if(!root){res.status(422).json({error:'This prospect has no website to check for a public email address.'});return;}
  const candidates=[root,root.replace(/\/$/,'')+'/contact',root.replace(/\/$/,'')+'/contact-us',root.replace(/\/$/,'')+'/about'];
  let found=[];
  for(const url of candidates){
    try{
      const response=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0 MySubbies public contact checker'},redirect:'follow'});
      if(!response.ok)continue;
      const html=await response.text();
      found=extractEmailsFromHtml(html);
      if(found.length)break;
    }catch(e){}
  }
  if(!found.length){await logActivity(supabase,p,'email_enrichment','not_found','No public email address found on the business website pages checked.');res.status(200).json({prospect:p,found:false,error:'No public email address was found on the website. Try the business contact page manually.'});return;}
  const selected=found.find(x=>/^(info|admin|office|hello|enquiries|enquiry|contact|reception|property|maintenance|support)@/i.test(x))||found[0];
  const {data:updated,error:updateError}=await supabase.from('business_development_prospects').update({email:selected,updated_at:new Date().toISOString()}).eq('id',id).select('*').single();
  if(updateError)throw updateError;
  await logActivity(supabase,updated,'email_enriched','success','Public business email found on the business website.');
  res.status(200).json({prospect:updated,found:true,email:selected,alternatives:found});
}
async function invite(supabase,body,res){
  const ids=Array.isArray(body.prospectIds)?body.prospectIds.slice(0,100):[];
  if(!ids.length){res.status(400).json({error:'Select at least one prospect.'});return;}
  const {data:rows,error}=await supabase.from('business_development_prospects').select('*').in('id',ids);if(error)throw error;
  const results=[];
  for(const p of rows||[]){
    if(!p.email){results.push({id:p.id,ok:false,error:'No public email recorded.'});continue;}
    const property=p.prospect_type==='property_manager';
    const subject=property?'Let us take care of your maintenance requests':'We bring you the work. You focus on doing the work.';
    const propertyBody='<h2 style="margin-top:0;">A simpler way to manage property maintenance</h2>'+
      '<img src="https://www.mysubbies.com.au/images/categories/property-maintenance.jpg" alt="Property maintenance by MySubbies" style="display:block;width:100%;height:auto;border-radius:10px;margin:0 0 22px;">'+
      '<p>Hi there,</p>'+
      '<p>I’m reaching out from <strong>Mysubbies Holding Pty Ltd</strong>, the company behind <strong>MySubbies</strong> — a platform designed to make property maintenance and contractor management simpler for property managers.</p>'+
      '<p>We understand that managing properties often means dealing with maintenance requests, organising trades, following up contractors and keeping owners informed.</p>'+
      '<p><strong>MySubbies is designed to take some of that workload off your team.</strong></p>'+
      '<p>When you have a maintenance request, you can submit it through MySubbies and our <strong>vetted contractor network</strong> can assist with the job. You remain in control throughout the process, with work and pricing proceeding <strong>only after your approval</strong>.</p>'+
      '<p style="font-size:16px;font-weight:700;margin:22px 0 10px;">What can we look after?</p>'+
      '<table width="100%" cellpadding="0" cellspacing="0" border="0" style="font-size:13px;line-height:21px;margin:0 0 20px;"><tr><td width="50%" valign="top" style="padding:0 10px 4px 0;">• General maintenance<br>• Handyman &amp; minor repairs<br>• Plumbing<br>• Electrical<br>• Painting &amp; plastering<br>• Carpentry<br>• Lawn &amp; garden maintenance<br>• Tree &amp; garden work<br>• Turf</td><td width="50%" valign="top" style="padding:0 0 4px 10px;">• Fencing &amp; gates<br>• Landscaping &amp; garden work<br>• Decking &amp; pergolas<br>• Cleaning &amp; carpet cleaning<br>• Pressure washing<br>• Rubbish &amp; green waste<br>• Flooring &amp; tiling<br>• Kitchen &amp; bathroom repairs/upgrades<br>• Concrete &amp; retaining walls</td></tr></table>'+
      '<p>If you have a maintenance requirement that isn’t listed above, feel free to ask us — we’ll let you know how we can assist.</p>'+
      '<p><strong>How MySubbies works:</strong><br>Maintenance request → Contractor coordination → Your approval → Work completed → Job updates</p>'+
      '<p>The aim is simple: <strong>give your team a straightforward way to manage maintenance while keeping you in control of every job.</strong></p>'+
      '<p style="font-size:16px;font-weight:700;">We’d love to introduce MySubbies to your team.</p>'+
      '<p>We’re currently inviting selected property managers to <strong>try MySubbies with one maintenance job</strong>, so you can see how the process works before deciding whether it’s useful for your business.</p>'+
      emailButton('Try MySubbies with one maintenance job →',registrationUrl(p.prospect_type))+
      '<p style="font-size:12px;color:#6B7280;margin-top:18px;">There’s no obligation — we’d simply appreciate the opportunity to demonstrate what we can do.</p>';
    const contractorBody='<h2 style="margin-top:0;">We bring you the work. You focus on doing the work.</h2>'+
      '<img src="https://www.mysubbies.com.au/images/contractor-landing-hero.jpg" alt="MySubbies contractor network" style="display:block;width:100%;height:auto;border-radius:10px;margin:0 0 22px;">'+
      '<p>We are building the MySubbies contractor network across Melbourne and are looking for reliable businesses to join us.</p>'+
      '<p>We aim to make getting work simpler — with clear job information and less quoting and administration.</p>'+
      '<p style="font-size:16px;font-weight:700;margin:22px 0 10px;">What you can expect</p>'+
      '<table width="100%" cellpadding="0" cellspacing="0" border="0" style="font-size:13px;line-height:21px;margin:0 0 20px;"><tr><td width="50%" valign="top" style="padding:0 10px 4px 0;">• Ongoing job opportunities<br>• Upfront payment amount before accepting<br>• No quoting for standard MySubbies jobs<br>• No upfront subscription or joining fee</td><td width="50%" valign="top" style="padding:0 0 4px 10px;">• Jobs matched to your trade &amp; area<br>• Customer &amp; job details in the portal<br>• Less time chasing customers<br>• Simple job management</td></tr></table>'+
      '<p><strong>You know what the job is and what you will be paid before you accept it.</strong></p>'+
      emailButton('Join the MySubbies contractor network →',registrationUrl(p.prospect_type))+
      '<p style="font-size:12px;color:#6B7280;margin-top:18px;">There is no upfront cost to join. We are looking for reliable contractors who want straightforward work opportunities.</p>';
    const result=await sendEmailWithResult({to:p.email,bcc:['accounts@mysubbies.com.au'],subject,html:wrapEmail((property?propertyBody:contractorBody)+'<p style="font-size:13px;line-height:20px;margin-top:24px;">Kind Regards,<br><strong>Mysubbies Holding Pty Ltd</strong></p>')});
    if(result.ok){await supabase.from('business_development_prospects').update({status:'invited',invitation_count:(p.invitation_count||0)+1,last_invited_at:new Date().toISOString(),updated_at:new Date().toISOString()}).eq('id',p.id);}
    await logActivity(supabase,p,'invitation_attempt',result.ok?'success':'failed',result.ok?'Invitation sent.':(result.error||'Invitation failed.'));
    results.push({id:p.id,ok:!!result.ok,error:result.ok?null:result.error});
  }
  res.status(200).json({results});
}
module.exports=async function handler(req,res){
  if(!requireAdmin(req,res))return;
  const supabase=getSupabase();
  try{
    const action=clean((req.query&&req.query.action)||(req.body&&req.body.action),80);
    if(req.method==='GET'&&action==='list'){await list(supabase,req,res);return;}
    if(req.method==='POST'&&action==='save'){await save(supabase,req.body||{},res);return;}
    if(req.method==='POST'&&action==='update'){await updateProspect(supabase,req.body||{},res);return;}
    if(req.method==='POST'&&action==='remove'){await removeProspect(supabase,req.body||{},res);return;}
    if(req.method==='POST'&&action==='delete'){await deleteProspect(supabase,req.body||{},res);return;}
    if(req.method==='POST'&&action==='search-public'){await searchPublic(req.body||{},res);return;}
    if(req.method==='POST'&&action==='enrich-email'){await enrichPublicEmail(supabase,req.body||{},res);return;}
    if(req.method==='POST'&&action==='invite'){await invite(supabase,req.body||{},res);return;}
    res.status(400).json({error:'Unsupported CRM action.'});
  }catch(e){console.error('business development error',e);res.status(500).json({error:'Business Development CRM request failed.'});}
};