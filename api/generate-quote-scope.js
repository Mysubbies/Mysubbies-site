const Anthropic = require('@anthropic-ai/sdk');
const { requireAdmin } = require('./_lib/adminAuth');
module.exports = async (req,res) => {
 if(req.method!=='POST') return res.status(405).json({error:'Method not allowed'});
 if(!requireAdmin(req,res)) return;
 const seed=String((req.body||{}).description||'').trim();
 if(!seed)return res.status(400).json({error:'Enter a short description first.'});
 if(!process.env.ANTHROPIC_API_KEY)return res.status(503).json({error:'AI quote writing is not configured.'});
 try{
  const anthropic=new Anthropic({apiKey:process.env.ANTHROPIC_API_KEY});
  const m=await anthropic.messages.create({model:'claude-sonnet-4-5',max_tokens:650,messages:[{role:'user',content:`Write a professional Melbourne construction quote scope from this short line: "${seed}". Preserve supplied dimensions/quantities/material facts. Do not invent dimensions, brands, engineering ratings, permits, certifications or compliance claims. For unknown selections say "to be selected/confirmed". Include appropriate supply, installation, normal fixings/sealants and finishing. Mention removal/disposal only if implied. Return only 3-6 concise plain-text lines ready for a customer quote, with no heading, price, markdown or commentary.`}]});
  const out=(m.content.find(x=>x.type==='text')||{}).text||'';
  return res.status(200).json({description:out.trim()});
 }catch(e){console.error('quote scope AI error',e);return res.status(500).json({error:'Could not generate the scope. Please try again.'});}
};