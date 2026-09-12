const crypto = require('crypto');

const MAX_ATTEMPTS_PER_HOUR = 5;
const PREVIEW_MAX_ATTEMPTS_PER_HOUR = 50;

function clientFingerprint(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const address = forwarded || req.socket?.remoteAddress || 'unknown';
  const salt = process.env.SIGNUP_RATE_LIMIT_SECRET || process.env.ADMIN_SESSION_SECRET || 'mysubbies-rate-limit';
  return crypto.createHash('sha256').update(`${salt}:${address}`).digest('hex');
}

function signupAttemptLimit() {
  return process.env.VERCEL_ENV === 'preview' ? PREVIEW_MAX_ATTEMPTS_PER_HOUR : MAX_ATTEMPTS_PER_HOUR;
}

async function enforceSignupRateLimit(supabase, req) {
  const fingerprint = clientFingerprint(req);
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count, error } = await supabase.from('contractor_signup_attempts').select('id', { count: 'exact', head: true })
    .eq('client_fingerprint', fingerprint).gte('attempted_at', since);
  if (error) throw error;
  if ((count || 0) >= signupAttemptLimit()) return { ok: false, retryAfter: 3600 };
  const { error: insertError } = await supabase.from('contractor_signup_attempts').insert({ client_fingerprint: fingerprint });
  if (insertError) throw insertError;
  return { ok: true };
}

function looksLikeBot(application) {
  if (application.website) return true;
  const started = Number(application.formStartedAt);
  return !Number.isFinite(started) || Date.now() - started < 2500 || Date.now() - started > 24 * 60 * 60 * 1000;
}

module.exports = { MAX_ATTEMPTS_PER_HOUR, PREVIEW_MAX_ATTEMPTS_PER_HOUR, clientFingerprint, enforceSignupRateLimit, looksLikeBot };
