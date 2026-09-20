const { wrapEmail, escapeHtml, emailButton } = require('./email');

function money(cents) { return `$${(Number(cents || 0) / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }

function renderInvoiceEmail({ invoice, quote, secureInvoiceUrl }) {
  const customer = invoice.customer_snapshot || {};
  return wrapEmail(`
    <p style="margin:0 0 8px;color:#6B7280;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;">Tax invoice INV-${escapeHtml(invoice.invoice_number)}</p>
    <h1 style="font-size:24px;line-height:1.2;margin:0 0 14px;color:#14213D;">${escapeHtml(invoice.milestone_label)}</h1>
    <p>Hi ${escapeHtml(customer.name || 'there')},</p>
    <p>Your MySubbies tax invoice for Quote #${escapeHtml(quote.quote_number)} is ready.</p>
    <div style="background:#F7F7F5;border-radius:12px;padding:16px;margin:18px 0;">
      <div style="font-size:12px;color:#6B7280;">Amount due</div>
      <div style="font-size:26px;font-weight:800;color:#14213D;">${money(invoice.total_inc_gst_cents)}</div>
      <div style="font-size:12px;color:#6B7280;margin-top:4px;">Due ${new Date(invoice.due_at).toLocaleDateString('en-AU')}</div>
    </div>
    ${emailButton('View & download tax invoice →', secureInvoiceUrl)}
    <p style="font-size:12px;color:#6B7280;margin-top:20px;">Payment instructions and the MySubbies Holdings Pty Ltd bank account are shown on the secure invoice.</p>
  `);
}

module.exports = { renderInvoiceEmail };
