// GET  /api/contractor-profile?email=X
//   -> merged profile: real `contractors` columns (business_name, abn, acn,
//      phone, categories, average_rating) plus the contact/licence/insurer/
//      profilePhoto fields that only ever landed in `full_application` jsonb
//      at signup (see sync-applications.js) -- nothing before this endpoint
//      ever read that jsonb back out for the contractor's own portal to
//      display, only admin's Applications tab did.
// POST /api/contractor-profile
//   { email, accessToken, phone?, businessName?, licence?, insurer?, profilePhoto? }
//     -> self-service edit of the contractor's own details. Ungated reads
//        match this project's existing posture for a portal reading its own
//        logged-in user's data (e.g. GET /api/admin-messages?contractorEmail=),
//        but a WRITE that touches PII gets a real check: accessToken is the
//        Supabase Auth session token the contractor's browser already holds
//        from login (sb.auth.getSession()), verified server-side via
//        supabase.auth.getUser(accessToken) and cross-checked against
//        contractors.auth_user_id for that email -- no new auth system
//        needed, this just uses the real session that already exists.
//   { action:'changeEmail', email, accessToken, newEmail }
//     -> separate branch: updates Supabase Auth's own user record AND
//        contractors.email together in one request. These are two
//        independent copies today with nothing keeping them in sync --
//        this is the one place that changes both, so they can't drift.
const { getSupabase } = require('./_lib/clients');

async function verifyContractorAuth(supabase, email, accessToken) {
  if (!accessToken) return { ok: false, error: 'Not signed in.' };
  const { data: userData, error: userErr } = await supabase.auth.getUser(accessToken);
  if (userErr || !userData || !userData.user) return { ok: false, error: 'Session expired — please log in again.' };
  const { data: contractor, error: cErr } = await supabase
    .from('contractors').select('id, auth_user_id, email').eq('email', String(email).toLowerCase()).maybeSingle();
  if (cErr) throw cErr;
  if (!contractor) return { ok: false, error: 'No contractor account found for that email.' };
  if (!contractor.auth_user_id || contractor.auth_user_id !== userData.user.id) {
    return { ok: false, error: 'You can only edit your own profile.' };
  }
  return { ok: true, contractor, authUserId: userData.user.id };
}

module.exports = async (req, res) => {
  const supabase = getSupabase();

  if (req.method === 'GET') {
    try {
      const { email } = req.query || {};
      if (!email) { res.status(400).json({ error: 'email is required.' }); return; }
      const { data: contractor, error } = await supabase
        .from('contractors')
        .select('business_name, abn, acn, phone, email, categories, average_rating, full_application')
        .eq('email', String(email).toLowerCase()).maybeSingle();
      if (error) throw error;
      if (!contractor) { res.status(404).json({ error: 'No contractor account found for that email.' }); return; }
      const app = contractor.full_application || {};
      res.status(200).json({
        businessName: contractor.business_name,
        abn: contractor.abn, acn: contractor.acn,
        phone: contractor.phone || app.phone || '',
        email: contractor.email,
        categories: contractor.categories || [],
        averageRating: contractor.average_rating,
        contactName: app.contact || '',
        licence: app.licence || '',
        insurer: app.insurer || '',
        profilePhoto: app.profilePhoto || null,
      });
    } catch (err) {
      console.error('contractor-profile GET error:', err);
      res.status(500).json({ error: 'Could not load profile.' });
    }
    return;
  }

  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const body = req.body || {};
    const { email, accessToken } = body;
    if (!email) { res.status(400).json({ error: 'email is required.' }); return; }

    const auth = await verifyContractorAuth(supabase, email, accessToken);
    if (!auth.ok) { res.status(401).json({ error: auth.error }); return; }

    if (body.action === 'changeEmail') {
      const newEmail = String(body.newEmail || '').trim().toLowerCase();
      if (!newEmail || !newEmail.includes('@')) { res.status(400).json({ error: 'Enter a valid new email address.' }); return; }
      const { data: clash } = await supabase.from('contractors').select('id').eq('email', newEmail).maybeSingle();
      if (clash) { res.status(409).json({ error: 'That email is already in use.' }); return; }

      const { error: authErr } = await supabase.auth.admin.updateUserById(auth.authUserId, { email: newEmail });
      if (authErr) throw authErr;
      const { error: updErr } = await supabase.from('contractors')
        .update({ email: newEmail, updated_at: new Date().toISOString() }).eq('id', auth.contractor.id);
      if (updErr) throw updErr;

      res.status(200).json({ email: newEmail });
      return;
    }

    // Plain field edit. Columns that exist on `contractors` update there;
    // contact/licence/insurer/profilePhoto only ever lived in
    // full_application jsonb (see sync-applications.js), so those merge
    // into that same object rather than needing new columns.
    const columnUpdate = { updated_at: new Date().toISOString() };
    if (typeof body.phone === 'string') columnUpdate.phone = body.phone.trim();
    if (typeof body.businessName === 'string' && body.businessName.trim()) columnUpdate.business_name = body.businessName.trim();

    const { data: currentRow } = await supabase.from('contractors').select('full_application').eq('id', auth.contractor.id).maybeSingle();
    const mergedApp = { ...(currentRow && currentRow.full_application) };
    if (typeof body.contactName === 'string') mergedApp.contact = body.contactName.trim();
    if (typeof body.licence === 'string') mergedApp.licence = body.licence.trim();
    if (typeof body.insurer === 'string') mergedApp.insurer = body.insurer.trim();
    if (typeof body.profilePhoto === 'string') mergedApp.profilePhoto = body.profilePhoto;
    columnUpdate.full_application = mergedApp;

    const { error: updErr } = await supabase.from('contractors').update(columnUpdate).eq('id', auth.contractor.id);
    if (updErr) throw updErr;

    res.status(200).json({ saved: true });
  } catch (err) {
    console.error('contractor-profile POST error:', err);
    res.status(500).json({ error: 'Could not save profile.' });
  }
};
