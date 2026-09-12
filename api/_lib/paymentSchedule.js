// Shared payment-schedule calculation/validation engine for the /api functions.
// The authoritative source remains server-side. Category rules/templates are
// preferred when configured; otherwise the existing paymentSchedule stored in
// the authoritative platform rate card is used unchanged.

class ScheduleValidationError extends Error {
  constructor(message) { super(message); this.name = 'ScheduleValidationError'; }
}

async function getConfig(supabase) {
  const { data, error } = await supabase.from('payment_schedule_config').select('*').eq('id', true).single();
  if (error) throw error;
  return data;
}

function normaliseRateCardMilestones(schedule) {
  if (!Array.isArray(schedule) || !schedule.length) return null;
  return schedule.map((m, index) => {
    const rawKey = String(m.key || m.milestone_type || m.label || `stage_${index + 1}`).trim();
    const key = rawKey.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || `stage_${index + 1}`;
    const label = String(m.label || m.name || rawKey || `Stage ${index + 1}`).trim();
    const pct = Number(m.pct != null ? m.pct : m.percentage);
    const lower = `${key} ${label}`.toLowerCase();
    let milestoneType = m.milestone_type || null;
    if (!milestoneType) {
      if (lower.includes('deposit') || lower.includes('booking')) milestoneType = 'deposit';
      else if (lower.includes('material') || lower.includes('deliver')) milestoneType = 'materials';
      else if (lower.includes('frame') || lower.includes('start')) milestoneType = 'progress';
      else if (lower.includes('complete') || lower.includes('final')) milestoneType = 'completion';
      else milestoneType = 'progress';
    }
    return {
      key,
      label,
      pct,
      milestone_type: milestoneType,
      requires_evidence_type: m.requires_evidence_type || (milestoneType === 'materials' ? 'delivery_docket' : milestoneType === 'deposit' ? 'none' : 'photo'),
      requires_customer_approval: m.requires_customer_approval != null ? !!m.requires_customer_approval : milestoneType !== 'deposit',
      review_period_hours: Number(m.review_period_hours || 72),
      auto_capture_enabled: !!m.auto_capture_enabled,
    };
  });
}

async function getCategoryRule(supabase, category) {
  const { data, error } = await supabase.from('category_payment_rules').select('*').eq('category', category).maybeSingle();
  if (error) throw error;
  if (data) return data;

  // Preserve the payment schedule that already exists in the rate card.
  // This avoids silently converting normal home-service bookings to the
  // deposit-only manual-review fallback when category_payment_rules has not
  // been separately configured for that category.
  const { data: rateCard, error: rateError } = await supabase
    .from('platform_rate_card').select('categories').eq('id', true).maybeSingle();
  if (rateError) throw rateError;
  const cat = rateCard && Array.isArray(rateCard.categories)
    ? rateCard.categories.find(c => c && !c.deleted && c.label === category)
    : null;
  const inlineMilestones = normaliseRateCardMilestones(cat && cat.paymentSchedule);
  if (inlineMilestones) {
    return {
      category,
      schedule_type: 'ratecard_inline',
      default_template_id: null,
      allow_job_override: false,
      inline_milestones: inlineMilestones,
    };
  }

  return { category, schedule_type: 'manual_review', default_template_id: null, allow_job_override: true };
}

function depositCapPct(config, priceCents) {
  return priceCents >= config.high_value_threshold_cents
    ? Number(config.deposit_cap_high_pct)
    : Number(config.deposit_cap_low_pct);
}

function computeMilestoneAmounts(milestones, totalPriceCents) {
  const amounts = milestones.map(m => Math.round(totalPriceCents * (Number(m.pct) / 100)));
  const sum = amounts.reduce((s, a) => s + a, 0);
  amounts[amounts.length - 1] += totalPriceCents - sum;
  return milestones.map((m, i) => ({ ...m, amount_cents: amounts[i] }));
}

function validateSchedule(milestones, totalPriceCents, config, priceCentsForDepositCap) {
  if (!Array.isArray(milestones) || milestones.length === 0) {
    throw new ScheduleValidationError('A payment schedule needs at least one milestone.');
  }
  for (const m of milestones) {
    if (!Number.isFinite(Number(m.pct)) || Number(m.pct) <= 0) {
      throw new ScheduleValidationError('Every payment milestone needs a valid percentage.');
    }
  }
  const pctSum = milestones.reduce((s, m) => s + Number(m.pct), 0);
  if (Math.round(pctSum * 100) !== 10000) {
    throw new ScheduleValidationError(`Milestone percentages must total exactly 100% (currently ${pctSum.toFixed(2)}%).`);
  }
  const depositMilestone = milestones.find(m => m.milestone_type === 'deposit');
  if (depositMilestone) {
    const cap = depositCapPct(config, priceCentsForDepositCap);
    if (Number(depositMilestone.pct) > cap + 0.01) {
      throw new ScheduleValidationError(`Deposit cannot exceed ${cap}% for a contract of this value (currently ${depositMilestone.pct}%).`);
    }
  }
  const withAmounts = computeMilestoneAmounts(milestones, totalPriceCents);
  if (withAmounts.reduce((s, m) => s + m.amount_cents, 0) !== totalPriceCents) {
    throw new ScheduleValidationError('Milestone amounts do not sum to the total contract price.');
  }
  return withAmounts;
}

async function resolveScheduleForJob(supabase, category, priceCents) {
  const config = await getConfig(supabase);
  const rule = await getCategoryRule(supabase, category);

  // Existing rate-card milestones are authoritative for categories that do
  // not have a separate category_payment_rules override. This is the normal
  // path for the schedules already configured in the MySubbies rate card.
  if (rule.schedule_type === 'ratecard_inline') {
    const milestones = validateSchedule(rule.inline_milestones, priceCents, config, priceCents);
    const deposit = milestones.find(m => m.milestone_type === 'deposit') || milestones[0];
    return {
      status: 'pending_customer_acceptance',
      schedule_type: 'ratecard_inline',
      template_id: null,
      deposit_pct: Number(deposit.pct),
      milestones,
    };
  }

  if (rule.schedule_type === 'manual_review') {
    const cap = depositCapPct(config, priceCents);
    const depositMilestone = {
      key: 'deposit', label: 'Booking Deposit', pct: cap, milestone_type: 'deposit',
      requires_evidence_type: 'none', requires_customer_approval: false,
      review_period_hours: 72, auto_capture_enabled: false,
      amount_cents: Math.round(priceCents * (cap / 100)),
    };
    return {
      status: 'pending_admin_schedule',
      schedule_type: 'manual_review',
      template_id: null,
      deposit_pct: cap,
      milestones: [depositMilestone],
    };
  }

  let template;
  if (rule.schedule_type === 'custom') {
    if (!rule.default_template_id) {
      throw new ScheduleValidationError(`Category "${category}" is set to a custom schedule but no template is assigned yet — an admin needs to configure this in Payment Schedule Settings.`);
    }
    const { data, error } = await supabase.from('payment_schedule_templates')
      .select('*').eq('id', rule.default_template_id).eq('status', 'approved').maybeSingle();
    if (error) throw error;
    if (!data) {
      throw new ScheduleValidationError(`The custom schedule assigned to "${category}" is not approved yet — an admin needs to approve it before it can be used.`);
    }
    template = data;
  } else {
    const { data, error } = await supabase.from('payment_schedule_templates')
      .select('*')
      .eq('schedule_type', rule.schedule_type)
      .eq('status', 'approved')
      .lte('min_price_cents', priceCents)
      .or(`max_price_cents.is.null,max_price_cents.gte.${priceCents}`)
      .order('min_price_cents', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      throw new ScheduleValidationError(`No approved payment schedule template covers a ${rule.schedule_type} job of this value — an admin needs to configure one in Payment Schedule Settings.`);
    }
    template = data;
  }

  const isDepositOnly = template.milestones.length === 1 && template.milestones[0].milestone_type === 'deposit';
  let milestonesWithAmounts;
  if (isDepositOnly) {
    const m = template.milestones[0];
    const cap = depositCapPct(config, priceCents);
    if (Number(m.pct) > cap + 0.01) {
      throw new ScheduleValidationError(`Deposit cannot exceed ${cap}% for a contract of this value.`);
    }
    milestonesWithAmounts = [{ ...m, amount_cents: Math.round(priceCents * (Number(m.pct) / 100)) }];
  } else {
    milestonesWithAmounts = validateSchedule(template.milestones, priceCents, config, priceCents);
  }

  return {
    status: isDepositOnly ? 'pending_admin_schedule' : 'pending_customer_acceptance',
    schedule_type: template.schedule_type,
    template_id: template.id,
    deposit_pct: Number(template.deposit_pct),
    milestones: milestonesWithAmounts,
  };
}

function nextClaimableMilestone(milestoneRows, sequenceOverride) {
  const sorted = [...milestoneRows].sort((a, b) => a.milestone_index - b.milestone_index);
  for (let i = 0; i < sorted.length; i++) {
    const m = sorted[i];
    if (m.status === 'paid') continue;
    if (i === 0) return m;
    const prev = sorted[i - 1];
    if (prev.status === 'paid' || sequenceOverride) return m;
    return null;
  }
  return null;
}

module.exports = {
  ScheduleValidationError,
  getConfig,
  getCategoryRule,
  depositCapPct,
  computeMilestoneAmounts,
  validateSchedule,
  resolveScheduleForJob,
  nextClaimableMilestone,
};
