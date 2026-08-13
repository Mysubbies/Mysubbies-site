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

function wrapEmail(bodyHtml) {
  return `
    <div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#171717;">
      <div style="background:#000;padding:20px;border-radius:12px 12px 0 0;">
        <span style="color:#fff;font-size:18px;font-weight:800;">MySubbies</span>
      </div>
      <div style="border:1px solid #E4E4E1;border-top:none;border-radius:0 0 12px 12px;padding:24px;">
        ${bodyHtml}
      </div>
      <p style="font-size:11px;color:#9C9C97;text-align:center;margin-top:16px;">MySubbies Group · Melbourne, VIC</p>
    </div>`;
}

module.exports = { sendEmail, wrapEmail };
