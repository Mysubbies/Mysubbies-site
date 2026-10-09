// Admin-only BDM import preview. Accepts externally verified, licensed prospect data.
// Does not call external data providers, send messages or write to the database.
const { requireAdmin } = require('./_lib/adminAuth');
const { normalizeProspect } = require('../lib/ai-workforce/prospect-ingestion');
module.exports = async (req, res) => {
 if (req.method !== 'POST') return res.status(405).json({error:'Method not allowed'});
 if (!requireAdmin(req,res)) return;
 try {
   const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
   const rows = body?.prospects;
   if (!Array.isArray(rows) || rows.length > 25) return res.status(400).json({error:'Provide up to 25 prospects'});
   const normalized = rows.map(normalizeProspect);
   const unique = new Set();
   const duplicates = [];
   normalized.forEach((row,index)=>{
     const key = row.provider_place_id ? row.provider+':'+row.provider_place_id : null;
     if(key && unique.has(key)) duplicates.push(index);
     if(key) unique.add(key);
   });
   return res.status(200).json({
     mode:'preview_only', suburb:body?.suburb || null,
     received:normalized.length, duplicates_in_batch:duplicates,
     ready_for_review:normalized.filter((r,i)=>r.provider_place_id && !duplicates.includes(i)).length,
     missing_provider_id:normalized.filter(r=>!r.provider_place_id).length,
     prospects:normalized.map(({public_email,...safe})=>safe),
     next_step:'Review source licensing and authorize a separate ingestion operation. No records have been saved.'
   });
 } catch(e){return res.status(400).json({error:'Invalid prospect input',detail:e.message});}
};
