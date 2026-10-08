const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');

const SOURCES = [
  { name:'Consumer Affairs Victoria - News & alerts', url:'https://www.consumer.vic.gov.au/news-and-alerts', jurisdiction:'Victoria' },
  { name:'Consumer Affairs Victoria - Renting', url:'https://www.consumer.vic.gov.au/housing/renting', jurisdiction:'Victoria' },
  { name:'WorkSafe Victoria - News', url:'https://www.worksafe.vic.gov.au/news', jurisdiction:'Victoria' },
  { name:'Energy Safe Victoria - Newsroom', url:'https://www.energysafe.vic.gov.au/newsroom', jurisdiction:'Victoria' },
  { name:'EPA Victoria - News and updates', url:'https://www.epa.vic.gov.au/about-epa/news-media-and-updates', jurisdiction:'Victoria' },
  { name:'Victorian Planning - Legislation & regulation', url:'https://www.planning.vic.gov.au/guides-and-resources/legislation-regulation-and-fees', jurisdiction:'Victoria' },
  { name:'Victorian Legislation', url:'https://www.legislation.vic.gov.au/', jurisdiction:'Victoria' }
];

function clean(v,n){return String(v||'').trim().slice(0,n||8000);}
function stripHtml(html){
  return clean(String(html||'')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi,' ')
    .replace(/<[^>]+>/g,' ')
    .replace(/&nbsp;/gi,' ')
    .replace(/&amp;/gi,'&')
    .replace(/&#39;/g,"'")
    .replace(/&quot;/gi,'"')
    .replace(/\s+/g,' '),22000);
}
function fingerprint(sourceUrl,title,effectiveDate){
  return crypto.createHash('sha256').update([sourceUrl,title,effectiveDate||''].join('|').toLowerCase()).digest('hex');
}
function normaliseSegments(v){
  const allowed=['real_estate','childcare','medical_clinic','dental_clinic','physio','aged_care','body_corporate','school','gym','warehouse','retail','hospitality'];
  return Array.isArray(v)?[...new Set(v.map(x=>String(x||'').trim()).filter(x=>allowed.includes(x)))]:[];
}
function parseJsonArray(raw){
  const text=String(raw||'').trim().replace(/^\`\`\`json/i,'').replace(/\`\`\`$/,'').trim();
  const first=text.indexOf('['),last=text.lastIndexOf(']');
  if(first<0||last<first)return [];
  try{const x=JSON.parse(text.slice(first,last+1));return Array.isArray(x)?x:[];}catch(e){return [];}
}
async function analyseSource(source,text){
  if(!process.env.ANTHROPIC_API_KEY)return [];
  const anthropic=new Anthropic({apiKey:process.env.ANTHROPIC_API_KEY});
  const today=new Date().toISOString().slice(0,10);
  const prompt=`You are the AI regulation-watch analyst for MySubbies, a Melbourne property maintenance, landscaping, outdoor construction and facilities-maintenance business.

Review the official-source page text below. Find only genuinely NEW, recently announced, amended, commenced, or upcoming regulatory/compliance changes that could create action for Victorian property managers, construction businesses, facilities managers, childcare, clinics, aged care, owners corporations/strata, schools, gyms, warehouses, retail or hospitality.

Do not invent rules. Ignore generic evergreen guidance unless the page clearly indicates a recent change, commencement, amendment, deadline, consultation or new obligation. Distinguish proposals/consultations from confirmed rules.

Today: ${today}
Official source: ${source.name}
URL: ${source.url}

Return ONLY a JSON array. Maximum 6 items. Each item:
{
 "title":"short factual title",
 "effectiveDate":"YYYY-MM-DD or empty",
 "summary":"what changed, factual and concise",
 "opportunityAngle":"how MySubbies could legitimately help without implying it is the regulator",
 "serviceCategory":"relevant MySubbies service",
 "affectedSegments":["real_estate","childcare","medical_clinic","dental_clinic","physio","aged_care","body_corporate","school","gym","warehouse","retail","hospitality"],
 "suggestedHeadline":"campaign headline",
 "suggestedCta":"short CTA",
 "confidence":0-100,
 "confirmed":true
}
If there is no meaningful recent change, return [].

SOURCE PAGE TEXT:
${text}`;
  const message=await anthropic.messages.create({
    model:'claude-sonnet-4-5',
    max_tokens:2200,
    messages:[{role:'user',content:prompt}]
  });
  const raw=(message.content||[]).find(x=>x.type==='text');
  return parseJsonArray(raw&&raw.text);
}
async function runRegulationWatch(supabase){
  const results={sources:0,changedSources:0,detected:0,added:0,duplicates:0,errors:[]};
  for(const source of SOURCES){
    results.sources++;
    try{
      const response=await fetch(source.url,{headers:{'User-Agent':'Mozilla/5.0 MySubbies Regulation Watch'},redirect:'follow'});
      if(!response.ok){results.errors.push(source.name+': HTTP '+response.status);continue;}
      const pageText=stripHtml(await response.text());
      if(pageText.length<200){results.errors.push(source.name+': page text unavailable');continue;}
      const pageHash=crypto.createHash('sha256').update(pageText).digest('hex');
      // If scan-source tracking table exists, skip unchanged pages; otherwise
      // continue and rely on opportunity-level deduplication.
      let sourceRow=null;
      try{
        const q=await supabase.from('marketing_regulation_scan_sources').select('*').eq('source_url',source.url).maybeSingle();
        if(!q.error)sourceRow=q.data;
      }catch(e){}
      if(sourceRow&&sourceRow.last_content_hash===pageHash){
        await supabase.from('marketing_regulation_scan_sources').update({last_scanned_at:new Date().toISOString(),last_error:null,updated_at:new Date().toISOString()}).eq('id',sourceRow.id);
        continue;
      }
      results.changedSources++;
      const findings=await analyseSource(source,pageText);
      results.detected+=findings.length;
      for(const item of findings){
        if(!item||!clean(item.title,240)||Number(item.confidence||0)<60)continue;
        const title=clean(item.title,240);
        const effectiveDate=/^\d{4}-\d{2}-\d{2}$/.test(String(item.effectiveDate||''))?String(item.effectiveDate):null;
        const fp=fingerprint(source.url,title,effectiveDate);
        let duplicate=false;
        try{
          const q=await supabase.from('marketing_regulation_watch').select('id').eq('source_fingerprint',fp).maybeSingle();
          if(!q.error&&q.data)duplicate=true;
        }catch(e){}
        if(!duplicate){
          const q=await supabase.from('marketing_regulation_watch').select('id').eq('source_url',source.url).ilike('title',title).maybeSingle();
          if(!q.error&&q.data)duplicate=true;
        }
        if(duplicate){results.duplicates++;continue;}
        const base={
          title,
          jurisdiction:source.jurisdiction,
          source_name:'AI Watch · '+source.name,
          source_url:source.url,
          effective_date:effectiveDate,
          affected_segments:normaliseSegments(item.affectedSegments),
          summary:clean(item.summary,8000),
          opportunity_angle:clean(item.opportunityAngle,5000),
          service_category:clean(item.serviceCategory,160)||'Property Maintenance',
          status:'watching'
        };
        // Use the richer columns when schema_v44 is present, but fall back
        // cleanly to the existing v43 regulation table.
        let insert={...base,review_status:'pending',detected_at:new Date().toISOString(),ai_generated:true,
          ai_confidence:Math.max(0,Math.min(100,Number(item.confidence||0))),suggested_headline:clean(item.suggestedHeadline,500)||null,
          suggested_cta:clean(item.suggestedCta,300)||null,source_fingerprint:fp};
        let out=await supabase.from('marketing_regulation_watch').insert(insert).select('id').single();
        if(out.error&&/column|schema cache/i.test(String(out.error.message||''))){
          out=await supabase.from('marketing_regulation_watch').insert(base).select('id').single();
        }
        if(out.error)throw out.error;
        results.added++;
      }
      try{
        if(sourceRow){
          await supabase.from('marketing_regulation_scan_sources').update({last_content_hash:pageHash,last_scanned_at:new Date().toISOString(),last_changed_at:new Date().toISOString(),last_error:null,updated_at:new Date().toISOString()}).eq('id',sourceRow.id);
        }
      }catch(e){}
    }catch(e){
      results.errors.push(source.name+': '+clean(e&&e.message,300));
      try{
        await supabase.from('marketing_regulation_scan_sources').update({last_scanned_at:new Date().toISOString(),last_error:clean(e&&e.message,500),updated_at:new Date().toISOString()}).eq('source_url',source.url);
      }catch(ignore){}
    }
  }
  return results;
}

module.exports={runRegulationWatch,SOURCES};