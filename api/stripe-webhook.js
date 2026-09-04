// POST /api/stripe-webhook
// Register this exact URL (https://yourdomain/api/stripe-webhook) in the
// Stripe Dashboard as TWO separate event destinations (Stripe requires this
// split — a single destination can't mix "Your account" and "Connected
// accounts" scopes):
//   1. Scope "Your account" — payment_intent.succeeded, payment_intent.payment_failed
//   2. Scope "Connected accounts" — account.updated (fires on the
//      contractor's account, not the platform account, once Connect is set up)
// Each destination gets its OWN signing secret from Stripe — copy them into
// STRIPE_WEBHOOK_SECRET and STRIPE_WEBHOOK_SECRET_CONNECT respectively. This
// handler tries both when verifying, since there's no way to know in advance
// which destination sent a given request.
//
// This is the ONLY place a job's deposit is ever marked paid. The browser
// can never do this directly — Stripe's signed event is the sole source of
// truth, verified below before anything touches the database.
const { getStripe, getSupabase } = require('./_lib/clients');
const { sendEmail, wrapEmail, escapeHtml, emailDetailsTable, emailButton } = require('./_lib/email');

// Same "Task — qty unit" summary line used by api/notify.js's job-assigned
// and new-job-available emails, duplicated here rather than imported --
// this file has no other dependency on notify.js and importing just this
// one helper isn't worth the cross-file coupling for one small function.
function itemsSummaryHtml(items, qty, unit) {
  if (Array.isArray(items) && items.length) {
    return items.map(i => `${escapeHtml(i.taskName || '')} — ${i.qty ?? ''} ${escapeHtml(i.unit || '')}`.trim()).join('<br>');
  }
  if (qty != null) return `${qty} ${escapeHtml(unit || '')}`.trim();
  return '';
}

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

  const possibleSecrets = [process.env.STRIPE_WEBHOOK_SECRET, process.env.STRIPE_WEBHOOK_SECRET_CONNECT].filter(Boolean);
  if (possibleSecrets.length === 0) {
    console.error('Neither STRIPE_WEBHOOK_SECRET nor STRIPE_WEBHOOK_SECRET_CONNECT is set.');
    res.status(500).end();
    return;
  }

  const stripe = getStripe();
  const rawBody = await readRawBody(req);
  const signature = req.headers['stripe-signature'];

  let event;
  let verified = false;
  for (const secret of possibleSecrets) {
    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, secret);
      verified = true;
      break;
    } catch (err) {
      // try the next secret
    }
  }
  if (!verified) {
    console.error('Webhook signature verification failed against all known secrets.');
    res.status(400).send('Webhook signature verification failed.');
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
        const stage = (intent.metadata && intent.metadata.stage) || 'deposit';
        const milestoneId = intent.metadata && intent.metadata.milestoneId;

        // Only the deposit ever touches the legacy jobs.status column.
        if (stage === 'deposit') {
          await supabase.from('jobs').update({ status: 'deposit_paid' }).eq('id', jobId);
        }

        // payment_milestones is a real relational row per milestone, not a
        // jsonb blob — a targeted UPDATE here is safe (no read-modify-write
        // race like the old full_record.paidStages approach had), so the
        // webhook is the authoritative place to mark a milestone paid.
        if (milestoneId) {
          const { data: milestoneRow } = await supabase.from('payment_milestones').select('*').eq('id', milestoneId).maybeSingle();
          if (milestoneRow && milestoneRow.status !== 'paid') {
            await supabase.from('payment_milestones').update({ status: 'paid', paid_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', milestoneId);
            await supabase.from('payment_audit_logs').insert({
              entity_type: 'payment_milestone', entity_id: milestoneId, action: 'payment_captured',
              actor_role: 'system', before_state: { status: milestoneRow.status }, after_state: { status: 'paid' },
            });

            // Errors here MUST throw, not fall through silently -- this read
            // decides whether the next milestone gets unlocked. A swallowed
            // error here (found live: one real job's deposit paid but its
            // next milestone stayed 'locked' forever, no error logged) would
            // permanently strand the job with no self-healing path, since
            // nothing else ever flips 'locked' -> 'available'. Throwing lets
            // the outer catch return 500, so Stripe retries the delivery.
            const { data: remaining, error: remainingErr } = await supabase.from('payment_milestones').select('*').eq('job_payment_schedule_id', milestoneRow.job_payment_schedule_id);
            if (remainingErr) throw remainingErr;
            if (remaining && remaining.every(m => m.status === 'paid')) {
              await supabase.from('job_payment_schedules').update({ status: 'completed', updated_at: new Date().toISOString() }).eq('id', milestoneRow.job_payment_schedule_id);
            } else if (remaining) {
              // Unlock the next milestone in sequence now that this one is
              // paid — nothing else flips a milestone from 'locked' to
              // 'available', so without this the next stage would be
              // permanently unclaimable by the contractor.
              const next = remaining
                .filter(m => m.milestone_index > milestoneRow.milestone_index && m.status === 'locked')
                .sort((a, b) => a.milestone_index - b.milestone_index)[0];
              if (next) {
                await supabase.from('payment_milestones').update({ status: 'available', updated_at: new Date().toISOString() }).eq('id', next.id);
                await supabase.from('payment_audit_logs').insert({
                  entity_type: 'payment_milestone', entity_id: next.id, action: 'milestone_unlocked',
                  actor_role: 'system', before_state: { status: 'locked' }, after_state: { status: 'available' },
                });
              }
            }
          }
        }

        // Best-effort confirmation email — never lets an email failure
        // affect the payment/webhook outcome above.
        try {
          const { data: jobRow } = await supabase.from('jobs').select('customer_email, full_record').eq('id', jobId).maybeSingle();
          const record = jobRow && jobRow.full_record;
          if (jobRow && jobRow.customer_email && record) {
            const isDeposit = stage === 'deposit';
            // Sep 2026 -- a real job-details table (quantity, urgency,
            // address) instead of one line of prose, built from whatever
            // the customer actually entered in the estimator (record is
            // the job's full client-side record, synced verbatim). No
            // photo here on purpose -- record.photoDataUrl is the
            // customer's raw, unresized upload (no client-side resize
            // step exists for it, unlike new-job-available's photoThumb
            // in mysubbies-booking.html), and this is the customer's own
            // photo -- they already know what they submitted, so the
            // real substance for this email is the booking details, not
            // re-showing them their own image.
            await sendEmail({
              to: jobRow.customer_email,
              subject: isDeposit ? `Booking confirmed — ${record.category} in ${record.suburb}` : `Payment received — ${stage} stage, ${record.category}`,
              html: wrapEmail(isDeposit ? `
                <h2 style="margin-top:0;">Your job is booked!</h2>
                <p>Thanks, ${escapeHtml(record.customerName || 'there')} — your deposit has been received and <strong>${escapeHtml(record.category)}</strong> in <strong>${escapeHtml(record.suburb)}</strong> is now live on the contractor board.</p>
                ${emailDetailsTable([
                  { label: 'Job', value: escapeHtml(record.category) },
                  { label: 'Quantity', value: itemsSummaryHtml(record.items, record.qty, record.unit) },
                  { label: 'Address', value: record.address ? escapeHtml(record.address) : escapeHtml(record.suburb) },
                  { label: 'Urgency', value: record.urgency ? escapeHtml(record.urgency) : '' },
                  { label: 'Total job price', value: record.basePrice != null ? `$${Number(record.basePrice).toLocaleString()}` : '' },
                  { label: 'Deposit paid', value: `<strong>$${(intent.amount / 100).toLocaleString()}</strong>` },
                ])}
                <p>We'll email you again once a contractor accepts. You can track everything, message your contractor, and see payment stages any time in My Jobs.</p>
                ${emailButton('Open My Jobs →', 'https://mysubbies-site.vercel.app/mysubbies-customer-portal.html')}
              ` : `
                <h2 style="margin-top:0;">Payment received</h2>
                <p>Your <strong>${escapeHtml(stage)}</strong> stage payment for <strong>${escapeHtml(record.category)}</strong> in <strong>${escapeHtml(record.suburb)}</strong> has gone through — $${(intent.amount / 100).toLocaleString()}.</p>
                <p>Track progress any time in My Jobs.</p>
                ${emailButton('Open My Jobs →', 'https://mysubbies-site.vercel.app/mysubbies-customer-portal.html')}
              `),
            });
          }
        } catch (emailErr) { console.error('payment confirmation email failed:', emailErr); }
      }
    } else if (event.type === 'account.updated') {
      const account = event.data.object;
      if (account.charges_enabled && account.payouts_enabled && account.details_submitted) {
        await supabase.from('contractor_connect_accounts')
          .update({ onboarding_status: 'complete' })
          .eq('stripe_connect_account_id', account.id);
      }
    } else if (event.type === 'charge.refunded') {
      const charge = event.data.object;
      const intentId = charge.payment_intent;
      if (intentId) {
        await supabase.from('payments').update({ status: 'refunded', stripe_event_id: event.id, updated_at: new Date().toISOString() }).eq('stripe_payment_intent_id', intentId);
        const { data: milestoneRow } = await supabase.from('payment_milestones').select('id, status').eq('stripe_payment_intent_id', intentId).maybeSingle();
        if (milestoneRow) {
          await supabase.from('payment_milestones').update({ status: 'refunded', updated_at: new Date().toISOString() }).eq('id', milestoneRow.id);
          await supabase.from('payment_audit_logs').insert({
            entity_type: 'payment_milestone', entity_id: milestoneRow.id, action: charge.amount_refunded < charge.amount ? 'partially_refunded' : 'refunded',
            actor_role: 'system', before_state: { status: milestoneRow.status }, after_state: { status: 'refunded', amount_refunded_cents: charge.amount_refunded },
          });
        }
      }
    } else if (event.type === 'charge.dispute.created') {
      const dispute = event.data.object;
      const intentId = dispute.payment_intent;
      if (intentId) {
        const { data: paymentRow } = await supabase.from('payments').select('job_id, stage').eq('stripe_payment_intent_id', intentId).maybeSingle();
        if (paymentRow) {
          await supabase.from('payment_audit_logs').insert({
            entity_type: 'payment', entity_id: intentId, action: 'stripe_chargeback_opened',
            actor_role: 'system', after_state: { job_id: paymentRow.job_id, stage: paymentRow.stage, dispute_reason: dispute.reason, amount_cents: dispute.amount },
          });
        }
      }
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error('stripe-webhook processing error:', err);
    // Return 500 so Stripe retries delivery — do not swallow processing errors.
    res.status(500).json({ error: 'Processing error' });
  }
};
