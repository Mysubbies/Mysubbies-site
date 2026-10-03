const { getSupabase } = require('./_lib/clients');
const { requireAdmin } = require('./_lib/adminAuth');
const { sendEmailWithResult, wrapEmail, escapeHtml, emailButton } = require('./_lib/email');

function clean(v,n){ return String(v||'').trim().slice(0,n||500); }
function email(v){ const x=clean(v,254).toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x)?x:''; }
function type(v){ return v==='property_manager'?'property_manager':'contractor'; }
async function logActivity(supabase,p,eventType,outcome,detail){try{await supabase.from('business_development_activity').insert({prospect_id:p.id,prospect_type:p.prospect_type,event_type:eventType,outcome:outcome||'success',detail:clean(detail,500)||null});}catch(e){console.error('CRM audit log failed',e);}}
function registrationUrl(t){
  return t==='property_manager'
    ? 'https://app.mysubbies.com.au/mysubbies-property-portal.html'
    : 'https://app.mysubbies.com.au/mysubbies-contractor-portal.html';
}
async function list(supabase,req,res){
  const t=type(req.query.type);
  const {data,error}=await supabase.from('business_development_prospects').select('*').eq('prospect_type',t).order('updated_at',{ascending:false}).limit(1000);
  if(error) throw error; res.status(200).json({prospects:data||[]});
}
async function save(supabase,body,res){
  const t=type(body.prospectType), e=email(body.email);
  const row={prospect_type:t,business_name:clean(body.businessName,180),contact_name:clean(body.contactName,120)||null,email:e||null,phone:clean(body.phone,60)||null,website:clean(body.website,500)||null,suburb:clean(body.suburb,120)||null,state:clean(body.state,20)||'VIC',trade_or_segment:clean(body.tradeOrSegment,160)||null,source_provider:clean(body.sourceProvider,80),source_url:clean(body.sourceUrl,1000),source_reference:clean(body.sourceReference,500)||null};
  if(!row.business_name||!row.source_provider||!row.source_url){res.status(400).json({error:'Business name and source evidence are required.'});return;}
  if(e){const {data:existing,error:xerr}=await supabase.from('business_development_prospects').select('*').eq('prospect_type',t).ilike('email',e).maybeSingle();if(xerr)throw xerr;if(existing){await logActivity(supabase,existing,'duplicate_prevented','success','Existing prospect returned instead of creating a duplicate.');res.status(200).json({prospect:existing,duplicatePrevented:true});return;}}
  const {data,error}=await supabase.from('business_development_prospects').insert(row).select('*').single();if(error)throw error;await logActivity(supabase,data,'prospect_created','success','Source-backed prospect added to CRM.');res.status(201).json({prospect:data});
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
    if(req.method==='POST'&&action==='invite'){await invite(supabase,req.body||{},res);return;}
    res.status(400).json({error:'Unsupported CRM action.'});
  }catch(e){console.error('business development error',e);res.status(500).json({error:'Business Development CRM request failed.'});}
};