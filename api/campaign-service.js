const { getSupabase } = require('./_lib/clients');

function clean(v,n){return String(v||'').trim().slice(0,n||10000);}
function validEmail(v){const x=clean(v,254).toLowerCase();return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x)?x:'';}

module.exports=async function handler(req,res){
  const s=getSupabase();
  if(req.method==='GET'){
    const service=clean(req.query&&req.query.service,180);
    try{
      const q=await s.from('platform_rate_card').select('categories').eq('id',true).maybeSingle();
      if(q.error)throw q.error;
      const categories=(q.data&&Array.isArray(q.data.categories))?q.data.categories:[];
      const needle=service.toLowerCase();
      let match=null;
      for(const cat of categories){
        if(cat.deleted||cat.disabled)continue;
        const enabled=(cat.tasks||[]).filter(t=>!t.disabled&&!t.unavailable);
        if(!enabled.length)continue;
        if(String(cat.label||'').toLowerCase()===needle){match={category:cat.label,task:null};break;}
        const task=enabled.find(t=>String(t.name||'').toLowerCase()===needle);
        if(task){match={category:cat.label,task:task.name};break;}
      }
      res.setHeader('Cache-Control','no-store');
      res.status(200).json({service,bookable:!!match,match});return;
    }catch(e){
      console.error('campaign service resolve error',e);
      res.status(500).json({error:'Could not check service availability.'});return;
    }
  }

  if(req.method==='POST'){
    const b=req.body||{};
    const email=validEmail(b.email);
    const requestedService=clean(b.requestedService,180);
    if(!email||!requestedService){res.status(400).json({error:'Email and requested service are required.'});return;}
    try{
      const row={
        campaign_id:clean(b.campaignId,80)||null,
        campaign_name:clean(b.campaignName,180)||null,
        requested_service:requestedService,
        business_name:clean(b.businessName,180)||null,
        contact_name:clean(b.contactName,160)||null,
        email,
        phone:clean(b.phone,60)||null,
        suburb:clean(b.suburb,120)||null,
        property_address:clean(b.propertyAddress,300)||null,
        scope:clean(b.scope,8000)||null,
        source_url:clean(b.sourceUrl,1200)||null,
        status:'new',
        updated_at:new Date().toISOString()
      };
      const q=await s.from('marketing_service_requests').insert(row).select('id').single();
      if(q.error)throw q.error;
      res.status(201).json({created:true,id:q.data.id});return;
    }catch(e){
      console.error('campaign service request error',e);
      res.status(500).json({error:'Could not submit your request. Please try again or contact MySubbies.'});return;
    }
  }

  res.status(405).json({error:'Method not allowed'});
};