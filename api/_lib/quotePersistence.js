function paymentScheduleNote(text) {
  if (text == null || text === '') return null;
  return { text: String(text) };
}

function paymentTermsFromVersion(version) {
  const note = version && version.payment_schedule_note;
  if (typeof note === 'string') return note;
  if (note && typeof note.text === 'string') return note.text;
  // Read-only compatibility for environments that previously applied v20.
  // Persistence intentionally targets the v19 column deployed today.
  return version && typeof version.payment_terms_text === 'string' ? version.payment_terms_text : '';
}

function quoteVersionContent(body, totals, existing) {
  const prior = existing || {};
  const has = key => Object.prototype.hasOwnProperty.call(body, key);
  return {
    property_snapshot: has('propertySnapshot') ? body.propertySnapshot : (prior.property_snapshot || null),
    line_items: totals.lineItems,
    subtotal_ex_gst_cents: totals.subtotalExGstCents,
    gst_cents: totals.gstCents,
    total_inc_gst_cents: totals.totalIncGstCents,
    scope_text: has('scopeText') ? (body.scopeText || null) : (prior.scope_text || null),
    inclusions_text: has('inclusionsText') ? (body.inclusionsText || null) : (prior.inclusions_text || null),
    exclusions_text: has('exclusionsText') ? (body.exclusionsText || null) : (prior.exclusions_text || null),
    payment_schedule_note: has('paymentTermsText')
      ? paymentScheduleNote(body.paymentTermsText)
      : (prior.payment_schedule_note || paymentScheduleNote(paymentTermsFromVersion(prior))),
    validity_days: body.validityDays || prior.validity_days || 30,
  };
}

module.exports = { paymentScheduleNote, paymentTermsFromVersion, quoteVersionContent };
