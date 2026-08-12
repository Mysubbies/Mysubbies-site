// GET  /api/job-payment-schedule?jobId=X
//        -> the persisted schedule + milestones for an existing job (used
//           by all three portals' payment displays).
// GET  /api/job-payment-schedule?category=X&priceCents=Y
//        -> a PREVIEW resolution, no jobId yet and nothing persisted — used
//           by the booking flow to show the schedule before the job exists.
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
      const { jobId, category, priceCents } = req.query || {};

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
        res.status(200).json({ schedule, milestones: milestones || [] });
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
