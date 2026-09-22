const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const NAVY = rgb(20 / 255, 33 / 255, 61 / 255);
const ORANGE = rgb(1, 106 / 255, 26 / 255);
const GREY = rgb(92 / 255, 101 / 255, 116 / 255);
const PALE = rgb(247 / 255, 247 / 255, 245 / 255);
const A4 = [595.28, 841.89];
const MARGIN = 42;

function money(cents) {
  return '$' + (Number(cents || 0) / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function date(value) {
  if (!value) return '-';
  return new Date(value).toLocaleDateString('en-AU', { timeZone: 'Australia/Melbourne' });
}

function ascii(value) {
  return String(value == null ? '' : value)
    .replace(/\u2022/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[^\x20-\x7E\n]/g, '');
}

function wrap(text, font, size, width) {
  const result = [];
  ascii(text).split(/\r?\n/).forEach(paragraph => {
    if (!paragraph.trim()) { result.push(''); return; }
    let line = '';
    paragraph.split(/\s+/).forEach(word => {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= width || !line) line = next;
      else { result.push(line); line = word; }
    });
    if (line) result.push(line);
  });
  return result;
}

async function generateQuotePdf({ quote, version }) {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page;
  let y;

  function footer() {
    page.drawLine({ start: { x: MARGIN, y: 28 }, end: { x: A4[0] - MARGIN, y: 28 }, thickness: 0.6, color: rgb(.85, .86, .88) });
    page.drawText('Mysubbies Holdings Pty Ltd  |  ABN 69 693 675 268  |  Not a tax invoice', { x: MARGIN, y: 15, size: 7.5, font: regular, color: GREY });
  }

  function newPage(first = false) {
    if (page) footer();
    page = doc.addPage(A4);
    if (first) {
      page.drawRectangle({ x: 0, y: A4[1] - 105, width: A4[0], height: 105, color: NAVY });
      page.drawText('My', { x: MARGIN, y: A4[1] - 51, size: 24, font: bold, color: rgb(1, 1, 1) });
      page.drawText('Subbies', { x: MARGIN + 31, y: A4[1] - 51, size: 24, font: bold, color: ORANGE });
      page.drawText('PROJECT PROPOSAL', { x: A4[0] - 170, y: A4[1] - 43, size: 12, font: bold, color: rgb(1, 1, 1) });
      page.drawText(`Quote #${ascii(quote.quote_number)}  |  Version ${version.version_number || 1}`, { x: A4[0] - 170, y: A4[1] - 61, size: 8, font: regular, color: rgb(.8, .83, .88) });
      y = A4[1] - 135;
    } else {
      page.drawRectangle({ x: 0, y: A4[1] - 38, width: A4[0], height: 38, color: NAVY });
      page.drawText(`MYSUBBIES  |  QUOTE #${ascii(quote.quote_number)}`, { x: MARGIN, y: A4[1] - 25, size: 10, font: bold, color: rgb(1, 1, 1) });
      y = A4[1] - 65;
    }
  }

  function ensure(height) { if (y - height < 42) newPage(false); }
  function textBlock(text, opts = {}) {
    const size = opts.size || 9;
    const font = opts.bold ? bold : regular;
    const lines = wrap(text, font, size, opts.width || (A4[0] - MARGIN * 2));
    const leading = opts.leading || size * 1.35;
    ensure(lines.length * leading + 4);
    lines.forEach(line => { if (line) page.drawText(line, { x: opts.x || MARGIN, y, size, font, color: opts.color || GREY }); y -= leading; });
    return lines.length;
  }
  function heading(label) {
    ensure(28);
    y -= 8;
    page.drawRectangle({ x: MARGIN, y: y + 8, width: 15, height: 3, color: ORANGE });
    page.drawText(label, { x: MARGIN, y: y - 3, size: 12, font: bold, color: NAVY });
    y -= 22;
  }

  newPage(true);
  const customer = version.customer_snapshot || {};
  const property = version.property_snapshot || {};
  page.drawText('PREPARED FOR', { x: MARGIN, y, size: 8, font: bold, color: GREY });
  page.drawText('ISSUED', { x: 382, y, size: 8, font: bold, color: GREY });
  y -= 17;
  page.drawText(ascii(customer.name || customer.email || 'Customer'), { x: MARGIN, y, size: 12, font: bold, color: NAVY });
  page.drawText(date(version.issued_at), { x: 382, y, size: 10, font: regular, color: NAVY });
  page.drawText('VALID UNTIL', { x: 470, y: y + 17, size: 8, font: bold, color: GREY });
  page.drawText(date(version.expires_at), { x: 470, y, size: 10, font: regular, color: NAVY });
  y -= 15;
  [property.address, [property.suburb, property.postcode].filter(Boolean).join(' '), customer.email, customer.phone].filter(Boolean).forEach(line => { page.drawText(ascii(line), { x: MARGIN, y, size: 8.5, font: regular, color: GREY }); y -= 12; });
  y -= 14;

  heading('Quote items');
  for (const item of version.line_items || []) {
    const qty = Number(item.qty) > 0 ? Number(item.qty) : 1;
    const amount = item.lineTotalCents != null ? item.lineTotalCents : Math.round(qty * Number(item.unitPriceCents || item.unit_price_cents || 0));
    const lines = wrap(item.description || 'Quoted service', regular, 9, 330);
    const rowHeight = Math.max(36, lines.length * 12 + 16);
    ensure(rowHeight);
    page.drawRectangle({ x: MARGIN, y: y - rowHeight + 8, width: A4[0] - MARGIN * 2, height: rowHeight, color: PALE });
    let rowY = y - 7;
    lines.forEach((line, index) => { page.drawText(line, { x: MARGIN + 10, y: rowY, size: 9, font: index === 0 ? bold : regular, color: index === 0 ? NAVY : GREY }); rowY -= 12; });
    page.drawText(`${qty} ${ascii(item.unit || '')}`, { x: 395, y: y - 7, size: 8.5, font: regular, color: GREY });
    page.drawText(money(amount), { x: 485, y: y - 7, size: 9, font: bold, color: NAVY });
    y -= rowHeight + 6;
  }

  ensure(78);
  const total = Number(version.total_inc_gst_cents || 0);
  const gst = Number(version.gst_cents || Math.round(total / 11));
  const ex = Number(version.subtotal_ex_gst_cents || total - gst);
  page.drawRectangle({ x: 360, y: y - 65, width: 193, height: 68, color: NAVY });
  [['Subtotal ex. GST', money(ex)], ['GST', money(gst)]].forEach(([label, value], index) => {
    page.drawText(label, { x: 373, y: y - 16 - index * 17, size: 8, font: regular, color: rgb(.78, .82, .88) });
    page.drawText(value, { x: 486, y: y - 16 - index * 17, size: 8.5, font: bold, color: rgb(1, 1, 1) });
  });
  page.drawText('TOTAL INC GST', { x: 373, y: y - 53, size: 9, font: bold, color: rgb(1, 1, 1) });
  page.drawText(money(total), { x: 474, y: y - 54, size: 12, font: bold, color: rgb(1, 1, 1) });
  y -= 85;

  const sections = [
    ['Scope of Works', version.scope_text],
    ['Inclusions', version.inclusions_text],
    ['Exclusions', version.exclusions_text],
    ['Payment Schedule', version.payment_terms_text],
    ['Terms / Important Information', version.terms_text],
  ];
  sections.forEach(([label, body]) => { if (body) { heading(label); textBlock(body); y -= 6; } });
  heading('Online review & acceptance');
  textBlock('The secure link in your email is the current online copy of this quote. Use it to review, ask a question, and accept the proposal.');
  footer();
  const pages = doc.getPages();
  pages.forEach((p, index) => p.drawText(`Page ${index + 1} of ${pages.length}`, { x: A4[0] - 83, y: 15, size: 7.5, font: regular, color: GREY }));
  return Buffer.from(await doc.save());
}

module.exports = { generateQuotePdf };
