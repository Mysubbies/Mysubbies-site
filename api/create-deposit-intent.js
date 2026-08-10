// POST /api/create-deposit-intent
// Body: { jobId, category, suburb, contractorEmail, depositAmountCents }
//
// KNOWN LIMITATION (v1, flagged deliberately, not an oversight): the rate
// card (21 categories, ~163 tasks) still lives only in the browser's
// localStorage, not in this backend. This function therefore can't
// independently recompute a job's price from scratch the way a fully
// server-authoritative system should. What it DOES do: the first time a
// given jobId is seen, it locks in the submitted deposit amount into the
// `jobs` table. Every subsequent call for that same jobId — including a
// second click, a retry, or an attempt to resubmit with a different number
// — reuses the amount already stored in the database and ignores whatever
// the client sends. So a customer cannot manipulate the charge after job
// creation, even though the very first number still originates client-side.
// Closing that gap fully means moving the rate card server-side too, which
// is out of scope for this "deposit only" pass.
const { getStripe, getSupabase } = require('./_lib/clients');

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const { jobId, category, suburb, contractorEmail, basePriceCents, depositAmountCents } = req.body || {};
    if (!jobId || !category || !basePriceCents || !depositAmountCents || depositAmountCents <= 0) {
      res.status(400).json({ error: 'jobId, category, basePriceCents and a positive depositAmountCents are required.' });
      return;
    }

    const supabase = getSupabase();

    // Lock in the job row on first sight only — see limitation note above.
    const { data: existingJob } = await supabase.from('jobs').select('*').eq('id', jobId).maybeSingle();

    let job = existingJob;
    if (!job) {
      const { data: inserted, error: insertError } = await supabase
        .from('jobs')
        .insert({
          id: jobId,
          category,
          suburb: suburb || null,
          contractor_email: contractorEmail || null,
          base_price_cents: basePriceCents,
          deposit_pct: Math.round((depositAmountCents / basePriceCents) * 10000) / 100,
          deposit_amount_cents: depositAmountCents,
          status: 'pending_deposit',
        })
        .select()
        .single();
      if (insertError) throw insertError;
      job = inserted;
    }

    const stripe = getStripe();
    const paymentIntent = await stripe.paymentIntents.create({
      amount: job.deposit_amount_cents,
      currency: 'aud',
      metadata: { jobId: job.id, stage: 'deposit' },
      description: `Mysubbies deposit — ${job.category}${job.suburb ? ' (' + job.suburb + ')' : ''}`,
    });

    await supabase.from('payments').upsert({
      job_id: job.id,
      stripe_payment_intent_id: paymentIntent.id,
      stage: 'deposit',
      amount_cents: job.deposit_amount_cents,
      status: 'requires_payment',
    }, { onConflict: 'stripe_payment_intent_id' });

    res.status(200).json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error('create-deposit-intent error:', err);
    res.status(500).json({ error: 'Could not create payment. Please try again.' });
  }
};
