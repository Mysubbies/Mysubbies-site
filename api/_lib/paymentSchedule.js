// Shared payment-schedule calculation/validation engine for the /api
// functions. Files under api/_lib are not routable endpoints — this is
// shared code, not an endpoint.
//
// This is the ONLY place a job's payment schedule is ever calculated. A
// client-submitted schedule (percentages, milestone list, deposit amount)
// is never trusted — every endpoint that creates or changes a schedule
// calls resolveScheduleForJob()/validateSchedule() here instead.

class ScheduleValidationError extends Error {
  constructor(message) { super(message); this.name = 'ScheduleValidationError'; }
}

async function getConfig(supabase) {
  const { data, error } = await supabase.from('payment_schedule_config').select('*').eq('id', true).single();
  if (error) throw error;
  return data;
}

async function getCategoryRule(supabase, category) {
  const { data } = await supabase.from('category_payment_rules').select('*').eq('category', category).maybeSingle();
  // No rule configured for this category yet — safest default is
  // manual_review, never silently guessing a schedule type for an
  // unconfigured category.
  return data || { category, schedule_type: 'manual_review', default_template_id: null, allow_job_override: true };
}

// Deposit cap is a hard, non-overridable ceiling — 10% under the high-value
// threshold, 5% at/above it (both dollar figures admin-configurable via
// payment_schedule_config, but the two-tier structure itself is not).
function depositCapPct(config, priceCents) {
  return priceCents >= config.high_value_threshold_cents ? Number(config.deposit_cap_high_pct) : Number(config.deposit_cap_low_pct);
}

// Distributes totalPriceCents across milestones by their pct, rounding each
// to the nearest cent, then puts any rounding remainder onto the LAST
// milestone so the amounts always sum to exactly totalPriceCents — per the
// explicit "one-cent rounding adjustment into the final payment" requirement.
function computeMilestoneAmounts(milestones, totalPriceCents) {
  const amounts = milestones.map(m => Math.round(totalPriceCents * (Number(m.pct) / 100)));
  const sum = amounts.reduce((s, a) => s + a, 0);
  const diff = totalPriceCents - sum;
  amounts[amounts.length - 1] += diff;
  return milestones.map((m, i) => ({ ...m, amount_cents: amounts[i] }));
}

// Hard validation — runs on every template save, every job schedule
// resolution, and every variation-triggered recalculation. Never trust a
// schedule (built-in, custom, or client-submitted) as pre-validated.
function validateSchedule(milestones, totalPriceCents, config, priceCentsForDepositCap) {
  if (!Array.isArray(milestones) || milestones.length === 0) {
    throw new ScheduleValidationError('A payment schedule needs at least one milestone.');
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
  const amountSum = withAmounts.reduce((s, m) => s + m.amount_cents, 0);
  if (amountSum !== totalPriceCents) {
    // Should be unreachable given computeMilestoneAmounts always balances
    // the last milestone, but never silently ship a schedule that doesn't
    // add up to the contract price.
    throw new ScheduleValidationError('Milestone amounts do not sum to the total contract price.');
  }
  return withAmounts;
}

// Resolves the schedule a job should use, from the category's configured
// rule and the built-in/custom template that matches the price bracket.
// Returns { status, schedule_type, template_id, deposit_pct, milestones }
// where milestones already have amount_cents computed. status is either
// 'pending_customer_acceptance' (a real schedule was resolved) or
// 'pending_admin_schedule' (manual_review category, or a structural job at
// or above the high-value threshold — never auto-generate a schedule for
// either of those, per the explicit compliance requirement).
async function resolveScheduleForJob(supabase, category, priceCents) {
  const config = await getConfig(supabase);
  const rule = await getCategoryRule(supabase, category);

  if (rule.schedule_type === 'manual_review') {
    // Deposit-only, same as the $20,000+ structural case below — this is
    // NOT a full 100%-summing schedule (there's deliberately only one
    // milestone here), so computeMilestoneAmounts (which balances a
    // rounding remainder across a full set) must not be used: the
    // deposit's amount is directly cap% of the price, full stop.
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
    if (!rule.default_template_id) throw new ScheduleValidationError(`Category "${category}" is set to a custom schedule but no template is assigned yet — an admin needs to configure this in Payment Schedule Settings.`);
    const { data, error } = await supabase.from('payment_schedule_templates').select('*').eq('id', rule.default_template_id).eq('status', 'approved').maybeSingle();
    if (error) throw error;
    if (!data) throw new ScheduleValidationError(`The custom schedule assigned to "${category}" is not approved yet — an admin needs to approve it before it can be used.`);
    template = data;
  } else {
    const { data, error } = await supabase
      .from('payment_schedule_templates')
      .select('*')
      .eq('schedule_type', rule.schedule_type)
      .eq('status', 'approved')
      .lte('min_price_cents', priceCents)
      .or(`max_price_cents.is.null,max_price_cents.gte.${priceCents}`)
      .order('min_price_cents', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new ScheduleValidationError(`No approved payment schedule template covers a ${rule.schedule_type} job of this value — an admin needs to configure one in Payment Schedule Settings.`);
    template = data;
  }

  // The $20,000+ structural template (and any manual_review-style template
  // an admin builds the same way) is deposit-only by design — a single
  // milestone means the "remaining balance" is deliberately left
  // unscheduled until an admin builds a project-specific plan for this job.
  // Its percentage deliberately does NOT sum to 100% (it's a fragment, not
  // a full schedule), so it must bypass validateSchedule's 100%-sum check
  // and computeMilestoneAmounts' remainder-balancing — both of which are
  // only correct for a schedule that represents the FULL contract.
  const isDepositOnly = template.milestones.length === 1 && template.milestones[0].milestone_type === 'deposit';
  let milestonesWithAmounts;
  if (isDepositOnly) {
    const m = template.milestones[0];
    const cap = depositCapPct(config, priceCents);
    if (Number(m.pct) > cap + 0.01) throw new ScheduleValidationError(`Deposit cannot exceed ${cap}% for a contract of this value.`);
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

// Enforces claim sequencing: milestone N is only claimable once milestone
// N-1 is 'paid', unless the job's schedule has an admin-authorized
// sequence_override. Returns the milestone row that's next claimable, or
// null if none (either everything's paid, or the next one is still
// 'locked' behind an unpaid predecessor).
function nextClaimableMilestone(milestoneRows, sequenceOverride) {
  const sorted = [...milestoneRows].sort((a, b) => a.milestone_index - b.milestone_index);
  for (let i = 0; i < sorted.length; i++) {
    const m = sorted[i];
    if (m.status === 'paid') continue;
    if (i === 0) return m;
    const prev = sorted[i - 1];
    if (prev.status === 'paid' || sequenceOverride) return m;
    return null; // next unpaid milestone is blocked behind an unpaid predecessor
  }
  return null; // everything paid
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
