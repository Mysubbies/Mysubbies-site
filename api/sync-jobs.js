// POST /api/sync-jobs
// Body: { jobs: [local display records] }
//
// Legacy portals still save a local array, but that array is no longer an
// authoritative replacement for jobs.full_record. Authenticated users may
// only append their own messages and update a small set of non-financial
// display/request fields. Structured database columns remain authoritative
// for identity, assignment, pricing and payment state.
const { getSupabase } = require('./_lib/clients');
const { verifyAdminAuth } = require('./_lib/adminAuth');
const { requireAccount } = require('./_lib/userAuth');
const { PROTECTED_FIELDS, mergePermittedMutation, restoreStructuredFields, initialRecord } = require('./_lib/jobMutationSecurity');
const { processJob, logJobEvent } = require('./_lib/jobLifecycle');

function requestedRole(req) {
  const role = req.body && req.body.role;
  return role === 'customer' || role === 'contractor' ? role : null;
}

function adminRecord(existing, submitted) {
  const prior = existing.full_record || {};
  // Admin may perform operational assignment/status/display edits, but even
  // an authenticated browser cannot overwrite financial/payment evidence.
  const merged = { ...prior, ...submitted };
  for (const key of PROTECTED_FIELDS) merged[key] = prior[key];
  // These two are explicit admin operations, rather than browser authority
  // over pricing/payment state.
  merged.contractor = submitted.contractor || null;
  const adminOperationalStatuses = new Set(['feed', 'assigned', 'cancellation_requested', 'cancelled']);
  merged.status = adminOperationalStatuses.has(submitted.status) ? submitted.status : prior.status;
  return restoreStructuredFields(merged, {
    ...existing,
    contractor_email: submitted.contractorEmail || null,
  });
}

function normalizeAddress(address) {
  return String(address || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

async function syncPropertyProfile(supabase, job) {
  const normalized = normalizeAddress(job.address);
  if (!normalized) return;
  const { data: profile, error } = await supabase.from('property_profiles').upsert({
    normalized_address: normalized,
    address: job.address,
    suburb: job.suburb || null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'normalized_address' }).select('id').single();
  if (error || !profile) return;

  // Completion state below is the previously stored, protected snapshot;
  // mergePermittedMutation never accepts paidStages/paymentSchedule from
  // this request.
  const complete = Array.isArray(job.paymentSchedule) && job.paymentSchedule.length
    && job.paymentSchedule.every(stage => job.paidStages && job.paidStages[stage.key]);
  if (!complete) return;
  await supabase.from('property_history').upsert({
    property_id: profile.id,
    job_id: job.id,
    category: job.category,
    task_summary: Array.isArray(job.items) ? job.items.map(item => item.taskName).filter(Boolean).join(', ') : null,
    contractor_email: job.contractorEmail || null,
    contractor_name: job.contractor || null,
    amount_paid_cents: Math.round((job.basePrice || 0) * 100) || null,
    completed_at: new Date().toISOString(),
  }, { onConflict: 'job_id' });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const { jobs } = req.body || {};
  if (!Array.isArray(jobs) || jobs.length === 0) {
    res.status(400).json({ error: 'jobs must be a non-empty array.' }); return;
  }

  try {
    const supabase = getSupabase();
    const isAdmin = verifyAdminAuth(req);
    const role = isAdmin ? 'admin' : requestedRole(req);
    if (!role) { res.status(400).json({ error: 'role must be customer or contractor.' }); return; }
    const auth = isAdmin ? null : await requireAccount(supabase, req, role);
    if (auth && !auth.ok) { res.status(auth.status).json({ error: auth.error }); return; }
    const email = auth ? String(auth.account.email).toLowerCase() : null;

    // Read and authorize the whole batch before any write. This avoids a
    // partial mutation when localStorage contains another account's record.
    const rows = [];
    for (const submitted of jobs.slice(0, 200)) {
      if (!submitted || !submitted.id) continue;
      const { data: existing, error } = await supabase.from('jobs').select('*').eq('id', submitted.id).maybeSingle();
      if (error) throw error;
      if (!existing) { res.status(409).json({ error: 'Job must be created by an authoritative booking flow before it can be synced.' }); return; }
      if (role === 'customer' && String(existing.customer_email || '').toLowerCase() !== email) {
        res.status(403).json({ error: 'You cannot modify another customer’s job.' }); return;
      }
      if (role === 'contractor' && existing.contractor_email && String(existing.contractor_email).toLowerCase() !== email) {
        res.status(403).json({ error: 'You cannot modify another contractor’s job.' }); return;
      }
      const accepting = role === 'contractor' && !existing.contractor_email
        && submitted.status === 'assigned' && !!submitted.contractorEmail;
      if (accepting) {
        const { data: contractor, error: contractorError } = await supabase.from('contractors').select('id,status,business_name').eq('email', email).maybeSingle();
        if (contractorError) throw contractorError;
        if (!contractor || !['approved', 'preferred'].includes(contractor.status)) { res.status(403).json({ error: 'An approved contractor profile is required.' }); return; }
        const { data: offer, error: offerError } = await supabase.from('job_offers').select('id,status,expires_at').eq('job_id', existing.id).eq('contractor_id', contractor.id).eq('status', 'pending').maybeSingle();
        if (offerError) throw offerError;
        if (!offer || (offer.expires_at && new Date(offer.expires_at) < new Date())) {
          res.status(409).json({ error: 'This job offer is no longer available to your account.' }); return;
        }
        submitted._acceptedOffer = { id: offer.id, contractorId: contractor.id, businessName: contractor.business_name || null };
      }
      if (role === 'contractor' && !existing.contractor_email && !accepting) continue;
      rows.push({ existing, submitted, accepting });
    }

    const synced = [];
    for (const { existing, submitted, accepting } of rows) {
      let storedRecord;
      if (role === 'admin') {
        const record = adminRecord(existing, submitted);
        storedRecord = record;
        const { error } = await supabase.from('jobs').update({
          full_record: record,
          contractor_email: submitted.contractorEmail || null,
          suburb: submitted.suburb || existing.suburb || null,
          updated_at: new Date().toISOString(),
        }).eq('id', existing.id);
        if (error) throw error;
      } else {
        const prior = existing.full_record || initialRecord(submitted, existing, auth);
        let record = mergePermittedMutation(prior, submitted, role);
        const update = { updated_at: new Date().toISOString() };
        if (accepting) {
          update.contractor_email = email;
          record = { ...record, contractorEmail: email, contractor: submitted._acceptedOffer.businessName, status: 'assigned' };
        }
        record = restoreStructuredFields(record, { ...existing, contractor_email: accepting ? email : existing.contractor_email });
        storedRecord = record;
        update.full_record = record;
        let query = supabase.from('jobs').update(update).eq('id', existing.id);
        if (accepting) query = query.is('contractor_email', null);
        const { error } = await query;
        if (error) throw error;
        if (accepting) {
          const { data: assigned } = await supabase.from('jobs').select('contractor_email,customer_email,category,suburb').eq('id', existing.id).single();
          if (String(assigned.contractor_email || '').toLowerCase() !== email) continue;
          await supabase.from('job_offers').update({ status: 'accepted', responded_at: new Date().toISOString() }).eq('id', submitted._acceptedOffer.id).eq('status', 'pending');
          await supabase.from('job_offers').update({ status: 'expired', responded_at: new Date().toISOString() }).eq('job_id', existing.id).eq('status', 'pending');
          await supabase.from('job_workflows').update({ state: 'assigned', next_retry_at: null, updated_at: new Date().toISOString() }).eq('job_id', existing.id);
          await supabase.from('ops_exceptions').update({ status: 'resolved', resolved_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('job_id', existing.id).eq('status', 'open');
          await supabase.from('notifications').insert([
            { recipient_role: 'customer', recipient_email: assigned.customer_email, event_type: 'job-assigned', title: 'Your contractor is matched', body: `${submitted._acceptedOffer.businessName || 'A vetted contractor'} accepted your ${assigned.category} job.`, link_job_id: existing.id },
            { recipient_role: 'admin', event_type: 'job-assigned', title: 'Job matched automatically', body: `${assigned.category} in ${assigned.suburb || 'Melbourne'} was accepted.`, link_job_id: existing.id },
          ]);
          await logJobEvent(supabase, existing.id, 'contractor_accepted', { contractorId: submitted._acceptedOffer.contractorId }, ['customer', 'contractor', 'admin']);
        }
      }
      synced.push(existing.id);
      try { await syncPropertyProfile(supabase, storedRecord); }
      catch (profileError) { console.error('property-profile sync error:', profileError); }
      if (role === 'customer' && !existing.contractor_email) {
        try {
          const { data: current } = await supabase.from('jobs').select('id,category,suburb,customer_email,contractor_email,base_price_cents,full_record,status').eq('id', existing.id).single();
          await processJob(supabase, current);
        } catch (lifecycleError) { console.error('job lifecycle start error:', lifecycleError); }
      }
    }
    res.status(200).json({ synced: synced.length });
  } catch (err) {
    console.error('sync-jobs error:', err);
    res.status(500).json({ error: 'Could not sync jobs.' });
  }
};
