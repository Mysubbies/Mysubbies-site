// POST /api/admin-account
// Body: { action: 'login', password } -- OR --
//       { role: 'customer'|'contractor', email, action: 'deactivate'|'reactivate'|'delete' }
//       { role: 'customer', customerId, action: 'updateProfile', name, phone, newEmail }
//       { role: 'contractor', contractorId, action: 'updateProfile', business, contact, phone, address, addressLocation }
//
// 'login' issues the admin session token (see api/_lib/adminAuth.js) that
// every other action here, and every other admin-only endpoint, requires
// via an Authorization: Bearer header. Kept in this file rather than a new
// top-level /api file since this project already sits at the edge of
// Vercel's Hobby-plan function-count cap (see CLAUDE.md).
//
// deactivate/reactivate just flip a status column that the account's own
// login flow already checks (customers.status -- see schema_v4 -- and
// contractors.status, which already had 'suspended'/'approved'). No
// Supabase Auth banning involved: this mirrors the exact pattern
// contractor-portal.html's doLogin() already uses, so it works regardless
// of whether the account signs in via a real Supabase Auth session or the
// local-cache self-heal fallback both portals fall back to.
//
// delete is a real, permanent removal -- of both the table row and the
// Supabase Auth user -- but only when there's no job history to lose.
// Every FK in this schema pointing at customers/contractors is unspecified
// (= Postgres default NO ACTION), so a delete would simply fail once a
// customer/contractor has a job, address, rating, or offer on record. We
// check for that explicitly first and refuse with a clear message rather
// than let it fail confusingly, or silently strip identifying info out of
// financial/job records that need to stay intact for the audit trail.
const { getSupabase } = require('./_lib/clients');
const { requireAdmin, verifyPassword, signAdminToken, adminSessionCookie, clearAdminSessionCookie } = require('./_lib/adminAuth');
const { MAX_FAILURES, countRecentFailures, recordFailure, clearFailures } = require('./_lib/adminLoginSecurity');
const { notifyAdmin, notifyContractor, CONTRACTOR_PORTAL_URL } = require('./_lib/contractorNotifications');
const { wrapEmail, emailButton, escapeHtml } = require('./_lib/email');

const ROLES = { customer: 'customers', contractor: 'contractors' };

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  res.setHeader('Cache-Control', 'no-store');

  try {
    const { role, email, action, password, reason, customerId, contractorId, name, phone, newEmail,
      business, contact, address, addressLocation } = req.body || {};

    if (action === 'login') {
      const supabase = getSupabase();
      const failures = await countRecentFailures(supabase, req);
      if (failures >= MAX_FAILURES) {
        res.setHeader('Retry-After', '900');
        res.status(429).json({ error: 'Too many login attempts. Try again in 15 minutes.' });
        return;
      }
      if (!verifyPassword(password)) {
        await recordFailure(supabase, req);
        res.status(401).json({ error: 'Incorrect password.' });
        return;
      }
      await clearFailures(supabase, req);
      const token = signAdminToken();
      res.setHeader('Set-Cookie', adminSessionCookie(token));
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'session') {
      if (!requireAdmin(req, res)) return;
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'logout') {
      if (!requireAdmin(req, res)) return;
      res.setHeader('Set-Cookie', clearAdminSessionCookie());
      res.status(200).json({ ok: true });
      return;
    }

    if (!requireAdmin(req, res)) return;

    const supabase = getSupabase();

    if (role === 'customer' && action === 'updateProfile') {
      const cleanId = String(customerId || '').trim();
      const cleanName = String(name || '').trim();
      const cleanPhone = String(phone || '').trim();
      const cleanEmail = String(newEmail || '').trim().toLowerCase();
      const location = addressLocation && typeof addressLocation === 'object' ? addressLocation : null;
      const latitude = location ? Number(location.latitude) : null;
      const longitude = location ? Number(location.longitude) : null;
      const validCoordinates = location && Number.isFinite(latitude) && latitude >= -44.5 && latitude <= -9 &&
        Number.isFinite(longitude) && longitude >= 112 && longitude <= 154;
      if (!cleanId || !cleanName || cleanName.length > 120 || cleanPhone.length > 30 ||
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
        res.status(400).json({ error: 'A valid customer, name, phone and email are required.' }); return;
      }
      if (location && !(location.verified === true && String(location.placeId || '').trim() && validCoordinates)) {
        res.status(400).json({ error: 'Select the customer address from the Google suggestions.' }); return;
      }
      const { data: current, error: findError } = await supabase.from('customers')
        .select('id, auth_user_id, email, name, phone').eq('id', cleanId).maybeSingle();
      if (findError) throw findError;
      if (!current) { res.status(404).json({ error: 'Customer not found.' }); return; }

      const emailChanged = current.email.toLowerCase() !== cleanEmail;
      if (emailChanged) {
        const { data: duplicate, error: duplicateError } = await supabase.from('customers')
          .select('id').eq('email', cleanEmail).neq('id', cleanId).limit(1);
        if (duplicateError) throw duplicateError;
        if ((duplicate || []).length) { res.status(409).json({ error: 'That email belongs to another customer.' }); return; }
      }

      if (emailChanged && current.auth_user_id) {
        const { error: authError } = await supabase.auth.admin.updateUserById(current.auth_user_id, { email: cleanEmail, email_confirm: true });
        if (authError) { res.status(400).json({ error: 'The login email could not be updated: ' + authError.message }); return; }
      }

      const { data: updated, error: updateError } = await supabase.rpc('admin_update_customer_profile_v2', {
        p_customer_id: cleanId, p_name: cleanName, p_phone: cleanPhone || null, p_email: cleanEmail,
        p_address_place_id: location ? String(location.placeId).trim().slice(0, 300) : null,
        p_address_formatted: location ? String(location.formattedAddress || '').trim().slice(0, 500) : null,
        p_address_suburb: location ? String(location.suburb || '').trim().slice(0, 100) : null,
        p_address_state: location ? String(location.state || '').trim().slice(0, 20) : null,
        p_address_postcode: location ? String(location.postcode || '').trim().slice(0, 10) : null,
        p_address_latitude: location ? latitude : null, p_address_longitude: location ? longitude : null,
        p_address_verified: location ? true : false,
      });
      if (updateError) {
        if (emailChanged && current.auth_user_id) {
          await supabase.auth.admin.updateUserById(current.auth_user_id, { email: current.email, email_confirm: true });
        }
        throw updateError;
      }
      res.status(200).json({ customer: updated && updated[0] ? updated[0] : { id: cleanId, name: cleanName, phone: cleanPhone || null, email: cleanEmail } });
      return;
    }

    if (role === 'contractor' && action === 'updateProfile') {
      const cleanId = String(contractorId || '').trim();
      const cleanBusiness = String(business || '').trim();
      const cleanContact = String(contact || '').trim();
      const cleanPhone = String(phone || '').trim();
      const location = addressLocation && typeof addressLocation === 'object' ? addressLocation : {};
      const latitude = Number(location.latitude);
      const longitude = Number(location.longitude);
      const validCoordinates = Number.isFinite(latitude) && latitude >= -44.5 && latitude <= -9 &&
        Number.isFinite(longitude) && longitude >= 112 && longitude <= 154;
      const verified = location.verified === true && !!String(location.placeId || '').trim() && validCoordinates;
      if (!cleanId || !cleanBusiness || cleanBusiness.length > 160 || cleanContact.length > 120 || cleanPhone.length > 30) {
        res.status(400).json({ error: 'A valid contractor, business name and contact details are required.' }); return;
      }
      if (!verified) { res.status(400).json({ error: 'Select the contractor address from the Google suggestions.' }); return; }
      const { data: current, error: findError } = await supabase.from('contractors')
        .select('id, email, full_application').eq('id', cleanId).maybeSingle();
      if (findError) throw findError;
      if (!current) { res.status(404).json({ error: 'Contractor not found.' }); return; }
      const formattedAddress = String(location.formattedAddress || address || '').trim().slice(0, 500);
      const mergedApplication = { ...(current.full_application || {}), business: cleanBusiness,
        contact: cleanContact, phone: cleanPhone, address: formattedAddress,
        addressLocation: { formattedAddress, placeId: String(location.placeId).trim().slice(0, 300),
          suburb: String(location.suburb || '').trim().slice(0, 100), state: String(location.state || '').trim().slice(0, 20),
          postcode: String(location.postcode || '').trim().slice(0, 10), country: 'AU', latitude, longitude, verified: true } };
      const { data: updated, error: updateError } = await supabase.from('contractors').update({
        business_name: cleanBusiness, phone: cleanPhone || null, address: formattedAddress,
        address_place_id: mergedApplication.addressLocation.placeId,
        address_formatted: formattedAddress, address_suburb: mergedApplication.addressLocation.suburb || null,
        address_state: mergedApplication.addressLocation.state || null, address_postcode: mergedApplication.addressLocation.postcode || null,
        address_latitude: latitude, address_longitude: longitude, address_verified: true,
        full_application: mergedApplication, updated_at: new Date().toISOString(),
      }).eq('id', cleanId).select('id, email, business_name, phone, address, address_formatted, address_suburb, address_state, address_postcode, address_latitude, address_longitude, address_verified').maybeSingle();
      if (updateError) throw updateError;
      res.status(200).json({ contractor: updated });
      return;
    }

    const table = ROLES[role];
    if (!table || !email || !['deactivate', 'reactivate', 'delete'].includes(action)) {
      res.status(400).json({ error: 'role (customer|contractor), email, and a valid action are required.' });
      return;
    }
    const normalizedEmail = String(email).toLowerCase();
    if (action === 'deactivate' || action === 'reactivate') {
      if (role === 'contractor' && action === 'deactivate' && !String(reason || '').trim()) {
        res.status(400).json({ error: 'A suspension reason is required.' }); return;
      }
      const status = role === 'customer'
        ? (action === 'deactivate' ? 'deactivated' : 'active')
        : (action === 'deactivate' ? 'suspended' : 'approved');
      const { data, error } = await supabase
        .from(table)
        .update({ status, ...(role === 'contractor' ? { updated_at: new Date().toISOString() } : {}) })
        .eq('email', normalizedEmail)
        .select('id');
      if (error) throw error;
      if (role === 'contractor' && (data || []).length) {
        const suspended = action === 'deactivate';
        const title = suspended ? 'Contractor account suspended' : 'Contractor account reactivated';
        const body = suspended ? `${String(reason).trim()} Contact MySubbies support if you need clarification or want the account reviewed.`
          : 'Your contractor account has been reactivated. You can sign in and review suitable job offers again.';
        await notifyContractor(supabase, { email: normalizedEmail,
          eventType: suspended ? 'contractor-account-suspended' : 'contractor-account-reactivated', title, body,
          subject: suspended ? 'Important update to your MySubbies contractor account' : 'Your MySubbies contractor account is active again',
          html: wrapEmail(`<h2 style="margin-top:0;">${title}</h2><p>${escapeHtml(body)}</p>${emailButton('Open Contractor Portal →', CONTRACTOR_PORTAL_URL)}`) });
        await notifyAdmin(supabase, { eventType: suspended ? 'contractor-account-suspended' : 'contractor-account-reactivated',
          title, body: `${normalizedEmail} was ${suspended ? 'suspended' : 'reactivated'}.` });
      }
      res.status(200).json({ updated: (data || []).length, status });
      return;
    }

    // action === 'delete'
    const { data: row, error: findErr } = await supabase
      .from(table)
      .select('id, auth_user_id')
      .eq('email', normalizedEmail)
      .maybeSingle();
    if (findErr) throw findErr;
    if (!row) { res.status(404).json({ error: 'No account found with that email.' }); return; }

    const jobIdCol = role === 'customer' ? 'customer_id' : 'contractor_id';
    const jobEmailCol = role === 'customer' ? 'customer_email' : 'contractor_email';
    const { data: jobRows, error: jobsErr } = await supabase
      .from('jobs')
      .select('id')
      .or(`${jobIdCol}.eq.${row.id},${jobEmailCol}.eq.${normalizedEmail}`)
      .limit(1);
    if (jobsErr) throw jobsErr;

    let hasHistory = (jobRows || []).length > 0;
    if (!hasHistory && role === 'customer') {
      const { data: addrRows, error: addrErr } = await supabase
        .from('customer_addresses').select('id').eq('customer_id', row.id).limit(1);
      if (addrErr) throw addrErr;
      hasHistory = (addrRows || []).length > 0;
    }
    if (!hasHistory && role === 'contractor') {
      const { data: ratingRows, error: ratingErr } = await supabase
        .from('ratings').select('id').eq('contractor_id', row.id).limit(1);
      if (ratingErr) throw ratingErr;
      hasHistory = (ratingRows || []).length > 0;
    }

    if (hasHistory) {
      res.status(409).json({ error: 'This account has job history and can’t be permanently deleted -- use Deactivate instead.' });
      return;
    }

    const { error: delErr } = await supabase.from(table).delete().eq('id', row.id);
    if (delErr) throw delErr;
    if (row.auth_user_id) {
      const { error: authDelErr } = await supabase.auth.admin.deleteUser(row.auth_user_id);
      if (authDelErr) console.error('admin-account: table row deleted but auth user deletion failed:', authDelErr);
    }

    res.status(200).json({ deleted: true });
  } catch (err) {
    console.error('admin-account error:', err);
    res.status(500).json({ error: 'Could not update this account.' });
  }
};
