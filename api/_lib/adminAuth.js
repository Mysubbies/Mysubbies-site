// Shared admin-session verification. Files under api/_lib are not routable
// endpoints (Vercel convention) -- just shared code, same as clients.js.
//
// Token shape: a signed, expiring credential using Node's built-in crypto
// (no new dependency) -- HMAC-SHA256 over a JSON payload containing only an
// expiry timestamp, using ADMIN_SESSION_SECRET (server-only, never shipped
// to the browser). Mirrors the CRON_SECRET bearer-token pattern already
// used in weekly-payout.js, but expiring rather than a static shared
// secret, so a leaked token (XSS, shared computer, devtools) has a bounded
// window instead of staying valid forever.
const crypto = require('crypto');

const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour emergency hardening
const MFA_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const ADMIN_COOKIE = '__Host-mysubbies_admin_session';

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function sign(payload) {
  return crypto.createHmac('sha256', process.env.ADMIN_SESSION_SECRET).update(payload).digest('base64url');
}

function signAdminToken() {
  if (!process.env.ADMIN_SESSION_SECRET) throw new Error('ADMIN_SESSION_SECRET is not configured.');
  const payload = base64url(JSON.stringify({ exp: Date.now() + TOKEN_TTL_MS, mfa: true }));
  return `${payload}.${sign(payload)}`;
}

function signMfaChallenge(clientFingerprint) {
  if (!process.env.ADMIN_SESSION_SECRET) throw new Error('ADMIN_SESSION_SECRET is not configured.');
  const payload = base64url(JSON.stringify({
    exp: Date.now() + MFA_CHALLENGE_TTL_MS,
    purpose: 'admin-mfa',
    fingerprint: clientFingerprint,
    nonce: crypto.randomBytes(16).toString('base64url'),
  }));
  return `${payload}.${sign(payload)}`;
}

function verifySignedToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof parsed.exp === 'number' && Date.now() < parsed.exp ? parsed : null;
  } catch (e) {
    return null;
  }
}

function verifyMfaChallenge(token, clientFingerprint) {
  if (!process.env.ADMIN_SESSION_SECRET) return false;
  const parsed = verifySignedToken(token);
  return !!parsed && parsed.purpose === 'admin-mfa' && parsed.fingerprint === clientFingerprint;
}

function cookieValue(req, name) {
  const header = String((req.headers && req.headers.cookie) || '');
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return '';
}

function adminSessionCookie(token) {
  return `${ADMIN_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${Math.floor(TOKEN_TTL_MS / 1000)}; HttpOnly; Secure; SameSite=Strict`;
}

function clearAdminSessionCookie() {
  return `${ADMIN_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

function verifyPassword(submitted) {
  // Constant-time comparison over equal-length SHA-256 digests, so a bare
  // string compare's early-exit timing can't leak how many leading
  // characters matched.
  if (!process.env.ADMIN_PASSWORD || typeof submitted !== 'string') return false;
  const a = crypto.createHash('sha256').update(submitted).digest();
  const b = crypto.createHash('sha256').update(process.env.ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

function verifyAdminAuth(req) {
  // Fail closed if the secret was never configured -- an unset env var
  // must never be treated as "any token verifies."
  if (!process.env.ADMIN_SESSION_SECRET) return false;
  // Do not accept the former browser-readable bearer token. Deployment of
  // this change intentionally signs existing admin tabs out once so a token
  // left in localStorage cannot continue authorising sensitive operations.
  const token = cookieValue(req, ADMIN_COOKIE);
  const parsed = verifySignedToken(token);
  return !!parsed && parsed.mfa === true;
}

function requireAdmin(req, res) {
  if (!verifyAdminAuth(req)) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

module.exports = { signAdminToken, signMfaChallenge, verifyMfaChallenge, verifyPassword, verifyAdminAuth, requireAdmin, adminSessionCookie, clearAdminSessionCookie };
