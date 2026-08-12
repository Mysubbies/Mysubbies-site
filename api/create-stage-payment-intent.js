// POST /api/create-stage-payment-intent
// Body: { jobId, stage, stageLabel, amountCents }
//
// Same "lock in on first sight" pattern as create-deposit-intent.js, and
// the same documented limitation: the exact stage amount still originates
// client-side (the rate card/payment schedule isn't server-side yet), but
// once a payments row exists for this (jobId, stage) pair, its amount is
// authoritative — later calls reuse it and ignore whatever the client sends,
// so a customer can't manipulate the charge after the first attempt.
//
// Unlike the deposit, this never transfers anything to the contractor via
// Stripe Connect — per the founder's explicit scope for this pass, money
// collected here sits in the Mysubbies platform account and contractors are
// paid out manually by Mysubbies AP. Automating that follow-on transfer is
// deliberately deferred until the staged-approval flow has proven stable.
const { getStripe, getSupabase } = require('./_lib/clients');

const VALID_STAGES = ['materials', 'frame', 'completion'];

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const { jobId, stage, stageLabel, amountCents } = req.body || {};
    if (!jobId || !VALID_STAGES.includes(stage) || !amountCents || amountCents <= 0) {
      res.status(400).json({ error: 'jobId, a valid stage, and a positive amountCents are required.' });
      return;
    }

    const supabase = getSupabase();

    const { data: job } = await supabase.from('jobs').select('id, category, suburb').eq('id', jobId).maybeSingle();
    if (!job) { res.status(404).json({ error: 'Unknown job.' }); return; }

    // Has this stage already been paid? Don't let it be charged twice.
    const { data: existingSucceeded } = await supabase
      .from('payments').select('id').eq('job_id', jobId).eq('stage', stage).eq('status', 'succeeded').maybeSingle();
    if (existingSucceeded) { res.status(409).json({ error: 'This stage has already been paid.' }); return; }

    // Lock the amount from the earliest attempt at this stage, if any.
    const { data: firstAttempt } = await supabase
      .from('payments').select('amount_cents').eq('job_id', jobId).eq('stage', stage).order('created_at', { ascending: true }).limit(1).maybeSingle();
    const lockedAmountCents = firstAttempt ? firstAttempt.amount_cents : amountCents;

    const stripe = getStripe();
    const paymentIntent = await stripe.paymentIntents.create({
      amount: lockedAmountCents,
      currency: 'aud',
      metadata: { jobId: job.id, stage },
      description: `Mysubbies ${stageLabel || stage} — ${job.category}${job.suburb ? ' (' + job.suburb + ')' : ''}`,
    });

    await supabase.from('payments').upsert({
      job_id: job.id,
      stripe_payment_intent_id: paymentIntent.id,
      stage,
      amount_cents: lockedAmountCents,
      status: 'requires_payment',
    }, { onConflict: 'stripe_payment_intent_id' });

    res.status(200).json({ clientSecret: paymentIntent.client_secret, amountCents: lockedAmountCents });
  } catch (err) {
    console.error('create-stage-payment-intent error:', err);
    res.status(500).json({ error: 'Could not create payment. Please try again.' });
  }
};
