// POST /api/process-cancellation-refund
// Body: { action: 'customer-self-cancel' | 'admin-approve-cancellation', jobId, ... }
//
// Refund policy (founder-confirmed, Sept 2026):
//   - Contractor hasn't accepted yet -> 100% refund, no fee.
//   - Contractor has accepted, no stage beyond the deposit paid yet ->
//     refund 90% of the deposit (10% retained as a cancellation fee).
//   - A later stage (materials onward) already paid -> no automation;
//     admin assesses the actual cost case by case. This endpoint takes no
//     Stripe action in that case and just reports it back.
//
// Both branches read the real `jobs` row server-side (service role) and
// never trust client-submitted payment state -- the client can only ever
// narrow what's *possible* (e.g. which job it's asking about), never what
// gets refunded or for how much.
//
// The existing Stripe webhook (api/stripe-webhook.js) already reacts to
// `charge.refunded` and flips `payments.status` to 'refunded' for us --
// this endpoint deliberately does not duplicate that write, to avoid two
// code paths racing to update the same row. It DOES write its own
// payment_audit_logs row, since the webhook's own audit-log write only
// covers the payment_milestones table, not the plain `payments` table
// used for deposits.
const { getStripe, getSupabase } = require('./_lib/clients');
const { requireAdmin } = require('./_lib/adminAuth');

async function auditLog(supabase, jobId, action, actorRole, actorId, before, after) {
  await supabase.from('payment_audit_logs').insert({
    entity_type: 'job_cancellation', entity_id: jobId,
    action, actor_role: actorRole, actor_id: actorId || null,
    before_state: before, after_state: after,
  });
}

// Resolves the deposit stage's own key the same way sync-jobs.js already
// does for a job's own paymentSchedule -- schedules are category-specific
// (Skip Bins 10/90, Electrical/Plumbing 10/30/60, default 5/35/50/10), so
// this must never assume 'deposit' is the literal key, only the
// conventional first-resolved one.
function depositStageKey(paymentSchedule) {
  if (!Array.isArray(paymentSchedule) || !paymentSchedule.length) return 'deposit';
  const deposit = paymentSchedule.find(s => s.key === 'deposit') || paymentSchedule[0];
  return deposit.key;
}

function laterStageAlreadyPaid(paymentSchedule, paidStages, depositKey) {
  if (!Array.isArray(paymentSchedule) || !paidStages) return false;
  return paymentSchedule.some(s => s.key !== depositKey && paidStages[s.key]);
}

async function refundDeposit(supabase, stripe, jobId, fraction) {
  const { data: payment, error } = await supabase.from('payments')
    .select('*').eq('job_id', jobId).eq('stage', 'deposit').eq('status', 'succeeded').maybeSingle();
  if (error) throw error;
  if (!payment) return { error: 'No successful deposit payment found for this job.' };

  const amountCents = Math.round(payment.amount_cents * fraction);
  const refund = await stripe.refunds.create({
    payment_intent: payment.stripe_payment_intent_id,
    amount: amountCents,
  });
  return { refund, amountCents, paymentIntentId: payment.stripe_payment_intent_id };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const { action } = req.body || {};
    const supabase = getSupabase();

    // ---------------------------------------------------------------
    // CUSTOMER-SELF-CANCEL -- pre-acceptance only, full refund. No admin
    // gate: eligibility itself (no contractor accepted, email matches) is
    // the authorization, verified server-side against the real jobs row.
    // ---------------------------------------------------------------
    if (action === 'customer-self-cancel') {
      const { jobId, customerEmail } = req.body || {};
      if (!jobId || !customerEmail) { res.status(400).json({ error: 'jobId and customerEmail are required.' }); return; }

      const { data: job, error: jobErr } = await supabase.from('jobs').select('*').eq('id', jobId).maybeSingle();
      if (jobErr) throw jobErr;
      if (!job) { res.status(404).json({ error: 'Job not found.' }); return; }
      if (job.customer_email !== customerEmail) { res.status(403).json({ error: 'This job does not belong to that customer.' }); return; }
      if (job.contractor_email) {
        res.status(409).json({ error: 'A contractor has already accepted this job -- use the cancellation request flow instead.' });
        return;
      }

      const stripe = getStripe();
      const result = await refundDeposit(supabase, stripe, jobId, 1);
      if (result.error) { res.status(409).json({ error: result.error }); return; }

      await supabase.from('jobs').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('id', jobId);
      await auditLog(supabase, jobId, 'full_refund_pre_acceptance', 'customer', customerEmail,
        { status: job.status }, { status: 'cancelled', refundedCents: result.amountCents });

      res.status(200).json({ refunded: true, amountCents: result.amountCents });
      return;
    }

    // ---------------------------------------------------------------
    // ADMIN-APPROVE-CANCELLATION -- post-acceptance. 90% refund unless a
    // later stage is already paid, in which case no automated action.
    // ---------------------------------------------------------------
    if (action === 'admin-approve-cancellation') {
      if (!requireAdmin(req, res)) return;
      const { jobId, adminActorEmail } = req.body || {};
      if (!jobId) { res.status(400).json({ error: 'jobId is required.' }); return; }

      const { data: job, error: jobErr } = await supabase.from('jobs').select('*').eq('id', jobId).maybeSingle();
      if (jobErr) throw jobErr;
      if (!job) { res.status(404).json({ error: 'Job not found.' }); return; }

      const fullRecord = job.full_record || {};
      const depositKey = depositStageKey(fullRecord.paymentSchedule);
      if (laterStageAlreadyPaid(fullRecord.paymentSchedule, fullRecord.paidStages, depositKey)) {
        await auditLog(supabase, jobId, 'cancellation_flagged_case_by_case', 'admin', adminActorEmail,
          { status: job.status }, { status: job.status, note: 'A later stage was already paid -- refund must be assessed manually.' });
        res.status(200).json({ caseByCase: true });
        return;
      }

      const stripe = getStripe();
      const result = await refundDeposit(supabase, stripe, jobId, 0.9);
      if (result.error) { res.status(409).json({ error: result.error }); return; }

      await supabase.from('jobs').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('id', jobId);
      await auditLog(supabase, jobId, 'partial_refund_post_acceptance', 'admin', adminActorEmail,
        { status: job.status }, { status: 'cancelled', refundedCents: result.amountCents });

      res.status(200).json({ refunded: true, amountCents: result.amountCents });
      return;
    }

    res.status(400).json({ error: 'Unknown action.' });
  } catch (err) {
    console.error('process-cancellation-refund error:', err);
    res.status(500).json({ error: 'Could not process this cancellation refund.' });
  }
};
