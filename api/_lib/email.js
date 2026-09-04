// Shared Resend email helper for the /api functions. Files under api/_lib
// are not routable endpoints (Vercel convention) — this is just shared code.
//
// Uses Resend's plain REST API via fetch rather than their SDK, so no new
// npm dependency is needed. Every call is fire-and-forget from the caller's
// side (never blocks or fails the underlying job/payment/application flow —
// a missing or bounced confirmation email should never be the reason a
// booking, payment, or approval fails).
//
// FROM_EMAIL defaults to Resend's own shared test domain, which sends
// without needing a verified sending domain first. Once a real domain
// (e.g. notifications@mysubbies.com.au) is verified in the Resend
// dashboard, set RESEND_FROM_EMAIL in Vercel to switch over — no code
// change needed.
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'MySubbies <onboarding@resend.dev>';

async function sendEmail({ to, subject, html }) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY not set — skipping email:', subject);
    return;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: FROM_EMAIL, to, subject, html }),
    });
    if (!res.ok) {
      console.error('Resend send failed:', res.status, await res.text());
    }
  } catch (err) {
    console.error('Resend send error:', err);
  }
}

// Sep 2026 redesign -- the old wrapper was plain black-header text-only,
// visually flat next to the rest of the product (every portal uses the
// real navy/gold brand colors — see mysubbies-website.html's :root vars).
// Same navy (#14213D) used everywhere else in this codebase (PDF
// letterheads, portal headers), a card-on-paper layout instead of a flat
// bordered box, and a real CTA button instead of a bare text link.
function wrapEmail(bodyHtml) {
  return `
    <div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;background:#F7F7F5;padding:28px 12px;">
      <div style="background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 14px rgba(20,33,61,0.08);">
        <div style="background:#14213D;padding:26px 28px;">
          <span style="color:#fff;font-size:21px;font-weight:800;letter-spacing:-0.02em;">My<span style="color:#F5A623;">Subbies</span></span>
        </div>
        <div style="padding:28px;color:#151A26;font-size:14px;line-height:1.55;">
          ${bodyHtml}
        </div>
      </div>
      <p style="font-size:11px;color:#9CA3AF;text-align:center;margin:18px 0 0;">Mysubbies Holdings Pty Ltd · ABN 69 693 675 268 · Melbourne, VIC</p>
    </div>`;
}

// Escapes user-supplied strings (job notes, business names, message text
// etc.) before they're interpolated into email HTML -- same rule CLAUDE.md
// documents for the client-side portals' innerHTML rendering, just
// server-side here since this file builds HTML outside a browser. Shared
// by every /api file that builds an email body from user input.
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// A clean label/value table for job details (category, quantity, urgency,
// address, access notes, etc.) -- used by the richer notification emails
// (new job available, booking confirmed, job assigned) so a contractor or
// customer gets real substance at a glance instead of one line of prose.
// Rows with no value are dropped rather than shown blank.
function emailDetailsTable(rows) {
  const shown = (rows || []).filter(r => r && r.value != null && r.value !== '');
  if (!shown.length) return '';
  return `<table role="presentation" style="width:100%;border-collapse:collapse;margin:16px 0;background:#F7F7F5;border-radius:10px;overflow:hidden;">
    ${shown.map(r => `
      <tr>
        <td style="padding:10px 14px;font-size:12px;color:#6B7280;font-weight:600;white-space:nowrap;vertical-align:top;">${escapeHtml(r.label)}</td>
        <td style="padding:10px 14px;font-size:13px;color:#151A26;">${r.value}</td>
      </tr>`).join('')}
  </table>`;
}

function emailButton(text, url) {
  return `<a href="${url}" style="display:inline-block;background:#14213D;color:#fff;text-decoration:none;padding:12px 24px;border-radius:999px;font-size:13px;font-weight:700;margin-top:4px;">${escapeHtml(text)}</a>`;
}

// dataUrl is a client-resized JPEG thumbnail (see resizeImageDataUrl() in
// mysubbies-booking.html), never the customer's full-resolution upload --
// embedding a multi-MB raw photo inline as base64 in an email sent to
// potentially many contractors at once is exactly the kind of unbounded
// payload growth this project already hit once with rate-card photos (see
// api/rate-card.js's header comment) -- keep it small at the source
// instead of trying to cap it here.
function emailPhoto(dataUrl) {
  if (!dataUrl) return '';
  return `<img src="${dataUrl}" alt="Job photo" style="width:100%;max-width:300px;border-radius:12px;margin:4px 0 14px;display:block;" />`;
}

module.exports = { sendEmail, wrapEmail, escapeHtml, emailDetailsTable, emailButton, emailPhoto };
