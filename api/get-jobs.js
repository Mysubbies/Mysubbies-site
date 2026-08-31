// GET /api/get-jobs?customerEmail=...  OR  ?contractorEmail=...  OR  ?all=1
//
// Returns the full_record for jobs matching the filter, so a device that
// never created these jobs locally (a different browser, a different
// phone) can still see them. Pairs with sync-jobs.js, which is what
// actually keeps full_record up to date on every mutation.
//
// Each returned job also carries `jobNumber` (Aug 2026) -- the real
// sequential number from jobs.job_number (see
// supabase/schema_v10_job_numbers.sql), spliced in here rather than stored
// inside full_record itself so there's exactly one source of truth for it.
//
// `all=1` is for the admin portal only — gated via api/_lib/adminAuth.js.
// The customerEmail/contractorEmail branches stay open, called directly by
// the customer/contractor portals for their own jobs.
const { getSupabase } = require('./_lib/clients');
const { requireAdmin } = require('./_lib/adminAuth');

module.exports = async (req, res) => {
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const { customerEmail, contractorEmail, all } = req.query || {};
    if (!customerEmail && !contractorEmail && !all) {
      res.status(400).json({ error: 'Provide customerEmail, contractorEmail, or all=1.' });
      return;
    }
    if (all && !customerEmail && !contractorEmail) {
      if (!requireAdmin(req, res)) return;
    }

    const supabase = getSupabase();

    if (contractorEmail) {
      // Two pieces: jobs already assigned to this contractor (any category —
      // they took it, they keep seeing it), and the unassigned feed pool,
      // trade-filtered by this contractor's approved categories so the feed
      // matches "dispatched to a matched contractor," not an open
      // marketplace. Falls back to showing the full unfiltered pool when the
      // contractor has no categories on record yet (legacy/local-only
      // accounts predating the `contractors.categories` column) so nobody's
      // feed silently goes empty.
      const email = String(contractorEmail).toLowerCase();
      const [{ data: ownJobs, error: ownErr }, { data: contractorRow }] = await Promise.all([
        supabase.from('jobs').select('full_record, job_number').not('full_record', 'is', null).eq('contractor_email', email).limit(500),
        supabase.from('contractors').select('categories').eq('email', email).maybeSingle(),
      ]);
      if (ownErr) throw ownErr;

      const categories = (contractorRow && contractorRow.categories) || [];
      let feedQuery = supabase.from('jobs').select('full_record, job_number').not('full_record', 'is', null).is('contractor_email', null);
      if (categories.length > 0) feedQuery = feedQuery.in('category', categories);
      const { data: feedJobs, error: feedErr } = await feedQuery.limit(500);
      if (feedErr) throw feedErr;

      const combined = [...(ownJobs || []), ...(feedJobs || [])];
      res.status(200).json({ jobs: combined.filter(r => r.full_record).map(r => ({ ...r.full_record, jobNumber: r.job_number })) });
      return;
    }

    let query = supabase.from('jobs').select('full_record, job_number').not('full_record', 'is', null);
    if (customerEmail) query = query.eq('customer_email', String(customerEmail).toLowerCase());

    const { data, error } = await query.limit(500);
    if (error) throw error;

    res.status(200).json({ jobs: (data || []).filter(r => r.full_record).map(r => ({ ...r.full_record, jobNumber: r.job_number })) });
  } catch (err) {
    console.error('get-jobs error:', err);
    res.status(500).json({ error: 'Could not fetch jobs.' });
  }
};
