// POST /api/admin-account
// Body: { action: 'login', password } -- OR --
//       { role: 'customer'|'contractor', email, action: 'deactivate'|'reactivate'|'delete' }
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
const { requireAdmin, verifyPassword, signAdminToken } = require('./_lib/adminAuth');

const ROLES = { customer: 'customers', contractor: 'contractors' };

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const { role, email, action, password } = req.body || {};

    if (action === 'login') {
      if (!verifyPassword(password)) { res.status(401).json({ error: 'Incorrect password.' }); return; }
      res.status(200).json({ token: signAdminToken() });
      return;
    }

    if (!requireAdmin(req, res)) return;

    const table = ROLES[role];
    if (!table || !email || !['deactivate', 'reactivate', 'delete'].includes(action)) {
      res.status(400).json({ error: 'role (customer|contractor), email, and a valid action are required.' });
      return;
    }
    const normalizedEmail = String(email).toLowerCase();
    const supabase = getSupabase();

    if (action === 'deactivate' || action === 'reactivate') {
      const status = role === 'customer'
        ? (action === 'deactivate' ? 'deactivated' : 'active')
        : (action === 'deactivate' ? 'suspended' : 'approved');
      const { data, error } = await supabase
        .from(table)
        .update({ status, ...(role === 'contractor' ? { updated_at: new Date().toISOString() } : {}) })
        .eq('email', normalizedEmail)
        .select('id');
      if (error) throw error;
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
