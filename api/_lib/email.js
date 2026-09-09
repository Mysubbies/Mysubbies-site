// Shared Resend email helper for the /api functions. Files under api/_lib
// are not routable endpoints (Vercel convention) — this is just shared code.
//
// Uses Resend's plain REST API via fetch rather than their SDK, so no new
// npm dependency is needed. Every call is fire-and-forget from the caller's
// side (never blocks or fails the underlying job/payment/application flow —
// a missing or bounced confirmation email should never be the reason a
// booking, payment, or approval fails).
//
// FROM_EMAIL defaults to the MySubbies domain. That domain/address must be
// verified in Resend; RESEND_FROM_EMAIL can select another verified sender.
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'MySubbies <notifications@mysubbies.com.au>';

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
// Sep 2026: sendEmail() above is deliberately fire-and-forget (never
// throws, never reports failure) because every OTHER caller in this
// codebase is a background notification that must never block a booking/
// payment/approval just because an email bounced. Quote delivery is
// different -- the founder reported an "Issue & email" that silently
// didn't reach the customer, and the admin genuinely needs to know when a
// send failed rather than seeing a false "success". This mirrors
// sendEmail() exactly but returns the real outcome instead of only
// logging it -- used by api/quotes.js's send_quote_email action, nothing
// else needs to change.
async function sendEmailWithResult({ to, subject, html }) {
  if (!process.env.RESEND_API_KEY) {
    return { ok: false, error: 'Email sending is not configured yet (RESEND_API_KEY is not set in Vercel).' };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM_EMAIL, to, subject, html }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let providerCode = '';
      try { providerCode = JSON.parse(text).name || ''; } catch (e) { /* not JSON */ }
      // Never copy the provider response into logs or the browser. It can
      // include recipient/sender details and is not part of our public API.
      console.error('Resend send failed:', { status: res.status, code: providerCode || 'unknown' });
      const configurationError = res.status === 401 || res.status === 403 ||
        ['validation_error', 'restricted_api_key', 'invalid_api_key'].includes(providerCode);
      return {
        ok: false,
        status: res.status,
        code: configurationError ? 'email_configuration_error' : 'email_provider_rejected',
        error: configurationError
          ? 'Email delivery is not configured for this sender. Verify RESEND_API_KEY, the Resend sending domain, and RESEND_FROM_EMAIL in this Vercel environment.'
          : `The email provider rejected this send (status ${res.status}).`,
      };
    }
    return { ok: true };
  } catch (err) {
    console.error('Resend send error:', err);
    return { ok: false, error: 'Could not reach the email provider — check your connection and try again.' };
  }
}

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

module.exports = { sendEmail, sendEmailWithResult, wrapEmail, escapeHtml, emailDetailsTable, emailButton, emailPhoto };
