// POST /api/sync-jobs
// Body: { jobs: [ <full localStorage job object>, ... ] }
//
// Mirrors the full job record (messages, photos, payment-stage ticks,
// variations — everything) into Supabase so it's visible from any device,
// not just the browser that created it. Called by every page's saveJobs()
// after it writes to localStorage, so it fires on every mutation without
// needing each individual button handler (accept job, send message, tick a
// payment stage, add a variation...) to know about the backend.
//
// IMPORTANT: this never touches the `status`, `base_price_cents`,
// `deposit_pct` or `deposit_amount_cents` columns on an existing row —
// those are the real payment state, owned exclusively by
// create-deposit-intent.js (locks the price in) and stripe-webhook.js
// (marks it paid). This endpoint only ever writes `full_record` (the
// entire local job object, for display) and a couple of lookup columns.
// A job that doesn't exist yet in the table (e.g. a multi-category bundle,
// which never goes through the real Stripe flow — see CLAUDE.md) gets a
// reasonable one-time default for those payment columns on first insert
// only, derived from the local job's own paymentSchedule/paidStages.
const { getSupabase } = require('./_lib/clients');

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const { jobs } = req.body || {};
    if (!Array.isArray(jobs) || jobs.length === 0) {
      res.status(400).json({ error: 'jobs must be a non-empty array.' });
      return;
    }

    const supabase = getSupabase();
    const results = [];

    for (const job of jobs.slice(0, 200)) {
      if (!job || !job.id || !job.category) continue;

      const { data: existing } = await supabase.from('jobs').select('id').eq('id', job.id).maybeSingle();

      if (existing) {
        await supabase.from('jobs').update({
          full_record: job,
          customer_email: job.customerEmail || null,
          contractor_email: job.contractorEmail || null,
          suburb: job.suburb || null,
          updated_at: new Date().toISOString(),
        }).eq('id', job.id);
      } else {
        const depositStage = Array.isArray(job.paymentSchedule)
          ? job.paymentSchedule.find(s => s.key === 'deposit') || job.paymentSchedule[0]
          : null;
        const depositPct = depositStage ? depositStage.pct : 5;
        const basePriceCents = Math.round((job.basePrice || 0) * 100);
        const depositAmountCents = Math.round(basePriceCents * (depositPct / 100));
        const depositAlreadyPaid = !!(job.paidStages && job.paidStages.deposit);

        await supabase.from('jobs').insert({
          id: job.id,
          category: job.category,
          suburb: job.suburb || null,
          contractor_email: job.contractorEmail || null,
          base_price_cents: basePriceCents || 1,
          deposit_pct: depositPct,
          deposit_amount_cents: depositAmountCents || 1,
          status: depositAlreadyPaid ? 'deposit_paid' : 'pending_deposit',
          full_record: job,
          customer_email: job.customerEmail || null,
        });
      }
      results.push(job.id);
    }

    res.status(200).json({ synced: results.length });
  } catch (err) {
    console.error('sync-jobs error:', err);
    res.status(500).json({ error: 'Could not sync jobs.' });
  }
};
