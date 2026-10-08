const { getSupabase } = require('./_lib/clients');
const { requireAdmin } = require('./_lib/adminAuth');
const { sendEmailWithResult, escapeHtml, emailButton } = require('./_lib/email');

function clean(v,n){return String(v||'').trim().slice(0,n||5000);}
function validEmail(v){const x=clean(v,254).toLowerCase();return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x)?x:'';}
function arr(v,n){return Array.isArray(v)?v.map(x=>clean(x,120)).filter(Boolean).slice(0,n||30):[];}
function website(v){const x=clean(v,600);if(!x)return '';return /^https?:\/\//i.test(x)?x:'https://'+x;}
function extractEmails(html){
  const found=(String(html||'').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)||[]).map(x=>x.toLowerCase());
  return [...new Set(found.filter(x=>!/^(example|test|noreply|no-reply)@/.test(x)))];
}
function preferredEmail(list){
  return (list||[]).find(e=>/^(info|admin|office|hello|enquiries|enquiry|contact|reception|property|maintenance|support|manager)@/i.test(e))||(list||[])[0]||'';
}
async function websiteEmail(url){
  const root=website(url);if(!root)return '';
  const base=root.replace(/\/$/,'');
  for(const u of [root,base+'/contact',base+'/contact-us',base+'/about']){
    try{
      const r=await fetch(u,{headers:{'User-Agent':'Mozilla/5.0 MySubbies public business contact checker'},redirect:'follow'});
      if(!r.ok)continue;
      const found=extractEmails(await r.text());
      if(found.length)return preferredEmail(found);
    }catch(e){}
  }
  return '';
}
async function log(s,id,event,detail){
  if(!id)return;
  try{await s.from('marketing_campaign_activity').insert({campaign_id:id,event_type:event,detail:clean(detail,500)||null});}
  catch(e){console.error('marketing audit failed',e);}
}
function placesKey(){
  return String(process.env.GOOGLE_PLACES_SERVER_API_KEY||process.env.GOOGLE_PLACES_API_KEY||process.env.GOOGLE_MAPS_API_KEY||process.env.GOOGLE_MAPS_JS_API_KEY||process.env.GOOGLE_MAPS_BROWSER_API_KEY||process.env.GOOGLE_API_KEY||'').trim();
}
async function discoverContacts(s,b,res){
  const key=placesKey();
  if(!key){res.status(503).json({error:'Google Places server key is missing from this deployment.'});return;}
  const segment=clean(b.segment,120);
  const query=clean(b.query,220)||segment;
  const location=clean(b.location,160)||'Melbourne VIC';
  if(!segment||!query){res.status(400).json({error:'Segment and business search are required.'});return;}
  const response=await fetch('https://places.googleapis.com/v1/places:searchText',{
    method:'POST',
    headers:{'Content-Type':'application/json','X-Goog-Api-Key':key,'X-Goog-FieldMask':'places.id,places.displayName,places.formattedAddress,places.websiteUri,places.nationalPhoneNumber,places.googleMapsUri'},
    body:JSON.stringify({textQuery:query+' in '+location,pageSize:20,regionCode:'AU',languageCode:'en'})
  });
  const payload=await response.json().catch(()=>({}));
  if(!response.ok){
    const reason=clean(payload&&payload.error&&payload.error.message,700)||('Google Places returned HTTP '+response.status);
    const code=clean(payload&&payload.error&&payload.error.status,120)||'PLACES_API_ERROR';
    console.error('Marketing prospect Places search failed',{status:response.status,code:code});
    res.status(502).json({
      error:'Google Places search failed: '+reason,
      code:code,
      setupHint:'Use a server-side Google Places API key in Vercel (GOOGLE_PLACES_SERVER_API_KEY) with Places API (New) enabled. A browser/referrer-restricted Maps JavaScript key may not work from the server.'
    });return;
  }
  let created=0,updated=0,withEmail=0;
  const contacts=[];
  for(const p of payload.places||[]){
    const name=clean(p.displayName&&p.displayName.text,180);if(!name)continue;
    const sourceReference=clean(p.id,500);
    const formatted=clean(p.formattedAddress,300);
    const pieces=formatted.split(',').map(x=>x.trim());
    const email=await websiteEmail(p.websiteUri);
    const row={
      business_name:name,segment,contact_name:null,email:email||null,
      phone:clean(p.nationalPhoneNumber,60)||null,website:clean(p.websiteUri,600)||null,
      suburb:pieces.length>1?pieces[pieces.length-2]:null,state:'VIC',
      source_provider:'Google Places',
      source_url:clean(p.googleMapsUri,1000)||('https://www.google.com/maps/search/?api=1&query_place_id='+encodeURIComponent(p.id||'')),
      source_reference:sourceReference||null,
      consent_status:'unknown',consent_basis:null,marketing_eligible:false,
      updated_at:new Date().toISOString()
    };
    let existing=null;
    if(sourceReference){
      const x=await s.from('marketing_contacts').select('*').eq('source_reference',sourceReference).maybeSingle();
      if(x.error)throw x.error;existing=x.data;
    }
    if(!existing&&email){
      const x=await s.from('marketing_contacts').select('*').ilike('email',email).maybeSingle();
      if(x.error)throw x.error;existing=x.data;
    }
    let saved;
    if(existing){
      const patch={...row};
      if(existing.consent_status!=='unknown'){delete patch.consent_status;delete patch.consent_basis;delete patch.marketing_eligible;}
      const q=await s.from('marketing_contacts').update(patch).eq('id',existing.id).select('*').single();
      if(q.error)throw q.error;saved=q.data;updated++;
    }else{
      const q=await s.from('marketing_contacts').insert(row).select('*').single();
      if(q.error)throw q.error;saved=q.data;created++;
    }
    if(saved.email)withEmail++;
    contacts.push(saved);
  }
  res.status(200).json({query:query+' in '+location,created,updated,withEmail,contacts});
}
function campaignEmail(c,contact){
  const cta=clean(c.call_to_action,200)||'Book a maintenance job';
  const url=clean(c.booking_url,1000)||'https://www.mysubbies.com.au/';
  const headline=clean(c.headline,300)||clean(c.name,180);
  const body=clean(c.body_copy,12000).replace(/\n/g,'<br>');
  const flyer=c.image_url?'<img src="'+escapeHtml(c.image_url)+'" alt="'+escapeHtml(headline)+'" style="display:block;width:100%;height:auto;border-radius:12px;margin:0 0 20px;">':'';
  const unsubscribe='https://app.mysubbies.com.au/api/marketing-unsubscribe?token='+encodeURIComponent(contact.unsubscribe_token);
  return '<div style="font-family:Arial,Helvetica,sans-serif;max-width:620px;margin:0 auto;background:#F4F5F6;padding:24px 12px;">'+
    '<div style="background:#fff;border-radius:14px;overflow:hidden;">'+
    '<div style="background:#14213D;padding:28px 34px;"><span style="color:#fff;font-size:26px;font-weight:800;">My<span style="color:#FF6A1A;">Subbies</span></span></div>'+
    '<div style="padding:28px 34px;color:#14213D;font-size:15px;line-height:1.6;">'+flyer+
    '<h1 style="font-size:24px;line-height:1.2;margin:0 0 16px;">'+escapeHtml(headline)+'</h1>'+
    '<div>'+body+'</div>'+
    '<div style="margin-top:20px;">'+emailButton(cta,url,'orange')+'</div>'+
    '<p style="font-size:13px;margin-top:26px;">Kind regards,<br><strong>MySubbies</strong><br>1300 200 601</p>'+
    '</div></div>'+
    '<p style="font-size:11px;color:#7B8494;text-align:center;line-height:1.5;margin:16px 20px 0;">Mysubbies Holdings Pty Ltd · Melbourne VIC · This is a business marketing message. <a href="'+escapeHtml(unsubscribe)+'" style="color:#7B8494;text-decoration:underline;">Unsubscribe</a></p></div>';
}
async function sendCampaign(s,b,res){
  const id=clean(b.id,80);
  if(!id){res.status(400).json({error:'Campaign id is required.'});return;}
  const q=await s.from('marketing_campaigns').select('*').eq('id',id).maybeSingle();
  if(q.error)throw q.error;const c=q.data;
  if(!c){res.status(404).json({error:'Campaign not found.'});return;}
  if(c.status!=='approved'){res.status(409).json({error:'Approve the campaign before sending.'});return;}
  const segments=arr(c.audience_segments,30);
  let contactsQuery=s.from('marketing_contacts').select('*').eq('marketing_eligible',true).neq('consent_status','opted_out').not('email','is',null).limit(500);
  if(segments.length)contactsQuery=contactsQuery.in('segment',segments);
  const cr=await contactsQuery;if(cr.error)throw cr.error;
  const contacts=cr.data||[];
  if(!contacts.length){res.status(409).json({error:'No eligible contacts match this campaign audience.'});return;}
  const results=[];let sent=0,failed=0;
  for(const contact of contacts.slice(0,100)){
    const exists=await s.from('marketing_campaign_recipients').select('id,delivery_status').eq('campaign_id',id).eq('contact_id',contact.id).maybeSingle();
    if(exists.error)throw exists.error;
    if(exists.data&&exists.data.delivery_status==='sent'){results.push({id:contact.id,ok:true,skipped:true});continue;}
    const result=await sendEmailWithResult({to:contact.email,subject:clean(c.email_subject,240)||clean(c.headline,240)||clean(c.name,180),html:campaignEmail(c,contact)});
    const row={campaign_id:id,contact_id:contact.id,email:contact.email,delivery_status:result.ok?'sent':'failed',error_text:result.ok?null:clean(result.error,500),sent_at:result.ok?new Date().toISOString():null};
    if(exists.data)await s.from('marketing_campaign_recipients').update(row).eq('id',exists.data.id);
    else await s.from('marketing_campaign_recipients').insert(row);
    if(result.ok){sent++;await s.from('marketing_contacts').update({status:'contacted',last_contacted_at:new Date().toISOString(),updated_at:new Date().toISOString()}).eq('id',contact.id);}
    else failed++;
    results.push({id:contact.id,ok:!!result.ok,error:result.ok?null:result.error});
  }
  if(sent){
    await s.from('marketing_campaigns').update({status:'published',sent_at:new Date().toISOString(),published_at:new Date().toISOString(),updated_at:new Date().toISOString()}).eq('id',id);
  }
  await log(s,id,'campaign_send','Sent '+sent+'; failed '+failed+'; eligible audience '+contacts.length+'.');
  res.status(200).json({sent,failed,eligible:contacts.length,results});
}

module.exports=async function handler(req,res){
  if(!requireAdmin(req,res))return;
  const s=getSupabase();
  try{
    const action=clean((req.query&&req.query.action)||(req.body&&req.body.action),80);
    if(req.method==='GET'&&action==='list'){
      const [campaigns,contacts,regulations,targets]=await Promise.all([
        s.from('marketing_campaigns').select('*').order('updated_at',{ascending:false}).limit(500),
        s.from('marketing_contacts').select('*').order('updated_at',{ascending:false}).limit(1500),
        s.from('marketing_regulation_watch').select('*').order('effective_date',{ascending:true}).limit(500),
        s.from('marketing_search_targets').select('*').order('updated_at',{ascending:false}).limit(500)
      ]);
      for(const q of [campaigns,contacts,regulations,targets])if(q.error)throw q.error;
      res.status(200).json({campaigns:campaigns.data||[],contacts:contacts.data||[],regulations:regulations.data||[],searchTargets:targets.data||[]});return;
    }
    if(req.method==='POST'&&action==='discover_contacts'){await discoverContacts(s,req.body||{},res);return;}
    if(req.method==='POST'&&action==='update_contact'){
      const b=req.body||{},id=clean(b.id,80);if(!id){res.status(400).json({error:'Contact id is required.'});return;}
      const consent=['unknown','express','inferred','existing_relationship','opted_out'].includes(b.consentStatus)?b.consentStatus:'unknown';
      const eligible=consent!=='unknown'&&consent!=='opted_out'&&!!b.marketingEligible;
      const row={segment:clean(b.segment,120),contact_name:clean(b.contactName,160)||null,email:validEmail(b.email)||null,phone:clean(b.phone,60)||null,
        consent_status:consent,consent_basis:clean(b.consentBasis,1000)||null,consent_recorded_at:consent==='unknown'?null:new Date().toISOString(),
        marketing_eligible:eligible,status:clean(b.status,40)||'prospect',notes:clean(b.notes,3000)||null,updated_at:new Date().toISOString()};
      const q=await s.from('marketing_contacts').update(row).eq('id',id).select('*').single();if(q.error)throw q.error;
      res.status(200).json({contact:q.data});return;
    }
    if(req.method==='POST'&&action==='save'){
      const b=req.body||{}, id=clean(b.id,80), allowed=['draft','ready_for_review','archived'];
      const row={name:clean(b.name,180),campaign_type:clean(b.campaignType,80)||'seasonal',offer:clean(b.offer,1000)||null,audience:clean(b.audience,500)||null,
        audience_segments:arr(b.audienceSegments,30),service_category:clean(b.serviceCategory,120)||null,headline:clean(b.headline,240)||null,body_copy:clean(b.bodyCopy,12000)||null,
        email_subject:clean(b.emailSubject,240)||null,flyer_copy:clean(b.flyerCopy,8000)||null,facebook_copy:clean(b.facebookCopy,5000)||null,
        instagram_copy:clean(b.instagramCopy,5000)||null,whatsapp_copy:clean(b.whatsappCopy,3000)||null,call_to_action:clean(b.callToAction,300)||null,
        hashtags:clean(b.hashtags,1000)||null,booking_url:clean(b.bookingUrl,1000)||null,image_url:clean(b.imageUrl,1500)||null,
        regulation_id:clean(b.regulationId,80)||null,status:allowed.includes(b.status)?b.status:'draft',updated_at:new Date().toISOString()};
      if(!row.name){res.status(400).json({error:'Campaign name is required.'});return;}
      const q=id?s.from('marketing_campaigns').update(row).eq('id',id):s.from('marketing_campaigns').insert({...row,tracking_code:'mkt_'+Date.now().toString(36)});
      const out=await q.select('*').single();if(out.error)throw out.error;await log(s,out.data.id,id?'campaign_updated':'campaign_created',out.data.status);res.status(id?200:201).json({campaign:out.data});return;
    }
    if(req.method==='POST'&&action==='approve'){
      const id=clean(req.body&&req.body.id,80);if(!id){res.status(400).json({error:'Campaign id is required.'});return;}
      const q=await s.from('marketing_campaigns').update({status:'approved',updated_at:new Date().toISOString()}).eq('id',id).select('*').single();if(q.error)throw q.error;
      await log(s,id,'campaign_approved','Approved by admin.');res.status(200).json({campaign:q.data});return;
    }
    if(req.method==='POST'&&action==='send'){await sendCampaign(s,req.body||{},res);return;}
    if(req.method==='POST'&&action==='save_regulation'){
      const b=req.body||{},id=clean(b.id,80);
      const row={title:clean(b.title,240),jurisdiction:clean(b.jurisdiction,100)||'Victoria',source_name:clean(b.sourceName,160)||null,source_url:clean(b.sourceUrl,1200)||null,
        effective_date:clean(b.effectiveDate,20)||null,affected_segments:arr(b.affectedSegments,30),summary:clean(b.summary,8000)||null,opportunity_angle:clean(b.opportunityAngle,5000)||null,
        service_category:clean(b.serviceCategory,160)||null,status:['watching','campaign_ready','actioned','archived'].includes(b.status)?b.status:'watching',updated_at:new Date().toISOString()};
      if(!row.title){res.status(400).json({error:'Regulation title is required.'});return;}
      const q=id?s.from('marketing_regulation_watch').update(row).eq('id',id):s.from('marketing_regulation_watch').insert(row);
      const out=await q.select('*').single();if(out.error)throw out.error;res.status(id?200:201).json({regulation:out.data});return;
    }
    if(req.method==='POST'&&action==='save_search_target'){
      const b=req.body||{},id=clean(b.id,80);
      const row={channel:b.channel==='sem'?'sem':'seo',keyword:clean(b.keyword,300),location:clean(b.location,160)||'Melbourne VIC',intent:clean(b.intent,300)||null,
        landing_page:clean(b.landingPage,1200)||null,service_category:clean(b.serviceCategory,160)||null,priority:['low','medium','high'].includes(b.priority)?b.priority:'medium',
        status:['planned','in_progress','live','paused','complete'].includes(b.status)?b.status:'planned',monthly_budget_cents:Number.isFinite(Number(b.monthlyBudgetCents))?Math.max(0,Math.round(Number(b.monthlyBudgetCents))):null,
        notes:clean(b.notes,3000)||null,updated_at:new Date().toISOString()};
      if(!row.keyword){res.status(400).json({error:'Keyword is required.'});return;}
      const q=id?s.from('marketing_search_targets').update(row).eq('id',id):s.from('marketing_search_targets').insert(row);
      const out=await q.select('*').single();if(out.error)throw out.error;res.status(id?200:201).json({target:out.data});return;
    }
    res.status(400).json({error:'Unsupported Marketing Centre action.'});
  }catch(e){
    console.error('marketing centre error',e);
    res.status(500).json({error:'Marketing Centre request failed. The Growth Marketing schema may still need to be applied in Supabase.'});
  }
};