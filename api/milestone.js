// POST /api/milestone
// Body: { action: 'claim' | 'respond' | 'admin-resolve', ... }
//
// The full milestone lifecycle in one file since every action shares the
// same lookup/validation groundwork and all write to payment_audit_logs.
//
// claim   { jobId, milestoneKey, contractorId, description, photoUrls,
//           deliveryDocketUrl, inspectionRecordId, declarationConfirmed }
// respond { milestoneId, customerId, response: 'approved'|'disputed', notes }
// admin-resolve { milestoneId, adminAction: 'approve'|'reject'|'request_evidence'|'return_to_contractor',
//                 adminNotes, actorId }
const { getSupabase } = require('./_lib/clients');
const { nextClaimableMilestone } = require('./_lib/paymentSchedule');
const { sendEmail, wrapEmail } = require('./_lib/email');

async function auditLog(supabase, milestoneId, action, actorRole, actorId, before, after) {
  await supabase.from('payment_audit_logs').insert({
    entity_type: 'payment_milestone', entity_id: milestoneId,
    action, actor_role: actorRole, actor_id: actorId || null,
    before_state: before, after_state: after,
  });
}

async function getScheduleMilestones(supabase, jobPaymentScheduleId) {
  const { data, error } = await supabase.from('payment_milestones').select('*')
    .eq('job_payment_schedule_id', jobPaymentScheduleId).order('milestone_index', { ascending: true });
  if (error) throw error;
  return data || [];
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const supabase = getSupabase();

  try {
    const { action } = req.body || {};

    // ---------------------------------------------------------------
    // CLAIM — contractor submits evidence for the next claimable milestone.
    // ---------------------------------------------------------------
    if (action === 'claim') {
      const { jobId, milestoneKey, contractorId, description, photoUrls, deliveryDocketUrl, inspectionRecordId, declarationConfirmed } = req.body || {};
      if (!jobId || !milestoneKey || !declarationConfirmed) {
        res.status(400).json({ error: 'jobId, milestoneKey and a confirmed declaration are required.' });
        return;
      }

      const { data: schedule, error: schedErr } = await supabase.from('job_payment_schedules').select('*')
        .eq('job_id', jobId).order('version', { ascending: false }).limit(1).maybeSingle();
      if (schedErr) throw schedErr;
      if (!schedule || schedule.status !== 'active') { res.status(409).json({ error: 'This job has no active payment schedule to claim against.' }); return; }

      const milestones = await getScheduleMilestones(supabase, schedule.id);
      const milestone = milestones.find(m => m.key === milestoneKey);
      if (!milestone) { res.status(404).json({ error: 'Milestone not found.' }); return; }
      if (milestone.milestone_type === 'deposit') { res.status(400).json({ error: 'The deposit is paid at booking, not claimed here.' }); return; }

      const claimable = nextClaimableMilestone(milestones, schedule.sequence_override);
      if (!claimable || claimable.id !== milestone.id) {
        res.status(409).json({ error: 'This milestone cannot be claimed yet — a previous milestone is still unpaid.' });
        return;
      }
      if (milestone.status !== 'available') {
        res.status(409).json({ error: `This milestone is already ${milestone.status} — it can't be claimed again.` });
        return;
      }

      // Evidence requirements — "site visit completed"/"job started" alone,
      // with no evidence, can never satisfy a claim. Enforced here, not just
      // in the UI.
      if (!description || !description.trim()) { res.status(400).json({ error: 'A progress description is required.' }); return; }
      const evidenceType = milestone.requires_evidence_type;
      if (evidenceType === 'photos' && (!photoUrls || photoUrls.length === 0)) {
        res.status(400).json({ error: 'At least one site photo is required to claim this milestone.' }); return;
      }
      if (evidenceType === 'delivery_docket') {
        if (!deliveryDocketUrl) { res.status(400).json({ error: 'A delivery docket or supplier invoice is required — materials must be delivered to the property before this can be claimed.' }); return; }
        if (!photoUrls || photoUrls.length === 0) { res.status(400).json({ error: 'At least one photo of the delivered materials is required.' }); return; }
      }
      if (evidenceType === 'inspection_certificate') {
        if (!inspectionRecordId) { res.status(400).json({ error: 'A linked inspection record is required to claim this milestone.' }); return; }
        const { data: inspection } = await supabase.from('inspection_records').select('result').eq('id', inspectionRecordId).maybeSingle();
        if (!inspection || inspection.result !== 'passed') {
          res.status(400).json({ error: 'The linked inspection must be marked passed before this milestone can be claimed.' }); return;
        }
      }

      const { error: evidenceError } = await supabase.from('milestone_evidence').insert({
        milestone_id: milestone.id, submitted_by_contractor_id: contractorId || null,
        description: description.trim(), photo_urls: photoUrls || [], delivery_docket_url: deliveryDocketUrl || null,
        inspection_record_id: inspectionRecordId || null, declaration_confirmed: true,
      });
      if (evidenceError) throw evidenceError;

      const newStatus = milestone.requires_customer_approval ? 'awaiting_customer' : 'approved';
      const { data: updated, error: updateError } = await supabase.from('payment_milestones')
        .update({ status: newStatus, updated_at: new Date().toISOString() }).eq('id', milestone.id).select().single();
      if (updateError) throw updateError;

      await auditLog(supabase, milestone.id, 'milestone_claimed', 'contractor', contractorId, { status: 'available' }, { status: newStatus });

      const { data: jobRow } = await supabase.from('jobs').select('customer_email, category').eq('id', jobId).maybeSingle();
      if (jobRow && jobRow.customer_email) {
        try {
          await sendEmail({
            to: jobRow.customer_email,
            subject: `Action needed — review the "${milestone.label}" milestone`,
            html: wrapEmail(`<h2 style="margin-top:0;">Your contractor submitted progress</h2><p>Your contractor has submitted evidence for <strong>${milestone.label}</strong> on your ${jobRow.category} job. Review it in <a href="https://mysubbies-site.vercel.app/mysubbies-customer-portal.html">My Jobs</a> to approve and pay, or raise an issue.</p>`),
          });
        } catch (e) { /* email is best-effort */ }
      }

      res.status(200).json({ milestone: updated });
      return;
    }

    // ---------------------------------------------------------------
    // RESPOND — customer approves or disputes a claimed milestone.
    // ---------------------------------------------------------------
    if (action === 'respond') {
      const { milestoneId, customerId, response, notes } = req.body || {};
      if (!milestoneId || !['approved', 'disputed'].includes(response)) {
        res.status(400).json({ error: 'milestoneId and a response of approved or disputed are required.' });
        return;
      }

      const { data: milestone, error: mErr } = await supabase.from('payment_milestones').select('*').eq('id', milestoneId).maybeSingle();
      if (mErr) throw mErr;
      if (!milestone) { res.status(404).json({ error: 'Milestone not found.' }); return; }
      if (milestone.status !== 'awaiting_customer') { res.status(409).json({ error: 'This milestone is not currently awaiting your review.' }); return; }

      await supabase.from('customer_milestone_responses').insert({ milestone_id: milestoneId, customer_id: customerId || null, response, notes: notes || null });

      if (response === 'approved') {
        await supabase.from('payment_milestones').update({ status: 'approved', updated_at: new Date().toISOString() }).eq('id', milestoneId);
        await auditLog(supabase, milestoneId, 'milestone_approved', 'customer', customerId, { status: 'awaiting_customer' }, { status: 'approved' });
      } else {
        await supabase.from('payment_milestones').update({ status: 'disputed', updated_at: new Date().toISOString() }).eq('id', milestoneId);
        await supabase.from('payment_milestone_disputes').insert({ milestone_id: milestoneId, raised_by: 'customer', reason: notes || 'No reason provided.' });
        await auditLog(supabase, milestoneId, 'milestone_disputed', 'customer', customerId, { status: 'awaiting_customer' }, { status: 'disputed' });
      }

      const { data: updated } = await supabase.from('payment_milestones').select('*').eq('id', milestoneId).single();
      res.status(200).json({ milestone: updated });
      return;
    }

    // ---------------------------------------------------------------
    // ADMIN-RESOLVE — admin action on a disputed (or otherwise escalated)
    // milestone claim.
    // ---------------------------------------------------------------
    if (action === 'admin-resolve') {
      const { milestoneId, adminAction, adminNotes, actorId } = req.body || {};
      if (!milestoneId || !['approve', 'reject', 'request_evidence', 'return_to_contractor'].includes(adminAction)) {
        res.status(400).json({ error: 'milestoneId and a valid adminAction are required.' });
        return;
      }

      const { data: milestone, error: mErr } = await supabase.from('payment_milestones').select('*').eq('id', milestoneId).maybeSingle();
      if (mErr) throw mErr;
      if (!milestone) { res.status(404).json({ error: 'Milestone not found.' }); return; }

      const statusMap = { approve: 'approved', reject: 'rejected', request_evidence: 'available', return_to_contractor: 'available' };
      const newStatus = statusMap[adminAction];

      await supabase.from('payment_milestones').update({ status: newStatus, updated_at: new Date().toISOString() }).eq('id', milestoneId);

      const { data: openDispute } = await supabase.from('payment_milestone_disputes').select('*')
        .eq('milestone_id', milestoneId).eq('status', 'open').order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (openDispute) {
        await supabase.from('payment_milestone_disputes').update({
          status: adminAction === 'approve' ? 'resolved_approved' : 'resolved_rejected',
          admin_notes: adminNotes || null, resolved_by: actorId || 'admin', resolved_at: new Date().toISOString(),
        }).eq('id', openDispute.id);
      }

      await auditLog(supabase, milestoneId, `admin_${adminAction}`, 'admin', actorId, { status: milestone.status }, { status: newStatus, adminNotes: adminNotes || null });

      const { data: updated } = await supabase.from('payment_milestones').select('*').eq('id', milestoneId).single();
      res.status(200).json({ milestone: updated });
      return;
    }

    res.status(400).json({ error: 'Unknown action.' });
  } catch (err) {
    console.error('milestone error:', err);
    res.status(500).json({ error: 'Could not process this milestone action.' });
  }
};
