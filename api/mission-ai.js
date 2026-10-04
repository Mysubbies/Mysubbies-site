const Anthropic = require('@anthropic-ai/sdk');
const { requireAdmin } = require('./_lib/adminAuth');

function clean(v,n){ return String(v||'').trim().slice(0,n||12000); }
function parseJson(text){
  const raw=String(text||'').trim().replace(/^\`\`\`(?:json)?\s*/i,'').replace(/\s*\`\`\`$/,'');
  return JSON.parse(raw);
}
function systemFor(mode){
  const common='You are MySubbies Group internal business AI. Australian English. Return ONLY valid JSON. Never claim qualifications, licences, projects, prices, availability, compliance, evidence, or facts that were not supplied. Mark unknowns clearly. Your output is a draft for human review and must never imply it has been approved, published, sent, or submitted.';
  if(mode==='marketing') return common+' Create practical conversion-focused campaign copy. JSON keys: name, offer, audience, serviceCategory, headline, bodyCopy, facebookCopy, instagramCopy, whatsappCopy, callToAction, hashtags.';
  if(mode==='blog') return common+' Create useful SEO content without keyword stuffing. bodyHtml may use simple safe HTML paragraphs and headings. JSON keys: title, slug, seoTitle, metaDescription, targetKeywords, excerpt, bodyHtml, featureImageAlt.';
  if(mode==='tender') return common+' Analyse only the tender information supplied. Separate confirmed requirements from assumptions and gaps. Do not invent credentials or compliance. JSON keys: summary, scope, mandatoryRequirements, exclusions, responseDraft, assumptions, complianceGaps.';
  throw new Error('Unsupported AI mode');
}
module.exports=async function handler(req,res){
  if(!requireAdmin(req,res)) return;
  if(req.method!=='POST'){res.status(405).json({error:'POST required.'});return;}
  try{
    const mode=clean(req.body&&req.body.mode,30);
    if(!['marketing','blog','tender'].includes(mode)){res.status(400).json({error:'Valid AI mode is required.'});return;}
    const input=clean(req.body&&req.body.input,16000);
    if(!input){res.status(400).json({error:'AI input is required.'});return;}
    if(!process.env.ANTHROPIC_API_KEY){res.status(503).json({error:'AI service is not configured.'});return;}
    const client=new Anthropic({apiKey:process.env.ANTHROPIC_API_KEY});
    const model=process.env.ANTHROPIC_MODEL||'claude-sonnet-4-5';
    const msg=await client.messages.create({model,max_tokens:mode==='blog'?5000:3500,temperature:0.3,system:systemFor(mode),messages:[{role:'user',content:input}]});
    const text=msg.content&&msg.content.filter(x=>x.type==='text').map(x=>x.text).join('\n');
    let draft; try{draft=parseJson(text);}catch(_){res.status(502).json({error:'AI returned an invalid structured draft. Please retry.'});return;}
    res.status(200).json({mode,draft,reviewRequired:true});
  }catch(e){console.error('mission AI error',e);res.status(500).json({error:'AI draft generation failed.'});}
};