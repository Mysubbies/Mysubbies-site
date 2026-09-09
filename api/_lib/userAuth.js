// Resolve a portal caller from the Supabase access token it already receives
// at login. Database reads continue through the server-only service-role
// client; this token is used solely to bind the request to an account row.
function bearerToken(req) {
  const header = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

async function requireAccount(supabase, req, role) {
  const token = bearerToken(req);
  if (!token) return { ok: false, status: 401, error: 'Authentication required.' };

  const { data: authData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !authData || !authData.user) {
    return { ok: false, status: 401, error: 'Session expired — please log in again.' };
  }

  const table = role === 'customer' ? 'customers' : role === 'contractor' ? 'contractors' : null;
  if (!table) return { ok: false, status: 400, error: 'Invalid account role.' };
  const fields = role === 'contractor' ? 'id, auth_user_id, email, categories, business_name' : 'id, auth_user_id, email, name, phone';
  const { data: account, error } = await supabase.from(table)
    .select(fields).eq('auth_user_id', authData.user.id).maybeSingle();
  if (error) throw error;
  if (!account) return { ok: false, status: 403, error: `No linked ${role} account was found.` };

  return { ok: true, role, account, user: authData.user };
}

module.exports = { bearerToken, requireAccount };
