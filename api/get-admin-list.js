// GET /api/get-admin-list?type=applications|customers
//
// Combines what were separate get-applications.js / get-customers.js
// endpoints into one file — Vercel's Hobby plan caps a deployment at 12
// serverless functions; splitting by ?type= keeps the same behavior
// without spending a function slot per read endpoint. Admin-only, gated
// server-side via api/_lib/adminAuth.js -- this used to rely entirely on
// admin-portal.html's client-side password prompt, which meant anyone who
// found this URL could read every customer/contractor/payment record with
// no credential at all.
const { getSupabase } = require('./_lib/clients');
const { requireAdmin } = require('./_lib/adminAuth');

module.exports = async (req, res) => {
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }
  if (!requireAdmin(req, res)) return;

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
        .select('id, email, name, phone, status, created_at')
        .order('created_at', { ascending: false })
        .limit(2000);
      if (error) throw error;
      res.status(200).json({ customers: data || [] });
      return;
    }

    // Milestones sitting in 'disputed' status — the Admin Resolution Queue.
    // Pulls in the job/schedule it belongs to and the contractor's submitted
    // evidence, since an admin needs both to make a resolution decision.
    if (type === 'milestone-claims') {
      const { data, error } = await supabase
        .from('payment_milestones')
        .select('*, payment_milestone_disputes(*), milestone_evidence(*), job_payment_schedules(job_id, schedule_type, revised_total_price_cents)')
        .in('status', ['disputed'])
        .order('updated_at', { ascending: true })
        .limit(500);
      if (error) throw error;
      res.status(200).json({ milestones: data || [] });
      return;
    }

    // Jobs whose schedule is waiting on an admin-built payment plan — the
    // $20,000+ structural / manual_review-category case where the deposit
    // is locked in but the remainder was deliberately never auto-generated.
    if (type === 'pending-schedule-jobs') {
      const { data, error } = await supabase
        .from('job_payment_schedules')
        .select('id, job_id, schedule_type, original_contract_price_cents, revised_total_price_cents, deposit_amount_cents, created_at')
        .eq('status', 'pending_admin_schedule')
        .order('created_at', { ascending: true })
        .limit(200);
      if (error) throw error;
      res.status(200).json({ schedules: data || [] });
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

    // Unread contractor replies (see schema_v8_two_way_admin_contractor_messages.sql)
    // -- feeds the Action required checklist so an admin who never happens
    // to open a specific contractor's thread still finds out a reply is
    // waiting. Grouped by contractor rather than returning every row, since
    // the checklist only needs a count, not the message content.
    if (type === 'unread-contractor-messages') {
      const { data, error } = await supabase
        .from('admin_contractor_messages')
        .select('contractor_email')
        .eq('sender_role', 'contractor')
        .is('read_at', null)
        .limit(2000);
      if (error) throw error;
      const byContractor = {};
      (data || []).forEach(r => { byContractor[r.contractor_email] = (byContractor[r.contractor_email] || 0) + 1; });
      res.status(200).json({ count: (data || []).length, contractorCount: Object.keys(byContractor).length });
      return;
    }

    // One row per contractor conversation (most recent message + unread
    // count), for the dedicated Messages tab -- reduced client-side from
    // the raw message rows rather than a DB view/function, matching this
    // project's existing preference for simple queries over new SQL
    // objects at this data scale (a solo-founder marketplace's contractor
    // panel, not a high-volume inbox).
    if (type === 'message-threads') {
      const { data, error } = await supabase
        .from('admin_contractor_messages')
        .select('contractor_email, sender_role, body, sent_at, read_at')
        .order('sent_at', { ascending: false })
        .limit(1000);
      if (error) throw error;
      const threads = {};
      (data || []).forEach(m => {
        if (!threads[m.contractor_email]) {
          threads[m.contractor_email] = { contractorEmail: m.contractor_email, lastMessage: m.body, lastSenderRole: m.sender_role, lastSentAt: m.sent_at, unreadCount: 0 };
        }
        if (m.sender_role === 'contractor' && !m.read_at) threads[m.contractor_email].unreadCount += 1;
      });
      res.status(200).json({ threads: Object.values(threads).sort((a, b) => new Date(b.lastSentAt) - new Date(a.lastSentAt)) });
      return;
    }

    res.status(400).json({ error: 'type must be applications, customers, milestone-claims, pending-schedule-jobs, payment-audit, unread-contractor-messages, or message-threads.' });
  } catch (err) {
    console.error('get-admin-list error:', err);
    res.status(500).json({ error: 'Could not fetch data.' });
  }
};
