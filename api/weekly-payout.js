// Legacy Stripe Connect transfer endpoint. Retained as a non-operational
// route for backwards compatibility and to prevent an old/manual caller
// from moving money after contractor Connect was retired. Customer Stripe
// collection endpoints and webhooks are unchanged.
module.exports = async (req, res) => {
  const authHeader = req.headers.authorization || '';
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  res.status(410).json({ error: 'Automatic Stripe Connect contractor payouts are disabled. Use the authorised Admin manual payout process.' });
};
