// Preview-only Google Places Text Search integration.
// IMPORTANT: Google's Places terms limit caching/storage and permitted uses.
// Do not write Places results into a permanent prospect database without
// a separately reviewed data-rights and compliance plan.
const { requireAdmin } = require('./_lib/adminAuth');
const ALLOWED_CATEGORIES = new Set(['medical clinics','schools','real estate agencies']);
const ALLOWED_SUBURBS = new Set(['Craigieburn']);
module.exports = async (req,res) => {
 if(req.method!=='GET')return res.status(405).json({error:'Method not allowed'});
 if(!requireAdmin(req,res))return;
 const suburb=String(req.query?.suburb||'Craigieburn').trim();
 const category=String(req.query?.category||'medical clinics').trim().toLowerCase();
 if(!ALLOWED_SUBURBS.has(suburb)||!ALLOWED_CATEGORIES.has(category))
   return res.status(400).json({error:'Pilot limited to Craigieburn and approved categories'});
 const key=process.env.GOOGLE_PLACES_API_KEY;
 if(!key)return res.status(503).json({error:'GOOGLE_PLACES_API_KEY not configured',setup:'Configure a restricted server-side Places API key in Vercel Preview environment.'});
 try{
   const controller=new AbortController();
   const timeout=setTimeout(()=>controller.abort(),8000);
   let response;
   try{
     response=await fetch('https://places.googleapis.com/v1/places:searchText',{
       method:'POST',signal:controller.signal,
       headers:{'Content-Type':'application/json','X-Goog-Api-Key':key,'X-Goog-FieldMask':'places.id,places.displayName,places.formattedAddress,places.websiteUri'},
       body:JSON.stringify({textQuery:category+' in '+suburb+', Victoria, Australia',pageSize:10,regionCode:'AU',languageCode:'en'})
     });
   }finally{clearTimeout(timeout);}
   if(!response.ok){console.error('Places API returned status',response.status);return res.status(502).json({error:'Places provider unavailable',provider_status:response.status});}
   const data=await response.json();
   return res.status(200).json({mode:'temporary_preview_only',category,suburb,results:(data.places||[]).map(p=>({
      provider_place_id:p.id,business_name:p.displayName?.text||'',address:p.formattedAddress||'',website:p.websiteUri||null
   })),notice:'Preview only. Results are not stored, emailed, or automatically added to the CRM. Check provider licensing before persistent storage.'});
 }catch(e){console.error('Places pilot search failed',e.name);return res.status(502).json({error:'Places search failed or timed out'});}
};
