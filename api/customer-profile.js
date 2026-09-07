// GET  /api/customer-profile?email=X
//   -> { hiddenJobIds: [...] } read from customers.preferences jsonb.
// POST /api/customer-profile
//   { email, accessToken, hiddenJobIds }
//     -> self-service write of the customer's own preferences. Ungated
//        read matches this project's existing posture for a portal reading
//        its own logged-in user's data; a WRITE gets a real check --
//        accessToken is the Supabase Auth session token the customer's
//        browser already holds from login (sb.auth.getSession()), verified
//        server-side via supabase.auth.getUser(accessToken) and
//        cross-checked against customers.auth_user_id for that email, same
//        pattern as api/contractor-profile.js.
//
// Sep 2026: first field stored here is hiddenJobIds -- the customer-portal
// equivalent of the contractor-portal "Remove cancelled job" list, which
// was localStorage-only and reappeared on any other device/browser or
// after site data was cleared. See supabase/schema_v18_customer_preferences.sql
// for the customers.preferences column this reads/writes.
const { getSupabase } = require('./_lib/clients');

async function verifyCustomerAuth(supabase, email, accessToken) {
  if (!accessToken) return { ok: false, error: 'Not signed in.' };
  const { data: userData, error: userErr } = await supabase.auth.getUser(accessToken);
  if (userErr || !userData || !userData.user) return { ok: false, error: 'Session expired — please log in again.' };
  const { data: customer, error: cErr } = await supabase
    .from('customers').select('id, auth_user_id, email').eq('email', String(email).toLowerCase()).maybeSingle();
  if (cErr) throw cErr;
  if (!customer) return { ok: false, error: 'No customer account found for that email.' };
  if (!customer.auth_user_id || customer.auth_user_id !== userData.user.id) {
    return { ok: false, error: 'You can only edit your own profile.' };
  }
  return { ok: true, customer };
}

module.exports = async (req, res) => {
  const supabase = getSupabase();

  if (req.method === 'GET') {
    try {
      const { email } = req.query || {};
      if (!email) { res.status(400).json({ error: 'email is required.' }); return; }
      const { data: customer, error } = await supabase
        .from('customers').select('preferences').eq('email', String(email).toLowerCase()).maybeSingle();
      if (error) throw error;
      if (!customer) { res.status(404).json({ error: 'No customer account found for that email.' }); return; }
      const prefs = customer.preferences || {};
      res.status(200).json({
        hiddenJobIds: Array.isArray(prefs.hiddenJobIds) ? prefs.hiddenJobIds : [],
      });
    } catch (err) {
      console.error('customer-profile GET error:', err);
      res.status(500).json({ error: 'Could not load profile.' });
    }
    return;
  }

  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const body = req.body || {};
    const { email, accessToken } = body;
    if (!email) { res.status(400).json({ error: 'email is required.' }); return; }

    const auth = await verifyCustomerAuth(supabase, email, accessToken);
    if (!auth.ok) { res.status(401).json({ error: auth.error }); return; }

    const { data: currentRow } = await supabase.from('customers').select('preferences').eq('id', auth.customer.id).maybeSingle();
    const mergedPrefs = { ...(currentRow && currentRow.preferences) };
    if (Array.isArray(body.hiddenJobIds)) mergedPrefs.hiddenJobIds = body.hiddenJobIds.filter(id => typeof id === 'string');

    const { error: updErr } = await supabase.from('customers')
      .update({ preferences: mergedPrefs }).eq('id', auth.customer.id);
    if (updErr) throw updErr;

    res.status(200).json({ saved: true });
  } catch (err) {
    console.error('customer-profile POST error:', err);
    res.status(500).json({ error: 'Could not save profile.' });
  }
};
