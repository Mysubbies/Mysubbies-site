const { resolveScheduleForJob } = require('./paymentSchedule');

class QuoteConversionError extends Error {
  constructor(message, statusCode) { super(message); this.name = 'QuoteConversionError'; this.statusCode = statusCode || 400; }
}

function deterministicJobId(quoteId) {
  return `quote_${String(quoteId)}`;
}

async function convertAcceptedQuoteToJob(supabase, quoteId) {
  if (!quoteId) throw new QuoteConversionError('quoteId is required.', 400);
  const { data: quote, error: quoteError } = await supabase.from('quotes').select('*').eq('id', quoteId).maybeSingle();
  if (quoteError) throw quoteError;
  if (!quote) throw new QuoteConversionError('Quote not found.', 404);
  if (quote.job_id) {
    const { data: linkedJob } = await supabase.from('jobs').select('*').eq('id', quote.job_id).maybeSingle();
    return { quote, job: linkedJob, alreadyConverted: true };
  }
  if (quote.current_status !== 'accepted') throw new QuoteConversionError('Only an accepted quote can be converted to a job.', 409);

  const { data: version, error: versionError } = await supabase.from('quote_versions').select('*')
    .eq('id', quote.current_version_id).maybeSingle();
  if (versionError) throw versionError;
  if (!version || version.status !== 'accepted' || version.quote_id !== quote.id) {
    throw new QuoteConversionError('The current accepted quote version could not be verified.', 409);
  }
  const totalCents = Number(version.total_inc_gst_cents);
  if (!Number.isSafeInteger(totalCents) || totalCents < 1) throw new QuoteConversionError('The accepted quote total is invalid.', 422);

  const category = 'Quoted Project';
  // An accepted free-text quote is not treated as acceptance of a structured
  // payment schedule. The existing resolver safely puts this unconfigured
  // category into manual review and applies the existing deposit cap policy.
  const resolved = await resolveScheduleForJob(supabase, category, totalCents);
  const deposit = resolved.milestones.find(m => m.milestone_type === 'deposit') || resolved.milestones[0];
  const jobId = deterministicJobId(quote.id);
  const customer = version.customer_snapshot || {};
  const property = version.property_snapshot || {};
  const record = {
    id: jobId, category, suburb: property.suburb || null, address: property.address || '',
    customerName: customer.name || null, customerPhone: customer.phone || null,
    customerEmail: customer.email || null, contractor: null, contractorEmail: null,
    items: version.line_items || [], basePrice: totalCents / 100,
    priceLow: totalCents / 100, priceHigh: totalCents / 100, status: 'feed',
    paidStages: {}, messages: [], internalMessages: [], createdAt: new Date().toISOString(),
    sourceQuote: { quoteId: quote.id, quoteNumber: quote.quote_number, quoteVersionId: version.id, versionNumber: version.version_number },
  };
  const insert = {
    id: jobId, category, suburb: property.suburb || null, address: property.address || null,
    customer_id: quote.customer_id, customer_email: customer.email || null,
    contractor_email: null, base_price_cents: totalCents,
    deposit_pct: resolved.deposit_pct, deposit_amount_cents: deposit.amount_cents,
    status: 'pending_deposit', stage: 'submitted', source: 'browse', full_record: record,
  };
  let { data: job, error: insertError } = await supabase.from('jobs').insert(insert).select().single();
  if (insertError) {
    // Deterministic ID makes simultaneous/retried conversion idempotent.
    const existing = await supabase.from('jobs').select('*').eq('id', jobId).maybeSingle();
    if (!existing.data) throw insertError;
    job = existing.data;
  }
  const { error: linkError } = await supabase.from('quotes').update({ job_id: jobId, updated_at: new Date().toISOString() })
    .eq('id', quote.id).is('job_id', null);
  if (linkError) throw linkError;
  return { quote: { ...quote, job_id: jobId }, version, job, alreadyConverted: !!insertError };
}

module.exports = { QuoteConversionError, deterministicJobId, convertAcceptedQuoteToJob };
