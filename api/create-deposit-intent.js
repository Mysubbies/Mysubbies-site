// POST /api/create-deposit-intent
// Body: { jobId, category, suburb, contractorEmail, basePriceCents, accepted, customerId, termsVersion }
//
// v2 (Aug 2026): the deposit amount and the full payment schedule are now
// resolved and validated server-side via api/_lib/paymentSchedule.js —
// client-submitted depositAmountCents is no longer trusted or even
// accepted. `accepted: true` is required (the customer must have ticked
// "I have reviewed and agree to the total price and milestone payment
// schedule" in the booking UI) before a schedule can go active and a
// deposit can be charged.
//
// Same "lock in on first sight" pattern as before: the first call for a
// given jobId creates the `jobs` row AND resolves+persists the schedule.
// Every subsequent call (retry, second click) reuses what's already
// persisted and ignores whatever the client sends for price/category.
const { getStripe, getSupabase } = require('./_lib/clients');
const { resolveScheduleForJob, ScheduleValidationError } = require('./_lib/paymentSchedule');

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const { jobId, category, suburb, contractorEmail, basePriceCents, accepted, customerId, termsVersion } = req.body || {};
    if (!jobId || !category || !basePriceCents) {
      res.status(400).json({ error: 'jobId, category and basePriceCents are required.' });
      return;
    }

    const supabase = getSupabase();

    let job = (await supabase.from('jobs').select('*').eq('id', jobId).maybeSingle()).data;
    let schedule = job ? (await supabase.from('job_payment_schedules').select('*').eq('job_id', jobId)
      .order('version', { ascending: false }).limit(1).maybeSingle()).data : null;

    if (!schedule) {
      if (!accepted) {
        res.status(400).json({ error: 'You must review and accept the payment schedule before booking.' });
        return;
      }

      const resolved = await resolveScheduleForJob(supabase, category, basePriceCents);
      const depositMilestone = resolved.milestones.find(m => m.milestone_type === 'deposit') || resolved.milestones[0];

      if (!job) {
        const { data: inserted, error: insertError } = await supabase
          .from('jobs')
          .insert({
            id: jobId, category, suburb: suburb || null, contractor_email: contractorEmail || null,
            base_price_cents: basePriceCents,
            deposit_pct: resolved.deposit_pct,
            deposit_amount_cents: depositMilestone.amount_cents,
            status: 'pending_deposit',
          })
          .select().single();
        if (insertError) throw insertError;
        job = inserted;
      }

      const isActive = resolved.status !== 'pending_admin_schedule';
      const nowIso = new Date().toISOString();
      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || null;
      const userAgent = req.headers['user-agent'] || null;

      const { data: scheduleRow, error: scheduleError } = await supabase
        .from('job_payment_schedules')
        .insert({
          job_id: jobId,
          template_id: resolved.template_id,
          schedule_type: resolved.schedule_type,
          original_contract_price_cents: basePriceCents,
          total_variations_cents: 0,
          revised_total_price_cents: basePriceCents,
          deposit_pct: resolved.deposit_pct,
          deposit_amount_cents: depositMilestone.amount_cents,
          status: isActive ? 'active' : 'pending_admin_schedule',
          accepted_at: isActive ? nowIso : null,
          accepted_by_customer_id: isActive ? (customerId || null) : null,
          accepted_ip: isActive ? ip : null,
          accepted_user_agent: isActive ? userAgent : null,
          terms_version: isActive ? (termsVersion || null) : null,
        })
        .select().single();
      if (scheduleError) throw scheduleError;
      schedule = scheduleRow;

      const milestoneRows = resolved.milestones.map((m, idx) => ({
        job_payment_schedule_id: schedule.id,
        milestone_index: idx,
        key: m.key, label: m.label, pct: m.pct, amount_cents: m.amount_cents,
        milestone_type: m.milestone_type,
        requires_evidence_type: m.requires_evidence_type || 'photos',
        requires_customer_approval: m.requires_customer_approval !== false,
        review_period_hours: m.review_period_hours || 72,
        auto_capture_enabled: !!m.auto_capture_enabled,
        status: idx === 0 ? 'available' : 'locked',
      }));
      const { error: milestoneError } = await supabase.from('payment_milestones').insert(milestoneRows);
      if (milestoneError) throw milestoneError;

      if (isActive) {
        await supabase.from('payment_schedule_versions').insert({
          job_payment_schedule_id: schedule.id, version_number: schedule.version,
          milestones_snapshot: milestoneRows, reason: 'initial', created_by: customerId || 'customer',
        });
      }
      await supabase.from('payment_audit_logs').insert({
        entity_type: 'job_payment_schedule', entity_id: schedule.id,
        action: isActive ? 'schedule_created_and_accepted' : 'schedule_pending_admin_review',
        actor_role: 'customer', actor_id: customerId || null,
        after_state: { status: schedule.status, schedule_type: resolved.schedule_type, deposit_pct: resolved.deposit_pct },
      });
    }

    if (!job) job = (await supabase.from('jobs').select('*').eq('id', jobId).maybeSingle()).data;

    const { data: depositMilestoneRow, error: depErr } = await supabase
      .from('payment_milestones').select('*').eq('job_payment_schedule_id', schedule.id)
      .eq('milestone_type', 'deposit').maybeSingle();
    if (depErr) throw depErr;
    if (!depositMilestoneRow) throw new Error('No deposit milestone found for this job.');
    if (depositMilestoneRow.status === 'paid') { res.status(409).json({ error: 'The deposit for this job has already been paid.' }); return; }

    const stripe = getStripe();
    const paymentIntent = await stripe.paymentIntents.create({
      amount: depositMilestoneRow.amount_cents,
      currency: 'aud',
      metadata: { jobId: job.id, stage: 'deposit', milestoneId: depositMilestoneRow.id },
      description: `MySubbies deposit — ${job.category}${job.suburb ? ' (' + job.suburb + ')' : ''}`,
    });

    await supabase.from('payments').upsert({
      job_id: job.id,
      stripe_payment_intent_id: paymentIntent.id,
      stage: 'deposit',
      amount_cents: depositMilestoneRow.amount_cents,
      status: 'requires_payment',
    }, { onConflict: 'stripe_payment_intent_id' });

    await supabase.from('payment_milestones').update({ stripe_payment_intent_id: paymentIntent.id, status: 'payment_processing', updated_at: new Date().toISOString() }).eq('id', depositMilestoneRow.id);

    res.status(200).json({ clientSecret: paymentIntent.client_secret, scheduleStatus: schedule.status });
  } catch (err) {
    if (err instanceof ScheduleValidationError) { res.status(422).json({ error: err.message }); return; }
    console.error('create-deposit-intent error:', err);
    res.status(500).json({ error: 'Could not create payment. Please try again.' });
  }
};
