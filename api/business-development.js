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
  res.status(200).json({query:searchText,results:results,reviewRequired:true});
}
async function invite(supabase,body,res){
  const ids=Array.isArray(body.prospectIds)?body.prospectIds.slice(0,100):[];
  if(!ids.length){res.status(400).json({error:'Select at least one prospect.'});return;}
  const {data:rows,error}=await supabase.from('business_development_prospects').select('*').in('id',ids);if(error)throw error;
  const results=[];
  for(const p of rows||[]){
    if(!p.email){results.push({id:p.id,ok:false,error:'No public email recorded.'});continue;}
    const property=p.prospect_type==='property_manager';
    const subject=property?'MySubbies property maintenance partnership':'MySubbies contractor network invitation';
    const intro=property
      ? 'MySubbies Group helps property managers coordinate maintenance, quotes, contractors and job visibility through one portal.'
      : 'MySubbies Group is expanding its contractor network and is looking for reliable businesses for upcoming work.';
    const result=await sendEmailWithResult({to:p.email,subject,html:wrapEmail('<h2 style="margin-top:0;">'+escapeHtml(p.business_name)+'</h2><p>'+escapeHtml(intro)+'</p><p>We would like to invite your business to connect with MySubbies.</p>'+emailButton(property?'Explore Property Portal →':'Join the contractor network →',registrationUrl(p.prospect_type))+'<p style="font-size:12px;color:#6B7280;margin-top:18px;">This invitation was approved by the MySubbies team before sending.</p>')});
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
    if(req.method==='POST'&&action==='search-public'){await searchPublic(req.body||{},res);return;}
    if(req.method==='POST'&&action==='invite'){await invite(supabase,req.body||{},res);return;}
    res.status(400).json({error:'Unsupported CRM action.'});
  }catch(e){console.error('business development error',e);res.status(500).json({error:'Business Development CRM request failed.'});}
};