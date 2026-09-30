const { bearerToken } = require('./userAuth');

async function authenticatedUser(supabase, req) {
  const token = bearerToken(req);
  if (!token) return { ok: false, status: 401, error: 'Authentication required.' };
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data || !data.user) return { ok: false, status: 401, error: 'Session expired — please log in again.' };
  return { ok: true, user: data.user };
}

async function requirePropertyMember(supabase, req) {
  const auth = await authenticatedUser(supabase, req);
  if (!auth.ok) return auth;
  const { data: member, error } = await supabase.from('pm_members')
    .select('id, organisation_id, auth_user_id, email, name, phone, role, can_approve, status')
    .eq('auth_user_id', auth.user.id).maybeSingle();
  if (error) throw error;
  if (!member || member.status !== 'active') return { ok: false, status: 403, error: 'No active property-management account is linked to this login.' };
  const { data: organisation, error: orgError } = await supabase.from('pm_organisations')
    .select('id, name, organisation_type, status, billing_email, approval_required, approval_limit_cents')
    .eq('id', member.organisation_id).maybeSingle();
  if (orgError) throw orgError;
  if (!organisation || organisation.status !== 'active') return { ok: false, status: 403, error: 'This organisation is not active.' };
  return { ok: true, user: auth.user, member, organisation };
}

module.exports = { authenticatedUser, requirePropertyMember };
