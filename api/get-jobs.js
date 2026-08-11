// GET /api/get-jobs?customerEmail=...  OR  ?contractorEmail=...  OR  ?all=1
//
// Returns the full_record for jobs matching the filter, so a device that
// never created these jobs locally (a different browser, a different
// phone) can still see them. Pairs with sync-jobs.js, which is what
// actually keeps full_record up to date on every mutation.
//
// `all=1` is for the admin portal only — no auth gate on that yet since
// the admin portal itself is only a client-side password prompt (see
// CLAUDE.md), consistent with the rest of this project's current security
// posture, not a new gap introduced here.
const { getSupabase } = require('./_lib/clients');

module.exports = async (req, res) => {
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const { customerEmail, contractorEmail, all } = req.query || {};
    if (!customerEmail && !contractorEmail && !all) {
      res.status(400).json({ error: 'Provide customerEmail, contractorEmail, or all=1.' });
      return;
    }

    const supabase = getSupabase();
    let query = supabase.from('jobs').select('full_record').not('full_record', 'is', null);
    if (customerEmail) query = query.eq('customer_email', String(customerEmail).toLowerCase());
    if (contractorEmail) {
      // Unassigned jobs (so the contractor can see + accept them, matching
      // the dedicated-panel model — not an open marketplace) PLUS jobs
      // already assigned to this contractor. Category matching still
      // happens client-side exactly as it already does today.
      const email = String(contractorEmail).toLowerCase();
      query = query.or(`contractor_email.eq.${email},contractor_email.is.null`);
    }

    const { data, error } = await query.limit(500);
    if (error) throw error;

    res.status(200).json({ jobs: (data || []).map(r => r.full_record).filter(Boolean) });
  } catch (err) {
    console.error('get-jobs error:', err);
    res.status(500).json({ error: 'Could not fetch jobs.' });
  }
};
