const { getSupabase } = require('./_lib/clients');
const { requireAdmin } = require('./_lib/adminAuth');
function clean(v,n){return String(v||'').trim().slice(0,n||5000);}
async function log(s,id,event,detail){try{await s.from('marketing_campaign_activity').insert({campaign_id:id,event_type:event,detail:clean(detail,500)||null});}catch(e){console.error('marketing audit failed',e);}}
module.exports=async function handler(req,res){
 if(!requireAdmin(req,res))return; const s=getSupabase();
 try{
  const action=clean((req.query&&req.query.action)||(req.body&&req.body.action),50);
  if(req.method==='GET'&&action==='list'){const {data,error}=await s.from('marketing_campaigns').select('*').order('updated_at',{ascending:false}).limit(500);if(error)throw error;res.status(200).json({campaigns:data||[]});return;}
  if(req.method==='POST'&&action==='save'){
   const b=req.body||{}, id=clean(b.id,50), allowed=['draft','ready_for_review','approved','scheduled','published','archived'];
   const row={name:clean(b.name,180),campaign_type:clean(b.campaignType,80)||'seasonal',offer:clean(b.offer,1000)||null,audience:clean(b.audience,500)||null,service_category:clean(b.serviceCategory,120)||null,headline:clean(b.headline,240)||null,body_copy:clean(b.bodyCopy,8000)||null,facebook_copy:clean(b.facebookCopy,5000)||null,instagram_copy:clean(b.instagramCopy,5000)||null,whatsapp_copy:clean(b.whatsappCopy,3000)||null,call_to_action:clean(b.callToAction,300)||null,hashtags:clean(b.hashtags,1000)||null,booking_url:clean(b.bookingUrl,1000)||null,image_url:clean(b.imageUrl,1500)||null,status:allowed.includes(b.status)?b.status:'draft',updated_at:new Date().toISOString()};
   if(!row.name){res.status(400).json({error:'Campaign name is required.'});return;}
   let q=id?s.from('marketing_campaigns').update(row).eq('id',id):s.from('marketing_campaigns').insert({...row,tracking_code:'mkt_'+Date.now().toString(36)});
   const {data,error}=await q.select('*').single();if(error)throw error;await log(s,data.id,id?'campaign_updated':'campaign_created',data.status);res.status(id?200:201).json({campaign:data});return;
  }
  if(req.method==='POST'&&action==='approve'){const id=clean(req.body&&req.body.id,50);if(!id){res.status(400).json({error:'Campaign id is required.'});return;}const {data,error}=await s.from('marketing_campaigns').update({status:'approved',updated_at:new Date().toISOString()}).eq('id',id).select('*').single();if(error)throw error;await log(s,id,'campaign_approved','Approved by admin.');res.status(200).json({campaign:data});return;}
  res.status(400).json({error:'Unsupported Marketing Centre action.'});
 }catch(e){console.error('marketing centre error',e);res.status(500).json({error:'Marketing Centre request failed.'});}
};