const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('admin session uses a short HttpOnly SameSite cookie', () => {
  process.env.ADMIN_SESSION_SECRET = 'test-session-secret-with-sufficient-entropy';
  const auth = require('../api/_lib/adminAuth');
  const token = auth.signAdminToken();
  const cookie = auth.adminSessionCookie(token);
  assert.match(cookie, /^__Host-mysubbies_admin_session=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Max-Age=3600/);
  assert.equal(auth.verifyAdminAuth({ headers: { cookie } }), true);
  assert.equal(auth.verifyAdminAuth({ headers: { authorization: `Bearer ${token}` } }), false);
});

test('admin login is persistently rate limited and never returns a bearer token', () => {
  const source = fs.readFileSync(path.join(root, 'api/admin-account.js'), 'utf8');
  assert.match(source, /countRecentFailures/);
  assert.match(source, /MAX_FAILURES/);
  assert.match(source, /status\(429\)/);
  assert.match(source, /Retry-After/);
  assert.match(source, /adminSessionCookie/);
  assert.doesNotMatch(source, /json\(\{\s*token:/);
  const limiter = fs.readFileSync(path.join(root, 'api/_lib/adminLoginSecurity.js'), 'utf8');
  assert.match(limiter, /PGRST205/);
  assert.match(limiter, /document_access_attempts/);
});

test('contractor message reads and writes require a verified contractor session', () => {
  const api = fs.readFileSync(path.join(root, 'api/admin-messages.js'), 'utf8');
  const portal = fs.readFileSync(path.join(root, 'mysubbies-contractor-portal.html'), 'utf8');
  assert.match(api, /requireAccount/);
  assert.match(api, /You cannot read another contractor/);
  assert.match(portal, /admin-messages[^\n]+[\s\S]{0,240}Authorization: 'Bearer ' \+ token/);
});

test('admin portal does not persist an admin bearer token in localStorage', () => {
  const portal = fs.readFileSync(path.join(root, 'mysubbies-admin-portal.html'), 'utf8');
  assert.doesNotMatch(portal, /mysubbies_admin_token/);
  assert.match(portal, /action: 'session'/);
  assert.match(portal, /action: 'logout'/);
});

test('admin security schema enables RLS on login attempts', () => {
  const schema = fs.readFileSync(path.join(root, 'supabase/schema_v29_admin_security.sql'), 'utf8');
  assert.match(schema, /admin_login_attempts enable row level security/i);
  assert.match(schema, /revoke all privileges.*anon, authenticated/i);
});
