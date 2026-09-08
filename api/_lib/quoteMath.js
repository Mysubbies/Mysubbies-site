// Server-authoritative quote totals (Sep 2026). Files under api/_lib are
// not routable endpoints (Vercel convention) -- shared code only.
//
// Mirrors mysubbies-customer-portal.html's existing gstBreakdown() --
// GST-inclusive, 1/11th method, single flat 10% rate -- the one real tax
// convention already used site-wide (matches "prices shown are GST
// inclusive" on mysubbies-terms.html). This is a server-side port of that
// same math, not a new tax model. Every line item carries its own
// taxTreatment so the shape genuinely supports more than one treatment
// later, but defaults to 'gst_inclusive_10' so existing rate-card tasks
// (which have no tax field at all) never block a quote from being built.
//
// Never trust a client-submitted total: api/quotes.js calls
// computeQuoteTotals() on every draft save and again at issue time,
// discarding whatever the browser sent for lineTotalCents/subtotal/gst.
function computeLineItem(raw) {
  const qty = Number(raw && raw.qty) > 0 ? Number(raw.qty) : 1;
  const unitPriceCents = Math.max(0, Math.round(Number(raw && raw.unitPriceCents) || 0));
  const taxTreatment = (raw && raw.taxTreatment === 'gst_exclusive') ? 'gst_exclusive' : 'gst_inclusive_10';
  const rawLineCents = Math.round(qty * unitPriceCents);

  let exGstCents, gstCents, lineTotalCents;
  if (taxTreatment === 'gst_exclusive') {
    exGstCents = rawLineCents;
    gstCents = Math.round(rawLineCents * 0.10);
    lineTotalCents = exGstCents + gstCents;
  } else {
    lineTotalCents = rawLineCents;
    gstCents = Math.round(lineTotalCents / 11);
    exGstCents = lineTotalCents - gstCents;
  }

  return {
    id: (raw && raw.id) || null,
    rateCardItemId: (raw && raw.rateCardItemId) || null,
    description: String((raw && raw.description) || '').trim(),
    qty,
    unit: (raw && raw.unit) || '',
    unitPriceCents,
    taxTreatment,
    lineTotalCents,
    exGstCents,
    gstCents,
  };
}

// GST is DERIVED from the whole (total - subtotal), never summed per-line,
// so the three headline numbers always reconcile exactly even after
// per-line rounding.
function computeQuoteTotals(rawLineItems) {
  const lineItems = Array.isArray(rawLineItems) ? rawLineItems.map(computeLineItem) : [];
  const totalIncGstCents = lineItems.reduce((s, l) => s + l.lineTotalCents, 0);
  const subtotalExGstCents = lineItems.reduce((s, l) => s + l.exGstCents, 0);
  const gstCents = totalIncGstCents - subtotalExGstCents;
  return { lineItems, subtotalExGstCents, gstCents, totalIncGstCents };
}

module.exports = { computeQuoteTotals };
