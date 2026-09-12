// POST /api/update-contractor-status
// Body: { email, status }
//
// Mirrors an admin's approve/reject decision (made against the local
// application record in mysubbies-admin-portal.html) into the real
// `contractors` table, so a contractor logging in from a device that's
// never touched this browser's localStorage still gets a correct answer
// instead of the "can't confirm your status here" fallback message in
// contractor-portal.html's doLogin().
//
// Matches by email rather than auth_user_id because the admin portal only
// ever knows the applicant's email — it has no session/auth context for
// them. If no contractors row exists yet for that email (e.g. an
// application submitted before the real-auth migration, whose contractor
// has never logged in since), this is a harmless no-op: the row gets
// created with the correct status the next time they do log in, via
// contractor-portal.html's own lazy-migration signUp path.
const { getSupabase } = require('./_lib/clients');
const { requireAdmin } = require('./_lib/adminAuth');
const { approvedEmail, rejectedEmail, applicationToken, tokenHash } = require('./_lib/contractorOnboarding');
const { notifyAdmin, notifyContractor } = require('./_lib/contractorNotifications');

const ALLOWED_STATUSES = ['approved', 'preferred', 'watchlist', 'suspended', 'expired_documents', 'manual_review', 'rejected'];

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  if (!requireAdmin(req, res)) return;

  try {
    const { email, status, reason } = req.body || {};
    if (!email || !ALLOWED_STATUSES.includes(status)) {
      res.status(400).json({ error: 'email and a valid status are required.' });
      return;
    }
    if (['rejected', 'manual_review'].includes(status) && !String(reason || '').trim()) {
      res.status(400).json({ error: 'A clear reason is required for rejection or more information.' });
      return;
    }

    const supabase = getSupabase();
    const { data: current, error: findError } = await supabase.from('contractors')
      .select('id, email, business_name, categories, full_application').eq('email', String(email).toLowerCase()).maybeSingle();
    if (findError) throw findError;
    if (!current) { res.status(404).json({ error: 'Contractor application not found.' }); return; }
    const updateToken = applicationToken();
    const expiry = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    const fullApplication = { ...(current.full_application || {}), status,
      ...(reason ? { reviewNotes: String(reason).trim() } : {}) };
    const { data, error } = await supabase
      .from('contractors')
      .update({ status, full_application: fullApplication, application_review_notes: reason || null,
        application_update_token_hash: tokenHash(updateToken), application_update_token_expires_at: expiry,
        updated_at: new Date().toISOString() })
      .eq('email', String(email).toLowerCase())
      .select('id, email, business_name, categories, full_application');
    if (error) throw error;

    let emailDelivery = 'not_applicable';
    if ((status === 'approved' || status === 'rejected' || status === 'manual_review') && data && data[0]) {
      const message = status === 'approved' ? approvedEmail(data[0], updateToken) : rejectedEmail(reason, status === 'manual_review', data[0], updateToken);
      const eventType = status === 'approved' ? 'contractor-application-approved'
        : status === 'rejected' ? 'contractor-application-rejected' : 'contractor-more-information-required';
      const title = status === 'approved' ? 'Application approved'
        : status === 'rejected' ? 'Application not approved' : 'More information required';
      const notificationBody = status === 'approved'
        ? 'Your contractor application is approved. Use the secure link in your email to activate your account.'
        : String(reason).trim();
      const delivery = await notifyContractor(supabase, { email, eventType, title, body: notificationBody,
        subject: message.subject, html: message.html, applicationRef: data[0].full_application && data[0].full_application.id });
      emailDelivery = delivery.ok ? 'sent' : 'failed';
      await notifyAdmin(supabase, { eventType: `contractor-application-${status}`,
        title: `Contractor application ${status === 'manual_review' ? 'awaiting contractor response' : status}`,
        body: `${data[0].business_name} was updated to ${status}.`,
        applicationRef: data[0].full_application && data[0].full_application.id });
    }

    res.status(200).json({ updated: (data || []).length, emailDelivery });
  } catch (err) {
    console.error('update-contractor-status error:', err);
    res.status(500).json({ error: 'Could not update contractor status.' });
  }
};
