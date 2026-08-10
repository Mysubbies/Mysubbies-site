// POST /api/create-connect-onboarding-link
// Body: { contractorEmail, refreshUrl, returnUrl }
// Creates (or reuses) a Stripe Connect Standard account for a contractor
// and returns a one-time onboarding link. Standard accounts get their own
// full Stripe dashboard and handle their own tax reporting — see CLAUDE.md
// for why Standard was chosen over Express.
const { getStripe, getSupabase } = require('./_lib/clients');

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const { contractorEmail, refreshUrl, returnUrl } = req.body || {};
    if (!contractorEmail || !refreshUrl || !returnUrl) {
      res.status(400).json({ error: 'contractorEmail, refreshUrl and returnUrl are required.' });
      return;
    }

    const stripe = getStripe();
    const supabase = getSupabase();

    const { data: existing } = await supabase
      .from('contractor_connect_accounts').select('*').eq('contractor_email', contractorEmail).maybeSingle();

    let accountId = existing && existing.stripe_connect_account_id;
    if (!accountId) {
      const account = await stripe.accounts.create({ type: 'standard', email: contractorEmail });
      accountId = account.id;
      await supabase.from('contractor_connect_accounts').insert({
        contractor_email: contractorEmail,
        stripe_connect_account_id: accountId,
        onboarding_status: 'pending',
      });
    }

    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: refreshUrl,
      return_url: returnUrl,
      type: 'account_onboarding',
    });

    res.status(200).json({ url: accountLink.url });
  } catch (err) {
    console.error('create-connect-onboarding-link error:', err);
    res.status(500).json({ error: 'Could not start onboarding. Please try again.' });
  }
};
