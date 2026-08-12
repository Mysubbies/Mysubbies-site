// GET  /api/payment-schedule-admin?type=templates|category-rules|config|versions&jobId=X
// POST /api/payment-schedule-admin
//   { action: 'save-template', template }
//   { action: 'approve-template', templateId, actorId }
//   { action: 'archive-template', templateId, actorId }
//   { action: 'save-category-rule', category, scheduleType, defaultTemplateId, allowJobOverride, actorId }
//   { action: 'save-config', config, actorId }
//   { action: 'build-job-schedule', jobId, milestones, actorId }  -- for the
//       $20,000+ structural / manual_review "pending_admin_schedule" case:
//       an admin builds the remaining schedule for one specific job.
//
// Admin-only by convention, same posture as the rest of this project's
// admin endpoints — no auth gate beyond admin-portal.html's own client-side
// password prompt (see CLAUDE.md).
const { getSupabase } = require('./_lib/clients');
const { validateSchedule, getConfig, computeMilestoneAmounts, ScheduleValidationError } = require('./_lib/paymentSchedule');

module.exports = async (req, res) => {
  const supabase = getSupabase();

  if (req.method === 'GET') {
    try {
      const { type, jobId } = req.query || {};

      if (type === 'templates') {
        const { data, error } = await supabase.from('payment_schedule_templates').select('*').order('schedule_type').order('min_price_cents');
        if (error) throw error;
        res.status(200).json({ templates: data || [] });
        return;
      }
      if (type === 'category-rules') {
        const { data, error } = await supabase.from('category_payment_rules').select('*').order('category');
        if (error) throw error;
        res.status(200).json({ rules: data || [] });
        return;
      }
      if (type === 'config') {
        const config = await getConfig(supabase);
        res.status(200).json({ config });
        return;
      }
      if (type === 'versions' && jobId) {
        const { data: schedule } = await supabase.from('job_payment_schedules').select('id').eq('job_id', jobId).order('version', { ascending: false }).limit(1).maybeSingle();
        if (!schedule) { res.status(200).json({ versions: [] }); return; }
        const { data: versions, error } = await supabase.from('payment_schedule_versions').select('*').eq('job_payment_schedule_id', schedule.id).order('version_number', { ascending: false });
        if (error) throw error;
        res.status(200).json({ versions: versions || [] });
        return;
      }

      res.status(400).json({ error: 'Provide a valid type (templates, category-rules, config, versions).' });
    } catch (err) {
      console.error('payment-schedule-admin GET error:', err);
      res.status(500).json({ error: 'Could not load payment schedule admin data.' });
    }
    return;
  }

  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const { action } = req.body || {};

    if (action === 'save-template') {
      const { template, actorId } = req.body || {};
      if (!template || !template.name || !template.schedule_type || !Array.isArray(template.milestones)) {
        res.status(400).json({ error: 'A template needs a name, schedule_type and milestones array.' }); return;
      }
      // Validate against a representative price (max_price_cents, or a
      // large placeholder if uncapped) — this only checks the percentages/
      // deposit-cap shape of the template itself, not a specific job's
      // dollar amounts (those get computed per-job at resolution time).
      const config = await getConfig(supabase);
      const representativePrice = template.max_price_cents || Math.max(template.min_price_cents, 100000000);
      validateSchedule(template.milestones, representativePrice, config, representativePrice);

      const row = {
        name: template.name, schedule_type: template.schedule_type,
        min_price_cents: template.min_price_cents || 0, max_price_cents: template.max_price_cents || null,
        deposit_pct: template.deposit_pct, milestones: template.milestones,
        is_builtin: !!template.is_builtin,
        status: template.is_builtin ? 'approved' : 'pending_review', // custom templates need explicit approval before use
        created_by: actorId || 'admin',
      };

      let saved;
      if (template.id) {
        const { data: existing } = await supabase.from('payment_schedule_templates').select('version').eq('id', template.id).maybeSingle();
        const { data, error } = await supabase.from('payment_schedule_templates')
          .update({ ...row, version: (existing ? existing.version : 1) + 1, updated_at: new Date().toISOString() })
          .eq('id', template.id).select().single();
        if (error) throw error;
        saved = data;
      } else {
        const { data, error } = await supabase.from('payment_schedule_templates').insert(row).select().single();
        if (error) throw error;
        saved = data;
      }

      await supabase.from('payment_audit_logs').insert({ entity_type: 'payment_schedule_template', entity_id: saved.id, action: 'template_saved', actor_role: 'admin', actor_id: actorId || null, after_state: row });
      res.status(200).json({ template: saved });
      return;
    }

    if (action === 'approve-template' || action === 'archive-template') {
      const { templateId, actorId } = req.body || {};
      if (!templateId) { res.status(400).json({ error: 'templateId is required.' }); return; }
      const newStatus = action === 'approve-template' ? 'approved' : 'archived';
      const { data, error } = await supabase.from('payment_schedule_templates')
        .update({ status: newStatus, approved_by: action === 'approve-template' ? (actorId || 'admin') : undefined, approved_at: action === 'approve-template' ? new Date().toISOString() : undefined, updated_at: new Date().toISOString() })
        .eq('id', templateId).select().single();
      if (error) throw error;
      await supabase.from('payment_audit_logs').insert({ entity_type: 'payment_schedule_template', entity_id: templateId, action, actor_role: 'admin', actor_id: actorId || null, after_state: { status: newStatus } });
      res.status(200).json({ template: data });
      return;
    }

    if (action === 'save-category-rule') {
      const { category, scheduleType, defaultTemplateId, allowJobOverride, actorId } = req.body || {};
      if (!category || !scheduleType) { res.status(400).json({ error: 'category and scheduleType are required.' }); return; }
      const { data, error } = await supabase.from('category_payment_rules')
        .upsert({ category, schedule_type: scheduleType, default_template_id: defaultTemplateId || null, allow_job_override: allowJobOverride !== false, updated_by: actorId || 'admin', updated_at: new Date().toISOString() }, { onConflict: 'category' })
        .select().single();
      if (error) throw error;
      await supabase.from('payment_audit_logs').insert({ entity_type: 'category_payment_rule', entity_id: category, action: 'rule_saved', actor_role: 'admin', actor_id: actorId || null, after_state: data });
      res.status(200).json({ rule: data });
      return;
    }

    if (action === 'save-config') {
      const { config, actorId } = req.body || {};
      if (!config) { res.status(400).json({ error: 'config is required.' }); return; }
      const { data, error } = await supabase.from('payment_schedule_config')
        .update({ ...config, id: true, updated_by: actorId || 'admin', updated_at: new Date().toISOString() })
        .eq('id', true).select().single();
      if (error) throw error;
      await supabase.from('payment_audit_logs').insert({ entity_type: 'payment_schedule_config', entity_id: 'singleton', action: 'config_saved', actor_role: 'admin', actor_id: actorId || null, after_state: data });
      res.status(200).json({ config: data });
      return;
    }

    if (action === 'build-job-schedule') {
      // For a job stuck in 'pending_admin_schedule' (a $20,000+ structural
      // job, or any manual_review category) — an admin builds and approves
      // a project-specific schedule covering the REMAINING balance (the
      // deposit milestone, already paid, is left untouched and excluded
      // from these new milestones).
      const { jobId, milestones, actorId } = req.body || {};
      if (!jobId || !Array.isArray(milestones) || milestones.length === 0) { res.status(400).json({ error: 'jobId and a non-empty milestones array are required.' }); return; }

      const { data: schedule, error: schedErr } = await supabase.from('job_payment_schedules').select('*').eq('job_id', jobId).order('version', { ascending: false }).limit(1).maybeSingle();
      if (schedErr) throw schedErr;
      if (!schedule) { res.status(404).json({ error: 'No schedule found for this job.' }); return; }
      if (schedule.status !== 'pending_admin_schedule') { res.status(409).json({ error: 'This job is not waiting on an admin-built schedule.' }); return; }

      const { data: existingMilestones } = await supabase.from('payment_milestones').select('amount_cents').eq('job_payment_schedule_id', schedule.id);
      const depositPaidCents = (existingMilestones || []).reduce((s, m) => s + m.amount_cents, 0);
      const remainingCents = schedule.revised_total_price_cents - depositPaidCents;

      const config = await getConfig(supabase);
      // These new milestones must sum to 100% of the REMAINING balance —
      // validateSchedule checks against remainingCents, not the full
      // contract price, since the deposit is a separate, already-locked
      // milestone outside this set.
      const withAmounts = validateSchedule(milestones, remainingCents, config, schedule.revised_total_price_cents);

      const nextIndex = (existingMilestones || []).length;
      const newRows = withAmounts.map((m, idx) => ({
        job_payment_schedule_id: schedule.id, milestone_index: nextIndex + idx,
        key: m.key, label: m.label, pct: m.pct, amount_cents: m.amount_cents,
        milestone_type: m.milestone_type || 'custom',
        requires_evidence_type: m.requires_evidence_type || 'photos',
        requires_customer_approval: m.requires_customer_approval !== false,
        review_period_hours: m.review_period_hours || 72,
        auto_capture_enabled: !!m.auto_capture_enabled,
        status: idx === 0 ? 'available' : 'locked',
      }));
      const { error: insertErr } = await supabase.from('payment_milestones').insert(newRows);
      if (insertErr) throw insertErr;

      const { data: updatedSchedule, error: updateErr } = await supabase.from('job_payment_schedules')
        .update({ status: 'pending_customer_acceptance', schedule_type: 'custom', updated_at: new Date().toISOString() })
        .eq('id', schedule.id).select().single();
      if (updateErr) throw updateErr;

      await supabase.from('payment_audit_logs').insert({ entity_type: 'job_payment_schedule', entity_id: schedule.id, action: 'admin_built_job_schedule', actor_role: 'admin', actor_id: actorId || null, after_state: { milestoneCount: newRows.length } });
      res.status(200).json({ schedule: updatedSchedule, milestones: newRows });
      return;
    }

    res.status(400).json({ error: 'Unknown action.' });
  } catch (err) {
    if (err instanceof ScheduleValidationError) { res.status(422).json({ error: err.message }); return; }
    console.error('payment-schedule-admin POST error:', err);
    res.status(500).json({ error: 'Could not save payment schedule settings.' });
  }
};
