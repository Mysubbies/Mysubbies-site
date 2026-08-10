// POST /api/stripe-webhook
// Register this exact URL (https://yourdomain/api/stripe-webhook) in the
// Stripe Dashboard under Developers > Webhooks, listening for
// payment_intent.succeeded, payment_intent.payment_failed, and
// account.updated (the last one needs "Listen to events on Connected
// accounts" turned on, since it fires on the contractor's account, not the
// platform account). Copy the signing secret it gives you into
// STRIPE_WEBHOOK_SECRET.
//
// This is the ONLY place a job's deposit is ever marked paid. The browser
// can never do this directly — Stripe's signed event is the sole source of
// truth, verified below before anything touches the database.
const { getStripe, getSupabase } = require('./_lib/clients');

// Vercel must NOT pre-parse the body — Stripe's signature is computed over
// the exact raw bytes, and JSON.parse+reserialize would break verification.
module.exports.config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).end(); return; }
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.error('STRIPE_WEBHOOK_SECRET is not set.');
    res.status(500).end();
    return;
  }

  const stripe = getStripe();
  const rawBody = await readRawBody(req);
  const signature = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    res.status(400).send(`Webhook signature verification failed.`);
    return;
  }

  const supabase = getSupabase();

  try {
    if (event.type === 'payment_intent.succeeded' || event.type === 'payment_intent.payment_failed') {
      const intent = event.data.object;
      const jobId = intent.metadata && intent.metadata.jobId;
      if (!jobId) { res.status(200).json({ received: true, note: 'no jobId in metadata, ignored' }); return; }

      // Idempotency: if we've already recorded this exact Stripe event, skip.
      // (Stripe can and will redeliver the same event more than once.)
      const { data: existingPayment } = await supabase
        .from('payments').select('stripe_event_id').eq('stripe_payment_intent_id', intent.id).maybeSingle();
      if (existingPayment && existingPayment.stripe_event_id === event.id) {
        res.status(200).json({ received: true, note: 'duplicate event, already processed' });
        return;
      }

      const newStatus = event.type === 'payment_intent.succeeded' ? 'succeeded' : 'failed';
      await supabase.from('payments')
        .update({ status: newStatus, stripe_event_id: event.id, updated_at: new Date().toISOString() })
        .eq('stripe_payment_intent_id', intent.id);

      if (newStatus === 'succeeded') {
        await supabase.from('jobs').update({ status: 'deposit_paid' }).eq('id', jobId);
      }
    } else if (event.type === 'account.updated') {
      const account = event.data.object;
      if (account.charges_enabled && account.payouts_enabled && account.details_submitted) {
        await supabase.from('contractor_connect_accounts')
          .update({ onboarding_status: 'complete' })
          .eq('stripe_connect_account_id', account.id);
      }
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error('stripe-webhook processing error:', err);
    // Return 500 so Stripe retries delivery — do not swallow processing errors.
    res.status(500).json({ error: 'Processing error' });
  }
};
