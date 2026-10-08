const { getSupabase } = require('./_lib/clients');

module.exports=async function handler(req,res){
  const token=String((req.query&&req.query.token)||(req.body&&req.body.token)||'').trim();
  if(!token){res.status(400).send('Missing unsubscribe token.');return;}
  try{
    const s=getSupabase();
    const {data,error}=await s.from('marketing_contacts')
      .update({consent_status:'opted_out',marketing_eligible:false,status:'archived',updated_at:new Date().toISOString()})
      .eq('unsubscribe_token',token).select('id').maybeSingle();
    if(error)throw error;
    if(!data){res.status(404).send('This unsubscribe link is not valid.');return;}
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.status(200).send('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribed - MySubbies</title></head><body style="font-family:Arial,sans-serif;background:#F7F7F5;color:#14213D;padding:40px 20px;"><div style="max-width:560px;margin:auto;background:#fff;border-radius:16px;padding:32px;"><h1 style="margin-top:0;">You are unsubscribed</h1><p>This email address will no longer receive MySubbies marketing campaigns.</p><p style="color:#6B7280;font-size:13px;">MySubbies · Melbourne, Victoria</p></div></body></html>');
  }catch(e){console.error('marketing unsubscribe error',e);res.status(500).send('Could not process unsubscribe. Please contact MySubbies.');}
};