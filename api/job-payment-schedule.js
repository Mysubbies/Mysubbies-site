// GET  /api/job-payment-schedule?jobId=X
//        -> the persisted schedule + milestones for an existing job (used
//           by all three portals' payment displays).
// GET  /api/job-payment-schedule?category=X&priceCents=Y
//        -> a PREVIEW resolution, no jobId yet and nothing persisted — used
//           by the booking flow to show the schedule before the job exists.
// GET  /api/job-payment-schedule?all=1&customerEmail=X  (or contractorEmail=X)
//        -> every job's latest schedule + milestones for that email in one
//           call (Aug 2026, for the Statement of Account export) — avoids an
//           N+1 loop of the single-jobId branch above across every job an
//           account has. Ungated, same posture as the customerEmail/
//           contractorEmail branches of get-jobs.js — a portal reading its
//           own logged-in user's data.
// POST /api/job-payment-schedule  { action: 'accept', jobId, customerId, termsVersion }
//        -> records the customer's explicit "I have reviewed and agree..."
//           acceptance. IP/user-agent are read server-side from the request
//           itself, never trusted from the client body.
const { getSupabase } = require('./_lib/clients');
const { resolveScheduleForJob, ScheduleValidationError } = require('./_lib/paymentSchedule');

module.exports = async (req, res) => {
  const supabase = getSupabase();

  if (req.method === 'GET') {
    try {
      const { jobId, category, priceCents, all, customerEmail, contractorEmail } = req.query || {};

      if (all && (customerEmail || contractorEmail)) {
        const email = String(customerEmail || contractorEmail).toLowerCase();
        const emailCol = customerEmail ? 'customer_email' : 'contractor_email';
        const { data: jobs, error: jobsErr } = await supabase
          .from('jobs').select('id, full_record, job_number').eq(emailCol, email)
          .not('full_record', 'is', null).limit(500);
        if (jobsErr) throw jobsErr;
        if (!jobs || jobs.length === 0) { res.status(200).json({ jobs: [] }); return; }

        const jobIds = jobs.map(j => j.id);
        const { data: schedules, error: schedErr } = await supabase
          .from('job_payment_schedules').select('*').in('job_id', jobIds).order('version', { ascending: false });
        if (schedErr) throw schedErr;
        const latestScheduleByJob = {};
        (schedules || []).forEach(s => { if (!latestScheduleByJob[s.job_id]) latestScheduleByJob[s.job_id] = s; });
        const scheduleIds = Object.values(latestScheduleByJob).map(s => s.id);

        let milestonesBySchedule = {};
        if (scheduleIds.length) {
          const { data: milestones, error: mErr } = await supabase
            .from('payment_milestones').select('*').in('job_payment_schedule_id', scheduleIds).order('milestone_index');
          if (mErr) throw mErr;
          (milestones || []).forEach(m => {
            (milestonesBySchedule[m.job_payment_schedule_id] = milestonesBySchedule[m.job_payment_schedule_id] || []).push(m);
          });
        }

        const result = jobs.map(j => {
          const fr = j.full_record || {};
          const schedule = latestScheduleByJob[j.id];
          const milestones = schedule ? (milestonesBySchedule[schedule.id] || []) : [];
          return {
            jobId: j.id, jobNumber: j.job_number,
            category: fr.category || null, suburb: fr.suburb || null, address: fr.address || null,
            customerName: fr.customerName || null, contractor: fr.contractor || null,
            createdAt: fr.createdAt || null, milestones,
          };
        });
        res.status(200).json({ jobs: result });
        return;
      }

      if (jobId) {
        const { data: schedule, error } = await supabase
          .from('job_payment_schedules').select('*').eq('job_id', jobId)
          .order('version', { ascending: false }).limit(1).maybeSingle();
        if (error) throw error;
        if (!schedule) { res.status(200).json({ schedule: null, milestones: [] }); return; }

        const { data: milestones, error: mErr } = await supabase
          .from('payment_milestones').select('*').eq('job_payment_schedule_id', schedule.id)
          .order('milestone_index', { ascending: true });
        if (mErr) throw mErr;

        // Latest evidence per milestone — the customer's review UI needs
        // this to show what the contractor actually submitted before
        // approving payment.
        const milestoneIds = (milestones || []).map(m => m.id);
        let evidenceByMilestone = {};
        if (milestoneIds.length) {
          const { data: evidence } = await supabase
            .from('milestone_evidence').select('*').in('milestone_id', milestoneIds)
            .order('submitted_at', { ascending: false });
          (evidence || []).forEach(ev => { if (!evidenceByMilestone[ev.milestone_id]) evidenceByMilestone[ev.milestone_id] = ev; });
        }

        res.status(200).json({ schedule, milestones: milestones || [], evidenceByMilestone });
        return;
      }

      if (category && priceCents) {
        const preview = await resolveScheduleForJob(supabase, category, parseInt(priceCents, 10));
        res.status(200).json({ preview });
        return;
      }

      res.status(400).json({ error: 'Provide jobId, or category and priceCents.' });
    } catch (err) {
      if (err instanceof ScheduleValidationError) { res.status(422).json({ error: err.message }); return; }
      console.error('job-payment-schedule GET error:', err);
      res.status(500).json({ error: 'Could not resolve payment schedule.' });
    }
    return;
  }

  if (req.method === 'POST') {
    try {
      const { action, jobId, customerId, termsVersion } = req.body || {};

      // Quantity/size edits on a still-unallocated job change its price —
      // the deposit is real captured Stripe money already, so it stays
      // fixed; only the REMAINING (unpaid) milestones' dollar amounts get
      // recalculated, preserving each one's relative share of what's left.
      // Never touches jobs.full_record — that's client-owned and synced up
      // via saveJobs()/api/sync-jobs.js, and writing it here would race
      // whatever the browser pushes right after.
      if (action === 'recalculate') {
        const { newBasePriceCents } = req.body || {};
        if (!jobId || !newBasePriceCents || newBasePriceCents <= 0) { res.status(400).json({ error: 'jobId and a positive newBasePriceCents are required.' }); return; }

        const { data: jobRow, error: jobErr } = await supabase.from('jobs').select('full_record').eq('id', jobId).maybeSingle();
        if (jobErr) throw jobErr;
        if (!jobRow) { res.status(404).json({ error: 'Job not found.' }); return; }
        const record = jobRow.full_record || {};
        if (record.contractor || record.status !== 'feed') {
          res.status(409).json({ error: 'This job can only be edited while it is still unallocated.' });
          return;
        }

        const { data: schedule, error: schedErr } = await supabase.from('job_payment_schedules').select('*').eq('job_id', jobId).order('version', { ascending: false }).limit(1).maybeSingle();
        if (schedErr) throw schedErr;
        if (!schedule) { res.status(404).json({ error: 'No payment schedule found for this job.' }); return; }

        const { data: milestones, error: mErr } = await supabase.from('payment_milestones').select('*').eq('job_payment_schedule_id', schedule.id).order('milestone_index');
        if (mErr) throw mErr;
        const depositMilestone = milestones.find(m => m.milestone_type === 'deposit');
        if (!depositMilestone || depositMilestone.status !== 'paid') { res.status(409).json({ error: 'The deposit must be paid before this job can be edited.' }); return; }

        const remaining = milestones.filter(m => m.id !== depositMilestone.id);
        const oldRemainingTotal = remaining.reduce((s, m) => s + m.amount_cents, 0);
        const newRemainingCents = newBasePriceCents - depositMilestone.amount_cents;
        if (newRemainingCents < 0) { res.status(422).json({ error: 'The new price is lower than the deposit already paid — please contact support to change this job.' }); return; }

        let updatedRemaining;
        if (oldRemainingTotal === 0 || remaining.length === 0) {
          updatedRemaining = remaining;
        } else {
          const amounts = remaining.map(m => Math.round(newRemainingCents * (m.amount_cents / oldRemainingTotal)));
          const sum = amounts.reduce((s, a) => s + a, 0);
          if (amounts.length) amounts[amounts.length - 1] += (newRemainingCents - sum);
          updatedRemaining = remaining.map((m, i) => ({ ...m, amount_cents: amounts[i] }));
          for (let i = 0; i < remaining.length; i++) {
            await supabase.from('payment_milestones').update({ amount_cents: amounts[i], updated_at: new Date().toISOString() }).eq('id', remaining[i].id);
          }
        }

        const { data: updatedSchedule, error: updErr } = await supabase.from('job_payment_schedules')
          .update({ original_contract_price_cents: newBasePriceCents, revised_total_price_cents: newBasePriceCents, updated_at: new Date().toISOString() })
          .eq('id', schedule.id).select().single();
        if (updErr) throw updErr;

        await supabase.from('payment_schedule_versions').insert({
          job_payment_schedule_id: schedule.id, version_number: schedule.version,
          milestones_snapshot: [depositMilestone, ...updatedRemaining], reason: 'customer_edit', created_by: customerId || 'customer',
        });
        await supabase.from('payment_audit_logs').insert({
          entity_type: 'job_payment_schedule', entity_id: schedule.id, action: 'price_recalculated_by_customer',
          actor_role: 'customer', actor_id: customerId || null,
          before_state: { total_cents: schedule.revised_total_price_cents }, after_state: { total_cents: newBasePriceCents },
        });

        res.status(200).json({ schedule: updatedSchedule, milestones: [depositMilestone, ...updatedRemaining] });
        return;
      }

      if (action !== 'accept') { res.status(400).json({ error: 'Unknown action.' }); return; }
      if (!jobId) { res.status(400).json({ error: 'jobId is required.' }); return; }

      const { data: schedule, error } = await supabase
        .from('job_payment_schedules').select('*').eq('job_id', jobId)
        .order('version', { ascending: false }).limit(1).maybeSingle();
      if (error) throw error;
      if (!schedule) { res.status(404).json({ error: 'No payment schedule found for this job.' }); return; }
      if (schedule.status === 'active' || schedule.status === 'completed') {
        // Already accepted — idempotent, not an error (e.g. a retried request).
        res.status(200).json({ schedule });
        return;
      }
      if (schedule.status === 'pending_admin_schedule') {
        res.status(409).json({ error: 'This job is waiting on an admin-built payment schedule before it can be accepted.' });
        return;
      }

      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || null;
      const userAgent = req.headers['user-agent'] || null;

      const { data: updated, error: updateError } = await supabase
        .from('job_payment_schedules')
        .update({
          status: 'active',
          accepted_at: new Date().toISOString(),
          accepted_by_customer_id: customerId || null,
          accepted_ip: ip,
          accepted_user_agent: userAgent,
          terms_version: termsVersion || null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', schedule.id)
        .select()
        .single();
      if (updateError) throw updateError;

      const { data: milestones } = await supabase
        .from('payment_milestones').select('*').eq('job_payment_schedule_id', schedule.id)
        .order('milestone_index', { ascending: true });

      await supabase.from('payment_schedule_versions').insert({
        job_payment_schedule_id: schedule.id,
        version_number: schedule.version,
        milestones_snapshot: milestones || [],
        reason: 'initial',
        created_by: customerId || 'customer',
      });

      await supabase.from('payment_audit_logs').insert({
        entity_type: 'job_payment_schedule', entity_id: schedule.id,
        action: 'schedule_accepted', actor_role: 'customer', actor_id: customerId || null,
        before_state: { status: schedule.status }, after_state: { status: 'active' },
      });

      res.status(200).json({ schedule: updated });
    } catch (err) {
      console.error('job-payment-schedule POST error:', err);
      res.status(500).json({ error: 'Could not record schedule acceptance.' });
    }
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
};
