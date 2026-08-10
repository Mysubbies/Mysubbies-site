// Shared Stripe + Supabase clients for the /api functions.
// Files under api/_lib are not routable endpoints (Vercel convention) —
// this is just shared code.
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is not set in Vercel environment variables.');
  }
  return new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
}

function getSupabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set in Vercel environment variables.');
  }
  // Service role key — this only ever runs server-side in /api functions,
  // never shipped to the browser. It bypasses row-level security by design
  // so these functions are the sole authority over payment/payout state.
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

module.exports = { getStripe, getSupabase };
