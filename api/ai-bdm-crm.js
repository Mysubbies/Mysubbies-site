const { requireAdmin }=require('./_lib/adminAuth');
const { getSupabase }=require('./_lib/clients');
const { outlookIntegrationReadiness }=require('../lib/ai-workforce/outlook-shared-mailbox-config');
const statuses=new Set(['new','qualified','contacted','interested','quoted','won','lost','suppressed']);
const clean=(v,max=500)=>typeof v==='string'?v.trim().slice(0,max):'';
module.exports=async(req,res)=>{
 if(!['GET','POST'].includes(req.method))return res.status(405).json({error:'Method not allowed'});
 if(!requireAdmin(req,res))return;
 res.setHeader('Cache-Control','no-store');
 let db;try{db=getSupabase()}catch(e){return res.status(503).json({error:'CRM backend not configured'})}
 try{
 if(req.method==='GET'){
 const [a,d]=await Promise.all([db.from('ai_bdm_accounts').select('id,business_name,suburb,category,service_interest,source_url,source_type,website,contact_email,contact_permission,status,notes,created_at').order('created_at',{ascending:false}).limit(100),db.from('ai_bdm_approvals').select('id,account_id,subject,message,status,created_at').eq('status','pending').order('created_at',{ascending:false}).limit(100)]);
 if(a.error||d.error)throw Error('CRM tables unavailable; apply reviewed migration');
 return res.status(200).json({accounts:a.data,approvals:d.data,outlook:outlookIntegrationReadiness()});
 }
 const b=typeof req.body==='string'?JSON.parse(req.body):req.body||{};
 if(b.action==='add_account'){
 const name=clean(b.business_name,150),suburb=clean(b.suburb,80),source=clean(b.source_url,500);
 if(!name||!suburb||!source||!['direct_enquiry','referral','independently_verified'].includes(b.source_type))return res.status(400).json({error:'Name, suburb, permitted source URL and source type required'});
 if(!/^https:\/\//i.test(source))return res.status(400).json({error:'Source URL must use HTTPS'});
 if(b.source_type==='independently_verified'&&/google\.(com|com\.au)\/maps|places\.google/i.test(source))return res.status(400).json({error:'Google Places preview data cannot be used as an independent CRM source'});
 const row={business_name:name,suburb,source_url:source,source_type:b.source_type,category:clean(b.category,80)||'other',service_interest:clean(b.service_interest,120)||'Property maintenance',notes:clean(b.notes,1000),status:'new',contact_permission:'unverified'};
 const {data,error}=await db.from('ai_bdm_accounts').insert(row).select('id').single();
 if(error){if(error.code==='23505')return res.status(409).json({error:'Business already exists in this suburb'});throw error}
 return res.status(201).json({id:data.id});
 }
 if(b.action==='status'){
 if(!statuses.has(b.status)||!clean(b.account_id,40))return res.status(400).json({error:'Invalid status or account'});
 const {data,error}=await db.from('ai_bdm_accounts').update({status:b.status,updated_at:new Date().toISOString()}).eq('id',b.account_id).select('id').maybeSingle();if(error)throw error;if(!data)return res.status(404).json({error:'Account not found'});return res.status(200).json({ok:true});
 }
 if(b.action==='submit_draft'){
 if(!clean(b.account_id,40)||!clean(b.subject,180)||!clean(b.message,5000))return res.status(400).json({error:'Account, subject and message required'});
 const {data:account,error:accountError}=await db.from('ai_bdm_accounts').select('id').eq('id',b.account_id).maybeSingle();if(accountError)throw accountError;if(!account)return res.status(404).json({error:'Account not found'});
 const {error}=await db.from('ai_bdm_approvals').insert({account_id:account.id,subject:clean(b.subject,180),message:clean(b.message,5000),status:'pending'});if(error)throw error;return res.status(201).json({ok:true});
 }
 if(b.action==='review'){
 if(!['approved','rejected'].includes(b.decision))return res.status(400).json({error:'Invalid decision'});
 const {data,error}=await db.from('ai_bdm_approvals').update({status:b.decision,reviewed_at:new Date().toISOString()}).eq('id',b.draft_id).eq('status','pending').select('id').maybeSingle();if(error)throw error;if(!data)return res.status(409).json({error:'Draft already reviewed or missing'});return res.status(200).json({ok:true,notice:'Review recorded; no email sent'});
 }
 return res.status(400).json({error:'Unsupported action'});
 }catch(e){console.error('BDM CRM error',e.message);return res.status(503).json({error:'CRM operation unavailable; verify migration and database setup'})}
};
