// POST /api/customer-register
// Creates or links the authenticated Supabase user to exactly one customer
// profile. The browser supplies its access token; email/user identity always
// comes from Supabase Auth, never from request fields.
const { getSupabase } = require('./_lib/clients');
const { bearerToken } = require('./_lib/userAuth');

function clean(value) { return String(value || '').trim(); }

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const supabase = getSupabase();
    const token = bearerToken(req);
    if (!token) { res.status(401).json({ error: 'Authentication required.' }); return; }
    const { data: authData, error: authError } = await supabase.auth.getUser(token);
    const user = authData && authData.user;
    if (authError || !user || !user.email) { res.status(401).json({ error: 'Session expired — please log in again.' }); return; }

    const email = user.email.toLowerCase();
    const firstName = clean(req.body && req.body.firstName);
    const lastName = clean(req.body && req.body.lastName);
    const phone = clean(req.body && req.body.phone);
    const metadata = user.user_metadata || {};
    const name = clean(`${firstName || metadata.first_name || ''} ${lastName || metadata.last_name || ''}`);
    const resolvedPhone = phone || clean(metadata.phone);
    if (!name || !resolvedPhone) { res.status(400).json({ error: 'First name, last name and mobile are required.' }); return; }

    const { data: linked, error: linkedError } = await supabase.from('customers')
      .select('id, auth_user_id, email, name, phone').eq('auth_user_id', user.id).maybeSingle();
    if (linkedError) throw linkedError;
    if (linked) {
      const { data, error } = await supabase.from('customers').update({ name, phone: resolvedPhone })
        .eq('id', linked.id).select('id, email, name, phone').single();
      if (error) throw error;
      res.status(200).json({ customer: data, linked: true }); return;
    }

    const { data: emailProfile, error: emailError } = await supabase.from('customers')
      .select('id, auth_user_id, email, name, phone').eq('email', email).maybeSingle();
    if (emailError) throw emailError;
    if (emailProfile) {
      if (emailProfile.auth_user_id && emailProfile.auth_user_id !== user.id) {
        res.status(409).json({ error: 'This customer profile is already linked to another login.' }); return;
      }
      const { data, error } = await supabase.from('customers')
        .update({ auth_user_id: user.id, name: name || emailProfile.name, phone: resolvedPhone || emailProfile.phone })
        .eq('id', emailProfile.id).is('auth_user_id', null).select('id, email, name, phone').single();
      if (error) throw error;
      res.status(200).json({ customer: data, linked: true }); return;
    }

    // A mobile number alone is not proof that two email identities are the
    // same person. Refuse the ambiguous merge rather than expose or take over
    // another customer's booking history.
    const { data: phoneProfiles, error: phoneError } = await supabase.from('customers')
      .select('id, email').eq('phone', resolvedPhone).limit(1);
    if (phoneError) throw phoneError;
    if (phoneProfiles && phoneProfiles.length) {
      res.status(409).json({ error: 'A customer profile already uses this mobile with a different email. Please contact support.' }); return;
    }

    const { data: created, error: createError } = await supabase.from('customers')
      .insert({ auth_user_id: user.id, email, name, phone: resolvedPhone }).select('id, email, name, phone').single();
    if (createError) throw createError;
    res.status(201).json({ customer: created, linked: true });
  } catch (error) {
    console.error('customer-register error:', error);
    res.status(500).json({ error: 'Could not link the customer profile.' });
  }
};
