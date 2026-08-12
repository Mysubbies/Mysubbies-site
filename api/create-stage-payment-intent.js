// POST /api/create-stage-payment-intent
// Body: { milestoneId }
//
// v2 (Aug 2026): the payment-capture step of the milestone workflow — only
// ever creates a PaymentIntent for a milestone already in 'approved'
// status (customer has reviewed evidence and approved it via
// api/milestone.js's respond action). The amount is read directly from the
// milestone row, which was itself locked in server-side when the schedule
// was created (api/_lib/paymentSchedule.js) — never trusted from the
// client here.
//
// Still never transfers anything to the contractor via Stripe Connect —
// money collected here sits in the Mysubbies platform account; contractor
// payout for these stages stays manual via Mysubbies AP per the founder's
// explicit scope for this pass.
const { getStripe, getSupabase } = require('./_lib/clients');

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const { milestoneId } = req.body || {};
    if (!milestoneId) { res.status(400).json({ error: 'milestoneId is required.' }); return; }

    const supabase = getSupabase();

    const { data: milestone, error: mErr } = await supabase.from('payment_milestones').select('*').eq('id', milestoneId).maybeSingle();
    if (mErr) throw mErr;
    if (!milestone) { res.status(404).json({ error: 'Milestone not found.' }); return; }
    if (milestone.status === 'paid') { res.status(409).json({ error: 'This milestone has already been paid.' }); return; }
    if (milestone.status !== 'approved') { res.status(409).json({ error: 'This milestone must be approved before it can be paid.' }); return; }

    const { data: schedule } = await supabase.from('job_payment_schedules').select('*').eq('id', milestone.job_payment_schedule_id).maybeSingle();
    if (!schedule) { res.status(404).json({ error: 'Payment schedule not found.' }); return; }

    // Defensive check: this milestone's amount should never push the job's
    // total paid past its revised contract price — the percentages were
    // already validated to sum to 100% at schedule-creation time, so this
    // should be unreachable, but never trust a single row in isolation for
    // a real money movement.
    const { data: allMilestones } = await supabase.from('payment_milestones').select('amount_cents, status').eq('job_payment_schedule_id', schedule.id);
    const alreadyPaidCents = (allMilestones || []).filter(m => m.status === 'paid').reduce((s, m) => s + m.amount_cents, 0);
    if (alreadyPaidCents + milestone.amount_cents > schedule.revised_total_price_cents) {
      res.status(409).json({ error: 'This payment would exceed the remaining contract balance.' });
      return;
    }

    const { data: jobRow } = await supabase.from('jobs').select('category, suburb').eq('id', schedule.job_id).maybeSingle();

    const stripe = getStripe();
    const paymentIntent = await stripe.paymentIntents.create({
      amount: milestone.amount_cents,
      currency: 'aud',
      metadata: { jobId: schedule.job_id, stage: milestone.key, milestoneId: milestone.id },
      description: `Mysubbies ${milestone.label} — ${jobRow ? jobRow.category : ''}${jobRow && jobRow.suburb ? ' (' + jobRow.suburb + ')' : ''}`,
    });

    await supabase.from('payments').upsert({
      job_id: schedule.job_id,
      stripe_payment_intent_id: paymentIntent.id,
      stage: milestone.key,
      amount_cents: milestone.amount_cents,
      status: 'requires_payment',
    }, { onConflict: 'stripe_payment_intent_id' });

    await supabase.from('payment_milestones').update({
      stripe_payment_intent_id: paymentIntent.id, status: 'payment_processing', updated_at: new Date().toISOString(),
    }).eq('id', milestone.id);

    res.status(200).json({ clientSecret: paymentIntent.client_secret, amountCents: milestone.amount_cents });
  } catch (err) {
    console.error('create-stage-payment-intent error:', err);
    res.status(500).json({ error: 'Could not create payment. Please try again.' });
  }
};
