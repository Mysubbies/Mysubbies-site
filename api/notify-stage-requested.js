// POST /api/notify-stage-requested
// Body: { customerEmail, category, stageLabel }
//
// Fired from mysubbies-contractor-portal.html's requestStageApproval() so
// the customer knows a payment stage is waiting on them, instead of only
// finding out next time they happen to open My Jobs.
const { sendEmail, wrapEmail } = require('./_lib/email');

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const { customerEmail, category, stageLabel } = req.body || {};
    if (!customerEmail || !category || !stageLabel) { res.status(400).json({ error: 'customerEmail, category and stageLabel are required.' }); return; }

    await sendEmail({
      to: customerEmail,
      subject: `Action needed — approve the ${stageLabel} stage for your ${category} job`,
      html: wrapEmail(`
        <h2 style="margin-top:0;">Your contractor is ready for the next stage</h2>
        <p>Your contractor has marked the <strong>${stageLabel}</strong> stage ready on your <strong>${category}</strong> job. Review and approve the payment in <a href="https://mysubbies-site.vercel.app/mysubbies-customer-portal.html">My Jobs</a> to keep things moving.</p>
        <p>Nothing is charged until you approve it there.</p>
      `),
    });
    res.status(200).json({ sent: true });
  } catch (err) {
    console.error('notify-stage-requested error:', err);
    res.status(200).json({ sent: false });
  }
};
