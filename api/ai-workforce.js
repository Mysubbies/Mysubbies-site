const { getSupabase } = require('./_lib/clients');
const { requireAdmin } = require('./_lib/adminAuth');
const { managerSnapshot } = require('../lib/ai-workforce/manager-snapshot');
module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAdmin(req, res)) return;
  try {
    const snapshot = await managerSnapshot(getSupabase());
    return res.status(200).json(snapshot);
  } catch (error) {
    console.error('AI workforce snapshot failed', error);
    return res.status(500).json({ error: 'Unable to load AI workforce metrics' });
  }
};
