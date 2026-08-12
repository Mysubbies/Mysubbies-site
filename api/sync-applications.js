// POST /api/sync-applications
// Body: { applications: [ <full localStorage application object>, ... ] }
//
// Same pattern as sync-jobs.js, for contractor applications. Without this,
// mysubbies-admin-portal.html's Applications tab could only ever show
// applications submitted in that exact browser — nothing synced the full
// application object (insurance docs, cert docs, profile photo, referral
// code, etc.) anywhere. Matches contractors by email (set at signup time),
// so it's a no-op for an application whose contractor row doesn't exist
// yet — that shouldn't normally happen since contractor-signup.html
// creates both together, but it's a safe no-op either way, not an error.
const { getSupabase } = require('./_lib/clients');

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const { applications } = req.body || {};
    if (!Array.isArray(applications) || applications.length === 0) {
      res.status(400).json({ error: 'applications must be a non-empty array.' });
      return;
    }

    const supabase = getSupabase();
    let updated = 0;

    for (const application of applications.slice(0, 200)) {
      if (!application || !application.email) continue;
      const { data, error } = await supabase
        .from('contractors')
        .update({ full_application: application, updated_at: new Date().toISOString() })
        .eq('email', String(application.email).toLowerCase())
        .select('id');
      if (!error && data && data.length) updated += data.length;
    }

    res.status(200).json({ updated });
  } catch (err) {
    console.error('sync-applications error:', err);
    res.status(500).json({ error: 'Could not sync applications.' });
  }
};
