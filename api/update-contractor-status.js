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
const { sendEmail, wrapEmail } = require('./_lib/email');

const ALLOWED_STATUSES = ['approved', 'preferred', 'watchlist', 'suspended', 'expired_documents', 'manual_review', 'rejected'];

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const { email, status } = req.body || {};
    if (!email || !ALLOWED_STATUSES.includes(status)) {
      res.status(400).json({ error: 'email and a valid status are required.' });
      return;
    }

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('contractors')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('email', String(email).toLowerCase())
      .select('id');
    if (error) throw error;

    if (status === 'approved' || status === 'rejected') {
      try {
        await sendEmail({
          to: email,
          subject: status === 'approved' ? 'Your MySubbies application has been approved' : 'Your MySubbies application update',
          html: wrapEmail(status === 'approved'
            ? `<h2 style="margin-top:0;">You're in!</h2><p>Your contractor application has been approved. You can now log in and start accepting jobs in your approved trade categories.</p><p><a href="https://mysubbies-site.vercel.app/mysubbies-contractor-portal.html">Log in to the Contractor Portal</a></p>`
            : `<h2 style="margin-top:0;">Application update</h2><p>Thanks for applying to join the MySubbies panel. After review, we're not able to approve your application at this time.</p><p>If you think this is a mistake, reply to this email and our team will take another look.</p>`),
        });
      } catch (emailErr) { console.error('application status email failed:', emailErr); }
    }

    res.status(200).json({ updated: (data || []).length });
  } catch (err) {
    console.error('update-contractor-status error:', err);
    res.status(500).json({ error: 'Could not update contractor status.' });
  }
};
