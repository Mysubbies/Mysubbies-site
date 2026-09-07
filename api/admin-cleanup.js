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
const { getSupabase } = require('./_lib/clients');
const { requireAdmin } = require('./_lib/adminAuth');

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
    const { data, error } = await supabase.from('jobs').delete().in('id', jobIds).select('id');
    if (error) throw error;
    res.status(200).json({ deleted: (data || []).length, deletedIds: (data || []).map(r => r.id) });
  } catch (err) {
    console.error('admin-cleanup error:', err);
    res.status(500).json({ error: 'Cleanup failed.' });
  }
};
