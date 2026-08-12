// GET /api/get-admin-list?type=applications|customers
//
// Combines what were separate get-applications.js / get-customers.js
// endpoints into one file — Vercel's Hobby plan caps a deployment at 12
// serverless functions; splitting by ?type= keeps the same behavior
// without spending a function slot per read endpoint. Admin-only by
// convention, same posture as before — no auth gate beyond
// admin-portal.html's own client-side password prompt.
const { getSupabase } = require('./_lib/clients');

module.exports = async (req, res) => {
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const { type } = req.query || {};
    const supabase = getSupabase();

    if (type === 'applications') {
      const { data, error } = await supabase
        .from('contractors')
        .select('full_application')
        .not('full_application', 'is', null)
        .limit(500);
      if (error) throw error;
      res.status(200).json({ applications: (data || []).map(r => r.full_application).filter(Boolean) });
      return;
    }

    if (type === 'customers') {
      const { data, error } = await supabase
        .from('customers')
        .select('email, name, phone, created_at')
        .order('created_at', { ascending: false })
        .limit(2000);
      if (error) throw error;
      res.status(200).json({ customers: data || [] });
      return;
    }

    // Milestones sitting in 'disputed' status — the Admin Resolution Queue.
    if (type === 'milestone-claims') {
      const { data, error } = await supabase
        .from('payment_milestones')
        .select('*, payment_milestone_disputes(*)')
        .in('status', ['disputed'])
        .order('updated_at', { ascending: true })
        .limit(500);
      if (error) throw error;
      res.status(200).json({ milestones: data || [] });
      return;
    }

    if (type === 'payment-audit') {
      const { data, error } = await supabase
        .from('payment_audit_logs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(1000);
      if (error) throw error;
      res.status(200).json({ logs: data || [] });
      return;
    }

    res.status(400).json({ error: 'type must be applications, customers, milestone-claims, or payment-audit.' });
  } catch (err) {
    console.error('get-admin-list error:', err);
    res.status(500).json({ error: 'Could not fetch data.' });
  }
};
