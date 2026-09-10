const { getSupabase } = require('./_lib/clients');
const { requireAdmin } = require('./_lib/adminAuth');
const { processDueJobs } = require('./_lib/jobLifecycle');

module.exports = async (req, res) => {
  const cronAuthorised = req.method === 'GET' && process.env.CRON_SECRET && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  if (!cronAuthorised && !requireAdmin(req, res)) return;
  if (!['GET', 'POST'].includes(req.method)) { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    if (req.method === 'POST' && req.body && req.body.action === 'resolve-exception') {
      const { id } = req.body;
      if (!id) { res.status(400).json({ error: 'id is required.' }); return; }
      const { error } = await getSupabase().from('ops_exceptions').update({ status: 'resolved', resolved_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', id);
      if (error) throw error;
      res.status(200).json({ ok: true }); return;
    }
    const results = await processDueJobs(getSupabase());
    res.status(200).json({ processed: results.length, results });
  } catch (error) {
    console.error('job-lifecycle error:', error);
    res.status(500).json({ error: 'Could not process job lifecycle.' });
  }
};
