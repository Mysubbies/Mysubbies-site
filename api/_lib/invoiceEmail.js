const { escapeHtml } = require('./email');

function money(cents) {
  return '$' + (Number(cents || 0) / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function itemAmount(item, fallbackTotal, itemCount) {
  if (item.lineTotalCents != null) return Number(item.lineTotalCents);
  if (item.line_total_cents != null) return Number(item.line_total_cents);
  const unitPrice = item.unitPriceCents != null ? item.unitPriceCents : item.unit_price_cents;
  if (unitPrice != null) return Math.round((Number(item.qty) > 0 ? Number(item.qty) : 1) * Number(unitPrice));
  return itemCount === 1 ? Number(fallbackTotal || 0) : 0;
}

function quoteItemsTable(version) {
  const items = Array.isArray(version && version.line_items) ? version.line_items : [];
  if (!items.length) return '';
  const rows = items.map(item => {
    const qty = Number(item.qty) > 0 ? Number(item.qty) : 1;
    const quantity = `${qty.toLocaleString('en-AU', { maximumFractionDigits: 4 })}${item.unit ? ` ${escapeHtml(item.unit)}` : ''}`;
    const amount = itemAmount(item, version.total_inc_gst_cents, items.length);
    return `<tr>
      <td style="padding:12px 8px 12px 0;border-bottom:1px solid #E7E7E4;font-size:13px;line-height:19px;color:#14213D;">${escapeHtml(item.description || 'Quoted service').replace(/\r\n?|\n/g, '<br>')}</td>
      <td valign="top" style="padding:12px 6px;border-bottom:1px solid #E7E7E4;font-size:12px;line-height:19px;color:#4B5563;white-space:nowrap;">${quantity}</td>
      <td valign="top" align="right" style="padding:12px 0 12px 8px;border-bottom:1px solid #E7E7E4;font-size:13px;line-height:19px;font-weight:700;color:#14213D;white-space:nowrap;">${money(amount)}</td>
    </tr>`;
  }).join('');
  return `<div style="margin-top:17px;font-size:12px;color:#6B7280;font-weight:700;text-transform:uppercase;letter-spacing:.04em;">Accepted quote details</div>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:7px;border-collapse:collapse;">
      <thead><tr>
        <th scope="col" align="left" style="padding:0 8px 7px 0;font-size:10px;line-height:15px;color:#6B7280;text-transform:uppercase;letter-spacing:.04em;">Description</th>
        <th scope="col" align="left" style="padding:0 6px 7px;font-size:10px;line-height:15px;color:#6B7280;text-transform:uppercase;letter-spacing:.04em;">Qty</th>
        <th scope="col" align="right" style="padding:0 0 7px 8px;font-size:10px;line-height:15px;color:#6B7280;text-transform:uppercase;letter-spacing:.04em;">Quote amount</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:10px;">
      <tr><td style="padding:5px 0;font-size:12px;color:#6B7280;">Accepted quote total (inc. GST)</td><td align="right" style="padding:5px 0;font-size:13px;font-weight:800;color:#14213D;">${money(version.total_inc_gst_cents)}</td></tr>
    </table>
    <div style="margin-top:4px;font-size:11px;line-height:17px;color:#6B7280;">Shown for reference only. The amount payable now is the invoice amount below.</div>`;
}

function absoluteUrl(value, secureInvoiceUrl) {
  try { return new URL(value, secureInvoiceUrl).toString(); }
  catch (e) { return ''; }
}

function renderInvoiceEmail({ invoice, quote, version, secureInvoiceUrl }) {
  const customer = invoice.customer_snapshot || {};
  const firstName = String(customer.name || '').trim().split(/\s+/)[0] || 'there';
  const itemsTable = quoteItemsTable(version || {});
  const portalUrl = absoluteUrl('mysubbies-customer-portal.html', secureInvoiceUrl);
  const privacyUrl = absoluteUrl('mysubbies-privacy-policy.html', secureInvoiceUrl);
  const termsUrl = absoluteUrl('mysubbies-terms.html', secureInvoiceUrl);

  return `<!doctype html><html lang="en" dir="ltr"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tax invoice INV-${escapeHtml(invoice.invoice_number)} — MySubbies</title><style>
    .primary-button:hover,.primary-button:active{background:#E6BF00!important}
    @media only screen and (max-width:600px){.email-shell{width:100%!important}.email-pad{padding-left:20px!important;padding-right:20px!important}.primary-button{display:block!important;text-align:center!important}}
  </style></head><body style="margin:0;padding:0;background:#F3F4F6;font-family:Arial,'Helvetica Neue',sans-serif;color:#151A26;">
  <table role="presentation" lang="en" dir="ltr" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F4F6;"><tr><td align="center" style="padding:24px 10px;">
    <table role="presentation" class="email-shell" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#FFFFFF;border-radius:16px;overflow:hidden;">
      <tr><td class="email-pad" style="background:#14213D;padding:25px 30px;"><div style="font-size:23px;font-weight:800;color:#FFFFFF;">My<span style="color:#F5A623;">Subbies</span></div></td></tr>
      <tr><td class="email-pad" style="padding:30px 34px 18px;">
        <p style="margin:0 0 15px;font-size:15px;line-height:23px;">Hi ${escapeHtml(firstName)},</p>
        <h1 style="margin:0 0 10px;color:#14213D;font-size:26px;line-height:33px;">Your tax invoice is ready</h1>
        <p style="margin:0;color:#4B5563;font-size:14px;line-height:22px;">Invoice <strong>INV-${escapeHtml(invoice.invoice_number)}</strong> relates to accepted Quote #${escapeHtml(quote.quote_number)}.</p>
      </td></tr>

      <tr><td class="email-pad" style="padding:8px 34px 22px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F7F7F5;border:1px solid #E7E7E4;border-radius:12px;">
          <tr><td style="padding:19px 20px;">
            <div style="font-size:12px;color:#6B7280;font-weight:700;text-transform:uppercase;letter-spacing:.04em;">Tax invoice INV-${escapeHtml(invoice.invoice_number)}</div>
            <div style="margin-top:6px;font-size:12px;color:#6B7280;">${escapeHtml(invoice.milestone_label)} · Due ${new Date(invoice.due_at).toLocaleDateString('en-AU')}</div>
            ${itemsTable}
            ${version && version.scope_text ? `<div style="margin-top:14px;font-size:12px;color:#6B7280;font-weight:700;text-transform:uppercase;letter-spacing:.04em;">Scope</div><div style="margin-top:5px;font-size:13px;line-height:20px;color:#14213D;">${escapeHtml(version.scope_text).replace(/\r\n?|\n/g, '<br>')}</div>` : ''}
            ${version && version.inclusions_text ? `<div style="margin-top:14px;font-size:12px;color:#6B7280;font-weight:700;text-transform:uppercase;letter-spacing:.04em;">Inclusions</div><div style="margin-top:5px;font-size:13px;line-height:20px;color:#14213D;">${escapeHtml(version.inclusions_text).replace(/\r\n?|\n/g, '<br>')}</div>` : ''}
            <div style="margin-top:18px;padding-top:15px;border-top:1px solid #D7D9DD;">
              <div style="font-size:12px;color:#6B7280;font-weight:700;text-transform:uppercase;letter-spacing:.04em;">Amount due on this invoice</div>
              <div style="margin-top:6px;font-size:28px;line-height:34px;font-weight:800;color:#14213D;">${money(invoice.total_inc_gst_cents)}</div>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;">
                <tr><td style="padding:3px 0;font-size:12px;color:#6B7280;">Subtotal (ex. GST)</td><td align="right" style="padding:3px 0;font-size:12px;color:#4B5563;">${money(invoice.subtotal_ex_gst_cents)}</td></tr>
                <tr><td style="padding:3px 0;font-size:12px;color:#6B7280;">GST (10%)</td><td align="right" style="padding:3px 0;font-size:12px;color:#4B5563;">${money(invoice.gst_cents)}</td></tr>
                <tr><td style="padding:9px 0 2px;border-top:1px solid #D7D9DD;font-size:14px;font-weight:800;color:#14213D;">Total (inc. GST)</td><td align="right" style="padding:9px 0 2px;border-top:1px solid #D7D9DD;font-size:20px;line-height:25px;font-weight:800;color:#14213D;">${money(invoice.total_inc_gst_cents)}</td></tr>
              </table>
            </div>
          </td></tr>
        </table>

        <a class="primary-button" href="${escapeHtml(secureInvoiceUrl)}" style="display:inline-block;margin-top:20px;background:#FFD400;color:#111111;text-decoration:none;border-radius:999px;padding:14px 24px;font-size:14px;font-weight:800;">View invoice &amp; pay securely →</a>
        <p style="margin:12px 0 0;color:#6B7280;font-size:12px;line-height:19px;">The secure invoice includes the full quote details, terms, bank-transfer information and credit/debit card payment through Stripe.</p>
      </td></tr>

      <tr><td class="email-pad" style="padding:4px 34px 25px;"><table role="presentation" width="100%"><tr style="font-size:11px;color:#4B5563;"><td>✓ Secure card payments</td><td>✓ Bank transfer available</td><td>✓ Payment receipts</td><td>✓ Australian support</td></tr></table></td></tr>

      <tr><td class="email-pad" style="background:#14213D;padding:25px 34px;"><h2 style="margin:0;color:#FFFFFF;font-size:19px;line-height:26px;">Manage everything in MySubbies.</h2><p style="margin:7px 0 16px;color:#CBD2DF;font-size:13px;line-height:20px;">View your jobs, quotes, invoices, payments, receipts and messages in one place.</p><a href="${escapeHtml(portalUrl)}" style="display:inline-block;background:#FF6A1A;color:#14213D;text-decoration:none;border-radius:999px;padding:12px 20px;font-size:13px;font-weight:800;">Open MySubbies →</a></td></tr>
      <tr><td class="email-pad" style="padding:23px 34px 28px;color:#6B7280;font-size:11px;line-height:18px;"><p style="margin:0 0 12px;">Questions about this invoice? Reply to this email and quote <strong>INV-${escapeHtml(invoice.invoice_number)}</strong>.</p><div>MySubbies Holdings Pty Ltd<br>ABN 69 693 675 268<br>PO Box 1126, Craigieburn VIC 3064</div><p style="margin:13px 0 0;"><a href="${escapeHtml(privacyUrl)}" style="color:#6B7280;">Privacy Policy</a> &nbsp;·&nbsp; <a href="${escapeHtml(termsUrl)}" style="color:#6B7280;">Terms</a></p></td></tr>
    </table>
  </td></tr></table></body></html>`;
}

module.exports = { renderInvoiceEmail };
