function cleanLabel(value) {
  return String(value || '').replace(/^[-–—,:;\s]+|[-–—,:;\s]+$/g, '').replace(/\s+/g, ' ').slice(0, 120);
}

// Quote schedules are historically free text. Extract only explicit percentages;
// the admin still reviews/edits the stage before an invoice can be created.
function milestoneOptions(paymentTermsText, totalCents) {
  const text = String(paymentTermsText || '');
  const matches = [];
  const re = /(?:^|[\n,;])\s*([^\n,;]*?)\s*(\d+(?:\.\d+)?)\s*%\s*([^\n,;]*)/g;
  let match;
  while ((match = re.exec(text))) {
    const pct = Number(match[2]);
    if (!(pct > 0 && pct <= 100)) continue;
    const before = cleanLabel(match[1]);
    const after = cleanLabel(match[3]);
    matches.push({
      key: `stage_${matches.length + 1}`,
      label: before || after || `Payment milestone ${matches.length + 1}`,
      percentage: pct,
      amountCents: Math.round(Number(totalCents || 0) * pct / 100),
    });
  }
  return matches;
}

function validateInvoiceAmount({ amountCents, quoteTotalCents, previouslyInvoicedCents }) {
  const amount = Number(amountCents);
  if (!Number.isInteger(amount) || amount <= 0) return 'Invoice amount must be greater than $0.00.';
  if (amount > Number(quoteTotalCents || 0)) return 'Invoice amount cannot exceed the accepted quote total.';
  if (amount + Number(previouslyInvoicedCents || 0) > Number(quoteTotalCents || 0)) {
    return 'This invoice would exceed the accepted quote total after earlier invoices.';
  }
  return null;
}

function gstBreakdown(totalIncGstCents) {
  const total = Number(totalIncGstCents || 0);
  const gst = Math.round(total / 11);
  return { totalIncGstCents: total, gstCents: gst, subtotalExGstCents: total - gst };
}

module.exports = { milestoneOptions, validateInvoiceAmount, gstBreakdown };
