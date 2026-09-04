// GET  /api/notifications?role=customer&email=...
// GET  /api/notifications?role=contractor&email=...
// GET  /api/notifications?role=admin                          (admin-gated)
// POST /api/notifications { action:'markRead', id, role, email }
// POST /api/notifications { action:'markAllRead', role, email }
//
// Backend for the bell icon / notification panel in all three portals
// (added Sep 2026, supabase/schema_v13_notifications.sql). Rows are
// written by api/notify.js right alongside the emails it already sends
// for the same events -- this is the in-app half of the same
// notification, not a separate system.
//
// GET returns the 50 most recent notifications plus a SEPARATE
// unreadCount query (not derived from the capped list), so a recipient
// with 50+ unread items still shows a correct badge number.
//
// customer/contractor GETs are ungated (same posture as every other
// self-service "read my own data" endpoint in this project, e.g.
// GET /api/admin-messages?contractorEmail=) -- admin's GET and every
// markRead/markAllRead call are gated: markRead/markAllRead touch
// another recipient's read state if unchecked, and admin's own feed
// isn't scoped to an email a client could self-supply.
const { getSupabase } = require('./_lib/clients');
const { requireAdmin } = require('./_lib/adminAuth');

module.exports = async (req, res) => {
  const supabase = getSupabase();

  if (req.method === 'GET') {
    try {
      const { role, email } = req.query || {};
      if (!role || !['customer', 'contractor', 'admin'].includes(role)) {
        res.status(400).json({ error: 'role must be customer, contractor or admin.' });
        return;
      }
      if (role === 'admin') {
        if (!requireAdmin(req, res)) return;
      } else if (!email) {
        res.status(400).json({ error: 'email is required for this role.' });
        return;
      }

      let listQuery = supabase.from('notifications').select('*').eq('recipient_role', role);
      let countQuery = supabase.from('notifications').select('id', { count: 'exact', head: true }).eq('recipient_role', role).is('read_at', null);
      if (role !== 'admin') {
        listQuery = listQuery.eq('recipient_email', email);
        countQuery = countQuery.eq('recipient_email', email);
      }
      const [{ data, error }, { count, error: countError }] = await Promise.all([
        listQuery.order('created_at', { ascending: false }).limit(50),
        countQuery,
      ]);
      if (error) throw error;
      if (countError) throw countError;

      res.status(200).json({
        notifications: (data || []).map(n => ({
          id: n.id, eventType: n.event_type, title: n.title, body: n.body,
          linkJobId: n.link_job_id, createdAt: n.created_at, readAt: n.read_at,
        })),
        unreadCount: count || 0,
      });
    } catch (err) {
      console.error('notifications GET error:', err);
      res.status(500).json({ error: 'Could not fetch notifications.' });
    }
    return;
  }

  if (req.method === 'POST') {
    try {
      const { action, role, email } = req.body || {};
      if (!role || !['customer', 'contractor', 'admin'].includes(role)) {
        res.status(400).json({ error: 'role must be customer, contractor or admin.' });
        return;
      }
      if (role === 'admin') {
        if (!requireAdmin(req, res)) return;
      } else if (!email) {
        res.status(400).json({ error: 'email is required for this role.' });
        return;
      }

      if (action === 'markRead') {
        const { id } = req.body || {};
        if (!id) { res.status(400).json({ error: 'id is required.' }); return; }
        let q = supabase.from('notifications').update({ read_at: new Date().toISOString() }).eq('id', id).eq('recipient_role', role);
        if (role !== 'admin') q = q.eq('recipient_email', email);
        const { error } = await q;
        if (error) throw error;
        res.status(200).json({ ok: true });
        return;
      }

      if (action === 'markAllRead') {
        let q = supabase.from('notifications').update({ read_at: new Date().toISOString() }).eq('recipient_role', role).is('read_at', null);
        if (role !== 'admin') q = q.eq('recipient_email', email);
        const { error } = await q;
        if (error) throw error;
        res.status(200).json({ ok: true });
        return;
      }

      res.status(400).json({ error: 'Unknown action.' });
    } catch (err) {
      console.error('notifications POST error:', err);
      res.status(500).json({ error: 'Could not update notifications.' });
    }
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
};
