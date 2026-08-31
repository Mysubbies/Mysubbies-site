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

    // Completed jobs per contractor, for manual weekly payment (Aug 2026).
    // Founder pays contractors manually -- this is a correct LIST, not a
    // payment trigger. "Completed" has to use the real signal per CLAUDE.md
    // (job.status never reaches 'completed' anywhere in this codebase):
    // a job with a real job_payment_schedules row is complete when every
    // payment_milestones row for it is 'paid'; an older/bundle job with no
    // schedule row falls back to the same full_record.paymentSchedule vs
    // paidStages check api/sync-jobs.js already uses. The contractor's 75%
    // share of an already-transferred deposit (payout_line_items,
    // status='transferred') is netted off so the founder doesn't double-pay
    // the slice the weekly Connect cron already sent automatically -- only
    // the deposit is ever auto-paid; materials/frame/completion stages are
    // still manual by explicit founder direction.
    if (type === 'contractor-payouts') {
      const { data: jobs, error: jobsErr } = await supabase
        .from('jobs')
        .select('id, job_number, category, suburb, contractor_email, base_price_cents, full_record, updated_at')
        .not('contractor_email', 'is', null)
        .limit(5000);
      if (jobsErr) throw jobsErr;

      const jobIds = (jobs || []).map(j => j.id);
      const safeJobIds = jobIds.length ? jobIds : ['__none__'];

      const { data: schedules, error: schedErr } = await supabase
        .from('job_payment_schedules')
        .select('job_id, payment_milestones(status, paid_at)')
        .in('job_id', safeJobIds);
      if (schedErr) throw schedErr;
      const scheduleByJobId = {};
      (schedules || []).forEach(s => { scheduleByJobId[s.job_id] = s; });

      const { data: transfers, error: transferErr } = await supabase
        .from('payout_line_items')
        .select('job_id, amount_cents')
        .eq('status', 'transferred')
        .in('job_id', safeJobIds);
      if (transferErr) throw transferErr;
      const transferredByJobId = {};
      (transfers || []).forEach(t => { transferredByJobId[t.job_id] = (transferredByJobId[t.job_id] || 0) + t.amount_cents; });

      function isLegacyComplete(fr) {
        return Array.isArray(fr.paymentSchedule) && fr.paymentSchedule.length > 0
          && fr.paymentSchedule.every(s => fr.paidStages && fr.paidStages[s.key]);
      }

      const byContractor = {};
      for (const job of (jobs || [])) {
        const schedule = scheduleByJobId[job.id];
        const fr = job.full_record || {};
        let completed = false;
        let completedAt = null;

        if (schedule) {
          const milestones = schedule.payment_milestones || [];
          completed = milestones.length > 0 && milestones.every(m => m.status === 'paid');
          if (completed) {
            const paidDates = milestones.map(m => m.paid_at).filter(Boolean).sort();
            completedAt = paidDates.length ? paidDates[paidDates.length - 1] : job.updated_at;
          }
        } else {
          completed = isLegacyComplete(fr);
          if (completed) completedAt = job.updated_at;
        }
        if (!completed) continue;

        const email = job.contractor_email;
        const shareCents = Math.round((job.base_price_cents || 0) * 0.75);
        const alreadyPaidCents = transferredByJobId[job.id] || 0;

        if (!byContractor[email]) byContractor[email] = { contractorEmail: email, jobs: [], grossOwedCents: 0, alreadyPaidCents: 0 };
        byContractor[email].jobs.push({
          jobId: job.id,
          jobNumber: job.job_number,
          category: job.category,
          suburb: job.suburb,
          basePriceCents: job.base_price_cents || 0,
          shareCents,
          alreadyPaidCents,
          completedAt,
        });
        byContractor[email].grossOwedCents += shareCents;
        byContractor[email].alreadyPaidCents += alreadyPaidCents;
      }

      const emails = Object.keys(byContractor);
      if (emails.length) {
        const { data: contractorRows, error: contractorsErr } = await supabase
          .from('contractors').select('email, business_name').in('email', emails);
        if (contractorsErr) throw contractorsErr;
        (contractorRows || []).forEach(c => { if (byContractor[c.email]) byContractor[c.email].businessName = c.business_name; });
      }

      const result = Object.values(byContractor).map(c => ({
        contractorEmail: c.contractorEmail,
        businessName: c.businessName || null,
        jobCount: c.jobs.length,
        jobs: c.jobs.sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt)),
        grossOwedCents: c.grossOwedCents,
        alreadyPaidCents: c.alreadyPaidCents,
        netOwedCents: c.grossOwedCents - c.alreadyPaidCents,
      })).sort((a, b) => b.netOwedCents - a.netOwedCents);

      res.status(200).json({ contractors: result });
      return;
    }

    res.status(400).json({ error: 'type must be applications, customers, milestone-claims, pending-schedule-jobs, payment-audit, unread-contractor-messages, message-threads, or contractor-payouts.' });
  } catch (err) {
    console.error('get-admin-list error:', err);
    res.status(500).json({ error: 'Could not fetch data.' });
  }
};
