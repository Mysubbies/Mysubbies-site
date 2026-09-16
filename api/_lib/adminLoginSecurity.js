const crypto = require('crypto');

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;

function missingAdminAttemptsTable(error) {
  return error && error.code === 'PGRST205';
}

function fingerprint(req) {
  const forwarded = String((req.headers && req.headers['x-forwarded-for']) || '').split(',')[0].trim();
  const ip = forwarded || (req.socket && req.socket.remoteAddress) || 'unknown';
  const secret = process.env.ADMIN_RATE_LIMIT_SECRET || process.env.ADMIN_SESSION_SECRET || 'mysubbies-admin-login';
  return crypto.createHmac('sha256', secret).update(ip).digest('hex');
}

async function countRecentFailures(supabase, req) {
  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  const { count, error } = await supabase.from('admin_login_attempts')
    .select('id', { count: 'exact', head: true })
    .eq('client_fingerprint', fingerprint(req)).gte('attempted_at', since);
  if (missingAdminAttemptsTable(error)) {
    const fallback = await supabase.from('document_access_attempts')
      .select('id', { count: 'exact', head: true })
      .eq('ip', fingerprint(req)).eq('success', false).gte('created_at', since);
    if (fallback.error) throw fallback.error;
    return fallback.count || 0;
  }
  if (error) throw error;
  return count || 0;
}

async function recordFailure(supabase, req) {
  const { error } = await supabase.from('admin_login_attempts')
    .insert({ client_fingerprint: fingerprint(req) });
  if (missingAdminAttemptsTable(error)) {
    const fallback = await supabase.from('document_access_attempts')
      .insert({ ip: fingerprint(req), success: false });
    if (fallback.error) throw fallback.error;
    return;
  }
  if (error) throw error;
}

async function clearFailures(supabase, req) {
  const { error } = await supabase.from('admin_login_attempts')
    .delete().eq('client_fingerprint', fingerprint(req));
  if (missingAdminAttemptsTable(error)) {
    const fallback = await supabase.from('document_access_attempts')
      .delete().eq('ip', fingerprint(req)).eq('success', false);
    if (fallback.error) throw fallback.error;
    return;
  }
  if (error) throw error;
}

module.exports = { WINDOW_MS, MAX_FAILURES, fingerprint, countRecentFailures, recordFailure, clearFailures };
