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
//
// Property Profiles (added Aug 2026): this is also the single choke point
// that sees every job mutation from all 4 portals, so it's the natural
// place to auto-populate the property_profiles/property_history tables —
// no separate client-side wiring needed. See CLAUDE.md and
// supabase/schema_v5_property_profiles.sql for the full writeup. A job
// counts as "genuinely complete" when every stage in its own paymentSchedule
// has been ticked in paidStages — jobs.status/'completed' is never actually
// reached anywhere in this codebase, so it can't be used as the signal here.
const { getSupabase } = require('./_lib/clients');

function normalizeAddress(addr) {
  return String(addr || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function isJobComplete(job) {
  return Array.isArray(job.paymentSchedule) && job.paymentSchedule.length > 0
    && job.paymentSchedule.every(s => job.paidStages && job.paidStages[s.key]);
}

async function syncPropertyProfile(supabase, job) {
  const normalized = normalizeAddress(job.address);
  if (!normalized) return;

  const { data: profile, error: profileErr } = await supabase
    .from('property_profiles')
    .upsert({
      normalized_address: normalized,
      address: job.address,
      suburb: job.suburb || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'normalized_address' })
    .select('id')
    .single();
  if (profileErr || !profile) return;

  if (!isJobComplete(job)) return;

  const taskSummary = Array.isArray(job.items) && job.items.length
    ? job.items.map(i => i.taskName).filter(Boolean).join(', ')
    : null;

  await supabase.from('property_history').upsert({
    property_id: profile.id,
    job_id: job.id,
    category: job.category,
    task_summary: taskSummary,
    contractor_email: job.contractorEmail || null,
    contractor_name: job.contractor || null,
    amount_paid_cents: Math.round((job.basePrice || 0) * 100) || null,
    completed_at: new Date().toISOString(),
  }, { onConflict: 'job_id' });
}

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

      // Never let a Property Profile hiccup break the actual job sync this
      // endpoint exists for — same "swallow and continue" approach notify.js
      // uses for its own non-critical side effects.
      try { await syncPropertyProfile(supabase, job); } catch (e) { console.error('property-profile sync error:', e); }
    }

    res.status(200).json({ synced: results.length });
  } catch (err) {
    console.error('sync-jobs error:', err);
    res.status(500).json({ error: 'Could not sync jobs.' });
  }
};
