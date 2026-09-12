// GET  /api/activate-contractor?email=...
// POST /api/activate-contractor   Body: { email, accessToken }
//
// Backs the "Founding 100" contractor-signup redesign's (Sep 2026) account
// activation step in mysubbies-contractor-portal.html. That redesign
// removed the password field from mysubbies-contractor-signup.html --
// password creation is deferred to first login instead, so the
// `contractors` row an application creates has no auth_user_id until this
// endpoint runs.
//
// GET checks whether an email is eligible to activate (a real row exists,
// isn't already linked, and its status allows login) -- this has to be a
// real server call, not a client-side Supabase read: `contractors` RLS
// only allows a row's own already-authenticated owner to select it
// (auth.uid() = auth_user_id), so an anonymous pre-login lookup by email
// always returns nothing from the browser's own Supabase client. The
// service-role client here bypasses that, same posture as every other
// /api file touching this table.
//
// POST links a freshly-created Supabase Auth user (from sb.auth.signUp()
// in the "Create your password" form) to that existing business record,
// so the contractor never ends up with two disconnected identities (one
// row with the real application data, one bare Auth user with nothing
// attached). accessToken (the just-created session's own JWT) is verified
// server-side via supabase.auth.getUser() rather than trusting a bare
// email/id pair from the client -- this links a real account, not a read,
// so it needs a genuine identity check.
const { getSupabase } = require('./_lib/clients');
const { tokenHash } = require('./_lib/contractorOnboarding');
const { notifyContractor, CONTRACTOR_PORTAL_URL } = require('./_lib/contractorNotifications');
const { wrapEmail, emailButton } = require('./_lib/email');

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    try {
      const email = String(req.query.email || '').toLowerCase().trim();
      const setupToken = String(req.query.setupToken || '');
      if (!email || !setupToken) { res.status(200).json({ eligible: false }); return; }
      const supabase = getSupabase();
      const { data: contractor, error } = await supabase
        .from('contractors')
        .select('auth_user_id, status, business_name, application_update_token_hash, application_update_token_expires_at')
        .eq('email', email)
        .maybeSingle();
      if (error) throw error;
      const tokenValid = contractor && contractor.application_update_token_hash === tokenHash(setupToken)
        && new Date(contractor.application_update_token_expires_at) > new Date();
      if (!tokenValid || !['approved', 'preferred'].includes(contractor.status)) { res.status(200).json({ eligible: false }); return; }
      res.status(200).json({
        eligible: true,
        activated: !!contractor.auth_user_id,
        status: contractor.status,
        businessName: contractor.business_name,
      });
    } catch (err) {
      console.error('activate-contractor GET error:', err);
      res.status(500).json({ error: 'Could not check activation status.' });
    }
    return;
  }

  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const { email, accessToken, setupToken } = req.body || {};
    if (!email || !accessToken || !setupToken) {
      res.status(400).json({ error: 'Activation credentials are required.' });
      return;
    }

    const supabase = getSupabase();
    const { data: userData, error: userErr } = await supabase.auth.getUser(accessToken);
    if (userErr || !userData || !userData.user) {
      res.status(401).json({ error: 'Could not verify your session — please try logging in again.' });
      return;
    }
    const authedEmail = String(userData.user.email || '').toLowerCase();
    if (authedEmail !== String(email).toLowerCase()) {
      res.status(403).json({ error: 'Session email does not match.' });
      return;
    }

    const { data: contractor, error: findErr } = await supabase
      .from('contractors')
      .select('id, auth_user_id, status, business_name, application_update_token_hash, application_update_token_expires_at')
      .eq('email', authedEmail)
      .maybeSingle();
    if (findErr) throw findErr;
    if (!contractor) {
      res.status(404).json({ error: 'No application found for this email.' });
      return;
    }
    if (!['approved', 'preferred'].includes(contractor.status)) {
      res.status(403).json({ error: 'This application is not approved for activation.' });
      return;
    }
    if (contractor.application_update_token_hash !== tokenHash(setupToken)
      || new Date(contractor.application_update_token_expires_at) <= new Date()) {
      res.status(403).json({ error: 'This activation link is invalid or expired.' });
      return;
    }
    // Already linked to a DIFFERENT auth user would mean something is
    // wrong (stale session, race) -- refuse rather than silently overwrite.
    if (contractor.auth_user_id && contractor.auth_user_id !== userData.user.id) {
      res.status(409).json({ error: 'This account has already been activated.' });
      return;
    }
    if (!contractor.auth_user_id) {
      const { error: updateErr } = await supabase
        .from('contractors')
        .update({ auth_user_id: userData.user.id, application_update_token_hash: null, application_update_token_expires_at: null })
        .eq('id', contractor.id);
      if (updateErr) throw updateErr;
    }

    try {
      await notifyContractor(supabase, { email: authedEmail, eventType: 'contractor-account-activated',
        title: 'Contractor account activated', body: 'Your account is active. Complete your profile and payout bank details, then review suitable job offers.',
        subject: 'Your MySubbies Contractor Portal account is active',
        html: wrapEmail(`<h2 style="margin-top:0;">Your account is active</h2><p>You can now access the Contractor Portal.</p><h3>Next steps</h3><ol><li>Review your contact details, categories and service areas.</li><li>Add payout bank details before your first payment.</li><li>Keep licence and insurance documents current.</li><li>Review each job offer and accept only suitable work.</li></ol>${emailButton('Open Contractor Portal →', CONTRACTOR_PORTAL_URL)}`) });
    } catch (notificationError) { console.error('account activation notification failed:', notificationError); }

    res.status(200).json({ ok: true, status: contractor.status, businessName: contractor.business_name });
  } catch (err) {
    console.error('activate-contractor error:', err);
    res.status(500).json({ error: 'Could not activate your account. Please try again.' });
  }
};
