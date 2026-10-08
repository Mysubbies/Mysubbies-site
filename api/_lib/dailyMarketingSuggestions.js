const Anthropic = require('@anthropic-ai/sdk');

function clean(v,n){return String(v||'').trim().slice(0,n||8000);}
function parseJsonArray(raw){
  const text=String(raw||'').trim().replace(/^```json/i,'').replace(/```$/,'').trim();
  const first=text.indexOf('['),last=text.lastIndexOf(']');
  if(first<0||last<first)return [];
  try{const x=JSON.parse(text.slice(first,last+1));return Array.isArray(x)?x:[];}catch(e){return [];}
}
function segmentLabel(key){
  const map={
    real_estate:'Real estate & property management',childcare:'Childcare centres',medical_clinic:'Medical clinics',
    dental_clinic:'Dental clinics',physio:'Physio & allied health',aged_care:'Aged care',
    body_corporate:'Owners corporation / strata',school:'Schools & education',gym:'Gyms & fitness',
    warehouse:'Warehouses & industrial',retail:'Retail & shopping',hospitality:'Hospitality'
  };
  return map[key]||key;
}
function validSegments(v){
  const allowed=['real_estate','childcare','medical_clinic','dental_clinic','physio','aged_care','body_corporate','school','gym','warehouse','retail','hospitality'];
  return Array.isArray(v)?[...new Set(v.map(x=>String(x||'').trim()).filter(x=>allowed.includes(x)))]:[];
}
function suggestedHeroImage(serviceCategory,segments){
  const service=String(serviceCategory||'').toLowerCase();
  const segs=validSegments(segments);
  let file='property-maintenance.jpg';
  if(/landscap|garden|lawn|outdoor/.test(service)) file='gardening-lawn-mowing.jpg';
  else if(/deck/.test(service)) file='decking.jpg';
  else if(/pergola/.test(service)) file='pergola.jpg';
  else if(/fenc/.test(service)) file='fencing.jpg';
  else if(/concret/.test(service)) file='concreting.jpg';
  else if(/clean/.test(service)) file='cleaning.jpg';
  else if(/electrical|energy|lighting/.test(service)) file='electrical.jpg';
  else if(/plumb|drain|gutter/.test(service)) file='plumbing.jpg';
  else if(segs.includes('gym')) file='gardening-lawn-mowing.jpg';
  else if(segs.includes('real_estate')||segs.includes('body_corporate')) file='property-maintenance.jpg';
  return 'https://www.mysubbies.com.au/images/categories/'+file;
}
async function generateDailyMarketingSuggestions(supabase,{force=false}={}){
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Australia/Melbourne',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  if(!force){
    const existing=await supabase.from('marketing_campaigns').select('*').eq('ai_generated',true).eq('suggestion_date',today).order('ai_rank',{ascending:true});
    if(!existing.error&&(existing.data||[]).length)return {date:today,created:0,suggestions:existing.data,alreadyExists:true};
  }

  const [contactsQ,rulesQ,campaignsQ]=await Promise.all([
    supabase.from('marketing_contacts').select('segment,email,marketing_eligible,consent_status,status,suburb').limit(3000),
    supabase.from('marketing_regulation_watch').select('*').neq('status','archived').order('effective_date',{ascending:true}).limit(40),
    supabase.from('marketing_campaigns').select('name,campaign_type,audience_segments,headline,status,created_at,suggestion_date').order('created_at',{ascending:false}).limit(60)
  ]);
  for(const q of [contactsQ,rulesQ,campaignsQ])if(q.error)throw q.error;

  const contacts=contactsQ.data||[];
  const counts={};
  for(const c of contacts){
    const key=c.segment||'other';
    if(!counts[key])counts[key]={total:0,email:0,eligible:0,suburbs:{}};
    counts[key].total++;
    if(c.email)counts[key].email++;
    if(c.email&&c.marketing_eligible&&c.consent_status!=='opted_out')counts[key].eligible++;
    if(c.suburb)counts[key].suburbs[c.suburb]=(counts[key].suburbs[c.suburb]||0)+1;
  }
  const audienceSummary=Object.entries(counts).map(([k,v])=>{
    const topSuburbs=Object.entries(v.suburbs).sort((a,b)=>b[1]-a[1]).slice(0,5).map(x=>x[0]).join(', ');
    return `- ${segmentLabel(k)}: ${v.total} prospects, ${v.email} with public email, ${v.eligible} campaign-eligible${topSuburbs?' | common suburbs: '+topSuburbs:''}`;
  }).join('\n')||'(no CRM contacts yet)';

  const rules=(rulesQ.data||[]).map(r=>({
    title:r.title,effectiveDate:r.effective_date,segments:r.affected_segments||[],summary:r.summary,
    opportunity:r.opportunity_angle,service:r.service_category,status:r.status
  }));
  const recent=(campaignsQ.data||[]).map(c=>({
    name:c.name,type:c.campaign_type,segments:c.audience_segments||[],headline:c.headline,status:c.status,date:c.created_at
  }));

  if(!process.env.ANTHROPIC_API_KEY)throw new Error('ANTHROPIC_API_KEY is not configured.');
  const anthropic=new Anthropic({apiKey:process.env.ANTHROPIC_API_KEY});
  const prompt=`You are the daily growth-marketing strategist for MySubbies, a Melbourne facilities-maintenance, landscaping, outdoor construction and property-maintenance business.

Create exactly 3 practical campaign suggestions for today. They must be useful for generating real enquiries, not generic social posts.

Use these inputs:
TODAY: ${today}

CRM AUDIENCE:
${audienceSummary}

CURRENT REGULATION / OPPORTUNITY WATCH:
${JSON.stringify(rules)}

RECENT CAMPAIGNS (avoid repetitive ideas):
${JSON.stringify(recent)}

Rules:
- Prefer audiences that actually exist in the CRM.
- If a timely regulation creates a strong opportunity, one suggestion may focus on it.
- The other suggestions can be facilities maintenance, seasonal/property risk, preventative maintenance, outdoor works, compliance-readiness or a useful business update.
- Do not invent legal requirements or imply MySubbies is a regulator.
- Make the email useful first, sales second.
- Keep claims factual and conservative.
- Each suggestion must be ready for human review, not automatically sent.
- Audience segments must only use these keys: real_estate, childcare, medical_clinic, dental_clinic, physio, aged_care, body_corporate, school, gym, warehouse, retail, hospitality.
- Rank 1 is the strongest recommendation.

Return ONLY a JSON array with exactly 3 objects:
[
 {
   "rank":1,
   "name":"campaign name",
   "campaignType":"regulation|facilities|seasonal|offer",
   "audienceSegments":["real_estate"],
   "serviceCategory":"Property Maintenance",
   "emailSubject":"...",
   "headline":"...",
   "bodyCopy":"plain text email body, 120-220 words",
   "flyerCopy":"short flyer copy, about 60-100 words",
   "callToAction":"Book a maintenance job",
   "bookingUrl":"https://www.mysubbies.com.au/mysubbies-property-managers.html",
   "rationale":"why this is worth running today, including audience fit"
 }
]`;

  const message=await anthropic.messages.create({
    model:'claude-sonnet-4-5',max_tokens:4200,
    messages:[{role:'user',content:prompt}]
  });
  const raw=(message.content||[]).find(x=>x.type==='text');
  const ideas=parseJsonArray(raw&&raw.text).slice(0,3);
  if(ideas.length!==3)throw new Error('AI did not return three campaign suggestions.');

  const inserted=[];
  for(let i=0;i<ideas.length;i++){
    const x=ideas[i]||{};
    const row={
      name:clean(x.name,180)||`AI campaign suggestion ${i+1}`,
      campaign_type:['regulation','facilities','seasonal','offer'].includes(x.campaignType)?x.campaignType:'facilities',
      audience:validSegments(x.audienceSegments).map(segmentLabel).join(', ')||null,
      audience_segments:validSegments(x.audienceSegments),
      service_category:clean(x.serviceCategory,120)||'Property Maintenance',
      headline:clean(x.headline,240)||null,
      body_copy:clean(x.bodyCopy,12000)||null,
      email_subject:clean(x.emailSubject,240)||null,
      flyer_copy:null,
      call_to_action:clean(x.callToAction,300)||'Book a maintenance job',
      booking_url:clean(x.bookingUrl,1000)||'https://www.mysubbies.com.au/',
      image_url:suggestedHeroImage(x.serviceCategory,x.audienceSegments),
      status:'ready_for_review',
      ai_generated:true,suggestion_date:today,ai_rationale:clean(x.rationale,3000)||null,
      ai_rank:Number.isFinite(Number(x.rank))?Math.max(1,Math.min(3,Math.round(Number(x.rank)))):i+1,
      tracking_code:'ai_'+today.replace(/-/g,'')+'_'+(i+1),
      updated_at:new Date().toISOString()
    };
    const existingRank=await supabase.from('marketing_campaigns').select('*').eq('tracking_code',row.tracking_code).maybeSingle();
    if(existingRank.error)throw existingRank.error;
    if(existingRank.data){inserted.push(existingRank.data);continue;}
    const out=await supabase.from('marketing_campaigns').insert(row).select('*').single();
    if(out.error){
      if(String(out.error.code||'')==='23505'){
        const raced=await supabase.from('marketing_campaigns').select('*').eq('tracking_code',row.tracking_code).single();
        if(raced.error)throw raced.error;
        inserted.push(raced.data);continue;
      }
      throw out.error;
    }
    inserted.push(out.data);
    try{await supabase.from('marketing_campaign_activity').insert({campaign_id:out.data.id,event_type:'ai_suggested',detail:'Daily AI marketing suggestion for '+today});}catch(e){}
  }
  return {date:today,created:inserted.length,suggestions:inserted,alreadyExists:false};
}

module.exports={generateDailyMarketingSuggestions};