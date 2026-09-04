// Triggered by Vercel Cron (see vercel.json — Mondays 01:00 UTC by
// default; adjust to your timezone preference there). Also callable
// manually by an admin for a one-off run, but only with the same
// CRON_SECRET bearer token — this must never be triggerable by a
// contractor, a customer, or an unauthenticated request, since it moves
// real money.
//
// Eligibility for payout, matching the "Uber-style weekly batch, don't pay
// on jobs with issues" requirement:
//   - job.status = 'deposit_paid' (Stripe confirmed the charge via webhook)
//   - job.disputed = false
//   - at least HOLD_DAYS days have passed since the deposit succeeded
//     (guards against chargebacks/disputes surfacing just after payment)
//   - contractor has completed Stripe Connect onboarding
//   - this job has never already been paid out (enforced by a DB unique
//     index as well as the query below — belt and braces against double-pay)
//
// v1 scope: only pays the contractor's 82% share of the DEPOSIT amount
// (18% platform commission, updated Sept 2026) — see schema.sql and
// create-deposit-intent.js for why the full job value isn't in scope yet.
const { getStripe, getSupabase } = require('./_lib/clients');

const HOLD_DAYS = 3;

module.exports = async (req, res) => {
  const authHeader = req.headers['authorization'] || '';
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const stripe = getStripe();
  const supabase = getSupabase();

  try {
    const holdCutoff = new Date(Date.now() - HOLD_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const { data: eligibleJobs, error: jobsError } = await supabase
      .from('jobs')
      .select('*, payments!inner(status, updated_at)')
      .eq('status', 'deposit_paid')
      .eq('disputed', false)
      .eq('payments.status', 'succeeded')
      .lte('payments.updated_at', holdCutoff);
    if (jobsError) throw jobsError;

    const { data: alreadyPaid } = await supabase
      .from('payout_line_items').select('job_id').eq('status', 'transferred');
    const alreadyPaidJobIds = new Set((alreadyPaid || []).map((r) => r.job_id));

    const { data: batch, error: batchError } = await supabase
      .from('payout_batches').insert({ status: 'running' }).select().single();
    if (batchError) throw batchError;

    let totalCents = 0;
    const results = [];

    for (const job of eligibleJobs || []) {
      if (alreadyPaidJobIds.has(job.id)) continue;
      if (!job.contractor_email) continue;

      const { data: connectAccount } = await supabase
        .from('contractor_connect_accounts')
        .select('*')
        .eq('contractor_email', job.contractor_email)
        .eq('onboarding_status', 'complete')
        .maybeSingle();
      if (!connectAccount) { results.push({ jobId: job.id, skipped: 'contractor not onboarded yet' }); continue; }

      const amountCents = Math.round(job.deposit_amount_cents * 0.82);

      try {
        const transfer = await stripe.transfers.create({
          amount: amountCents,
          currency: 'aud',
          destination: connectAccount.stripe_connect_account_id,
          transfer_group: job.id,
          metadata: { jobId: job.id, batchId: batch.id },
        });

        await supabase.from('payout_line_items').insert({
          batch_id: batch.id,
          job_id: job.id,
          contractor_email: job.contractor_email,
          amount_cents: amountCents,
          stripe_transfer_id: transfer.id,
          status: 'transferred',
        });
        totalCents += amountCents;
        results.push({ jobId: job.id, transferred: amountCents });
      } catch (transferErr) {
        console.error(`Transfer failed for job ${job.id}:`, transferErr);
        await supabase.from('payout_line_items').insert({
          batch_id: batch.id,
          job_id: job.id,
          contractor_email: job.contractor_email,
          amount_cents: amountCents,
          status: 'failed',
        });
        results.push({ jobId: job.id, failed: transferErr.message });
      }
    }

    await supabase.from('payout_batches')
      .update({ status: 'completed', total_amount_cents: totalCents })
      .eq('id', batch.id);

    res.status(200).json({ batchId: batch.id, totalCents, results });
  } catch (err) {
    console.error('weekly-payout error:', err);
    res.status(500).json({ error: 'Payout batch failed — check logs.' });
  }
};
