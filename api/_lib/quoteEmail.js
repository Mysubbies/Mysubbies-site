const { escapeHtml } = require('./email');

function money(cents) {
  return '$' + (Number(cents || 0) / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function absoluteUrl(value, secureQuoteUrl) {
  try { return new URL(value, secureQuoteUrl).toString(); }
  catch (e) { return ''; }
}

function serviceUrl(service, secureQuoteUrl) {
  const target = absoluteUrl((service.destination && service.destination.page) || 'mysubbies-website.html#categories', secureQuoteUrl);
  if (!target) return '';
  const url = new URL(target);
  url.searchParams.set('service', service.category);
  return url.toString();
}

function recommendationCell(service, secureQuoteUrl) {
  const image = absoluteUrl(service.image, secureQuoteUrl);
  const destination = serviceUrl(service, secureQuoteUrl);
  const price = service.startingPriceDollars == null
    ? 'Get an estimate'
    : `From $${Number(service.startingPriceDollars).toLocaleString('en-AU')}`;
  return `<td class="recommendation-column" width="33.33%" valign="top" style="padding:0 5px 10px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #E7E7E4;border-radius:12px;background:#FFFFFF;overflow:hidden;">
      <tr><td><img src="${escapeHtml(image)}" width="170" alt="${escapeHtml(service.displayName)}" style="display:block;width:100%;height:105px;object-fit:cover;border:0;" /></td></tr>
      <tr><td style="padding:13px 13px 15px;">
        <div style="font-size:14px;line-height:20px;font-weight:700;color:#14213D;">${escapeHtml(service.displayName)}</div>
        <div style="font-size:12px;line-height:18px;color:#6B7280;margin-top:3px;">${escapeHtml(price)}</div>
        <a href="${escapeHtml(destination)}" style="display:inline-block;margin-top:9px;color:#D84F09;text-decoration:none;font-size:12px;line-height:18px;font-weight:700;">Explore service →</a>
      </td></tr>
    </table>
  </td>`;
}

function itemAmount(item, fallbackTotal, itemCount) {
  if (item.lineTotalCents != null) return Number(item.lineTotalCents);
  if (item.line_total_cents != null) return Number(item.line_total_cents);
  const unitPrice = item.unitPriceCents != null ? item.unitPriceCents : item.unit_price_cents;
  if (unitPrice != null) return Math.round((Number(item.qty) > 0 ? Number(item.qty) : 1) * Number(unitPrice));
  return itemCount === 1 ? Number(fallbackTotal || 0) : 0;
}

function quoteItemsTable(version) {
  const items = Array.isArray(version.line_items) ? version.line_items : [];
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
  return `<div style="margin-top:17px;font-size:12px;color:#6B7280;font-weight:700;text-transform:uppercase;letter-spacing:.04em;">Itemised quote</div>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:7px;border-collapse:collapse;">
      <thead><tr>
        <th scope="col" align="left" style="padding:0 8px 7px 0;font-size:10px;line-height:15px;color:#6B7280;text-transform:uppercase;letter-spacing:.04em;">Description</th>
        <th scope="col" align="left" style="padding:0 6px 7px;font-size:10px;line-height:15px;color:#6B7280;text-transform:uppercase;letter-spacing:.04em;">Qty</th>
        <th scope="col" align="right" style="padding:0 0 7px 8px;font-size:10px;line-height:15px;color:#6B7280;text-transform:uppercase;letter-spacing:.04em;">Price</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderQuoteEmail({ quote, version, secureQuoteUrl, recommendations = [], sourceCategory }) {
  const customer = version.customer_snapshot || {};
  const property = version.property_snapshot || {};
  const firstName = String(customer.name || '').trim().split(/\s+/)[0] || 'there';
  const service = sourceCategory || ((version.line_items || [])[0] && version.line_items[0].description) || 'your property project';
  const place = property.suburb ? ` in ${property.suburb}` : '';
  const itemsTable = quoteItemsTable(version);
  const total = Number(version.total_inc_gst_cents || 0);
  const gst = version.gst_cents != null ? Number(version.gst_cents) : Math.round(total / 11);
  const subtotal = version.subtotal_ex_gst_cents != null ? Number(version.subtotal_ex_gst_cents) : total - gst;
  const base = absoluteUrl('/', secureQuoteUrl);
  const portalUrl = absoluteUrl('mysubbies-customer-portal.html', base);
  const privacyUrl = absoluteUrl('mysubbies-privacy-policy.html', base);
  const termsUrl = absoluteUrl('mysubbies-terms.html', base);
  const cards = recommendations.slice(0, 3).map(item => recommendationCell(item, secureQuoteUrl)).join('');

  return `<!doctype html><html lang="en" dir="ltr"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your MySubbies quote is ready (Quote #${escapeHtml(quote.quote_number)})</title><style>
    .primary-button:hover,.primary-button:active{background:#E6BF00!important}
    @media only screen and (max-width:600px){.email-shell{width:100%!important}.email-pad{padding-left:20px!important;padding-right:20px!important}.recommendation-column{display:block!important;width:100%!important}.primary-button{display:block!important;text-align:center!important}.trust-item{display:block!important;padding:4px 0!important}}
  </style></head><body style="margin:0;padding:0;background:#F3F4F6;font-family:Arial,'Helvetica Neue',sans-serif;color:#151A26;">
  <table role="presentation" lang="en" dir="ltr" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F4F6;"><tr><td align="center" style="padding:24px 10px;">
    <table role="presentation" class="email-shell" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#FFFFFF;border-radius:16px;overflow:hidden;">
      <tr><td class="email-pad" style="background:#14213D;padding:25px 30px;"><div style="font-size:23px;font-weight:800;color:#FFFFFF;">My<span style="color:#F5A623;">Subbies</span></div></td></tr>
      <tr><td class="email-pad" style="padding:30px 34px 18px;">
        <p style="margin:0 0 15px;font-size:15px;line-height:23px;">Hi ${escapeHtml(firstName)},</p>
        <h1 style="margin:0 0 10px;color:#14213D;font-size:26px;line-height:33px;">Your quote is ready</h1>
        <p style="margin:0;color:#4B5563;font-size:14px;line-height:22px;">We've prepared your MySubbies quote for <strong>${escapeHtml(service)}</strong>${escapeHtml(place)}.</p>
      </td></tr>
      <tr><td class="email-pad" style="padding:8px 34px 22px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F7F7F5;border:1px solid #E7E7E4;border-radius:12px;">
          <tr><td style="padding:19px 20px;">
            <div style="font-size:12px;color:#6B7280;font-weight:700;text-transform:uppercase;letter-spacing:.04em;">Quote #${escapeHtml(quote.quote_number)}</div>
            <div style="margin-top:6px;font-size:12px;color:#6B7280;">Prepared for ${escapeHtml(customer.name || customer.email || 'Customer')}</div>
            ${itemsTable}
            ${version.scope_text ? `<div style="margin-top:14px;font-size:12px;color:#6B7280;font-weight:700;text-transform:uppercase;letter-spacing:.04em;">Scope</div><div style="margin-top:5px;font-size:13px;line-height:20px;color:#14213D;">${escapeHtml(version.scope_text).replace(/\r\n?|\n/g, '<br>')}</div>` : ''}
            ${version.inclusions_text ? `<div style="margin-top:14px;font-size:12px;color:#6B7280;font-weight:700;text-transform:uppercase;letter-spacing:.04em;">Inclusions</div><div style="margin-top:5px;font-size:13px;line-height:20px;color:#14213D;">${escapeHtml(version.inclusions_text).replace(/\r\n?|\n/g, '<br>')}</div>` : ''}
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;">
              <tr><td style="padding:3px 0;font-size:12px;color:#6B7280;">Subtotal (ex. GST)</td><td align="right" style="padding:3px 0;font-size:12px;color:#4B5563;">${money(subtotal)}</td></tr>
              <tr><td style="padding:3px 0;font-size:12px;color:#6B7280;">GST (10%)</td><td align="right" style="padding:3px 0;font-size:12px;color:#4B5563;">${money(gst)}</td></tr>
              <tr><td style="padding:9px 0 2px;border-top:1px solid #D7D9DD;font-size:14px;font-weight:800;color:#14213D;">Total (inc. GST)</td><td align="right" style="padding:9px 0 2px;border-top:1px solid #D7D9DD;font-size:20px;line-height:25px;font-weight:800;color:#14213D;">${money(total)}</td></tr>
            </table>
            <div style="margin-top:5px;font-size:12px;color:#6B7280;">Valid until: ${version.expires_at ? new Date(version.expires_at).toLocaleDateString('en-AU') : 'See quote'}</div>
          </td></tr>
        </table>
        <a class="primary-button" href="${escapeHtml(secureQuoteUrl)}" style="display:inline-block;margin-top:20px;background:#FFD400;color:#111111;text-decoration:none;border-radius:999px;padding:14px 24px;font-size:14px;font-weight:800;">View your quote →</a>
        <p style="margin:12px 0 0;color:#6B7280;font-size:12px;line-height:19px;">Review the full scope, inclusions, pricing and terms securely online.</p>
      </td></tr>
      <tr><td class="email-pad" style="padding:4px 34px 25px;"><table role="presentation" width="100%"><tr style="font-size:11px;color:#4B5563;"><td class="trust-item">✓ Vetted professionals</td><td class="trust-item">✓ Upfront pricing</td><td class="trust-item">✓ Secure payments</td><td class="trust-item">✓ Australian support</td></tr></table></td></tr>
      ${cards ? `<tr><td class="email-pad" style="border-top:1px solid #E7E7E4;padding:27px 29px 23px;"><h2 style="margin:0;color:#14213D;font-size:19px;line-height:26px;">Something else planned for your property?</h2><p style="margin:6px 5px 16px 0;color:#6B7280;font-size:13px;line-height:20px;">While you're getting this job sorted, here are a few other services MySubbies can help with.</p><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${cards}</tr></table></td></tr>` : ''}
      <tr><td class="email-pad" style="background:#14213D;padding:25px 34px;"><h2 style="margin:0;color:#FFFFFF;font-size:19px;line-height:26px;">Everything for your property, in one place.</h2><p style="margin:7px 0 16px;color:#CBD2DF;font-size:13px;line-height:20px;">Manage your quotes, bookings, payments, receipts and messages with MySubbies.</p><a href="${escapeHtml(portalUrl)}" style="display:inline-block;background:#FF6A1A;color:#14213D;text-decoration:none;border-radius:999px;padding:12px 20px;font-size:13px;font-weight:800;">Open MySubbies →</a></td></tr>
      <tr><td class="email-pad" style="padding:23px 34px 28px;color:#6B7280;font-size:11px;line-height:18px;"><p style="margin:0 0 9px;"><strong>A PDF copy is attached</strong> for your records. The online quote link above is the current version to use for questions and acceptance.</p><p style="margin:0 0 14px;">Questions? Simply reply to this email or use <strong>Ask a question</strong> on your quote.</p><div>MySubbies Holdings Pty Ltd<br>ABN 69 693 675 268<br>PO Box 1126, Craigieburn VIC 3064</div><p style="margin:13px 0 0;"><a href="${escapeHtml(privacyUrl)}" style="color:#6B7280;">Privacy Policy</a> &nbsp;·&nbsp; <a href="${escapeHtml(termsUrl)}" style="color:#6B7280;">Terms</a></p></td></tr>
    </table>
  </td></tr></table></body></html>`;
}

module.exports = { absoluteUrl, serviceUrl, renderQuoteEmail };
