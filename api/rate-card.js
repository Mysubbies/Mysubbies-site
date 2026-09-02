// GET  /api/rate-card
// POST /api/rate-card { categories }   (admin-gated)
//
// The single authoritative copy of the rate card (see
// supabase/schema_v12_rate_card_sync.sql for why this exists — previously
// every browser's rate card was purely local, so an admin price/disable/
// removal never reached any customer). GET is ungated: every visitor's
// estimator needs to read this to price a job, same posture as
// GET /api/get-jobs. POST is admin-only.
const { getSupabase } = require('./_lib/clients');
const { requireAdmin } = require('./_lib/adminAuth');

module.exports = async (req, res) => {
  const supabase = getSupabase();

  if (req.method === 'GET') {
    try {
      const { data, error } = await supabase.from('platform_rate_card').select('categories, updated_at').eq('id', true).maybeSingle();
      if (error) throw error;
      res.status(200).json({ categories: data ? data.categories : null, updatedAt: data ? data.updated_at : null });
    } catch (err) {
      console.error('rate-card GET error:', err);
      res.status(500).json({ error: 'Could not fetch the rate card.' });
    }
    return;
  }

  if (req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    try {
      const { categories } = req.body || {};
      if (!Array.isArray(categories)) { res.status(400).json({ error: 'categories must be an array.' }); return; }
      const { error } = await supabase.from('platform_rate_card').upsert({
        id: true, categories, updated_by: 'admin', updated_at: new Date().toISOString(),
      });
      if (error) throw error;
      res.status(200).json({ saved: true });
    } catch (err) {
      console.error('rate-card POST error:', err);
      res.status(500).json({ error: 'Could not save the rate card.' });
    }
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
};
