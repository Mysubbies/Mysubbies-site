const crypto = require('crypto');

const STEP_SECONDS = 30; // RFC 6238 default interval used by authenticator apps
const CODE_DIGITS = 6;

function decodeBase32(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(value || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  if (!clean) throw new Error('ADMIN_TOTP_SECRET is not configured.');
  let bits = '';
  for (const char of clean) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error('ADMIN_TOTP_SECRET is invalid.');
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function codeForCounter(secret, counter) {
  const key = decodeBase32(secret);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', key).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % (10 ** CODE_DIGITS)).padStart(CODE_DIGITS, '0');
}

function verifyTotp(code, now = Date.now()) {
  if (!process.env.ADMIN_TOTP_SECRET || !/^\d{6}$/.test(String(code || ''))) return false;
  const submitted = Buffer.from(String(code));
  const counter = Math.floor(now / 1000 / STEP_SECONDS);
  for (let drift = -1; drift <= 1; drift += 1) {
    const expected = Buffer.from(codeForCounter(process.env.ADMIN_TOTP_SECRET, counter + drift));
    if (submitted.length === expected.length && crypto.timingSafeEqual(submitted, expected)) return true;
  }
  return false;
}

module.exports = { verifyTotp, codeForCounter };
