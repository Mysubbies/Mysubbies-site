// Shared admin notification helper. Files under api/_lib are not routable
// endpoints (Vercel convention) -- shared code only.
//
// Extracted from api/support.js (Sep 2026) so api/quotes.js's
// 'ask_question' action can notify admin the exact same way a support
// inquiry already does (a real `notifications` row + an email to
// ADMIN_NOTIFY_EMAIL) instead of duplicating this logic a second time.
// Pure code move -- no behavior change for api/support.js's existing
// disputes/inquiries notifications.
const { getSupabase } = require('./clients');
const { sendEmail, wrapEmail, escapeHtml, emailButton } = require('./email');

const ADMIN_NOTIFY_EMAIL = process.env.ADMIN_NOTIFY_EMAIL || 'accounts@mysubbies.com.au';
const ADMIN_URL = 'https://app.mysubbies.com.au/mysubbies-admin-portal.html';

async function notifyAdmin({ eventType, title, body }) {
  const supabase = getSupabase();
  try {
    await supabase.from('notifications').insert({ recipient_role: 'admin', event_type: eventType, title, body });
  } catch (e) { console.error('notification insert error:', e); }
  try {
    await sendEmail({
      to: ADMIN_NOTIFY_EMAIL, subject: title,
      html: wrapEmail(`<h2 style="margin-top:0;">${escapeHtml(title)}</h2><p>${body}</p>${emailButton('Review in Admin →', ADMIN_URL)}`),
    });
  } catch (e) { console.error('admin notify email error:', e); }
}

module.exports = { notifyAdmin };
