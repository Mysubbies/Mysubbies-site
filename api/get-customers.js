// GET /api/get-customers
//
// Returns every registered customer (email, name, phone, created_at) for
// admin-side marketing/analysis export. Admin-only by convention, same
// posture as get-applications.js — no auth gate beyond admin-portal.html's
// own client-side password prompt.
const { getSupabase } = require('./_lib/clients');

module.exports = async (req, res) => {
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('customers')
      .select('email, name, phone, created_at')
      .order('created_at', { ascending: false })
      .limit(2000);
    if (error) throw error;

    res.status(200).json({ customers: data || [] });
  } catch (err) {
    console.error('get-customers error:', err);
    res.status(500).json({ error: 'Could not fetch customers.' });
  }
};
