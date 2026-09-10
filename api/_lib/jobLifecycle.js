const { sendEmail, wrapEmail, escapeHtml, emailButton } = require('./email');
const { CONTRACTOR_REGIONS, suburbToRegion, jobMatchesContractorArea } = require('./serviceAreas');

const MATCH_BATCH_SIZE = 3;
const MATCH_RETRY_MINUTES = 15;
const MAX_MATCH_ROUNDS = 3;

function normalized(value) { return String(value || '').trim().toLowerCase(); }
function list(value) { return Array.isArray(value) ? value : []; }
function contractorApplication(row) { return row.full_application || {}; }

function isEligible(job, contractor) {
  if (!['approved', 'preferred'].includes(contractor.status)) return false;
  const app = contractorApplication(contractor);
  const categories = list(contractor.categories).concat(list(app.trades)).map(normalized);
  if (!categories.includes(normalized(job.category))) return false;
  const areas = list(contractor.suburb_ids).concat(list(app.suburbs), list(app.regions));
  if (!areas.length || !job.suburb) return true;
  const regions = areas.filter(area => CONTRACTOR_REGIONS.includes(area));
  const suburbs = areas.filter(area => !CONTRACTOR_REGIONS.includes(area));
  return jobMatchesContractorArea(job.suburb, { regions, suburbs });
}

async function logJobEvent(supabase, jobId, eventType, payload = {}, visibleTo = ['admin']) {
  const { error } = await supabase.from('job_events').insert({
    job_id: jobId, event_type: eventType, actor_role: 'system', actor_id: 'job-lifecycle',
    payload, visible_to: visibleTo,
  });
  if (error) throw error;
}

async function notify(supabase, row) {
  const { error } = await supabase.from('notifications').insert(row);
  if (error) throw error;
}

async function openException(supabase, jobId, type, summary, details = {}) {
  const { data: existing, error: readError } = await supabase.from('ops_exceptions').select('id,status').eq('job_id', jobId).eq('exception_type', type).maybeSingle();
  if (readError) throw readError;
  const { error } = await supabase.from('ops_exceptions').upsert({
    job_id: jobId, exception_type: type, summary, details, status: 'open', updated_at: new Date().toISOString(),
  }, { onConflict: 'job_id,exception_type' });
  if (error) throw error;
  const newlyOpened = !existing || existing.status !== 'open';
  if (newlyOpened) {
    await notify(supabase, { recipient_role: 'admin', event_type: `ops_${type}`, title: 'Job lifecycle exception', body: summary, link_job_id: jobId });
    await logJobEvent(supabase, jobId, 'ops_exception_opened', { type, summary });
  }
  return newlyOpened;
}

async function ensureWorkflow(supabase, jobId) {
  const { error } = await supabase.from('job_workflows').upsert({ job_id: jobId }, { onConflict: 'job_id', ignoreDuplicates: true });
  if (error) throw error;
}

function rankContractors(rows) {
  return rows.slice().sort((a, b) => {
    const preferred = Number(b.status === 'preferred') - Number(a.status === 'preferred');
    if (preferred) return preferred;
    return Number(b.reliability_score || 0) - Number(a.reliability_score || 0);
  });
}

async function sendOffer(supabase, job, contractor, round) {
  const payout = Math.round(Number(job.base_price_cents || 0) * 0.82);
  const { error } = await supabase.from('job_offers').upsert({
    job_id: job.id, contractor_id: contractor.id, contractor_payout_cents: payout,
    match_score: contractor.reliability_score || null, status: 'pending', match_round: round,
    expires_at: new Date(Date.now() + MATCH_RETRY_MINUTES * 60000).toISOString(),
  }, { onConflict: 'job_id,contractor_id', ignoreDuplicates: true });
  if (error) throw error;
  await notify(supabase, {
    recipient_role: 'contractor', recipient_email: contractor.email, event_type: 'new-job-available',
    title: `New ${job.category} job`, body: `${job.suburb || 'Melbourne'} · review this job in your feed.`, link_job_id: job.id,
  });
  await sendEmail({
    to: contractor.email, subject: `New ${job.category} job in ${job.suburb || 'Melbourne'}`,
    html: wrapEmail(`<h2 style="margin-top:0;">New job available</h2><p>A <strong>${escapeHtml(job.category)}</strong> job is available in <strong>${escapeHtml(job.suburb || 'Melbourne')}</strong>.</p><p>Open your secure job feed to review the scope and accept.</p>${emailButton('Review job →', 'https://app.mysubbies.com.au/contractor')}`),
  });
}

async function processJob(supabase, job, now = new Date()) {
  await ensureWorkflow(supabase, job.id);
  if (job.contractor_email) return { jobId: job.id, state: 'assigned' };
  const record = job.full_record || {};
  const missing = ['customer_email', 'category', 'suburb'].filter(key => !(job[key] || record[key.replace('_email', 'Email')]));
  if (!record.address) missing.push('address');
  if (missing.length) {
    await supabase.from('job_workflows').update({ state: 'awaiting_intake', updated_at: now.toISOString() }).eq('job_id', job.id);
    const newlyOpened = await openException(supabase, job.id, 'incomplete_intake', `Job is missing required intake: ${missing.join(', ')}`, { missing });
    if (newlyOpened && job.customer_email) await notify(supabase, { recipient_role: 'customer', recipient_email: job.customer_email, event_type: 'intake_required', title: 'Complete your job details', body: 'Add the missing site details so contractor matching can continue.', link_job_id: job.id });
    return { jobId: job.id, state: 'awaiting_intake', missing };
  }

  const { data: workflow, error: workflowError } = await supabase.from('job_workflows').select('*').eq('job_id', job.id).single();
  if (workflowError) throw workflowError;
  if (workflow.state === 'matching' && workflow.next_retry_at && new Date(workflow.next_retry_at) > now) {
    return { jobId: job.id, state: 'matching', deferred: true };
  }
  const previousRound = Number(workflow.match_round || 0);
  if (previousRound >= MAX_MATCH_ROUNDS) {
    await supabase.from('job_workflows').update({ state: 'exception', next_retry_at: null, updated_at: now.toISOString() }).eq('job_id', job.id);
    await openException(supabase, job.id, 'no_contractor_match', `No contractor accepted ${job.category} in ${job.suburb} after ${previousRound} matching rounds.`, { round: previousRound });
    return { jobId: job.id, state: 'exception', offered: 0 };
  }
  const round = previousRound + 1;
  await supabase.from('job_offers').update({ status: 'expired', responded_at: now.toISOString() }).eq('job_id', job.id).eq('status', 'pending').lt('expires_at', now.toISOString());
  const { data: contractors, error } = await supabase.from('contractors').select('id,email,status,categories,suburb_ids,reliability_score,full_application');
  if (error) throw error;
  const { data: existing } = await supabase.from('job_offers').select('contractor_id').eq('job_id', job.id);
  const offered = new Set(list(existing).map(row => row.contractor_id));
  const matches = rankContractors(list(contractors).filter(c => isEligible(job, c) && !offered.has(c.id))).slice(0, MATCH_BATCH_SIZE);
  for (const contractor of matches) await sendOffer(supabase, job, contractor, round);

  const nextRetry = new Date(now.getTime() + MATCH_RETRY_MINUTES * 60000).toISOString();
  await supabase.from('job_workflows').update({ state: 'matching', match_round: round, next_retry_at: nextRetry, last_matched_at: now.toISOString(), updated_at: now.toISOString() }).eq('job_id', job.id);
  await logJobEvent(supabase, job.id, 'contractor_match_round', { round, recipients: matches.map(c => c.id), nextRetry });
  return { jobId: job.id, state: 'matching', offered: matches.length, round };
}

async function processDueJobs(supabase, limit = 50) {
  const now = new Date();
  const { data: jobs, error } = await supabase.from('jobs').select('id,category,suburb,customer_email,contractor_email,base_price_cents,full_record,status').neq('status', 'cancelled').limit(limit);
  if (error) throw error;
  const results = [];
  for (const job of jobs || []) {
    const { data: workflow } = await supabase.from('job_workflows').select('state,next_retry_at').eq('job_id', job.id).maybeSingle();
    if (job.contractor_email || ['assigned', 'awaiting_intake', 'exception', 'completed', 'cancelled'].includes(workflow?.state)) continue;
    if (workflow?.next_retry_at && new Date(workflow.next_retry_at) > now) continue;
    results.push(await processJob(supabase, job, now));
  }
  return results;
}

module.exports = { MATCH_BATCH_SIZE, MATCH_RETRY_MINUTES, MAX_MATCH_ROUNDS, isEligible, processJob, processDueJobs, logJobEvent, suburbToRegion };
