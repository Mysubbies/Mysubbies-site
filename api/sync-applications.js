// POST /api/sync-applications
// Body: { applications: [ <full localStorage application object>, ... ] }
//
// Same pattern as sync-jobs.js, for contractor applications. Without this,
// mysubbies-admin-portal.html's Applications tab could only ever show
// applications submitted in that exact browser — nothing synced the full
// application object (insurance docs, cert docs, profile photo, referral
// code, etc.) anywhere.
//
// Sept 2026 (contractor signup redesign, "Founding 100"): this now UPSERTS
// the contractors row instead of update-only. Before this redesign,
// mysubbies-contractor-signup.html created the contractors row itself via
// an authenticated client-side insert (sb.auth.signUp() ran first, so
// auth.uid() matched the RLS "insert own row" policy). Password creation
// is now deferred to portal activation, so there's no authenticated
// session at application time — this service-role endpoint (which bypasses
// RLS by design, see _lib/clients.js) is now the only thing that can create
// the row. Matches by email; a row with no auth_user_id yet is expected
// and normal until the contractor activates their account.
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
      const email = String(application.email).toLowerCase();
      const { data, error } = await supabase
        .from('contractors')
        .upsert({
          email,
          business_name: application.business || email,
          address: application.address || null,
          abn: application.abn || null,
          acn: application.acn || null,
          business_structure: application.businessStructure || null,
          phone: application.phone || null,
          categories: application.trades || [],
          referral_code: application.referralCode || null,
          referred_by: application.referredBy || null,
          full_application: application,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'email' })
        .select('id');
      if (!error && data && data.length) updated += data.length;
      else if (error) console.error('sync-applications upsert error for', email, error);
    }

    res.status(200).json({ updated });
  } catch (err) {
    console.error('sync-applications error:', err);
    res.status(500).json({ error: 'Could not sync applications.' });
  }
};
