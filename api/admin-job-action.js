const { getSupabase } = require('./_lib/clients');
const { requireAdmin } = require('./_lib/adminAuth');
const { notifyContractor } = require('./_lib/contractorNotifications');

module.exports = async (req,res)=>{
  if(req.method!=='POST'){res.status(405).json({error:'Method not allowed'});return;}
  if(!requireAdmin(req,res)) return;
  try{
    const {jobId,action,contractorEmail,contractorName}=req.body||{};
    if(!jobId || !['assign','unassign'].includes(action)){res.status(400).json({error:'jobId and a valid action are required.'});return;}
    const s=getSupabase();
    const {data:job,error:findError}=await s.from('jobs').select('id,category,contractor_email,full_record').eq('id',jobId).maybeSingle();
    if(findError) throw findError;
    if(!job){res.status(404).json({error:'Job not found.'});return;}
    const previous=job.contractor_email||null;
    let nextEmail=null,nextName=null,nextStatus='feed';
    if(action==='assign'){
      nextEmail=String(contractorEmail||'').trim().toLowerCase();
      nextName=String(contractorName||'').trim();
      if(!nextEmail){res.status(400).json({error:'Select a contractor.'});return;}
      const {data:contractor,error:contractorError}=await s.from('contractors').select('email,business_name,status').eq('email',nextEmail).in('status',['approved','preferred']).maybeSingle();
      if(contractorError) throw contractorError;
      if(!contractor){res.status(400).json({error:'That contractor is not approved.'});return;}
      nextName=contractor.business_name||nextName||nextEmail;
      nextStatus='assigned';
    }
    const prior=job.full_record||{};
    const record={...prior,contractorEmail:nextEmail,contractor:nextName,status:nextStatus};
    const {error:updateError}=await s.from('jobs').update({contractor_email:nextEmail,full_record:record,updated_at:new Date().toISOString()}).eq('id',jobId);
    if(updateError) throw updateError;
    if(previous && previous!==nextEmail) await notifyContractor(s,{email:previous,eventType:'contractor-job-reassigned',title:'Job assignment changed',body:'The '+(job.category||'')+' job is no longer assigned to you.',subject:'Assignment update for your '+(job.category||'')+' job',jobId});
    if(nextEmail && previous!==nextEmail) await notifyContractor(s,{email:nextEmail,eventType:'contractor-job-assigned',title:'Job assigned to you',body:'The '+(job.category||'')+' job has been assigned to you. Review it in the portal.',subject:'A '+(job.category||'')+' job has been assigned to you',jobId});
    res.status(200).json({updated:true,jobId,contractorEmail:nextEmail,contractor:nextName,status:nextStatus});
  }catch(e){console.error('admin-job-action error',e);res.status(500).json({error:e.message||'Could not update job assignment.'});}
};