const { getSupabase } = require('./_lib/clients');
const { generateDailyMarketingSuggestions } = require('./_lib/dailyMarketingSuggestions');

module.exports=async function handler(req,res){
  if(req.method!=='GET'){res.status(405).json({error:'Method not allowed'});return;}
  if(!process.env.CRON_SECRET || req.headers.authorization!==`Bearer ${process.env.CRON_SECRET}`){
    res.status(401).json({error:'Unauthorized'});return;
  }
  try{
    const result=await generateDailyMarketingSuggestions(getSupabase());
    res.status(200).json(result);
  }catch(e){
    console.error('daily marketing suggestions cron error',e);
    res.status(500).json({error:'Daily marketing suggestion generation failed.'});
  }
};