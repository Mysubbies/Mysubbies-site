// In-memory service boundary for isolated pilot testing. Never connects to live services.
const crypto = require('node:crypto');
function createPilot() {
  const tables = Object.fromEntries(['pm_organisations','pm_members','pm_properties','pm_work_orders','pm_work_order_files','pm_work_order_events','jobs','job_offers','contractors','platform_rate_card','property_profiles','property_history'].map(t=>[t,[]]));
  tables.contractors.push({id:'contractor-one',auth_user_id:'auth-contractor',email:'contractor@example.invalid',business_name:'Pilot Trades',status:'approved',categories:['Handyman']}, {id:'contractor-two',auth_user_id:'auth-other',email:'other@example.invalid',business_name:'Other Trades',status:'approved',categories:['Handyman']});
  tables.platform_rate_card.push({id:true,categories:[{label:'Handyman',tasks:[{name:'Minor repair',rate:150,unit:'job'}]}]});
  const users = {pm:{id:'auth-pm',email:'pm@example.invalid'},requester:{id:'auth-requester',email:'requester@example.invalid'},contractor:{id:'auth-contractor',email:'contractor@example.invalid'},other:{id:'auth-other',email:'other@example.invalid'}};
  const emails=[],notifications=[],objects=new Map();
  const db = {
    auth:{getUser:async token=>({data:{user:users[token]||null},error:users[token]?null:new Error('Invalid token')})},
    storage:{from:()=>({upload:async(path,bytes)=>{objects.set(path,bytes);return {error:null}},createSignedUrl:async(path,ttl)=>({data:{signedUrl:'/pilot-files/'+encodeURIComponent(path)+'?ttl='+ttl},error:null})})},
    from(table) {
      if (!tables[table]) throw new Error('Unknown table '+table);
      let operation='select', values, filters=[], single=false, max=Infinity, sort;
      const q={
        select(){return q},eq(k,v){filters.push(r=>r[k]===v);return q},neq(k,v){filters.push(r=>r[k]!==v);return q},is(k,v){filters.push(r=>(r[k]??null)===v);return q},in(k,v){filters.push(r=>v.includes(r[k]));return q},not(k,op,v){filters.push(r=>(r[k]??null)!==v);return q},
        order(k,opts={}){sort=[k,opts.ascending!==false];return q},limit(n){max=n;return q},maybeSingle(){single=true;return q},single(){single=true;return q},
        insert(v){operation='insert';values=Array.isArray(v)?v:[v];return q},update(v){operation='update';values=v;return q},upsert(v){operation='upsert';values=Array.isArray(v)?v:[v];return q},
        then(resolve,reject){return Promise.resolve().then(()=>{
          let rows=tables[table].filter(r=>filters.every(f=>f(r)));
          if(operation==='insert'||operation==='upsert'){
            rows=[];
            for(const v of values){
              const old=tables[table].find(r=>v.id&&r.id===v.id || table==='job_offers'&&r.job_id===v.job_id&&r.contractor_id===v.contractor_id);
              if(old&&operation==='insert')return {data:null,error:{code:'23505'}};
              if(old){Object.assign(old,v);rows.push(old);continue;}
              const row={id:crypto.randomUUID(),created_at:new Date().toISOString(),updated_at:new Date().toISOString(),...v};
              if(table==='pm_organisations')row.status??='active';
              if(table==='pm_properties')row.active??=true;
              if(table==='pm_work_orders'){row.invoice_status??='not_issued';row.legal_review_status??='not_required';}
              if(table==='jobs')row.job_number=tables.jobs.length+1;
              tables[table].push(row);rows.push(row);
            }
          } else if(operation==='update')rows.forEach(r=>Object.assign(r,values));
          if(sort)rows.sort((a,b)=>String(a[sort[0]]).localeCompare(String(b[sort[0]]))*(sort[1]?1:-1));
          rows=rows.slice(0,max);
          if(single&&rows.length>1)return {data:null,error:new Error('Multiple rows')};
          return {data:structuredClone(single?rows[0]||null:rows),error:null};
        }).then(resolve,reject)}
      }; return q;
    }
  };
  const clients=require('../../api/_lib/clients');clients.getSupabase=()=>db;clients.getPropertySupabase=()=>db;
  const email=require('../../api/_lib/email');email.sendEmailWithResult=async message=>{emails.push(message);return {ok:true}};
  const notify=require('../../api/_lib/contractorNotifications');notify.notifyAdmin=async(db,message)=>{notifications.push(message);return {ok:true}};notify.notifyContractor=async(db,message)=>{notifications.push(message);return {ok:true}};
  process.env.ADMIN_SESSION_SECRET='isolated-pilot-test-secret';
  const adminToken=require('../../api/_lib/adminAuth').signAdminToken();
  const handlers={};
  for(const name of ['property-management','get-jobs','sync-jobs']){delete require.cache[require.resolve('../../api/'+name)];handlers[name]=require('../../api/'+name);}
  async function invoke(action,body={},token='admin',method='POST',handler='property-management'){
    let response;
    const req={method,body:{action,...body},query:method==='GET'?{action,...body}:{},headers:token==='admin'?{cookie:'__Host-mysubbies_admin_session='+adminToken}:{authorization:'Bearer '+token}};
    const res={status(code){this.code=code;return this},setHeader(){},json(data){response={status:this.code||200,body:data};return this}};
    await handlers[handler](req,res);return response;
  }
  return {db,tables,users,emails,notifications,objects,handlers,invoke,adminToken};
}
module.exports={createPilot};
