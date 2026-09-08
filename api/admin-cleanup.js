// POST /api/admin-cleanup
// Body: { action: 'delete-jobs', jobIds: [...] }
//
// Admin-gated, one-off data-hygiene endpoint. Deliberately accepts only an
// explicit list of job ids -- never a date range, status filter, or "all
// before X" wildcard -- so this can never be pointed at more than exactly
// what an admin has already reviewed and named. Built to let
// api/admin-account.js's existing delete action (which correctly refuses
// to remove a customer/contractor still holding job history) succeed for
// genuinely test-only accounts, by clearing their test jobs first.
//
// A job has real FK children across the payment-milestone system
// (job_payment_schedules -> payment_milestones -> milestone_evidence /
// customer_milestone_responses / payment_milestone_disputes) plus several
// flat job_id references (payments, payout_line_items, property_history,
// ratings, variations, job_events, disputes) -- none of these are
// ON DELETE CASCADE, so every layer has to be cleared in dependency order
// before the job row itself can go. Each step is wrapped individually: a
// table that doesn't exist yet in this database (a schema migration never
// run) or has no matching rows must never block clearing the rest.
const { getSupabase } = require('./_lib/clients');
const { requireAdmin } = require('./_lib/adminAuth');

async function safeDeleteIn(supabase, table, column, values, log) {
  if (!values || values.length === 0) return;
  const { error } = await supabase.from(table).delete().in(column, values);
  if (error) log.push(`${table}: ${error.message}`);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  if (!requireAdmin(req, res)) return;

  try {
    const { action, jobIds } = req.body || {};
    if (action !== 'delete-jobs') { res.status(400).json({ error: 'Unknown action.' }); return; }
    if (!Array.isArray(jobIds) || jobIds.length === 0 || jobIds.length > 200) {
      res.status(400).json({ error: 'jobIds must be a non-empty array of at most 200 ids.' });
      return;
    }
    const supabase = getSupabase();
    const warnings = [];

    // Deepest layer first: schedules -> milestones -> milestone children.
    const { data: schedules } = await supabase
      .from('job_payment_schedules').select('id').in('job_id', jobIds);
    const scheduleIds = (schedules || []).map(s => s.id);

    let milestoneIds = [];
    if (scheduleIds.length) {
      const { data: milestones } = await supabase
        .from('payment_milestones').select('id').in('job_payment_schedule_id', scheduleIds);
      milestoneIds = (milestones || []).map(m => m.id);
    }

    await safeDeleteIn(supabase, 'payment_milestone_disputes', 'milestone_id', milestoneIds, warnings);
    await safeDeleteIn(supabase, 'customer_milestone_responses', 'milestone_id', milestoneIds, warnings);
    await safeDeleteIn(supabase, 'milestone_evidence', 'milestone_id', milestoneIds, warnings);
    await safeDeleteIn(supabase, 'payment_milestones', 'id', milestoneIds, warnings);
    await safeDeleteIn(supabase, 'job_payment_schedules', 'job_id', jobIds, warnings);

    // Flat job_id references.
    await safeDeleteIn(supabase, 'payments', 'job_id', jobIds, warnings);
    await safeDeleteIn(supabase, 'payout_line_items', 'job_id', jobIds, warnings);
    await safeDeleteIn(supabase, 'property_history', 'job_id', jobIds, warnings);
    await safeDeleteIn(supabase, 'ratings', 'job_id', jobIds, warnings);
    await safeDeleteIn(supabase, 'variations', 'job_id', jobIds, warnings);
    await safeDeleteIn(supabase, 'job_events', 'job_id', jobIds, warnings);
    await safeDeleteIn(supabase, 'disputes', 'job_id', jobIds, warnings);

    const { data, error } = await supabase.from('jobs').delete().in('id', jobIds).select('id');
    if (error) throw error;

    res.status(200).json({ deleted: (data || []).length, deletedIds: (data || []).map(r => r.id), warnings });
  } catch (err) {
    console.error('admin-cleanup error:', err);
    res.status(500).json({ error: 'Cleanup failed.', detail: err.message || String(err) });
  }
};
