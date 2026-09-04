// GET  /api/support?entity=disputes&role=admin                        (admin-gated)
// GET  /api/support?entity=disputes&role=customer|contractor&email=... (own disputes)
// GET  /api/support?entity=inquiries&role=admin                       (admin-gated)
// GET  /api/support?entity=inquiries&role=customer|contractor&email=... (own inquiries)
// POST /api/support { entity:'disputes', action:'create', jobId, reason, details, reportedBy, reportedByEmail }
// POST /api/support { entity:'disputes', action:'resolve', id }        (admin-gated)
// POST /api/support { entity:'inquiries', action:'create', role, name, email, text }
// POST /api/support { entity:'inquiries', action:'reply', id, from, text, role, email }
// POST /api/support { entity:'inquiries', action:'resolve', id }       (admin-gated)
// POST /api/support { entity:'inquiries', action:'reopen', id }        (admin-gated)
//
// Added Sep 2026 (pre-launch audit) -- disputes and inquiries used to be
// 100% localStorage-only in every portal, so a customer's "Report a
// problem" or "Contact MySubbies" submission never actually reached admin
// on any device, despite the UI telling them it had been reported. This
// is the real backend for both (supabase/schema_v14_disputes_inquiries.sql).
// `reply`/`create` write a real notification row + email to admin
// (notifications table, see api/notify.js's same pattern) so admin is
// actively told, not just able to see it if they happen to open the tab.
const { getSupabase } = require('./_lib/clients');
const { requireAdmin } = require('./_lib/adminAuth');
const { sendEmail, wrapEmail, escapeHtml, emailButton } = require('./_lib/email');

const ADMIN_NOTIFY_EMAIL = process.env.ADMIN_NOTIFY_EMAIL || 'accounts@mysubbies.com.au';
const ADMIN_URL = 'https://mysubbies-site.vercel.app/mysubbies-admin-portal.html';

async function notifyAdmin({ eventType, title, body }) {
  const supabase = getSupabase();
  try {
    await supabase.from('notifications').insert({ recipient_role: 'admin', event_type: eventType, title, body });
  } catch (e) { console.error('notification insert error:', e); }
  try {
    await sendEmail({
      to: ADMIN_NOTIFY_EMAIL, subject: title,
      html: wrapEmail(`<h2 style="margin-top:0;">${escapeHtml(title)}</h2><p>${body}</p>${emailButton('Review in Admin →', ADMIN_URL)}`),
    });
  } catch (e) { console.error('admin notify email error:', e); }
}

module.exports = async (req, res) => {
  const supabase = getSupabase();

  if (req.method === 'GET') {
    try {
      const { entity, role, email } = req.query || {};
      if (!['disputes', 'inquiries'].includes(entity)) { res.status(400).json({ error: 'entity must be disputes or inquiries.' }); return; }
      if (!role || !['customer', 'contractor', 'admin'].includes(role)) { res.status(400).json({ error: 'role must be customer, contractor or admin.' }); return; }
      if (role === 'admin') {
        if (!requireAdmin(req, res)) return;
      } else if (!email) {
        res.status(400).json({ error: 'email is required for this role.' }); return;
      }

      if (entity === 'disputes') {
        let q = supabase.from('disputes').select('*').order('reported_at', { ascending: false });
        if (role !== 'admin') q = q.eq('reported_by_email', email);
        const { data, error } = await q;
        if (error) throw error;
        res.status(200).json({ disputes: (data || []).map(d => ({
          id: d.id, jobId: d.job_id, reason: d.reason, details: d.details, status: d.status,
          reportedBy: d.reported_by, reportedByEmail: d.reported_by_email, reportedAt: d.reported_at, resolvedAt: d.resolved_at,
        })) });
      } else {
        let q = supabase.from('inquiries').select('*').order('created_at', { ascending: false });
        if (role !== 'admin') q = q.eq('email', email);
        const { data, error } = await q;
        if (error) throw error;
        res.status(200).json({ inquiries: (data || []).map(i => ({
          id: i.id, role: i.role, name: i.name, email: i.email, status: i.status,
          messages: i.messages || [], createdAt: i.created_at, updatedAt: i.updated_at,
        })) });
      }
    } catch (err) {
      console.error('support GET error:', err);
      res.status(500).json({ error: 'Could not fetch support data.' });
    }
    return;
  }

  if (req.method === 'POST') {
    try {
      const { entity, action } = req.body || {};
      if (!['disputes', 'inquiries'].includes(entity)) { res.status(400).json({ error: 'entity must be disputes or inquiries.' }); return; }

      if (entity === 'disputes') {
        if (action === 'create') {
          const { jobId, reason, details, reportedBy, reportedByEmail } = req.body || {};
          if (!jobId || !reason || !reportedBy || !reportedByEmail) { res.status(400).json({ error: 'jobId, reason, reportedBy and reportedByEmail are required.' }); return; }
          const { data, error } = await supabase.from('disputes').insert({
            job_id: jobId, reason, details: details || null, reported_by: reportedBy, reported_by_email: reportedByEmail,
          }).select().single();
          if (error) throw error;
          const { data: jobRow } = await supabase.from('jobs').select('category, suburb').eq('id', jobId).maybeSingle();
          const jobLabel = jobRow ? `${jobRow.category} in ${jobRow.suburb}` : `job ${jobId}`;
          await notifyAdmin({
            eventType: 'dispute-raised', title: 'A dispute was reported',
            body: `${escapeHtml(reportedBy)} (${escapeHtml(reportedByEmail)}) reported "${escapeHtml(reason)}" on ${escapeHtml(jobLabel)}.`,
          });
          res.status(200).json({ id: data.id });
          return;
        }
        if (action === 'resolve') {
          if (!requireAdmin(req, res)) return;
          const { id } = req.body || {};
          if (!id) { res.status(400).json({ error: 'id is required.' }); return; }
          const { error } = await supabase.from('disputes').update({ status: 'resolved', resolved_at: new Date().toISOString() }).eq('id', id);
          if (error) throw error;
          res.status(200).json({ ok: true });
          return;
        }
        res.status(400).json({ error: 'Unknown disputes action.' });
        return;
      }

      // inquiries
      if (action === 'create') {
        const { role, name, email, text, attachments } = req.body || {};
        if (!role || !['customer', 'contractor'].includes(role) || !email || !text) { res.status(400).json({ error: 'role, email and text are required.' }); return; }
        const { data, error } = await supabase.from('inquiries').insert({
          role, name: name || null, email, messages: [{ from: role, text, attachments: attachments || [], createdAt: new Date().toISOString() }],
        }).select().single();
        if (error) throw error;
        await notifyAdmin({
          eventType: 'inquiry-created', title: 'New "Contact MySubbies" message',
          body: `${escapeHtml(name || email)} (${role}) sent: "${escapeHtml(String(text).slice(0, 200))}"`,
        });
        res.status(200).json({ id: data.id });
        return;
      }
      if (action === 'reply') {
        const { id, from, text, role, email, attachments } = req.body || {};
        if (!id || !from || !text) { res.status(400).json({ error: 'id, from and text are required.' }); return; }
        const isAdmin = from === 'admin';
        if (isAdmin) { if (!requireAdmin(req, res)) return; }
        const { data: existing, error: getErr } = await supabase.from('inquiries').select('*').eq('id', id).maybeSingle();
        if (getErr) throw getErr;
        if (!existing) { res.status(404).json({ error: 'Inquiry not found.' }); return; }
        if (!isAdmin && email && existing.email !== email) { res.status(403).json({ error: 'This inquiry belongs to a different account.' }); return; }
        const messages = [...(existing.messages || []), { from, text, attachments: attachments || [], createdAt: new Date().toISOString() }];
        const { error } = await supabase.from('inquiries').update({ messages, updated_at: new Date().toISOString() }).eq('id', id);
        if (error) throw error;
        if (!isAdmin) {
          await notifyAdmin({
            eventType: 'inquiry-reply', title: 'New reply on a "Contact MySubbies" thread',
            body: `${escapeHtml(existing.name || existing.email)} replied: "${escapeHtml(String(text).slice(0, 200))}"`,
          });
        }
        res.status(200).json({ ok: true });
        return;
      }
      if (action === 'resolve' || action === 'reopen') {
        if (!requireAdmin(req, res)) return;
        const { id } = req.body || {};
        if (!id) { res.status(400).json({ error: 'id is required.' }); return; }
        const { error } = await supabase.from('inquiries').update({ status: action === 'resolve' ? 'resolved' : 'open', updated_at: new Date().toISOString() }).eq('id', id);
        if (error) throw error;
        res.status(200).json({ ok: true });
        return;
      }
      res.status(400).json({ error: 'Unknown inquiries action.' });
    } catch (err) {
      console.error('support POST error:', err);
      res.status(500).json({ error: 'Could not save support data.' });
    }
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
};
