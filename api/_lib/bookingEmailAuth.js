const crypto = require('crypto');
const { clientFingerprint } = require('./signupSecurity');
const { sendEmailWithResult, wrapEmail, escapeHtml } = require('./email');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

async function bookingCodeRateLimit(supabase, req, email) {
  const since = new Date(Date.now() - 3600000).toISOString();
  // Separate namespaces keep booking-code requests from consuming contractor signup limits.
  for (const [key, limit] of [[`booking-code-ip:${clientFingerprint(req)}`, 10], [`booking-code-email:${email}`, 5]]) {
    const fingerprint = digest(key);
    const { count, error } = await supabase.from('contractor_signup_attempts').select('id', { count:'exact', head:true })
      .eq('client_fingerprint', fingerprint).gte('attempted_at', since);
    if (error) throw error;
    if ((count || 0) >= limit) return false;
    const lock = digest(`${fingerprint}:${Math.floor(Date.now() / 60000)}`).slice(0,32);
    const id = `${lock.slice(0,8)}-${lock.slice(8,12)}-${lock.slice(12,16)}-${lock.slice(16,20)}-${lock.slice(20)}`;
    const { error: writeError } = await supabase.from('contractor_signup_attempts').insert({ id, client_fingerprint:fingerprint });
    if (writeError?.code === '23505') return false; // Atomic per-minute lock across concurrent instances.
    if (writeError) throw writeError;
  }
  return true;
}
async function requestBookingCode(supabase, req, res) {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { res.status(400).json({error:'Enter a valid email address.'}); return; }
  res.setHeader('Cache-Control','no-store');
  if (!process.env.RESEND_API_KEY) { res.status(503).json({error:'Email verification is temporarily unavailable. You can use password login instead.'}); return; }
  try {
    if (!await bookingCodeRateLimit(supabase, req, email)) {
      res.setHeader('Retry-After','3600'); res.status(429).json({error:'Too many code requests. Please try again later.'}); return;
    }
    // Supabase generates and verifies the single-use token. No custom credentials
    // or token hashes are returned to the public caller or written to logs.
    const { data, error } = await supabase.auth.admin.generateLink({type:'magiclink',email});
    const code = data?.properties?.email_otp;
    if (error || !/^\d{6,10}$/.test(String(code || ''))) throw new Error('Code generation unavailable');
    const delivery = await sendEmailWithResult({to:email,subject:'Your MySubbies booking verification code',
      html:wrapEmail(`<h2>Continue your booking</h2><p>Enter this single-use code on the MySubbies booking screen:</p><p style="font-size:30px;letter-spacing:6px;font-weight:700;">${escapeHtml(code)}</p><p>No password is needed. Your booking is submitted when you choose Verify &amp; confirm booking. No booking fee is charged.</p><p>If you did not request this code, you can ignore this email.</p>`)});
    if (!delivery.ok) throw new Error('Code delivery unavailable');
    res.status(200).json({sent:true});
  } catch (_) {
    res.status(503).json({error:'We could not send a verification code. Please try again or use password login.'});
  }
}
module.exports = { bookingCodeRateLimit, requestBookingCode };
