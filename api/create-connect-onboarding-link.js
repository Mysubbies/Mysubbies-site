// Legacy endpoint retained so old bookmarks/clients fail safely. Contractor
// Stripe Connect onboarding was retired in September 2026; bank payout
// details are now managed through the authenticated contractor profile.
module.exports = async (_req, res) => {
  res.status(410).json({ error: 'Stripe Connect contractor onboarding is no longer used. Add payout bank details in the Contractor Portal.' });
};
