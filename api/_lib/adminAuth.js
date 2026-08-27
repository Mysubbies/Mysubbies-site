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

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function sign(payload) {
  return crypto.createHmac('sha256', process.env.ADMIN_SESSION_SECRET).update(payload).digest('base64url');
}

function signAdminToken() {
  const payload = base64url(JSON.stringify({ exp: Date.now() + TOKEN_TTL_MS }));
  return `${payload}.${sign(payload)}`;
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
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payload, signature] = parts;
  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof exp === 'number' && Date.now() < exp;
  } catch (e) {
    return false;
  }
}

function requireAdmin(req, res) {
  if (!verifyAdminAuth(req)) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

module.exports = { signAdminToken, verifyPassword, verifyAdminAuth, requireAdmin };
