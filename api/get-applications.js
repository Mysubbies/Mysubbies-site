// GET /api/get-applications
//
// Returns every contractor's full_application (admin-only — no auth gate
// on that beyond what already exists for the rest of admin-portal.html,
// see CLAUDE.md's note on that page's client-side password prompt).
// Pairs with sync-applications.js, which keeps full_application current.
const { getSupabase } = require('./_lib/clients');

module.exports = async (req, res) => {
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('contractors')
      .select('full_application')
      .not('full_application', 'is', null)
      .limit(500);
    if (error) throw error;

    res.status(200).json({ applications: (data || []).map(r => r.full_application).filter(Boolean) });
  } catch (err) {
    console.error('get-applications error:', err);
    res.status(500).json({ error: 'Could not fetch applications.' });
  }
};
