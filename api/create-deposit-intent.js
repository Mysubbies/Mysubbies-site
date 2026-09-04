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

// GET ?email=... -- referral-credit preview (Sep 2026, "Give $50, Get
// $50"), read by mysubbies-booking.html's payment-schedule review screen
// so the deposit amount shown BEFORE payment matches what will actually
// be charged. Ungated, same posture as every other self-service "read my
// own data" endpoint in this project -- returns only a dollar figure, no
// PII.
async function handleCreditPreview(req, res) {
  try {
    const { email } = req.query || {};
    if (!email) { res.status(400).json({ error: 'email is required.' }); return; }
    const supabase = getSupabase();
    const { data, error } = await supabase.from('customer_credits').select('amount_cents').eq('customer_email', email).eq('status', 'available');
    if (error) throw error;
    const creditCents = (data || []).reduce((s, c) => s + c.amount_cents, 0);
    res.status(200).json({ creditCents });
  } catch (err) {
    console.error('create-deposit-intent credit preview error:', err);
    res.status(500).json({ error: 'Could not check for a referral credit.' });
  }
}

module.exports = async (req, res) => {
  if (req.method === 'GET') { await handleCreditPreview(req, res); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const { jobId, category, suburb, contractorEmail, basePriceCents, accepted, customerId, customerEmail, termsVersion } = req.body || {};
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

      // Referral credit (Sep 2026, "Give $50, Get $50") -- applied once,
      // right here, the first time this job's schedule is ever created
      // (this whole `if (!schedule)` branch only runs once per job).
      // Mutates depositMilestone.amount_cents in place before it's used
      // for both the jobs row and the milestone rows below, so everything
      // downstream (the actual Stripe charge, the stored schedule,
      // "Payment history" later) reflects the discounted amount
      // consistently -- there's no separate "discount line" to keep in
      // sync elsewhere. Only ever applies a credit in full (never
      // partial -- customer_credits has no partial-amount tracking), and
      // never reduces the charge below $1 (Stripe's practical minimum).
      // Best-effort: a lookup failure here must never block the booking
      // itself, it just means the discount doesn't apply this time.
      if (customerEmail) {
        try {
          const { data: credits } = await supabase.from('customer_credits').select('*')
            .eq('customer_email', customerEmail).eq('status', 'available').order('created_at', { ascending: true });
          if (credits && credits.length) {
            const cap = Math.max(0, depositMilestone.amount_cents - 100);
            let remaining = cap, appliedCents = 0;
            const usedIds = [];
            for (const credit of credits) {
              if (credit.amount_cents > remaining) continue;
              remaining -= credit.amount_cents;
              appliedCents += credit.amount_cents;
              usedIds.push(credit.id);
            }
            if (usedIds.length) {
              depositMilestone.amount_cents -= appliedCents;
              await supabase.from('customer_credits').update({ status: 'used', used_at: new Date().toISOString(), used_job_id: jobId }).in('id', usedIds);
            }
          }
        } catch (creditErr) { console.error('referral credit lookup failed (continuing without discount):', creditErr); }
      }

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
